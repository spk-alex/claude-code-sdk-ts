/**
 * Temporal workflow integration for Claude Agent SDK.
 *
 * This module provides a durable, fault-tolerant way to run Claude agent
 * sessions using Temporal workflows. Key components:
 *
 * - **Workflow** (`claudeAgentWorkflow`): A multi-turn agent session that
 *   survives process crashes and can be queried/signalled while running.
 *
 * - **Activities** (`executeAgentQuery`): The actual Claude SDK calls,
 *   running in normal Node.js context with heartbeat support.
 *
 * - **Worker** (`createAgentWorker`): Sets up a Temporal worker to
 *   execute the agent workflows and activities.
 *
 * - **Client** (`startAgentWorkflow`, `executeAgentWorkflow`): Starts
 *   and interacts with agent workflows from application code.
 *
 * @example
 * ```ts
 * // --- Worker process ---
 * import { createAgentWorker } from '@instantlyeasy/claude-code-sdk-ts/temporal';
 *
 * const worker = await createAgentWorker({ taskQueue: 'claude-agent-queue' });
 * await worker.run();
 *
 * // --- Client process ---
 * import { executeAgentWorkflow } from '@instantlyeasy/claude-code-sdk-ts/temporal';
 *
 * const output = await executeAgentWorkflow({
 *   steps: [
 *     { prompt: 'Read src/ and summarize the project' },
 *     { prompt: 'Add unit tests for the main module' },
 *   ],
 *   options: { permissionMode: 'acceptEdits', cwd: '/my/project' },
 * });
 * console.log(output.fullText);
 * ```
 *
 * @module temporal
 */

// Types
export type {
  AgentSessionOptions,
  AgentQueryInput,
  AgentQueryResult,
  SerializableMessage,
  AgentWorkflowStep,
  AgentWorkflowInput,
  AgentWorkflowOutput,
  AgentWorkflowStepResult,
  AgentWorkerOptions,
  AgentClientOptions,
} from './types.js';

export { toClaudeCodeOptions, toSerializableMessage } from './types.js';

// Activities
export { executeAgentQuery, mergeAgentOptions } from './activities.js';

// Workflow
export {
  claudeAgentWorkflow,
  addStepSignal,
  cancelSignal,
  abortAndInsertSignal,
  replaceQueueSignal,
  getProgressQuery,
  isRunningQuery,
} from './workflows.js';

// Worker
export { createAgentWorker, runAgentWorker } from './worker.js';

// Client
export {
  createAgentClient,
  startAgentWorkflow,
  executeAgentWorkflow,
  getAgentWorkflow,
  AgentWorkflowHandle,
} from './client.js';
