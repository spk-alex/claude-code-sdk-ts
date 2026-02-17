/**
 * Container Manager — creates and manages Docker containers for coding agent sessions.
 *
 * Containers persist between retry cycles so the orchestrator can send
 * follow-up tasks to the same filesystem state (e.g. "fix the test failures").
 * Containers are keyed by `contextId` for reuse.
 */

import { execa, type ExecaChildProcess } from 'execa';
import type { ContainerConfig, ContainerInfo } from './types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ContainerManager {
  /** Create or retrieve an existing container for the given context. */
  getOrCreate(contextId: string, config?: ContainerConfig): Promise<ContainerInfo>;

  /**
   * Execute a command inside a running container.
   * Returns an execa child process for streaming stdout/stderr.
   */
  exec(
    containerId: string,
    command: string[],
    env?: Record<string, string>
  ): ExecaChildProcess;

  /** Remove a container and optionally its workspace. */
  remove(containerId: string, removeWorkspace?: boolean): Promise<void>;

  /** List all managed containers. */
  list(): ContainerInfo[];
}

// ---------------------------------------------------------------------------
// Docker CLI implementation
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = 'node:20';
const WORKSPACE_MOUNT = '/workspace';

export class DockerContainerManager implements ContainerManager {
  private containers = new Map<string, ContainerInfo>();
  private contextToContainer = new Map<string, string>();

  constructor(
    private workspacesDir: string = '/tmp/agent-workspaces',
    private defaultConfig: Partial<ContainerConfig> = {}
  ) {}

  async getOrCreate(
    contextId: string,
    config?: ContainerConfig
  ): Promise<ContainerInfo> {
    // Check if we already have a container for this context.
    const existingId = this.contextToContainer.get(contextId);
    if (existingId) {
      const existing = this.containers.get(existingId);
      if (existing) {
        // Verify it's still running.
        const running = await this.isRunning(existingId);
        if (running) {
          return { ...existing, running: true };
        }
        // Restart stopped container.
        await execa('docker', ['start', existingId]);
        existing.running = true;
        return existing;
      }
    }

    // Create workspace directory on host.
    const workspaceDir =
      config?.workspaceDir ??
      path.join(this.workspacesDir, contextId);

    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    // Build docker run args.
    const merged = { ...this.defaultConfig, ...config };
    const image = merged.image ?? DEFAULT_IMAGE;
    const args: string[] = [
      'run', '-d',
      '--name', `agent-${contextId}`,
      '-v', `${workspaceDir}:${WORKSPACE_MOUNT}`,
      '-w', WORKSPACE_MOUNT,
    ];

    // Environment variables.
    const env = { ...this.defaultConfig.env, ...config?.env };
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }

    // Resource limits.
    if (merged.memoryLimit) args.push('--memory', merged.memoryLimit);
    if (merged.cpuLimit) args.push('--cpus', merged.cpuLimit);

    // Ports.
    for (const port of merged.ports ?? []) {
      args.push('-p', `${port.host}:${port.container}`);
    }

    // Image + long-running idle command so container stays alive.
    args.push(image, 'tail', '-f', '/dev/null');

    const { stdout } = await execa('docker', args);
    const containerId = stdout.trim().slice(0, 12);

    // Install Claude Code CLI inside the container.
    await execa('docker', [
      'exec', containerId,
      'npm', 'install', '-g', '@anthropic-ai/claude-code',
    ]);

    // Install any extra packages.
    if (merged.packages && merged.packages.length > 0) {
      await execa('docker', [
        'exec', containerId,
        'npm', 'install', '-g', ...merged.packages,
      ]);
    }

    const info: ContainerInfo = {
      id: containerId,
      workspaceDir,
      running: true,
      createdAt: new Date().toISOString(),
    };

    this.containers.set(containerId, info);
    this.contextToContainer.set(contextId, containerId);

    return info;
  }

  exec(
    containerId: string,
    command: string[],
    env?: Record<string, string>
  ): ExecaChildProcess {
    const args = ['exec'];

    if (env) {
      for (const [key, value] of Object.entries(env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(containerId, ...command);

    return execa('docker', args, {
      buffer: false,
      // Don't throw on non-zero exit — let the caller handle errors.
      reject: false,
    });
  }

  async remove(containerId: string, removeWorkspace = false): Promise<void> {
    const info = this.containers.get(containerId);

    try {
      await execa('docker', ['rm', '-f', containerId]);
    } catch {
      // Container may already be removed.
    }

    if (removeWorkspace && info?.workspaceDir) {
      fs.rmSync(info.workspaceDir, { recursive: true, force: true });
    }

    this.containers.delete(containerId);

    // Clean up context mapping.
    for (const [ctx, id] of this.contextToContainer) {
      if (id === containerId) {
        this.contextToContainer.delete(ctx);
        break;
      }
    }
  }

  list(): ContainerInfo[] {
    return [...this.containers.values()];
  }

  private async isRunning(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await execa('docker', [
        'inspect', '-f', '{{.State.Running}}', containerId,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }
}
