import { describe, expect, it } from 'vitest';

import { formatMessage } from './formatter.js';
import type { AgentMessage } from './types.js';

const baseGeneration = {
  type: 'generation',
  model: 'claude-sonnet-4-20250514',
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: null,
} satisfies Pick<
  AgentMessage & {
    /**
     *
     */
    type: 'generation';
  },
  'type' | 'model' | 'usage' | 'stopReason'
>;

describe('formatMessage', () => {
  describe('init messages', () => {
    it('formats init with model and tool count', () => {
      const result = formatMessage({
        type: 'init',
        sessionId: 'session-123',
        model: 'claude-sonnet-4-20250514',
        tools: ['Bash', 'Read', 'Write'],
      });

      expect(result).toBe('[init] model=claude-sonnet-4-20250514 tools=3');
    });

    it('formats init with defaults when fields are missing', () => {
      const result = formatMessage({ type: 'init', sessionId: 'session-123' });

      expect(result).toBe('[init] model=unknown tools=0');
    });
  });

  describe('system messages', () => {
    it('formats status when non-empty', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'status',
          status: 'compacting',
        }),
      ).toBe('[status] compacting');
    });

    it('returns null for status with null status field', () => {
      expect(
        formatMessage({ type: 'system', subtype: 'status', status: null }),
      ).toBeNull();
    });

    it('formats api_retry', () => {
      const result = formatMessage({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1000,
      });

      expect(result).toBe('[retry] attempt 2/5 (1000ms delay)');
    });

    it('formats api_retry with defaults when fields are missing', () => {
      expect(formatMessage({ type: 'system', subtype: 'api_retry' })).toBe(
        '[retry] attempt 0/0 (0ms delay)',
      );
    });

    it('formats task_started', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'task_started',
          description: 'Analyzing codebase',
        }),
      ).toBe('[task:started] Analyzing codebase');
    });

    it('formats task_started with defaults when description is missing', () => {
      expect(formatMessage({ type: 'system', subtype: 'task_started' })).toBe(
        '[task:started] ',
      );
    });

    it('formats task_notification', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'task_notification',
          status: 'completed',
          summary: 'Found 3 issues',
        }),
      ).toBe('[task:completed] Found 3 issues');
    });

    it('formats task_notification with defaults when fields are missing', () => {
      expect(
        formatMessage({ type: 'system', subtype: 'task_notification' }),
      ).toBe('[task:unknown] ');
    });

    it('formats task_progress with last tool name', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'task_progress',
          description: 'Working on fix',
          last_tool_name: 'Bash',
        }),
      ).toBe('[task:progress] Working on fix (Bash)');
    });

    it('formats task_progress with camelCase last tool name', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'task_progress',
          description: 'Working on fix',
          lastTool: 'Read',
        }),
      ).toBe('[task:progress] Working on fix (Read)');
    });

    it('formats task_progress without last tool name', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'task_progress',
          description: 'Working on fix',
        }),
      ).toBe('[task:progress] Working on fix');
    });

    it('formats task_progress with defaults when description is missing', () => {
      expect(formatMessage({ type: 'system', subtype: 'task_progress' })).toBe(
        '[task:progress] ',
      );
    });

    it('formats local_command_output', () => {
      expect(
        formatMessage({
          type: 'system',
          subtype: 'local_command_output',
          content: 'total 42\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 src',
        }),
      ).toBe(
        '[output] total 42\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 src',
      );
    });

    it('truncates long local_command_output', () => {
      const longOutput = 'x'.repeat(1200);
      const result = formatMessage({
        type: 'system',
        subtype: 'local_command_output',
        content: longOutput,
      });

      expect(result).toBe(`[output] ${'x'.repeat(1000)}…`);
    });

    it('returns null for local_command_output with no content', () => {
      expect(
        formatMessage({ type: 'system', subtype: 'local_command_output' }),
      ).toBeNull();
    });

    it('returns null for non-displayed system subtypes', () => {
      expect(
        formatMessage({ type: 'system', subtype: 'compact_boundary' }),
      ).toBeNull();
    });
  });

  describe('generation messages', () => {
    it('formats text output', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: 'Hello, world!',
        toolCalls: [],
      });

      expect(result).toBe('Hello, world!');
    });

    it('formats Bash tool call with command', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [{ id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } }],
      });

      expect(result).toBe('[tool_use] Bash: ls -la');
    });

    it('formats file tool call with file_path', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [
          { id: 'tu_1', name: 'Read', input: { file_path: '/src/index.ts' } },
        ],
      });

      expect(result).toBe('[tool_use] Read: /src/index.ts');
    });

    it('formats file tool call with camelCase filePath', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [
          {
            id: 'tu_1',
            name: 'Write',
            input: { filePath: '/src/new.ts', content: '...' },
          },
        ],
      });

      expect(result).toBe('[tool_use] Write: /src/new.ts');
    });

    it('formats tool call with query input', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [
          {
            id: 'tu_1',
            name: 'WebSearch',
            input: { query: 'MetaMask agent SDK' },
          },
        ],
      });

      expect(result).toBe('[tool_use] WebSearch: MetaMask agent SDK');
    });

    it('formats tool call with unknown input as JSON', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [{ id: 'tu_1', name: 'Custom', input: { foo: 'bar' } }],
      });

      expect(result).toBe('[tool_use] Custom: {"foo":"bar"}');
    });

    it('truncates long command input', () => {
      const longCommand = 'x'.repeat(250);
      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [
          { id: 'tu_1', name: 'Bash', input: { command: longCommand } },
        ],
      });

      expect(result).toBe(`[tool_use] Bash: ${'x'.repeat(200)}…`);
    });

    it('formats tool call without usable input', () => {
      expect(
        formatMessage({
          ...baseGeneration,
          text: '',
          toolCalls: [{ id: 'tu_1', name: 'Noop', input: undefined }],
        }),
      ).toBe('[tool_use] Noop');
    });

    it('handles circular input gracefully', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = formatMessage({
        ...baseGeneration,
        text: '',
        toolCalls: [{ id: 'tu_1', name: 'Bad', input: circular }],
      });

      expect(result).toBe('[tool_use] Bad');
    });

    it('formats mixed text and tool calls', () => {
      const result = formatMessage({
        ...baseGeneration,
        text: 'Let me check the files.',
        toolCalls: [{ id: 'tu_1', name: 'Read', input: { file_path: '/foo' } }],
      });

      expect(result).toBe('[tool_use] Read: /foo\nLet me check the files.');
    });

    it('returns null when generation has no visible content', () => {
      expect(
        formatMessage({ ...baseGeneration, text: '', toolCalls: [] }),
      ).toBeNull();
    });
  });

  describe('tool_result messages', () => {
    it('formats tool_result with string content', () => {
      const result = formatMessage({
        type: 'tool_result',
        toolUseId: 'tu_123',
        content: 'file contents here',
        isError: false,
      });

      expect(result).toBe('[tool_output] file contents here');
    });

    it('formats tool_error when isError is true', () => {
      const result = formatMessage({
        type: 'tool_result',
        toolUseId: 'tu_123',
        isError: true,
        content: 'command not found: mm',
      });

      expect(result).toBe('[tool_error] command not found: mm');
    });

    it('truncates long tool output', () => {
      const longOutput = 'y'.repeat(1200);
      const result = formatMessage({
        type: 'tool_result',
        toolUseId: 'tu_123',
        content: longOutput,
        isError: false,
      });

      expect(result).toBe(`[tool_output] ${'y'.repeat(1000)}…`);
    });

    it('returns null when tool_result has empty content', () => {
      expect(
        formatMessage({
          type: 'tool_result',
          toolUseId: 'tu_123',
          content: '',
          isError: false,
        }),
      ).toBeNull();
    });
  });

  describe('tool_progress messages', () => {
    it('formats tool name and elapsed time', () => {
      expect(
        formatMessage({
          type: 'tool_progress',
          toolName: 'Bash',
          elapsedSeconds: 12,
        }),
      ).toBe('[tool_progress] Bash (12s)');
    });
  });

  describe('tool_use_summary messages', () => {
    it('formats summary text', () => {
      expect(
        formatMessage({
          type: 'tool_use_summary',
          summary: 'Edited 3 files successfully.',
        }),
      ).toBe('[tool_summary] Edited 3 files successfully.');
    });

    it('returns null when summary is empty', () => {
      expect(
        formatMessage({ type: 'tool_use_summary', summary: '' }),
      ).toBeNull();
    });
  });

  describe('result messages', () => {
    it('formats success result with turns and cost', () => {
      const result = formatMessage({
        type: 'result',
        success: true,
        turns: 5,
        costUsd: 0.1234,
        result: 'Task completed.',
      });

      expect(result).toBe(
        '[result] done in 5 turns ($0.1234)\nTask completed.',
      );
    });

    it('formats success result without cost', () => {
      const result = formatMessage({
        type: 'result',
        success: true,
        turns: 2,
        result: 'Done.',
      });

      expect(result).toBe('[result] done in 2 turns\nDone.');
    });

    it('formats error result with error message', () => {
      const result = formatMessage({
        type: 'result',
        success: false,
        turns: 3,
        costUsd: 0.05,
        error: 'Connection failed, Timeout',
      });

      expect(result).toBe(
        '[result:error] Connection failed, Timeout (3 turns ($0.0500))',
      );
    });

    it('formats success result with missing result field', () => {
      expect(formatMessage({ type: 'result', success: true, turns: 1 })).toBe(
        '[result] done in 1 turns\n',
      );
    });

    it('formats error result falling back to unknown when error is missing', () => {
      expect(formatMessage({ type: 'result', success: false, turns: 0 })).toBe(
        '[result:error] unknown error (0 turns)',
      );
    });

    it('defaults turns to 0 when the field is absent', () => {
      expect(formatMessage({ type: 'result', success: true })).toBe(
        '[result] done in 0 turns\n',
      );
    });
  });

  describe('rate_limit messages', () => {
    it('formats rate limit status', () => {
      expect(
        formatMessage({ type: 'rate_limit', status: 'allowed_warning' }),
      ).toBe('[rate_limit] allowed_warning');
    });

    it('returns null when status is empty', () => {
      expect(formatMessage({ type: 'rate_limit', status: '' })).toBeNull();
    });
  });
});
