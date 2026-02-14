import { describe, it, expect } from 'vitest';
import {
  toClaudeCodeOptions,
  toSerializableMessage,
} from '../types.js';
import type {
  AgentSessionOptions,
} from '../types.js';
import type { Message } from '../../types.js';

describe('toClaudeCodeOptions', () => {
  it('returns empty object when no options provided', () => {
    expect(toClaudeCodeOptions()).toEqual({});
    expect(toClaudeCodeOptions(undefined)).toEqual({});
  });

  it('maps all AgentSessionOptions fields to ClaudeCodeOptions', () => {
    const opts: AgentSessionOptions = {
      model: 'sonnet',
      allowedTools: ['Read', 'Write'],
      deniedTools: ['Bash'],
      permissionMode: 'acceptEdits',
      cwd: '/tmp/test',
      env: { FOO: 'bar' },
      timeout: 5000,
      systemPrompt: 'You are a helpful assistant',
      context: ['some context'],
      maxTokens: 1024,
      temperature: 0.7,
    };

    const result = toClaudeCodeOptions(opts);

    expect(result).toEqual({
      model: 'sonnet',
      allowedTools: ['Read', 'Write'],
      deniedTools: ['Bash'],
      permissionMode: 'acceptEdits',
      cwd: '/tmp/test',
      env: { FOO: 'bar' },
      timeout: 5000,
      systemPrompt: 'You are a helpful assistant',
      context: ['some context'],
      maxTokens: 1024,
      temperature: 0.7,
    });
  });

  it('handles partial options', () => {
    const opts: AgentSessionOptions = { model: 'opus' };
    const result = toClaudeCodeOptions(opts);

    expect(result.model).toBe('opus');
    expect(result.cwd).toBeUndefined();
    expect(result.timeout).toBeUndefined();
  });

  it('prepends agentInstructions to systemPrompt', () => {
    const opts: AgentSessionOptions = {
      agentInstructions: 'You are a senior TS engineer.',
      systemPrompt: 'Be concise.',
    };

    const result = toClaudeCodeOptions(opts);

    expect(result.systemPrompt).toBe(
      'You are a senior TS engineer.\n\nBe concise.'
    );
  });

  it('uses agentInstructions as systemPrompt when no systemPrompt set', () => {
    const opts: AgentSessionOptions = {
      agentInstructions: 'Always write tests.',
    };

    const result = toClaudeCodeOptions(opts);

    expect(result.systemPrompt).toBe('Always write tests.');
  });

  it('passes addDirectories through to ClaudeCodeOptions', () => {
    const opts: AgentSessionOptions = {
      addDirectories: ['/repo/a', '/repo/b'],
    };

    const result = toClaudeCodeOptions(opts);

    expect(result.addDirectories).toEqual(['/repo/a', '/repo/b']);
  });
});

describe('toSerializableMessage', () => {
  it('serializes a user message', () => {
    const msg: Message = {
      type: 'user',
      content: 'Hello',
      session_id: 'sess-123',
    };

    const result = toSerializableMessage(msg);

    expect(result.type).toBe('user');
    expect(result.content).toBe('Hello');
    expect(result.session_id).toBe('sess-123');
  });

  it('serializes an assistant message with content blocks', () => {
    const msg: Message = {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo' } },
      ],
    };

    const result = toSerializableMessage(msg);

    expect(result.type).toBe('assistant');
    expect(result.content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo' } },
    ]);
  });

  it('serializes a result message with usage and cost', () => {
    const msg: Message = {
      type: 'result',
      content: 'Done',
      session_id: 'sess-456',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
      cost: {
        total_cost: 0.005,
      },
    };

    const result = toSerializableMessage(msg);

    expect(result.type).toBe('result');
    expect(result.content).toBe('Done');
    expect(result.session_id).toBe('sess-456');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result.cost).toEqual({ total_cost: 0.005 });
  });

  it('serializes a system message with subtype and data', () => {
    const msg: Message = {
      type: 'system',
      subtype: 'error',
      data: { message: 'Something failed' },
    };

    const result = toSerializableMessage(msg);

    expect(result.type).toBe('system');
    expect(result.subtype).toBe('error');
    expect(result.data).toEqual({ message: 'Something failed' });
  });

  it('omits undefined optional fields', () => {
    const msg: Message = {
      type: 'system',
    };

    const result = toSerializableMessage(msg);

    expect(result).toEqual({ type: 'system' });
    expect(result.subtype).toBeUndefined();
    expect(result.session_id).toBeUndefined();
    expect(result.data).toBeUndefined();
  });
});
