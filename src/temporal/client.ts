/**
 * Temporal client helpers for starting and interacting with Claude agent workflows.
 *
 * @example
 * ```ts
 * import { startAgentWorkflow, executeAgentWorkflow } from '@instantlyeasy/claude-code-sdk-ts/temporal';
 *
 * // Fire-and-forget (returns a handle for later interaction)
 * const handle = await startAgentWorkflow({
 *   prompt: 'Analyze this project structure',
 *   options: { cwd: '/my/project', permissionMode: 'bypassPermissions' },
 * });
 * console.log('Workflow started:', handle.workflowId);
 *
 * // Or execute and wait for the result
 * const result = await executeAgentWorkflow({
 *   prompt: 'Explain async/await in TypeScript',
 * });
 * console.log(result.fullText);
 * ```
 */

import { Client, Connection } from '@temporalio/client';
import type { WorkflowHandle } from '@temporalio/client';
import type {
  AgentClientOptions,
  AgentWorkflowInput,
  AgentWorkflowOutput,
  AgentWorkflowStepResult,
  AgentSessionOptions,
} from './types.js';
import {
  claudeAgentWorkflow,
  addStepSignal,
  cancelSignal,
  abortAndInsertSignal,
  replaceQueueSignal,
  getProgressQuery,
  isRunningQuery,
} from './workflows.js';

const DEFAULT_TASK_QUEUE = 'claude-agent-queue';
const DEFAULT_ADDRESS = 'localhost:7233';
const DEFAULT_NAMESPACE = 'default';

/**
 * Create a Temporal Client connected to the server.
 */
export async function createAgentClient(
  options?: AgentClientOptions
): Promise<Client> {
  const address = options?.temporalAddress ?? DEFAULT_ADDRESS;
  const namespace = options?.namespace ?? DEFAULT_NAMESPACE;

  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}

/**
 * Start a Claude agent workflow (fire-and-forget).
 *
 * Returns a workflow handle that can be used to query progress, send
 * signals, or await the final result.
 */
export async function startAgentWorkflow(
  input: AgentWorkflowInput,
  clientOptions?: AgentClientOptions
): Promise<AgentWorkflowHandle> {
  const client = await createAgentClient(clientOptions);
  const taskQueue = input.taskQueue ?? DEFAULT_TASK_QUEUE;
  const workflowId =
    input.workflowId ?? `claude-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const handle = await client.workflow.start(claudeAgentWorkflow, {
    workflowId,
    taskQueue,
    args: [input],
  });

  return new AgentWorkflowHandle(handle);
}

/**
 * Execute a Claude agent workflow and wait for the result.
 *
 * This is the simplest way to run an agent session — it blocks until
 * the workflow completes and returns the output.
 */
export async function executeAgentWorkflow(
  input: AgentWorkflowInput,
  clientOptions?: AgentClientOptions
): Promise<AgentWorkflowOutput> {
  const handle = await startAgentWorkflow(input, clientOptions);
  return handle.result();
}

/**
 * Get a handle to an existing running workflow by ID.
 */
export async function getAgentWorkflow(
  workflowId: string,
  clientOptions?: AgentClientOptions
): Promise<AgentWorkflowHandle> {
  const client = await createAgentClient(clientOptions);
  const handle = client.workflow.getHandle(workflowId);
  return new AgentWorkflowHandle(handle);
}

// ---------------------------------------------------------------------------
// Workflow handle wrapper with agent-specific helpers
// ---------------------------------------------------------------------------

/**
 * A typed wrapper around the raw Temporal workflow handle that exposes
 * agent-specific operations.
 */
export class AgentWorkflowHandle {
  constructor(
    private readonly handle: WorkflowHandle<typeof claudeAgentWorkflow>
  ) {}

  /** The Temporal workflow ID. */
  get workflowId(): string {
    return this.handle.workflowId;
  }

  /** Wait for the workflow to complete and return the output. */
  async result(): Promise<AgentWorkflowOutput> {
    return this.handle.result();
  }

  /** Query the current list of completed step results. */
  async getProgress(): Promise<AgentWorkflowStepResult[]> {
    return this.handle.query(getProgressQuery);
  }

  /** Query whether the workflow is still executing steps. */
  async isRunning(): Promise<boolean> {
    return this.handle.query(isRunningQuery);
  }

  /**
   * Add a new step to the running workflow.
   *
   * The step will be appended to the queue and executed after the
   * current step completes.
   */
  async addStep(
    prompt: string,
    options?: Partial<AgentSessionOptions>
  ): Promise<void> {
    await this.handle.signal(addStepSignal, { prompt, options });
  }

  /** Request the workflow to cancel gracefully (aborts the current step). */
  async cancel(): Promise<void> {
    await this.handle.signal(cancelSignal);
  }

  /**
   * Abort the currently running step and insert a new step at the front
   * of the queue. The aborted step is recorded with `success: false` and
   * the new step begins immediately.
   */
  async abortAndInsert(
    prompt: string,
    options?: Partial<AgentSessionOptions>
  ): Promise<void> {
    await this.handle.signal(abortAndInsertSignal, { prompt, options });
  }

  /**
   * Abort the currently running step and replace the entire pending queue.
   * All previously queued steps are discarded and the provided steps
   * become the new execution plan.
   */
  async replaceQueue(
    steps: Array<{ prompt: string; options?: Partial<AgentSessionOptions> }>
  ): Promise<void> {
    await this.handle.signal(replaceQueueSignal, { steps });
  }

  /** Terminate the workflow immediately (last resort). */
  async terminate(reason?: string): Promise<void> {
    await this.handle.terminate(reason);
  }

  /** Get the underlying Temporal workflow handle for advanced usage. */
  get raw(): WorkflowHandle<typeof claudeAgentWorkflow> {
    return this.handle;
  }
}
