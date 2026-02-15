/**
 * Temporal workflow that orchestrates Claude agent SDK sessions.
 *
 * IMPORTANT: This file runs inside the Temporal workflow sandbox — a
 * deterministic V8 isolate. It must NOT import Node.js APIs or
 * non-deterministic code directly. All real work is delegated to
 * activities via `proxyActivities`.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';

import type * as activitiesModule from './activities.js';
import type {
  AgentWorkflowInput,
  AgentWorkflowOutput,
  AgentWorkflowStepResult,
  AgentQueryInput,
  AgentQueryResult,
  AgentSessionOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Proxy the activities so they run in normal Node.js context
// ---------------------------------------------------------------------------

const {
  executeAgentQuery,
  mergeAgentOptions,
} = proxyActivities<typeof activitiesModule>({
  // Agent queries can be long-running (Claude may use many tools).
  startToCloseTimeout: '10 minutes',
  // Heartbeat to detect stuck activities.
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

// ---------------------------------------------------------------------------
// Signals & Queries — allow external code to interact with a running workflow
// ---------------------------------------------------------------------------

/** Signal: append an additional step to the workflow while it's running. */
export const addStepSignal = defineSignal<[{ prompt: string; options?: Partial<AgentSessionOptions> }]>(
  'addStep'
);

/** Signal: request the workflow to cancel gracefully after the current step. */
export const cancelSignal = defineSignal('cancel');

/**
 * Signal: abort the current step and insert a new step at the front of the queue.
 *
 * The currently running activity is cancelled immediately, and the provided
 * step becomes the next one to execute. Any previously queued steps remain
 * behind it.
 */
export const abortAndInsertSignal = defineSignal<[{ prompt: string; options?: Partial<AgentSessionOptions> }]>(
  'abortAndInsert'
);

/**
 * Signal: abort the current step and replace the entire pending queue.
 *
 * The currently running activity is cancelled, the pending queue is cleared,
 * and the provided steps become the new queue.
 */
export const replaceQueueSignal = defineSignal<[{ steps: Array<{ prompt: string; options?: Partial<AgentSessionOptions> }> }]>(
  'replaceQueue'
);

/** Query: get the current list of completed step results so far. */
export const getProgressQuery = defineQuery<AgentWorkflowStepResult[]>('getProgress');

/** Query: check whether the workflow is still running. */
export const isRunningQuery = defineQuery<boolean>('isRunning');

// ---------------------------------------------------------------------------
// Workflow implementation
// ---------------------------------------------------------------------------

/**
 * `claudeAgentWorkflow` — a durable, multi-turn Claude agent session.
 *
 * Accepts either a single prompt or an ordered list of steps. Each step
 * is executed sequentially in the same Claude session (session ID is
 * carried forward). New steps can be added at runtime via the `addStep`
 * signal, and the workflow can be gracefully cancelled via the `cancel`
 * signal.
 *
 * @example
 * ```ts
 * // Single prompt
 * const output = await client.workflow.execute(claudeAgentWorkflow, {
 *   workflowId: 'agent-session-1',
 *   taskQueue: 'claude-agent-queue',
 *   args: [{ prompt: 'Explain how async/await works in TypeScript' }],
 * });
 *
 * // Multi-step
 * const output = await client.workflow.execute(claudeAgentWorkflow, {
 *   workflowId: 'agent-session-2',
 *   taskQueue: 'claude-agent-queue',
 *   args: [{
 *     steps: [
 *       { prompt: 'Read the src/ directory and summarize the project' },
 *       { prompt: 'Now add unit tests for the main module' },
 *     ],
 *     options: { permissionMode: 'acceptEdits', cwd: '/my/project' },
 *   }],
 * });
 * ```
 */
export async function claudeAgentWorkflow(
  input: AgentWorkflowInput
): Promise<AgentWorkflowOutput> {
  // Mutable state visible to signal/query handlers.
  const stepResults: AgentWorkflowStepResult[] = [];
  const pendingSteps: Array<{ prompt: string; options?: Partial<AgentSessionOptions> }> = [];
  let cancelled = false;
  let running = true;
  let sessionId: string | null = null;

  // Reference to the current CancellationScope so abort signals can cancel
  // the in-flight activity immediately.
  let currentScope: CancellationScope | null = null;

  // --- Register handlers ---

  setHandler(addStepSignal, (step) => {
    pendingSteps.push(step);
  });

  setHandler(cancelSignal, () => {
    cancelled = true;
    if (currentScope) {
      currentScope.cancel();
    }
  });

  setHandler(abortAndInsertSignal, (step) => {
    // Insert the new step at the front of the queue so it executes next.
    pendingSteps.unshift(step);
    if (currentScope) {
      currentScope.cancel();
    }
  });

  setHandler(replaceQueueSignal, ({ steps }) => {
    // Clear the queue and replace with the new steps.
    pendingSteps.length = 0;
    for (const s of steps) {
      pendingSteps.push(s);
    }
    if (currentScope) {
      currentScope.cancel();
    }
  });

  setHandler(getProgressQuery, () => [...stepResults]);

  setHandler(isRunningQuery, () => running);

  // --- Build the initial step queue ---

  if (input.steps && input.steps.length > 0) {
    for (const step of input.steps) {
      pendingSteps.push({ prompt: step.prompt, options: step.options });
    }
  } else if (input.prompt) {
    pendingSteps.push({ prompt: input.prompt });
  }

  // --- Execute steps sequentially ---

  let stepIndex = 0;

  while (!cancelled) {
    // Wait until there is at least one pending step, or we're cancelled.
    if (pendingSteps.length === 0) {
      // If we've already run at least one step and nothing new is queued,
      // give a short window for signals before finishing.
      if (stepIndex > 0) {
        const gotMore = await condition(
          () => pendingSteps.length > 0 || cancelled,
          // Wait up to 5 seconds for new steps after last step completes
          '5s'
        );
        if (!gotMore || cancelled) break;
      } else {
        // No initial steps at all — wait indefinitely for a signal.
        await condition(() => pendingSteps.length > 0 || cancelled);
        if (cancelled) break;
      }
    }

    const step = pendingSteps.shift();
    if (!step) continue;

    // Merge workflow-level defaults with step-level overrides.
    const mergedOptions = await mergeAgentOptions(input.options, step.options);

    const queryInput: AgentQueryInput = {
      prompt: step.prompt,
      sessionId: sessionId ?? undefined,
      options: mergedOptions,
    };

    // Wrap the activity in a CancellationScope so abort/replace signals
    // can cancel it mid-execution.
    const scope = new CancellationScope({ cancellable: true });
    currentScope = scope;

    let stepResult: AgentQueryResult | null = null;

    try {
      stepResult = await scope.run(() => executeAgentQuery(queryInput));
    } catch (e) {
      if (!isCancellation(e)) {
        throw e;
      }
      // Activity was cancelled by an abort/replace/cancel signal.
      // stepResult remains null — handled below.
    } finally {
      currentScope = null;
    }

    if (stepResult) {
      // Normal completion — carry session forward.
      if (stepResult.sessionId) {
        sessionId = stepResult.sessionId;
      }

      stepResults.push({
        stepIndex,
        prompt: step.prompt,
        result: stepResult,
      });
    } else {
      // Step was aborted.
      stepResults.push({
        stepIndex,
        prompt: step.prompt,
        result: {
          text: '',
          sessionId,
          messages: [],
          success: false,
          errors: ['Step aborted'],
        },
      });
    }

    stepIndex++;
  }

  // --- Assemble final output ---

  running = false;

  const allSucceeded = stepResults.every((s) => s.result.success);
  const fullText = stepResults.map((s) => s.result.text).join('\n\n');

  return {
    stepResults,
    sessionId,
    success: allSucceeded,
    fullText,
  };
}
