import { describe, expect, it } from 'vitest';

import { formatMessage } from './formatter.js';
import type { SdkMessage } from './types.js';

/**
 * Casts a plain object to SdkMessage for test fixtures.
 *
 * @param obj - Plain object matching an SDK message shape.
 * @returns The object typed as SdkMessage.
 */
function sdkMessage(obj: Record<string, unknown>): SdkMessage {
  return obj as SdkMessage;
}

describe('formatMessage', () => {
  describe('system messages', () => {
    it('formats init with model and tool count', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-4-20250514',
          tools: ['Bash', 'Read', 'Write'],
        }),
      );

      expect(result).toBe(
        '[init] model=claude-sonnet-4-20250514 tools=3',
      );
    });

    it('formats init with defaults when fields are missing', () => {
      const result = formatMessage(
        sdkMessage({ type: 'system', subtype: 'init' }),
      );

      expect(result).toBe('[init] model=unknown tools=0');
    });

    it('formats status when non-null', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'status', status: 'compacting' }),
        ),
      ).toBe('[status] compacting');
    });

    it('returns null for status with null status field', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'status', status: null }),
        ),
      ).toBeNull();
    });

    it('formats api_retry', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 5,
          retry_delay_ms: 1000,
        }),
      );

      expect(result).toBe('[retry] attempt 2/5 (1000ms delay)');
    });

    it('formats task_started', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'system',
            subtype: 'task_started',
            description: 'Analyzing codebase',
          }),
        ),
      ).toBe('[task:started] Analyzing codebase');
    });

    it('formats task_notification', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'system',
            subtype: 'task_notification',
            status: 'completed',
            summary: 'Found 3 issues',
          }),
        ),
      ).toBe('[task:completed] Found 3 issues');
    });

    it('formats task_notification with defaults when fields are missing', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'task_notification' }),
        ),
      ).toBe('[task:unknown] ');
    });

    it('formats task_progress with last tool name', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'system',
            subtype: 'task_progress',
            description: 'Working on fix',
            last_tool_name: 'Bash',
          }),
        ),
      ).toBe('[task:progress] Working on fix (Bash)');
    });

    it('formats task_progress without last tool name', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'system',
            subtype: 'task_progress',
            description: 'Working on fix',
          }),
        ),
      ).toBe('[task:progress] Working on fix');
    });

    it('formats local_command_output', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'system',
            subtype: 'local_command_output',
            content: 'total 42\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 src',
          }),
        ),
      ).toBe(
        '[output] total 42\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 src',
      );
    });

    it('truncates long local_command_output', () => {
      const longOutput = 'x'.repeat(1200);
      const result = formatMessage(
        sdkMessage({
          type: 'system',
          subtype: 'local_command_output',
          content: longOutput,
        }),
      );

      expect(result).toBe(`[output] ${'x'.repeat(1000)}…`);
    });

    it('returns null for local_command_output with no content', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'local_command_output' }),
        ),
      ).toBeNull();
    });

    it('returns null for compact_boundary', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'compact_boundary' }),
        ),
      ).toBeNull();
    });

    it('returns null for hook_started', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'system', subtype: 'hook_started' }),
        ),
      ).toBeNull();
    });
  });

  describe('assistant messages', () => {
    it('formats text content blocks', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello, world!' }],
          },
        }),
      );

      expect(result).toBe('Hello, world!');
    });

    it('formats multiple text blocks joined by newline', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First paragraph.' },
              { type: 'text', text: 'Second paragraph.' },
            ],
          },
        }),
      );

      expect(result).toBe('First paragraph.\nSecond paragraph.');
    });

    it('formats Bash tool_use with command', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] Bash: ls -la');
    });

    it('formats file tool_use with file_path', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: '/src/index.ts' },
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] Read: /src/index.ts');
    });

    it('formats file tool_use with camelCase filePath', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Write',
                input: { filePath: '/src/new.ts', content: '...' },
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] Write: /src/new.ts');
    });

    it('formats tool_use with query input', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'WebSearch',
                input: { query: 'MetaMask agent SDK' },
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] WebSearch: MetaMask agent SDK');
    });

    it('formats tool_use with unknown input as JSON', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Custom',
                input: { foo: 'bar' },
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] Custom: {"foo":"bar"}');
    });

    it('truncates long command input', () => {
      const longCommand = 'x'.repeat(250);
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: longCommand },
              },
            ],
          },
        }),
      );

      expect(result).toBe(`[tool_use] Bash: ${'x'.repeat(200)}…`);
    });

    it('formats tool_use without input', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Noop' }],
            },
          }),
        ),
      ).toBe('[tool_use] Noop');
    });

    it('handles circular input gracefully', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bad', input: circular },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_use] Bad');
    });

    it('formats mixed text and tool_use blocks', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me check the files.' },
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: '/foo' },
              },
            ],
          },
        }),
      );

      expect(result).toBe('Let me check the files.\n[tool_use] Read: /foo');
    });

    it('skips thinking blocks', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'internal reasoning...' },
              { type: 'text', text: 'Visible output.' },
            ],
          },
        }),
      );

      expect(result).toBe('Visible output.');
    });

    it('returns error string when error field is present', () => {
      expect(
        formatMessage(sdkMessage({ type: 'assistant', error: 'rate_limit' })),
      ).toBe('[error] rate_limit');
    });

    it('returns null when content is empty', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'assistant', message: { content: [] } }),
        ),
      ).toBeNull();
    });

    it('returns null when message field is missing', () => {
      expect(formatMessage(sdkMessage({ type: 'assistant' }))).toBeNull();
    });

    it('skips non-object content blocks', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'assistant',
          message: {
            content: [null, 'stray-string', { type: 'text', text: 'valid' }],
          },
        }),
      );

      expect(result).toBe('valid');
    });
  });

  describe('tool_progress messages', () => {
    it('formats tool name and elapsed time', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'tool_progress',
            tool_name: 'Bash',
            elapsed_time_seconds: 12,
          }),
        ),
      ).toBe('[tool_progress] Bash (12s)');
    });

    it('defaults to unknown and 0s when fields are missing', () => {
      expect(formatMessage(sdkMessage({ type: 'tool_progress' }))).toBe(
        '[tool_progress] unknown (0s)',
      );
    });
  });

  describe('tool_use_summary messages', () => {
    it('formats summary text', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'tool_use_summary',
            summary: 'Edited 3 files successfully.',
          }),
        ),
      ).toBe('[tool_summary] Edited 3 files successfully.');
    });

    it('returns null when summary is missing', () => {
      expect(
        formatMessage(sdkMessage({ type: 'tool_use_summary' })),
      ).toBeNull();
    });
  });

  describe('result messages', () => {
    it('formats success result with turns and cost', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'result',
          subtype: 'success',
          num_turns: 5,
          total_cost_usd: 0.1234,
          result: 'Task completed.',
        }),
      );

      expect(result).toBe(
        '[result] done in 5 turns ($0.1234)\nTask completed.',
      );
    });

    it('formats success result without cost', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'result',
          subtype: 'success',
          num_turns: 2,
          result: 'Done.',
        }),
      );

      expect(result).toBe('[result] done in 2 turns\nDone.');
    });

    it('formats error result with error messages', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'result',
          subtype: 'error_during_execution',
          num_turns: 3,
          total_cost_usd: 0.05,
          errors: ['Connection failed', 'Timeout'],
        }),
      );

      expect(result).toBe(
        '[result:error] Connection failed, Timeout (3 turns ($0.0500))',
      );
    });

    it('formats error result with subtype as fallback when errors is empty', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'result',
          subtype: 'error_max_turns',
          num_turns: 10,
          errors: [],
        }),
      );

      expect(result).toBe('[result:error] error_max_turns (10 turns)');
    });

    it('formats success result with missing result field', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'result', subtype: 'success', num_turns: 1 }),
        ),
      ).toBe('[result] done in 1 turns\n');
    });

    it('formats error result with missing errors array', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'result', subtype: 'error_during_execution', num_turns: 1 }),
        ),
      ).toBe('[result:error] error_during_execution (1 turns)');
    });

    it('formats error result falling back to unknown when subtype and errors are missing', () => {
      expect(
        formatMessage(sdkMessage({ type: 'result', num_turns: 0 })),
      ).toBe('[result:error] unknown error (0 turns)');
    });
  });

  describe('rate_limit_event messages', () => {
    it('formats rate limit status', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed_warning' },
          }),
        ),
      ).toBe('[rate_limit] allowed_warning');
    });

    it('returns null when rate_limit_info is missing', () => {
      expect(
        formatMessage(sdkMessage({ type: 'rate_limit_event' })),
      ).toBeNull();
    });

    it('returns null when rate_limit_info has no status', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'rate_limit_event', rate_limit_info: {} }),
        ),
      ).toBeNull();
    });
  });

  describe('user messages (tool results)', () => {
    it('formats synthetic tool_result with string content', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                content: 'file contents here',
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_output] file contents here');
    });

    it('formats synthetic tool_result with array content blocks', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                content: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' },
                ],
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_output] line one\nline two');
    });

    it('formats tool_error when is_error is true', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                is_error: true,
                content: 'command not found: mm',
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_error] command not found: mm');
    });

    it('truncates long tool output', () => {
      const longOutput = 'y'.repeat(1200);
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                content: longOutput,
              },
            ],
          },
        }),
      );

      expect(result).toBe(`[tool_output] ${'y'.repeat(1000)}…`);
    });

    it('returns null for non-synthetic user messages without tool results', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'user',
            message: { role: 'user', content: 'hello' },
          }),
        ),
      ).toBeNull();
    });

    it('formats tool_result even when isSynthetic is not set', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_456',
                content: 'output from tool',
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_output] output from tool');
    });

    it('returns null when tool_result has empty content', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'user',
            isSynthetic: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_123',
                  content: '',
                },
              ],
            },
          }),
        ),
      ).toBeNull();
    });

    it('returns null for synthetic message with no message field', () => {
      expect(
        formatMessage(sdkMessage({ type: 'user', isSynthetic: true })),
      ).toBeNull();
    });

    it('handles non-object blocks in tool_result content array', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                content: [null, 'stray', { type: 'text', text: 'valid' }],
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_output] valid');
    });

    it('handles non-array non-string tool_result content', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'user',
            isSynthetic: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_123',
                  content: 42,
                },
              ],
            },
          }),
        ),
      ).toBeNull();
    });

    it('handles non-object blocks in synthetic message content', () => {
      expect(
        formatMessage(
          sdkMessage({
            type: 'user',
            isSynthetic: true,
            message: {
              role: 'user',
              content: [
                null,
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_123',
                  content: 'output',
                },
              ],
            },
          }),
        ),
      ).toBe('[tool_output] output');
    });

    it('skips non-tool_result blocks in synthetic messages', () => {
      const result = formatMessage(
        sdkMessage({
          type: 'user',
          isSynthetic: true,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'not a tool result' },
              {
                type: 'tool_result',
                tool_use_id: 'tu_123',
                content: 'actual output',
              },
            ],
          },
        }),
      );

      expect(result).toBe('[tool_output] actual output');
    });
  });

  describe('skipped message types', () => {
    it('returns null for stream_event messages', () => {
      expect(
        formatMessage(sdkMessage({ type: 'stream_event', event: {} })),
      ).toBeNull();
    });

    it('returns null for auth_status messages', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'auth_status', isAuthenticating: true }),
        ),
      ).toBeNull();
    });

    it('returns null for prompt_suggestion messages', () => {
      expect(
        formatMessage(
          sdkMessage({ type: 'prompt_suggestion', suggestion: 'next?' }),
        ),
      ).toBeNull();
    });

    it('returns null for unknown message types', () => {
      expect(
        formatMessage(sdkMessage({ type: 'some_future_type' })),
      ).toBeNull();
    });
  });
});
