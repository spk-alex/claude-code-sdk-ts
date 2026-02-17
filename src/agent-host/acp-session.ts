/**
 * ACP Session — runs a Claude Code coding agent inside a Docker container
 * and streams progress events.
 *
 * The session spawns `claude --print --output-format stream-json` inside the
 * container via `docker exec`, parses the newline-delimited JSON messages,
 * and yields structured progress events.
 */

import type { ContainerManager } from './container-manager.js';
import type { ACPSessionConfig, ACPSessionResult, ACPProgressEvent } from './types.js';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class ACPSession {
  private abortController: AbortController | null = null;

  constructor(
    private containerManager: ContainerManager,
    private defaults: Partial<ACPSessionConfig> = {}
  ) {}

  /**
   * Run a coding agent session inside the given container.
   * Yields progress events as the agent works.
   */
  async *run(
    containerId: string,
    config: ACPSessionConfig
  ): AsyncGenerator<ACPProgressEvent> {
    const merged = { ...this.defaults, ...config };

    // Build the claude command.
    const command = [
      'claude',
      '--print',
      '--output-format', 'stream-json',
    ];

    if (merged.model) {
      command.push('--model', merged.model);
    }
    if (merged.sessionId) {
      command.push('--resume', merged.sessionId);
    }
    if (merged.permissionMode === 'bypassPermissions') {
      command.push('--dangerously-skip-permissions');
    } else if (merged.permissionMode === 'acceptEdits') {
      command.push('--allowedTools', 'Edit', 'Write', 'NotebookEdit');
    }
    if (merged.allowedTools && merged.allowedTools.length > 0) {
      command.push('--allowedTools', ...merged.allowedTools);
    }
    if (merged.deniedTools && merged.deniedTools.length > 0) {
      command.push('--disallowedTools', ...merged.deniedTools);
    }
    if (merged.systemPrompt) {
      command.push('--system-prompt', merged.systemPrompt);
    }
    if (merged.maxTurns) {
      command.push('--max-turns', String(merged.maxTurns));
    }

    // Prompt goes last via -p.
    command.push('-p', merged.prompt);

    // Environment variables for the container exec.
    const env: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    // Spawn the process inside the container.
    this.abortController = new AbortController();
    const child = this.containerManager.exec(containerId, command, env);

    if (!child.stdout) {
      throw new Error('Failed to get stdout from container exec');
    }

    let buffer = '';

    try {
      for await (const chunk of child.stdout) {
        if (this.abortController?.signal.aborted) break;

        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const event = this.parseLine(trimmed);
          if (event) yield event;
        }
      }

      // Process remaining buffer.
      if (buffer.trim()) {
        const event = this.parseLine(buffer.trim());
        if (event) yield event;
      }
    } finally {
      this.abortController = null;
    }
  }

  /** Abort the currently running session. */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Run and collect the full result (non-streaming).
   */
  async runToCompletion(
    containerId: string,
    config: ACPSessionConfig
  ): Promise<ACPSessionResult> {
    let text = '';
    let sessionId: string | null = null;
    const errors: string[] = [];
    let usage: ACPSessionResult['usage'];

    for await (const event of this.run(containerId, config)) {
      switch (event.type) {
        case 'text':
          text += event.content;
          break;
        case 'error':
          errors.push(event.content);
          break;
        case 'complete':
          // Parse completion data if present.
          try {
            const data = JSON.parse(event.content);
            if (data.sessionId) sessionId = data.sessionId;
            if (data.usage) usage = data.usage;
          } catch {
            // Not JSON, that's fine.
          }
          break;
      }
    }

    return {
      text,
      sessionId,
      success: errors.length === 0,
      errors,
      usage,
    };
  }

  // ---- Internal ----

  private parseLine(line: string): ACPProgressEvent | null {
    try {
      const msg = JSON.parse(line);
      const now = new Date().toISOString();

      if (msg.type === 'assistant') {
        // Extract text blocks.
        const textParts = (msg.content ?? [])
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text);

        if (textParts.length > 0) {
          return { type: 'text', content: textParts.join(''), timestamp: now };
        }

        // Check for tool use.
        const toolUses = (msg.content ?? [])
          .filter((b: { type: string }) => b.type === 'tool_use');

        if (toolUses.length > 0) {
          return {
            type: 'tool_use',
            content: JSON.stringify(toolUses.map((t: { name: string; input: unknown }) => ({
              tool: t.name,
              input: t.input,
            }))),
            timestamp: now,
          };
        }
      }

      if (msg.type === 'result') {
        const completionData: Record<string, unknown> = {};
        if (msg.session_id) completionData.sessionId = msg.session_id;
        if (msg.usage) {
          completionData.usage = {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            totalTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
            totalCost: msg.cost?.total_cost ?? 0,
          };
        }
        return { type: 'complete', content: JSON.stringify(completionData), timestamp: now };
      }

      if (msg.type === 'system' && msg.subtype === 'error') {
        const errorMsg =
          msg.data && typeof msg.data === 'object' && 'message' in msg.data
            ? String(msg.data.message)
            : 'Unknown error';
        return { type: 'error', content: errorMsg, timestamp: now };
      }

      return null;
    } catch {
      // Not valid JSON — skip.
      return null;
    }
  }
}
