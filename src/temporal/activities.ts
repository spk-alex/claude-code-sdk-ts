/**
 * Temporal activities that wrap Claude Agent SDK operations.
 *
 * Activities run in normal Node.js context (not the deterministic Temporal
 * workflow sandbox), so they can freely use the Claude SDK, network I/O,
 * filesystem access, etc.
 *
 * These activities are registered with the Temporal worker and called from
 * the workflow via `proxyActivities`.
 */

import { heartbeat, Context } from '@temporalio/activity';
import { claude } from '../fluent.js';
import type {
  AgentQueryInput,
  AgentQueryResult,
  AgentSessionOptions,
} from './types.js';
import { toClaudeCodeOptions, toSerializableMessage } from './types.js';

/**
 * Execute a single Claude agent query.
 *
 * This is the core activity — it spawns a Claude CLI subprocess, streams
 * messages back, and returns a fully serializable result.
 *
 * The activity sends Temporal heartbeats while streaming so that long-running
 * agent sessions are not falsely timed out.
 */
export async function executeAgentQuery(
  input: AgentQueryInput
): Promise<AgentQueryResult> {
  const opts = toClaudeCodeOptions(input.options);

  // Continue an existing session when provided.
  if (input.sessionId) {
    opts.sessionId = input.sessionId;
  }

  const builder = claude();

  // Apply options
  if (opts.model) builder.withModel(opts.model);
  if (opts.permissionMode === 'bypassPermissions') builder.skipPermissions();
  else if (opts.permissionMode === 'acceptEdits') builder.acceptEdits();
  if (opts.cwd) builder.inDirectory(opts.cwd);
  if (opts.timeout) builder.withTimeout(opts.timeout);
  if (opts.sessionId) builder.withSessionId(opts.sessionId);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    builder.allowTools(...opts.allowedTools);
  }
  if (opts.deniedTools && opts.deniedTools.length > 0) {
    builder.denyTools(...opts.deniedTools);
  }
  if (opts.env) builder.withEnv(opts.env);
  if (opts.addDirectories && opts.addDirectories.length > 0) {
    builder.addDirectory(opts.addDirectories);
  }
  if (opts.agents && Object.keys(opts.agents).length > 0) {
    builder.withAgents(opts.agents);
  }

  // Wire Temporal's activity cancellation signal to the Claude CLI subprocess.
  // When the workflow cancels this activity (via CancellationScope), the
  // AbortSignal fires and SubprocessAbortHandler kills the process immediately.
  const cancellationSignal = Context.current().cancellationSignal;
  builder.withSignal(cancellationSignal);

  const parser = builder.query(input.prompt);

  // Stream messages with periodic heartbeats so Temporal knows we're alive
  // throughout long-running agent sessions (not just at the end).
  let messageCount = 0;
  await parser.stream(() => {
    messageCount++;
    if (messageCount % 5 === 0) {
      heartbeat(`streaming-${messageCount}-messages`);
    }
  });

  heartbeat('query-complete');

  // asArray() returns already-collected messages after stream() consumed them.
  const allMessages = await parser.asArray();

  const text = allMessages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => {
      if (m.type !== 'assistant') return [];
      return m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''));
    })
    .join('\n');

  // Extract session ID
  let sessionId: string | null = null;
  for (const msg of allMessages) {
    if ('session_id' in msg && msg.session_id) {
      sessionId = msg.session_id;
      break;
    }
  }

  // Determine success
  const errors: string[] = [];
  for (const msg of allMessages) {
    if (msg.type === 'system' && msg.subtype === 'error') {
      const errorMessage =
        msg.data && typeof msg.data === 'object' && 'message' in msg.data
          ? String(msg.data.message)
          : 'Unknown error';
      errors.push(errorMessage);
    }
  }

  // Extract usage from result message
  let usage: AgentQueryResult['usage'];
  const resultMsg = allMessages.findLast((m) => m.type === 'result');
  if (resultMsg && resultMsg.type === 'result' && resultMsg.usage) {
    const u = resultMsg.usage;
    usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      totalCost: resultMsg.cost?.total_cost ?? 0,
    };
  }

  return {
    text,
    sessionId,
    messages: allMessages.map(toSerializableMessage),
    success: errors.length === 0,
    errors,
    usage,
  };
}

/**
 * Merge two AgentSessionOptions objects (step overrides win).
 *
 * Exposed as an activity so the workflow can call it deterministically
 * through proxyActivities rather than importing non-deterministic code
 * into the workflow sandbox.
 */
export async function mergeAgentOptions(
  base: AgentSessionOptions | undefined,
  overrides: Partial<AgentSessionOptions> | undefined
): Promise<AgentSessionOptions> {
  if (!base && !overrides) return {};
  if (!base) return overrides as AgentSessionOptions;
  if (!overrides) return base;

  return {
    ...base,
    ...overrides,
    env: { ...base.env, ...overrides.env },
    allowedTools: overrides.allowedTools ?? base.allowedTools,
    deniedTools: overrides.deniedTools ?? base.deniedTools,
    context: overrides.context ?? base.context,
    addDirectories: overrides.addDirectories ?? base.addDirectories,
    // Merge agent definitions: step-level agents override workflow-level
    // agents with the same name, new names are added.
    agents: (base.agents || overrides.agents)
      ? { ...base.agents, ...overrides.agents }
      : undefined,
  };
}
