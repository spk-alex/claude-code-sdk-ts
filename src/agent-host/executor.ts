/**
 * Coding Agent Executor — implements the A2A `AgentExecutor` interface.
 *
 * Receives A2A tasks, creates/reuses Docker containers per context,
 * runs Claude Code (ACP) sessions inside them, and publishes progress
 * events back through the A2A `ExecutionEventBus`.
 *
 * This is the glue between the A2A protocol and the container + ACP layers.
 */

import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import type {
  Message,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskStatus1,
  TextPart,
  DataPart,
} from '@a2a-js/sdk';

import { ACPSession } from './acp-session.js';
import type { ContainerManager } from './container-manager.js';
import type { AgentHostConfig, ACPProgressEvent } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(text: string): TextPart {
  return { kind: 'text', text };
}

function dataPart(data: Record<string, unknown>): DataPart {
  return { kind: 'data', data };
}

function makeMessage(role: 'agent' | 'user', parts: Array<TextPart | DataPart>): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role,
    parts,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class CodingAgentExecutor implements AgentExecutor {
  private activeSessions = new Map<string, ACPSession>();

  constructor(
    private containerManager: ContainerManager,
    private config: AgentHostConfig = {}
  ) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;

    // Extract prompt from message parts.
    const prompt = this.extractPrompt(userMessage);
    if (!prompt) {
      eventBus.publish(this.statusUpdate(taskId, contextId, 'failed', 'No text prompt found in message'));
      eventBus.finished();
      return;
    }

    // Publish working status.
    eventBus.publish(this.statusUpdate(taskId, contextId, 'working', 'Starting coding session...'));

    try {
      // Get or create container for this context (persists between retries).
      const container = await this.containerManager.getOrCreate(
        contextId,
        this.config.defaultContainer
      );

      // Create ACP session.
      const session = new ACPSession(this.containerManager, this.config.defaultSession);
      this.activeSessions.set(taskId, session);

      // Stream progress events → A2A events.
      let resultText = '';
      let sessionId: string | null = null;

      for await (const event of session.run(container.id, { prompt })) {
        const a2aEvent = this.progressToA2AEvent(taskId, contextId, event);
        if (a2aEvent) {
          eventBus.publish(a2aEvent);
        }

        // Accumulate text for final artifact.
        if (event.type === 'text') {
          resultText += event.content;
        }
        if (event.type === 'complete') {
          try {
            const data = JSON.parse(event.content);
            if (data.sessionId) sessionId = data.sessionId;
          } catch { /* ignore */ }
        }
      }

      // Publish result as artifact.
      if (resultText) {
        const artifact: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: {
            artifactId: `${taskId}-response`,
            name: 'agent-response',
            description: 'Claude Code agent response',
            parts: [textPart(resultText)],
          },
          lastChunk: true,
        };
        eventBus.publish(artifact);
      }

      // Publish completion with session metadata.
      const parts: Array<TextPart | DataPart> = [
        textPart(resultText || 'Session completed.'),
      ];
      if (sessionId) {
        parts.push(dataPart({ sessionId, contextId, containerId: container.id }));
      }
      eventBus.publish(makeMessage('agent', parts));

    } catch (error) {
      eventBus.publish(
        this.statusUpdate(taskId, contextId, 'failed', `Session failed: ${String(error)}`)
      );
    } finally {
      this.activeSessions.delete(taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const session = this.activeSessions.get(taskId);
    if (session) {
      session.abort();
      this.activeSessions.delete(taskId);
    }

    eventBus.publish(this.statusUpdate(taskId, '', 'canceled', 'Task canceled'));
    eventBus.finished();
  }

  // ---- Helpers ----

  private extractPrompt(message: Message): string | null {
    for (const part of message.parts) {
      if (part.kind === 'text') {
        return (part as TextPart).text;
      }
    }
    return null;
  }

  private statusUpdate(
    taskId: string,
    contextId: string,
    state: TaskStatus1['state'],
    text?: string
  ): TaskStatusUpdateEvent {
    const status: TaskStatus1 = {
      state,
      timestamp: new Date().toISOString(),
    };
    if (text) {
      status.message = makeMessage('agent', [textPart(text)]);
    }

    return {
      kind: 'status-update',
      taskId,
      contextId,
      status,
      final: state === 'completed' || state === 'failed' || state === 'canceled',
    };
  }

  private progressToA2AEvent(
    taskId: string,
    contextId: string,
    event: ACPProgressEvent
  ): TaskStatusUpdateEvent | null {
    switch (event.type) {
      case 'text':
        return this.statusUpdate(taskId, contextId, 'working', event.content);
      case 'tool_use':
        return this.statusUpdate(taskId, contextId, 'working', `Using tools: ${event.content}`);
      case 'error':
        return this.statusUpdate(taskId, contextId, 'failed', event.content);
      case 'complete':
        return this.statusUpdate(taskId, contextId, 'completed', 'Session completed');
      default:
        return null;
    }
  }
}
