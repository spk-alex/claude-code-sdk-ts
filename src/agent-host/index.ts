/**
 * Agent Host — A2A-compatible service that manages Docker containers
 * and runs Claude Code coding sessions.
 *
 * @module agent-host
 */

// Types
export type {
  ContainerConfig,
  ContainerInfo,
  ACPSessionConfig,
  ACPSessionResult,
  ACPProgressEvent,
  ManagedTaskState,
  ManagedTask,
  AgentHostConfig,
} from './types.js';

// Container Manager
export { DockerContainerManager } from './container-manager.js';
export type { ContainerManager } from './container-manager.js';

// ACP Session
export { ACPSession } from './acp-session.js';

// Executor
export { CodingAgentExecutor } from './executor.js';

// Server
export { createAgentHost } from './server.js';
export type { AgentHostResult } from './server.js';
