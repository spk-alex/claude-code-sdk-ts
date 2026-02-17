import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACPSession } from '../acp-session.js';
import type { ContainerManager } from '../container-manager.js';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContainerManager(
  stdoutContent: string
): ContainerManager {
  const readable = new Readable({
    read() {
      this.push(stdoutContent);
      this.push(null);
    },
  });

  return {
    getOrCreate: vi.fn(),
    exec: vi.fn().mockReturnValue({ stdout: readable }),
    remove: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACPSession', () => {
  describe('run', () => {
    it('parses assistant text messages', async () => {
      const content = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello from Claude' }],
      }) + '\n';

      const cm = createMockContainerManager(content);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text');
      expect(events[0].content).toBe('Hello from Claude');
    });

    it('parses tool_use messages', async () => {
      const content = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { path: '/foo' } }],
      }) + '\n';

      const cm = createMockContainerManager(content);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_use');
      const parsed = JSON.parse(events[0].content);
      expect(parsed[0].tool).toBe('Read');
    });

    it('parses result messages as complete events', async () => {
      const content = JSON.stringify({
        type: 'result',
        session_id: 'sess-42',
        usage: { input_tokens: 100, output_tokens: 50 },
        cost: { total_cost: 0.002 },
      }) + '\n';

      const cm = createMockContainerManager(content);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('complete');

      const data = JSON.parse(events[0].content);
      expect(data.sessionId).toBe('sess-42');
      expect(data.usage.inputTokens).toBe(100);
      expect(data.usage.outputTokens).toBe(50);
      expect(data.usage.totalCost).toBe(0.002);
    });

    it('parses system error messages', async () => {
      const content = JSON.stringify({
        type: 'system',
        subtype: 'error',
        data: { message: 'Rate limit exceeded' },
      }) + '\n';

      const cm = createMockContainerManager(content);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].content).toBe('Rate limit exceeded');
    });

    it('handles multiple messages in single stream', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Starting...' }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Done!' }],
        }),
        JSON.stringify({ type: 'result', session_id: 'sess-1' }),
      ].join('\n') + '\n';

      const cm = createMockContainerManager(lines);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(4);
      expect(events.map(e => e.type)).toEqual(['text', 'tool_use', 'text', 'complete']);
    });

    it('skips invalid JSON lines', async () => {
      const content = 'not json\n' +
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Valid' }] }) +
        '\n';

      const cm = createMockContainerManager(content);
      const session = new ACPSession(cm);

      const events = [];
      for await (const event of session.run('cid', { prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('Valid');
    });

    it('builds correct claude command with all options', async () => {
      const cm = createMockContainerManager('');
      const session = new ACPSession(cm);

      // Exhaust the generator.
      for await (const _ of session.run('cid', {
        prompt: 'test prompt',
        model: 'opus',
        sessionId: 'existing-session',
        permissionMode: 'bypassPermissions',
        allowedTools: ['Read', 'Write'],
        deniedTools: ['Bash'],
        systemPrompt: 'You are a helper',
        maxTurns: 5,
      })) {
        // consume
      }

      expect(cm.exec).toHaveBeenCalledWith(
        'cid',
        expect.arrayContaining([
          'claude', '--print', '--output-format', 'stream-json',
          '--model', 'opus',
          '--resume', 'existing-session',
          '--dangerously-skip-permissions',
          '--allowedTools', 'Read', 'Write',
          '--disallowedTools', 'Bash',
          '--system-prompt', 'You are a helper',
          '--max-turns', '5',
          '-p', 'test prompt',
        ]),
        expect.any(Object),
      );
    });
  });

  describe('runToCompletion', () => {
    it('collects all events into a result', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        }),
        JSON.stringify({
          type: 'result',
          session_id: 'sess-99',
          usage: { input_tokens: 10, output_tokens: 20 },
          cost: { total_cost: 0.001 },
        }),
      ].join('\n') + '\n';

      const cm = createMockContainerManager(lines);
      const session = new ACPSession(cm);

      const result = await session.runToCompletion('cid', { prompt: 'test' });

      expect(result.text).toBe('Hello');
      expect(result.sessionId).toBe('sess-99');
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.usage?.inputTokens).toBe(10);
    });

    it('captures errors', async () => {
      const lines = [
        JSON.stringify({
          type: 'system',
          subtype: 'error',
          data: { message: 'Something broke' },
        }),
        JSON.stringify({ type: 'result' }),
      ].join('\n') + '\n';

      const cm = createMockContainerManager(lines);
      const session = new ACPSession(cm);

      const result = await session.runToCompletion('cid', { prompt: 'test' });

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Something broke');
    });
  });

  describe('abort', () => {
    it('signals abort via internal controller', async () => {
      // Create a slow stream that we can abort.
      const readable = new Readable({
        read() {
          // Don't push anything — simulate a long-running process.
        },
      });

      const cm: ContainerManager = {
        getOrCreate: vi.fn(),
        exec: vi.fn().mockReturnValue({ stdout: readable }),
        remove: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      };

      const session = new ACPSession(cm);

      // Start the generator but don't consume it fully.
      const gen = session.run('cid', { prompt: 'test' });

      // Abort after a short delay.
      setTimeout(() => {
        session.abort();
        readable.push(null); // End the stream so the for-await exits.
      }, 10);

      const events = [];
      for await (const event of gen) {
        events.push(event);
      }

      // Should have no events since we aborted before any data.
      expect(events).toHaveLength(0);
    });
  });
});
