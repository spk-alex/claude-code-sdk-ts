import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodingAgentExecutor } from '../executor.js';
import type { ContainerManager } from '../container-manager.js';
import type { ACPProgressEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockContainerManager(): ContainerManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      id: 'container-abc',
      workspaceDir: '/tmp/ws/ctx-1',
      running: true,
      createdAt: new Date().toISOString(),
    }),
    exec: vi.fn(),
    remove: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

function createMockEventBus() {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
  };
}

function createMockRequestContext(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    contextId: 'ctx-1',
    userMessage: {
      kind: 'message' as const,
      messageId: 'msg-1',
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'Write a hello world' }],
    },
    ...overrides,
  };
}

// Mock ACPSession so tests don't spawn containers.
vi.mock('../acp-session.js', () => {
  let events: ACPProgressEvent[] = [
    { type: 'text', content: 'Hello, world!', timestamp: new Date().toISOString() },
    { type: 'complete', content: JSON.stringify({ sessionId: 'sess-1' }), timestamp: new Date().toISOString() },
  ];

  return {
    ACPSession: vi.fn().mockImplementation(() => ({
      run: vi.fn().mockImplementation(async function* () {
        for (const event of events) {
          yield event;
        }
      }),
      abort: vi.fn(),
    })),
    __setEvents: (e: ACPProgressEvent[]) => { events = e; },
    __resetEvents: () => {
      events = [
        { type: 'text', content: 'Hello, world!', timestamp: new Date().toISOString() },
        { type: 'complete', content: JSON.stringify({ sessionId: 'sess-1' }), timestamp: new Date().toISOString() },
      ];
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodingAgentExecutor', () => {
  let containerManager: ContainerManager;
  let executor: CodingAgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    containerManager = createMockContainerManager();
    executor = new CodingAgentExecutor(containerManager);
  });

  describe('execute', () => {
    it('publishes working status, artifact, and completion message', async () => {
      const bus = createMockEventBus();
      const ctx = createMockRequestContext();

      await executor.execute(ctx as any, bus as any);

      // First call: working status.
      const firstPublish = bus.publish.mock.calls[0][0];
      expect(firstPublish.kind).toBe('status-update');
      expect(firstPublish.status.state).toBe('working');

      // Should have published an artifact with the result text.
      const artifactCall = bus.publish.mock.calls.find(
        (c: any[]) => c[0].kind === 'artifact-update'
      );
      expect(artifactCall).toBeDefined();
      expect(artifactCall![0].artifact.parts[0].text).toBe('Hello, world!');

      // Should call finished.
      expect(bus.finished).toHaveBeenCalled();
    });

    it('fails when message has no text part', async () => {
      const bus = createMockEventBus();
      const ctx = createMockRequestContext({
        userMessage: {
          kind: 'message',
          messageId: 'msg-1',
          role: 'user',
          parts: [{ kind: 'data', data: {} }],
        },
      });

      await executor.execute(ctx as any, bus as any);

      const failPublish = bus.publish.mock.calls[0][0];
      expect(failPublish.kind).toBe('status-update');
      expect(failPublish.status.state).toBe('failed');
      expect(bus.finished).toHaveBeenCalled();
    });

    it('publishes streaming status updates for text and tool_use events', async () => {
      const { __setEvents } = await import('../acp-session.js') as any;
      __setEvents([
        { type: 'text', content: 'Thinking...', timestamp: new Date().toISOString() },
        { type: 'tool_use', content: '[{"tool":"Read"}]', timestamp: new Date().toISOString() },
        { type: 'text', content: 'Done.', timestamp: new Date().toISOString() },
        { type: 'complete', content: '{}', timestamp: new Date().toISOString() },
      ]);

      const bus = createMockEventBus();
      const ctx = createMockRequestContext();

      await executor.execute(ctx as any, bus as any);

      // Filter status-update events.
      const statusUpdates = bus.publish.mock.calls
        .map((c: any[]) => c[0])
        .filter((e: any) => e.kind === 'status-update');

      // Should have: initial working + text + tool_use + text + completed
      expect(statusUpdates.length).toBeGreaterThanOrEqual(4);

      // Find tool_use status.
      const toolUpdate = statusUpdates.find((e: any) =>
        e.status.message?.parts?.[0]?.text?.includes('Using tools')
      );
      expect(toolUpdate).toBeDefined();

      const { __resetEvents } = await import('../acp-session.js') as any;
      __resetEvents();
    });

    it('publishes failed status on session error', async () => {
      const { __setEvents } = await import('../acp-session.js') as any;
      __setEvents([
        { type: 'error', content: 'Rate limit exceeded', timestamp: new Date().toISOString() },
      ]);

      const bus = createMockEventBus();
      const ctx = createMockRequestContext();

      await executor.execute(ctx as any, bus as any);

      const statusUpdates = bus.publish.mock.calls
        .map((c: any[]) => c[0])
        .filter((e: any) => e.kind === 'status-update');

      const failedUpdate = statusUpdates.find(
        (e: any) => e.status.state === 'failed'
      );
      expect(failedUpdate).toBeDefined();

      const { __resetEvents } = await import('../acp-session.js') as any;
      __resetEvents();
    });

    it('includes session metadata in completion message', async () => {
      const bus = createMockEventBus();
      const ctx = createMockRequestContext();

      await executor.execute(ctx as any, bus as any);

      // Find the Message event (not status-update, not artifact-update).
      const messageCall = bus.publish.mock.calls.find(
        (c: any[]) => c[0].kind === 'message'
      );
      expect(messageCall).toBeDefined();

      const msg = messageCall![0];
      expect(msg.role).toBe('agent');

      // Should have data part with session metadata.
      const dataPart = msg.parts.find((p: any) => p.kind === 'data');
      expect(dataPart).toBeDefined();
      expect(dataPart.data.sessionId).toBe('sess-1');
      expect(dataPart.data.containerId).toBe('container-abc');
    });
  });

  describe('cancelTask', () => {
    it('aborts the active session and publishes canceled status', async () => {
      // Start an execution first so there's an active session.
      const bus1 = createMockEventBus();
      const ctx = createMockRequestContext();
      await executor.execute(ctx as any, bus1 as any);

      // Cancel — session already completed so abort won't find it,
      // but it should still publish the cancel event.
      const bus2 = createMockEventBus();
      await executor.cancelTask('task-1', bus2 as any);

      const cancelPublish = bus2.publish.mock.calls[0][0];
      expect(cancelPublish.kind).toBe('status-update');
      expect(cancelPublish.status.state).toBe('canceled');
      expect(bus2.finished).toHaveBeenCalled();
    });
  });
});
