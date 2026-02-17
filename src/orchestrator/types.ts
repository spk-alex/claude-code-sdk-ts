/**
 * Types for the CF Workflow orchestrator.
 */

// ---------------------------------------------------------------------------
// Workflow configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** URL of the A2A agent host (e.g. `https://agent.example.com`). */
  agentUrl: string;
  /** Auth token for the agent host (optional). */
  agentAuthToken?: string;
  /** Context ID for container reuse across retries. */
  contextId?: string;
  /** Maximum retry attempts before giving up. */
  maxRetries?: number;
  /** Timeout for waiting for agent completion (ms). Default: 600000 (10 min). */
  completionTimeout?: number;
  /** URL for push notification callback. */
  pushNotificationUrl?: string;
}

// ---------------------------------------------------------------------------
// Step types for CF Workflow
// ---------------------------------------------------------------------------

export interface DispatchStepInput {
  prompt: string;
  contextId: string;
  agentUrl: string;
  agentAuthToken?: string;
  pushNotificationUrl?: string;
}

export interface DispatchStepResult {
  taskId: string;
  contextId: string;
  status: 'working' | 'failed';
}

export interface WaitStepResult {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  text?: string;
  sessionId?: string;
  errors?: string[];
}

export interface EvaluateStepInput {
  taskId: string;
  originalPrompt: string;
  result: WaitStepResult;
  attempt: number;
  maxRetries: number;
}

export type EvaluateDecision =
  | { action: 'accept'; reason: string }
  | { action: 'revise'; reason: string; revisedPrompt: string }
  | { action: 'fail'; reason: string };

// ---------------------------------------------------------------------------
// Push notification event (received by CF Workflow via waitForEvent)
// ---------------------------------------------------------------------------

export interface AgentCompletionEvent {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  text?: string;
  sessionId?: string;
  contextId?: string;
  containerId?: string;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Full workflow input/output
// ---------------------------------------------------------------------------

export interface OrchestratorInput {
  prompt: string;
  config: OrchestratorConfig;
}

export interface OrchestratorOutput {
  success: boolean;
  finalText: string;
  attempts: AttemptRecord[];
  contextId: string;
  sessionId?: string;
}

export interface AttemptRecord {
  attempt: number;
  prompt: string;
  taskId: string;
  result: WaitStepResult;
  decision: EvaluateDecision;
}
