/**
 * Types for the Temporal workflow integration with Claude Agent SDK.
 *
 * These types define the inputs, outputs, and configuration for running
 * Claude agent sessions as durable Temporal workflows.
 */

import type { ClaudeCodeOptions, Message, ToolName, PermissionMode } from '../types.js';

// ---------------------------------------------------------------------------
// Activity input / output
// ---------------------------------------------------------------------------

/** Serializable subset of ClaudeCodeOptions that can cross the Temporal wire. */
export interface AgentSessionOptions {
  /** AI model to use (e.g. "sonnet", "opus"). */
  model?: string;
  /** Allowed tool names. */
  allowedTools?: ToolName[];
  /** Denied tool names. */
  deniedTools?: ToolName[];
  /** Permission mode for the agent. */
  permissionMode?: PermissionMode;
  /** Working directory for the agent. */
  cwd?: string;
  /** Environment variables forwarded to the CLI. */
  env?: Record<string, string>;
  /** Timeout per query in milliseconds. */
  timeout?: number;
  /** System prompt override. */
  systemPrompt?: string;
  /** Additional context strings. */
  context?: string[];
  /** Max tokens for the model response. */
  maxTokens?: number;
  /** Temperature for the model. */
  temperature?: number;
}

/** Input for a single Claude agent query activity. */
export interface AgentQueryInput {
  /** The prompt to send to Claude. */
  prompt: string;
  /** Session ID for continuing a previous conversation. */
  sessionId?: string;
  /** Agent session configuration. */
  options?: AgentSessionOptions;
}

/** Serializable representation of a single message from Claude. */
export interface SerializableMessage {
  type: Message['type'];
  content?: unknown;
  subtype?: string;
  session_id?: string;
  data?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost?: {
    input_cost?: number;
    output_cost?: number;
    total_cost?: number;
  };
}

/** Output from a single Claude agent query activity. */
export interface AgentQueryResult {
  /** The text response from Claude. */
  text: string;
  /** The session ID for conversation continuity. */
  sessionId: string | null;
  /** All messages returned by the query. */
  messages: SerializableMessage[];
  /** Whether the query completed without tool errors. */
  success: boolean;
  /** Any error messages encountered. */
  errors: string[];
  /** Token usage statistics. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCost: number;
  };
}

// ---------------------------------------------------------------------------
// Workflow input / output
// ---------------------------------------------------------------------------

/** A single step in a multi-turn agent workflow. */
export interface AgentWorkflowStep {
  /** The prompt for this step. */
  prompt: string;
  /**
   * Optional per-step option overrides.
   * Merged with the workflow-level options (step wins).
   */
  options?: Partial<AgentSessionOptions>;
}

/** Input for the multi-turn agent workflow. */
export interface AgentWorkflowInput {
  /** The initial prompt to send (for simple single-turn usage). */
  prompt?: string;
  /**
   * Ordered list of steps for multi-turn conversations.
   * If provided, `prompt` is ignored and steps are executed sequentially
   * within the same Claude session.
   */
  steps?: AgentWorkflowStep[];
  /** Default options applied to every step. */
  options?: AgentSessionOptions;
  /** Temporal task queue to run on (used by the client, not the workflow). */
  taskQueue?: string;
  /** Workflow ID (used by the client, not the workflow). */
  workflowId?: string;
}

/** Result of a single step within the workflow. */
export interface AgentWorkflowStepResult {
  /** Zero-based index of this step. */
  stepIndex: number;
  /** The prompt that was sent. */
  prompt: string;
  /** The query result. */
  result: AgentQueryResult;
}

/** Final output of the agent workflow. */
export interface AgentWorkflowOutput {
  /** Results from each step, in order. */
  stepResults: AgentWorkflowStepResult[];
  /** The session ID shared across all steps. */
  sessionId: string | null;
  /** Whether all steps completed successfully. */
  success: boolean;
  /** Aggregated text from all steps. */
  fullText: string;
}

// ---------------------------------------------------------------------------
// Worker configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a Temporal worker that runs agent activities. */
export interface AgentWorkerOptions {
  /** Temporal server address (default: localhost:7233). */
  temporalAddress?: string;
  /** Temporal namespace (default: "default"). */
  namespace?: string;
  /** Task queue name (default: "claude-agent-queue"). */
  taskQueue?: string;
  /** Default agent session options applied to all activities. */
  defaultAgentOptions?: AgentSessionOptions;
}

/** Configuration for the Temporal client used to start workflows. */
export interface AgentClientOptions {
  /** Temporal server address (default: localhost:7233). */
  temporalAddress?: string;
  /** Temporal namespace (default: "default"). */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert AgentSessionOptions to ClaudeCodeOptions. */
export function toClaudeCodeOptions(opts?: AgentSessionOptions): ClaudeCodeOptions {
  if (!opts) return {};
  return {
    model: opts.model,
    allowedTools: opts.allowedTools,
    deniedTools: opts.deniedTools,
    permissionMode: opts.permissionMode,
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout,
    systemPrompt: opts.systemPrompt,
    context: opts.context,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  };
}

/** Convert a Message to a serializable form (strips non-serializable parts). */
export function toSerializableMessage(msg: Message): SerializableMessage {
  const base: SerializableMessage = { type: msg.type };

  if ('content' in msg) {
    base.content = msg.content;
  }
  if ('subtype' in msg && msg.subtype) {
    base.subtype = msg.subtype;
  }
  if ('session_id' in msg && msg.session_id) {
    base.session_id = msg.session_id;
  }
  if ('data' in msg && msg.data !== undefined) {
    base.data = msg.data;
  }
  if ('usage' in msg && msg.usage) {
    base.usage = msg.usage;
  }
  if ('cost' in msg && msg.cost) {
    base.cost = msg.cost;
  }

  return base;
}
