import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchTask,
  parseCompletionEvent,
  evaluateResult,
  createPushNotificationHandler,
} from '../workflow.js';
import type {
  DispatchStepInput,
  WaitStepResult,
  EvaluateStepInput,
  AgentCompletionEvent,
} from '../types.js';

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

describe('dispatchTask', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends a properly formed A2A message/send request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { id: 'task-abc', status: { state: 'working' } },
      }),
    });
    globalThis.fetch = mockFetch as any;

    const input: DispatchStepInput = {
      prompt: 'Fix the tests',
      contextId: 'ctx-1',
      agentUrl: 'https://agent.example.com',
      pushNotificationUrl: 'https://webhook.example.com/notify',
    };

    const result = await dispatchTask(input);

    expect(result.taskId).toBe('task-abc');
    expect(result.contextId).toBe('ctx-1');
    expect(result.status).toBe('working');

    // Verify the fetch call.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://agent.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );

    // Verify the body.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('message/send');
    expect(body.params.message.parts[0].text).toBe('Fix the tests');
    expect(body.params.configuration.contextId).toBe('ctx-1');
    expect(body.params.configuration.pushNotification.url).toBe(
      'https://webhook.example.com/notify'
    );
  });

  it('includes Authorization header when token provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { id: 'task-1', status: { state: 'working' } },
      }),
    });
    globalThis.fetch = mockFetch as any;

    await dispatchTask({
      prompt: 'test',
      contextId: 'ctx-1',
      agentUrl: 'https://agent.example.com',
      agentAuthToken: 'secret-token',
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer secret-token');
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }) as any;

    await expect(dispatchTask({
      prompt: 'test',
      contextId: 'ctx-1',
      agentUrl: 'https://agent.example.com',
    })).rejects.toThrow('A2A dispatch failed: 500');
  });

  it('throws on JSON-RPC error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        error: { message: 'Task rejected' },
      }),
    }) as any;

    await expect(dispatchTask({
      prompt: 'test',
      contextId: 'ctx-1',
      agentUrl: 'https://agent.example.com',
    })).rejects.toThrow('A2A error: Task rejected');
  });

  it('falls back to contextId when task ID not in response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: {} }),
    }) as any;

    const result = await dispatchTask({
      prompt: 'test',
      contextId: 'ctx-fallback',
      agentUrl: 'https://agent.example.com',
    });

    expect(result.taskId).toBe('ctx-fallback');
  });

  it('returns failed status when task status is failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { id: 'task-1', status: { state: 'failed' } },
      }),
    }) as any;

    const result = await dispatchTask({
      prompt: 'test',
      contextId: 'ctx-1',
      agentUrl: 'https://agent.example.com',
    });

    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// parseCompletionEvent
// ---------------------------------------------------------------------------

describe('parseCompletionEvent', () => {
  it('normalizes completion event to WaitStepResult', () => {
    const event: AgentCompletionEvent = {
      taskId: 'task-1',
      status: 'completed',
      text: 'All tests pass',
      sessionId: 'sess-1',
    };

    const result = parseCompletionEvent(event);

    expect(result.taskId).toBe('task-1');
    expect(result.status).toBe('completed');
    expect(result.text).toBe('All tests pass');
    expect(result.sessionId).toBe('sess-1');
  });

  it('handles failed events with errors', () => {
    const event: AgentCompletionEvent = {
      taskId: 'task-2',
      status: 'failed',
      errors: ['OOM', 'Container killed'],
    };

    const result = parseCompletionEvent(event);

    expect(result.status).toBe('failed');
    expect(result.errors).toEqual(['OOM', 'Container killed']);
  });
});

// ---------------------------------------------------------------------------
// evaluateResult
// ---------------------------------------------------------------------------

describe('evaluateResult', () => {
  it('accepts completed tasks', async () => {
    const result: WaitStepResult = {
      taskId: 'task-1',
      status: 'completed',
      text: 'Done',
    };

    const decision = await evaluateResult({
      taskId: 'task-1',
      originalPrompt: 'Fix the bug',
      result,
      attempt: 0,
      maxRetries: 3,
    });

    expect(decision.action).toBe('accept');
  });

  it('revises failed tasks when retries remain', async () => {
    const result: WaitStepResult = {
      taskId: 'task-1',
      status: 'failed',
      errors: ['Test suite failed'],
    };

    const decision = await evaluateResult({
      taskId: 'task-1',
      originalPrompt: 'Fix the bug',
      result,
      attempt: 0,
      maxRetries: 3,
    });

    expect(decision.action).toBe('revise');
    if (decision.action === 'revise') {
      expect(decision.revisedPrompt).toContain('Test suite failed');
      expect(decision.revisedPrompt).toContain('Fix the bug');
    }
  });

  it('fails when all retries exhausted', async () => {
    const result: WaitStepResult = {
      taskId: 'task-1',
      status: 'failed',
      errors: ['Persistent failure'],
    };

    const decision = await evaluateResult({
      taskId: 'task-1',
      originalPrompt: 'Fix the bug',
      result,
      attempt: 2,
      maxRetries: 3,
    });

    expect(decision.action).toBe('fail');
    expect(decision.reason).toContain('All 3 attempts failed');
  });

  it('fails immediately on canceled tasks', async () => {
    const result: WaitStepResult = {
      taskId: 'task-1',
      status: 'canceled',
    };

    const decision = await evaluateResult({
      taskId: 'task-1',
      originalPrompt: 'Fix the bug',
      result,
      attempt: 0,
      maxRetries: 3,
    });

    expect(decision.action).toBe('fail');
    expect(decision.reason).toContain('canceled');
  });
});

// ---------------------------------------------------------------------------
// createPushNotificationHandler
// ---------------------------------------------------------------------------

describe('createPushNotificationHandler', () => {
  it('parses push notification and calls onNotification', async () => {
    const onNotification = vi.fn().mockResolvedValue(undefined);
    const handler = createPushNotificationHandler(onNotification);

    const req = {
      body: {
        id: 'task-abc',
        status: {
          state: 'completed',
          message: {
            parts: [{ type: 'text', text: 'Task output' }],
          },
        },
      },
    };
    const res = { json: vi.fn() };

    await handler(req, res);

    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-abc',
        status: 'completed',
        text: 'Task output',
      })
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('handles notifications without message text', async () => {
    const onNotification = vi.fn().mockResolvedValue(undefined);
    const handler = createPushNotificationHandler(onNotification);

    const req = {
      body: {
        id: 'task-xyz',
        status: { state: 'failed' },
      },
    };
    const res = { json: vi.fn() };

    await handler(req, res);

    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-xyz',
        status: 'failed',
        text: undefined,
      })
    );
  });
});
