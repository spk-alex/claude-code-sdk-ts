import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeAgentOptions } from '../activities.js';
import type { AgentSessionOptions } from '../types.js';
import type { AgentDefinition } from '../../types.js';

// Mock the @temporalio/activity heartbeat since we're not running in a real
// Temporal activity context.
vi.mock('@temporalio/activity', () => ({
  heartbeat: vi.fn(),
}));

// Mock the fluent API so we don't spawn real Claude CLI processes.
vi.mock('../../fluent.js', () => {
  const mockParser = {
    asArray: vi.fn().mockResolvedValue([
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'Mocked response' }],
        session_id: 'mock-session-1',
      },
      {
        type: 'result',
        content: 'Done',
        session_id: 'mock-session-1',
        usage: { input_tokens: 10, output_tokens: 20 },
        cost: { total_cost: 0.001 },
      },
    ]),
  };

  const mockBuilder = {
    withModel: vi.fn().mockReturnThis(),
    skipPermissions: vi.fn().mockReturnThis(),
    acceptEdits: vi.fn().mockReturnThis(),
    inDirectory: vi.fn().mockReturnThis(),
    withTimeout: vi.fn().mockReturnThis(),
    withSessionId: vi.fn().mockReturnThis(),
    allowTools: vi.fn().mockReturnThis(),
    denyTools: vi.fn().mockReturnThis(),
    withEnv: vi.fn().mockReturnThis(),
    addDirectory: vi.fn().mockReturnThis(),
    withAgents: vi.fn().mockReturnThis(),
    query: vi.fn().mockReturnValue(mockParser),
  };

  return {
    claude: vi.fn(() => mockBuilder),
    __mockBuilder: mockBuilder,
    __mockParser: mockParser,
  };
});

describe('mergeAgentOptions', () => {
  it('returns empty object when both inputs are undefined', async () => {
    const result = await mergeAgentOptions(undefined, undefined);
    expect(result).toEqual({});
  });

  it('returns overrides when base is undefined', async () => {
    const overrides: Partial<AgentSessionOptions> = {
      model: 'opus',
      cwd: '/tmp',
    };
    const result = await mergeAgentOptions(undefined, overrides);
    expect(result).toEqual(overrides);
  });

  it('returns base when overrides is undefined', async () => {
    const base: AgentSessionOptions = {
      model: 'sonnet',
      cwd: '/home',
      timeout: 5000,
    };
    const result = await mergeAgentOptions(base, undefined);
    expect(result).toEqual(base);
  });

  it('merges base and overrides with overrides winning', async () => {
    const base: AgentSessionOptions = {
      model: 'sonnet',
      cwd: '/home',
      timeout: 5000,
      env: { A: '1', B: '2' },
      allowedTools: ['Read'],
    };
    const overrides: Partial<AgentSessionOptions> = {
      model: 'opus',
      env: { B: '3', C: '4' },
      allowedTools: ['Read', 'Write', 'Edit'],
    };

    const result = await mergeAgentOptions(base, overrides);

    expect(result.model).toBe('opus');
    expect(result.cwd).toBe('/home');
    expect(result.timeout).toBe(5000);
    expect(result.env).toEqual({ A: '1', B: '3', C: '4' });
    expect(result.allowedTools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('falls back to base for array fields when overrides does not set them', async () => {
    const base: AgentSessionOptions = {
      allowedTools: ['Read'],
      deniedTools: ['Bash'],
      context: ['ctx1'],
    };
    const overrides: Partial<AgentSessionOptions> = {
      model: 'opus',
    };

    const result = await mergeAgentOptions(base, overrides);

    expect(result.allowedTools).toEqual(['Read']);
    expect(result.deniedTools).toEqual(['Bash']);
    expect(result.context).toEqual(['ctx1']);
  });

  it('merges agents from base and overrides (overrides win by name)', async () => {
    const base: AgentSessionOptions = {
      agents: {
        reviewer: {
          description: 'Base reviewer',
          prompt: 'Review code',
          tools: ['Read'],
        },
        debugger: {
          description: 'Debugger agent',
          prompt: 'Debug issues',
        },
      },
    };
    const overrides: Partial<AgentSessionOptions> = {
      agents: {
        reviewer: {
          description: 'Override reviewer',
          prompt: 'Review code thoroughly',
          tools: ['Read', 'Grep'],
        },
      },
    };

    const result = await mergeAgentOptions(base, overrides);

    // Override wins for 'reviewer'
    expect(result.agents?.reviewer?.description).toBe('Override reviewer');
    expect(result.agents?.reviewer?.tools).toEqual(['Read', 'Grep']);
    // Base preserved for 'debugger'
    expect(result.agents?.debugger?.description).toBe('Debugger agent');
  });

  it('preserves base agents when overrides has none', async () => {
    const base: AgentSessionOptions = {
      agents: {
        helper: { description: 'Helper', prompt: 'Help' },
      },
    };

    const result = await mergeAgentOptions(base, { model: 'opus' });

    expect(result.agents?.helper?.description).toBe('Helper');
  });

  it('returns undefined agents when neither base nor overrides has them', async () => {
    const result = await mergeAgentOptions(
      { model: 'sonnet' },
      { model: 'opus' }
    );

    expect(result.agents).toBeUndefined();
  });

  it('preserves addDirectories from base when overrides has none', async () => {
    const base: AgentSessionOptions = {
      addDirectories: ['/repo/config'],
    };

    const result = await mergeAgentOptions(base, { model: 'opus' });

    expect(result.addDirectories).toEqual(['/repo/config']);
  });
});

describe('executeAgentQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a query and returns structured result', async () => {
    // Dynamic import so mocks are applied
    const { executeAgentQuery } = await import('../activities.js');

    const result = await executeAgentQuery({
      prompt: 'Hello, world',
      options: { model: 'sonnet' },
    });

    expect(result.text).toBe('Mocked response');
    expect(result.sessionId).toBe('mock-session-1');
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.messages).toHaveLength(2);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      totalCost: 0.001,
    });
  });

  it('configures the builder with provided options', async () => {
    const { executeAgentQuery } = await import('../activities.js');
    const { __mockBuilder: mockBuilder } = await import('../../fluent.js') as any;

    await executeAgentQuery({
      prompt: 'test',
      sessionId: 'existing-session',
      options: {
        model: 'opus',
        permissionMode: 'bypassPermissions',
        cwd: '/project',
        timeout: 10000,
        allowedTools: ['Read', 'Write'],
        deniedTools: ['Bash'],
        env: { KEY: 'val' },
      },
    });

    expect(mockBuilder.withModel).toHaveBeenCalledWith('opus');
    expect(mockBuilder.skipPermissions).toHaveBeenCalled();
    expect(mockBuilder.inDirectory).toHaveBeenCalledWith('/project');
    expect(mockBuilder.withTimeout).toHaveBeenCalledWith(10000);
    expect(mockBuilder.withSessionId).toHaveBeenCalledWith('existing-session');
    expect(mockBuilder.allowTools).toHaveBeenCalledWith('Read', 'Write');
    expect(mockBuilder.denyTools).toHaveBeenCalledWith('Bash');
    expect(mockBuilder.withEnv).toHaveBeenCalledWith({ KEY: 'val' });
  });

  it('calls heartbeat after query completes', async () => {
    const { executeAgentQuery } = await import('../activities.js');
    const { heartbeat } = await import('@temporalio/activity');

    await executeAgentQuery({ prompt: 'test' });

    expect(heartbeat).toHaveBeenCalledWith('query-complete');
  });

  it('calls withAgents when agents are defined', async () => {
    const { executeAgentQuery } = await import('../activities.js');
    const { __mockBuilder: mockBuilder } = await import('../../fluent.js') as any;

    const agents: Record<string, AgentDefinition> = {
      reviewer: {
        description: 'Code reviewer',
        prompt: 'Review code for quality',
        tools: ['Read', 'Grep'],
      },
    };

    await executeAgentQuery({
      prompt: 'Use the reviewer agent',
      options: { agents },
    });

    expect(mockBuilder.withAgents).toHaveBeenCalledWith(agents);
  });

  it('calls addDirectory when addDirectories is set', async () => {
    const { executeAgentQuery } = await import('../activities.js');
    const { __mockBuilder: mockBuilder } = await import('../../fluent.js') as any;

    await executeAgentQuery({
      prompt: 'test',
      options: {
        addDirectories: ['/repo/docs', '/repo/config'],
      },
    });

    expect(mockBuilder.addDirectory).toHaveBeenCalledWith(['/repo/docs', '/repo/config']);
  });

  it('detects errors from system messages', async () => {
    const { __mockParser: mockParser } = await import('../../fluent.js') as any;

    mockParser.asArray.mockResolvedValueOnce([
      {
        type: 'system',
        subtype: 'error',
        data: { message: 'Rate limit exceeded' },
      },
      {
        type: 'result',
        content: '',
      },
    ]);

    const { executeAgentQuery } = await import('../activities.js');
    const result = await executeAgentQuery({ prompt: 'test' });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Rate limit exceeded');
  });
});
