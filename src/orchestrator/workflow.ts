/**
 * CF Workflow orchestrator — dispatches coding tasks to A2A agent hosts,
 * waits for completion via push notifications, evaluates results, and
 * retries with feedback when needed.
 *
 * This module provides the workflow step implementations that run inside
 * a Cloudflare Workflow. The CF Workflow runtime calls these steps
 * with automatic durability — each step is independently retriable.
 *
 * @example
 * ```ts
 * // In a Cloudflare Worker:
 * import { WorkflowEntrypoint } from 'cloudflare:workers';
 * import { dispatchTask, waitForCompletion, evaluateResult } from '@instantlyeasy/claude-code-sdk-ts/orchestrator';
 *
 * export class CodingWorkflow extends WorkflowEntrypoint<Env, OrchestratorInput> {
 *   async run(event, step) {
 *     const { prompt, config } = event.payload;
 *     const contextId = config.contextId ?? crypto.randomUUID();
 *
 *     let currentPrompt = prompt;
 *
 *     for (let attempt = 0; attempt < (config.maxRetries ?? 3); attempt++) {
 *       const dispatch = await step.do(`dispatch-${attempt}`, () =>
 *         dispatchTask({ prompt: currentPrompt, contextId, ...config })
 *       );
 *
 *       const result = await step.waitForEvent(`completion-${attempt}`, {
 *         type: `task-${dispatch.taskId}`,
 *         timeout: config.completionTimeout ?? '10 minutes',
 *       });
 *
 *       const decision = await step.do(`evaluate-${attempt}`, () =>
 *         evaluateResult({ taskId: dispatch.taskId, originalPrompt: currentPrompt, result, attempt, maxRetries: config.maxRetries ?? 3 })
 *       );
 *
 *       if (decision.action === 'accept') return { success: true, ... };
 *       if (decision.action === 'fail') return { success: false, ... };
 *       currentPrompt = decision.revisedPrompt; // retry with feedback
 *     }
 *   }
 * }
 * ```
 */

import type {
  DispatchStepInput,
  DispatchStepResult,
  WaitStepResult,
  EvaluateStepInput,
  EvaluateDecision,
  AgentCompletionEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Step 1: Dispatch task to A2A agent
// ---------------------------------------------------------------------------

/**
 * Send a coding task to the A2A agent host.
 *
 * This step is called from within a CF Workflow `step.do()`. It sends
 * a `message/send` JSON-RPC call to the agent host and returns the
 * task ID for tracking.
 */
export async function dispatchTask(
  input: DispatchStepInput
): Promise<DispatchStepResult> {
  const { prompt, contextId, agentUrl, agentAuthToken, pushNotificationUrl } = input;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (agentAuthToken) {
    headers['Authorization'] = `Bearer ${agentAuthToken}`;
  }

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
      },
      configuration: {
        contextId,
        ...(pushNotificationUrl ? {
          pushNotification: {
            url: pushNotificationUrl,
          },
        } : {}),
      },
    },
  };

  const res = await fetch(agentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`A2A dispatch failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json() as { result?: { id?: string; status?: { state?: string } }; error?: { message?: string } };

  if (json.error) {
    throw new Error(`A2A error: ${json.error.message}`);
  }

  const task = json.result;
  return {
    taskId: task?.id ?? contextId,
    contextId,
    status: (task?.status?.state === 'failed' ? 'failed' : 'working') as 'working' | 'failed',
  };
}

// ---------------------------------------------------------------------------
// Step 2: Parse completion event
// ---------------------------------------------------------------------------

/**
 * Parse the push notification event received via `step.waitForEvent()`.
 *
 * CF Workflows deliver the event payload as-is. This function normalizes
 * it into a `WaitStepResult`.
 */
export function parseCompletionEvent(
  event: AgentCompletionEvent
): WaitStepResult {
  return {
    taskId: event.taskId,
    status: event.status,
    text: event.text,
    sessionId: event.sessionId,
    errors: event.errors,
  };
}

// ---------------------------------------------------------------------------
// Step 3: Evaluate result
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the agent's output is acceptable.
 *
 * This is a placeholder that returns 'accept' if the task completed
 * successfully. In production, you'd call an LLM (e.g. Claude) to
 * evaluate the output quality and decide whether to accept, revise,
 * or fail.
 *
 * @example
 * ```ts
 * // Custom evaluator that calls Claude:
 * const decision = await step.do('evaluate', async () => {
 *   const evaluation = await claude()
 *     .query(`Evaluate this code review result: ${result.text}`)
 *     .asJSON<EvaluateDecision>();
 *   return evaluation;
 * });
 * ```
 */
export async function evaluateResult(
  input: EvaluateStepInput
): Promise<EvaluateDecision> {
  const { result, attempt, maxRetries, originalPrompt } = input;

  // Task failed — decide whether to retry.
  if (result.status === 'failed') {
    if (attempt < maxRetries - 1) {
      const feedback = result.errors?.join('; ') ?? 'Unknown failure';
      return {
        action: 'revise',
        reason: `Attempt ${attempt + 1} failed: ${feedback}`,
        revisedPrompt: `Previous attempt failed with: ${feedback}\n\nPlease retry the original task:\n${originalPrompt}`,
      };
    }
    return {
      action: 'fail',
      reason: `All ${maxRetries} attempts failed. Last error: ${result.errors?.join('; ') ?? 'unknown'}`,
    };
  }

  // Task canceled — don't retry.
  if (result.status === 'canceled') {
    return {
      action: 'fail',
      reason: 'Task was canceled',
    };
  }

  // Task completed — accept.
  return {
    action: 'accept',
    reason: 'Task completed successfully',
  };
}

// ---------------------------------------------------------------------------
// Push notification webhook handler (for receiving A2A push notifications)
// ---------------------------------------------------------------------------

/**
 * Create an Express/Hono-compatible handler for receiving A2A push
 * notifications and forwarding them to CF Workflows via `sendEvent()`.
 *
 * The CF Workflow's `step.waitForEvent()` listens for events with
 * type `task-{taskId}`.
 *
 * @example
 * ```ts
 * // In a Cloudflare Worker or proxy:
 * app.post('/webhook/agent-completion', async (req, res) => {
 *   const event = req.body;
 *   // Forward to CF Workflow instance:
 *   await workflow.sendEvent({ type: `task-${event.id}`, payload: event });
 *   res.json({ ok: true });
 * });
 * ```
 */
export function createPushNotificationHandler(
  onNotification: (event: AgentCompletionEvent) => Promise<void>
) {
  return async (req: { body: unknown }, res: { json: (data: unknown) => void }) => {
    const raw = req.body as Record<string, unknown>;

    // A2A push notifications carry TaskStatusUpdateEvent.
    const status = raw.status as Record<string, unknown> | undefined;
    const message = status?.message as Record<string, unknown> | undefined;
    const parts = message?.parts as Array<Record<string, unknown>> | undefined;
    const firstPartText = parts?.[0]?.type === 'text' ? String(parts[0].text) : undefined;

    const event: AgentCompletionEvent = {
      taskId: (raw.id as string) ?? '',
      status: ((status?.state as string) ?? 'failed') as AgentCompletionEvent['status'],
      text: firstPartText,
    };

    await onNotification(event);
    res.json({ ok: true });
  };
}
