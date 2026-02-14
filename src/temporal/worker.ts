/**
 * Temporal worker setup for running Claude agent workflow activities.
 *
 * The worker connects to the Temporal server, registers the workflow and
 * activity implementations, and starts polling the task queue.
 *
 * @example
 * ```ts
 * import { createAgentWorker } from '@instantlyeasy/claude-code-sdk-ts/temporal';
 *
 * const worker = await createAgentWorker({
 *   taskQueue: 'claude-agent-queue',
 *   temporalAddress: 'localhost:7233',
 * });
 * await worker.run(); // blocks until shutdown
 * ```
 */

import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities.js';
import type { AgentWorkerOptions } from './types.js';

const DEFAULT_TASK_QUEUE = 'claude-agent-queue';
const DEFAULT_ADDRESS = 'localhost:7233';
const DEFAULT_NAMESPACE = 'default';

/**
 * Create a Temporal Worker pre-configured to run Claude agent workflows.
 *
 * The returned Worker is ready to call `.run()`, which blocks until the
 * worker is shut down (e.g. via SIGINT).
 */
export async function createAgentWorker(
  options?: AgentWorkerOptions
): Promise<Worker> {
  const address = options?.temporalAddress ?? DEFAULT_ADDRESS;
  const namespace = options?.namespace ?? DEFAULT_NAMESPACE;
  const taskQueue = options?.taskQueue ?? DEFAULT_TASK_QUEUE;

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // Workflows are loaded from the compiled workflows module.
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    // Activities are passed directly — they run in the worker's Node.js context.
    activities,
  });

  return worker;
}

/**
 * Convenience: create and immediately run a worker (blocks until shutdown).
 */
export async function runAgentWorker(
  options?: AgentWorkerOptions
): Promise<void> {
  const worker = await createAgentWorker(options);
  await worker.run();
}
