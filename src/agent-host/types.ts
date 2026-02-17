/**
 * Types for the Agent Host — the VM-based service that receives A2A tasks,
 * manages Docker containers, and runs ACP (coding agent) sessions.
 */

import type { PushNotificationConfig } from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  /** Base Docker image (default: `node:20`). */
  image?: string;
  /** Host directory to mount as /workspace in the container. */
  workspaceDir?: string;
  /** Whether to create a fresh workspace directory if it doesn't exist. */
  createWorkspace?: boolean;
  /** Environment variables injected into the container. */
  env?: Record<string, string>;
  /** Ports to expose (host:container). */
  ports?: Array<{ host: number; container: number }>;
  /** Memory limit (e.g. `2g`). */
  memoryLimit?: string;
  /** CPU limit (e.g. `2.0`). */
  cpuLimit?: string;
  /** Extra packages to install in the container. */
  packages?: string[];
}

export interface ContainerInfo {
  /** Dagger or Docker container ID. */
  id: string;
  /** Host path to the workspace volume. */
  workspaceDir: string;
  /** Whether the container is currently running. */
  running: boolean;
  /** Timestamp when the container was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ACP Session
// ---------------------------------------------------------------------------

export interface ACPSessionConfig {
  /** The prompt/task for the coding agent. */
  prompt: string;
  /** Claude model to use (default: `sonnet`). */
  model?: string;
  /** Permission mode (default: `bypassPermissions` for automated use). */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'default';
  /** Timeout per query in ms (default: 600000 = 10 min). */
  timeout?: number;
  /** Resume from existing session ID. */
  sessionId?: string;
  /** Allowed tools. */
  allowedTools?: string[];
  /** Denied tools. */
  deniedTools?: string[];
  /** System prompt override. */
  systemPrompt?: string;
  /** Max turns for the agent. */
  maxTurns?: number;
}

export interface ACPSessionResult {
  /** Text output from the agent. */
  text: string;
  /** Session ID for continuation. */
  sessionId: string | null;
  /** Whether the session completed successfully. */
  success: boolean;
  /** Error messages if any. */
  errors: string[];
  /** Token usage. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCost: number;
  };
  /** Files modified during the session. */
  modifiedFiles?: string[];
}

/** Streaming progress callback from ACP session. */
export interface ACPProgressEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'complete';
  content: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Task Store
// ---------------------------------------------------------------------------

export type ManagedTaskState = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

export interface ManagedTask {
  /** A2A task ID. */
  id: string;
  /** Context ID — groups tasks that share a container. */
  contextId: string;
  /** Container ID for this task. */
  containerId: string | null;
  /** Current state. */
  state: ManagedTaskState;
  /** The original prompt. */
  prompt: string;
  /** ACP session ID (for multi-turn within same container). */
  sessionId: string | null;
  /** Push notification config from orchestrator. */
  pushNotification: PushNotificationConfig | null;
  /** Task result (set on completion). */
  result: ACPSessionResult | null;
  /** Timestamps. */
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent Host
// ---------------------------------------------------------------------------

export interface AgentHostConfig {
  /** Port to listen on (default: 3000). */
  port?: number;
  /** Host to bind to (default: `0.0.0.0`). */
  host?: string;
  /** Base directory for workspace volumes (default: `/tmp/agent-workspaces`). */
  workspacesDir?: string;
  /** Default container config for new tasks. */
  defaultContainer?: ContainerConfig;
  /** Default ACP session config. */
  defaultSession?: Partial<ACPSessionConfig>;
  /** Agent card metadata. */
  agentName?: string;
  agentDescription?: string;
  agentUrl?: string;
  /** SQLite database path (default: in-memory). */
  dbPath?: string;
}
