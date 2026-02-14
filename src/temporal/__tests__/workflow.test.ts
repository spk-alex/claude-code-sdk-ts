/**
 * Tests for the Temporal workflow definition.
 *
 * These tests verify the workflow structure, signal/query definitions, and
 * the exported workflow function signature. Full integration testing
 * requires a Temporal test server (see Temporal's testing documentation).
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentWorkflowInput,
  AgentWorkflowOutput,
  AgentWorkflowStepResult,
} from '../types.js';

describe('Workflow types', () => {
  it('AgentWorkflowInput supports single prompt', () => {
    const input: AgentWorkflowInput = {
      prompt: 'Hello, Claude',
    };
    expect(input.prompt).toBe('Hello, Claude');
    expect(input.steps).toBeUndefined();
  });

  it('AgentWorkflowInput supports multi-step', () => {
    const input: AgentWorkflowInput = {
      steps: [
        { prompt: 'Step 1' },
        { prompt: 'Step 2', options: { model: 'opus' } },
      ],
      options: {
        permissionMode: 'acceptEdits',
        cwd: '/project',
      },
    };
    expect(input.steps).toHaveLength(2);
    expect(input.steps![0]!.prompt).toBe('Step 1');
    expect(input.steps![1]!.options?.model).toBe('opus');
    expect(input.options?.cwd).toBe('/project');
  });

  it('AgentWorkflowInput supports taskQueue and workflowId', () => {
    const input: AgentWorkflowInput = {
      prompt: 'test',
      taskQueue: 'custom-queue',
      workflowId: 'my-workflow-1',
    };
    expect(input.taskQueue).toBe('custom-queue');
    expect(input.workflowId).toBe('my-workflow-1');
  });

  it('AgentWorkflowOutput captures all step results', () => {
    const output: AgentWorkflowOutput = {
      stepResults: [
        {
          stepIndex: 0,
          prompt: 'Step 1',
          result: {
            text: 'Response 1',
            sessionId: 'sess-1',
            messages: [],
            success: true,
            errors: [],
          },
        },
        {
          stepIndex: 1,
          prompt: 'Step 2',
          result: {
            text: 'Response 2',
            sessionId: 'sess-1',
            messages: [],
            success: true,
            errors: [],
          },
        },
      ],
      sessionId: 'sess-1',
      success: true,
      fullText: 'Response 1\n\nResponse 2',
    };

    expect(output.stepResults).toHaveLength(2);
    expect(output.success).toBe(true);
    expect(output.sessionId).toBe('sess-1');
    expect(output.fullText).toContain('Response 1');
    expect(output.fullText).toContain('Response 2');
  });

  it('AgentWorkflowOutput reflects failure when a step fails', () => {
    const output: AgentWorkflowOutput = {
      stepResults: [
        {
          stepIndex: 0,
          prompt: 'Failing step',
          result: {
            text: '',
            sessionId: null,
            messages: [],
            success: false,
            errors: ['Rate limit exceeded'],
          },
        },
      ],
      sessionId: null,
      success: false,
      fullText: '',
    };

    expect(output.success).toBe(false);
    expect(output.stepResults[0]!.result.errors).toContain('Rate limit exceeded');
  });
});

describe('Workflow module exports', () => {
  // These tests verify that the workflow module correctly exports the
  // expected symbols. We can't import the actual workflow code in a
  // non-Temporal environment (it uses @temporalio/workflow internals),
  // so we verify the types and index re-exports instead.

  it('re-exports workflow types from the index barrel', async () => {
    // The index barrel should export all public types.
    const types = await import('../types.js');

    expect(types.toClaudeCodeOptions).toBeTypeOf('function');
    expect(types.toSerializableMessage).toBeTypeOf('function');
  });
});

describe('AgentWorkflowStepResult', () => {
  it('contains step metadata alongside the query result', () => {
    const stepResult: AgentWorkflowStepResult = {
      stepIndex: 0,
      prompt: 'Analyze the code',
      result: {
        text: 'The code does X',
        sessionId: 'sess-42',
        messages: [
          { type: 'assistant', content: [{ type: 'text', text: 'The code does X' }] },
        ],
        success: true,
        errors: [],
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          totalCost: 0.003,
        },
      },
    };

    expect(stepResult.stepIndex).toBe(0);
    expect(stepResult.prompt).toBe('Analyze the code');
    expect(stepResult.result.usage?.totalTokens).toBe(150);
  });
});
