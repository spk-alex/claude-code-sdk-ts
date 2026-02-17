/**
 * Agent Host Server — Express-based A2A server that orchestrates
 * Docker containers and Claude Code sessions.
 *
 * Uses `@a2a-js/sdk/server/express` for protocol handling and
 * wires in the CodingAgentExecutor for the actual agent logic.
 *
 * @example
 * ```ts
 * import { createAgentHost } from '@instantlyeasy/claude-code-sdk-ts/agent-host';
 *
 * const { app, cleanup } = await createAgentHost({
 *   agentName: 'coding-agent',
 *   agentUrl: 'https://agent.example.com',
 *   workspacesDir: '/data/workspaces',
 * });
 *
 * app.listen(3000, () => console.log('Agent host listening on :3000'));
 *
 * // On shutdown:
 * process.on('SIGTERM', cleanup);
 * ```
 */

import express from 'express';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  InMemoryPushNotificationStore,
  DefaultPushNotificationSender,
} from '@a2a-js/sdk/server';
import {
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';

import { DockerContainerManager } from './container-manager.js';
import type { ContainerManager } from './container-manager.js';
import { CodingAgentExecutor } from './executor.js';
import type { AgentHostConfig } from './types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentHostResult {
  /** The Express app — call `app.listen()` to start serving. */
  app: express.Express;
  /** The underlying container manager for advanced operations. */
  containerManager: ContainerManager;
  /** The A2A request handler for advanced operations. */
  requestHandler: DefaultRequestHandler;
  /** Cleanup function — removes containers on shutdown. */
  cleanup: () => Promise<void>;
}

/**
 * Create an Agent Host server ready to receive A2A tasks.
 */
export async function createAgentHost(
  config: AgentHostConfig = {}
): Promise<AgentHostResult> {
  const {
    workspacesDir = '/tmp/agent-workspaces',
    agentName = 'coding-agent',
    agentDescription = 'A coding agent powered by Claude Code',
    agentUrl = 'http://localhost:3000',
  } = config;

  // --- Infrastructure ---

  const containerManager = new DockerContainerManager(
    workspacesDir,
    config.defaultContainer
  );

  const executor = new CodingAgentExecutor(containerManager, config);

  // --- A2A SDK wiring ---

  const agentCard: AgentCard = {
    name: agentName,
    description: agentDescription,
    url: agentUrl,
    protocolVersion: '0.3',
    provider: { organization: agentName, url: agentUrl },
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'code',
        name: 'Code Generation & Editing',
        description: 'Write, edit, and refactor code across any language',
        tags: ['coding', 'development'],
      },
      {
        id: 'debug',
        name: 'Debugging & Testing',
        description: 'Debug issues and write/run tests',
        tags: ['debugging', 'testing'],
      },
      {
        id: 'review',
        name: 'Code Review',
        description: 'Review code for quality, security, and best practices',
        tags: ['review', 'security'],
      },
    ],
  };

  const taskStore = new InMemoryTaskStore();
  const pushStore = new InMemoryPushNotificationStore();
  const pushSender = new DefaultPushNotificationSender(pushStore);

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
    undefined, // eventBusManager — use default
    pushStore,
    pushSender
  );

  // --- Express app ---

  const app = express();
  app.use(express.json());

  // A2A agent card.
  app.get(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: requestHandler })
  );

  // A2A JSON-RPC endpoint.
  app.post(
    '/',
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    })
  );

  // Health check.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      containers: containerManager.list().length,
    });
  });

  // --- Cleanup ---

  const cleanup = async () => {
    for (const container of containerManager.list()) {
      await containerManager.remove(container.id);
    }
  };

  return { app, containerManager, requestHandler, cleanup };
}
