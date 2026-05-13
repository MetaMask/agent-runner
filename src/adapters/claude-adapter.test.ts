import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAdapter } from './claude-adapter.js';

const claudeMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeMocks.query,
}));

/** Generic Claude SDK message shape used by adapter tests. */
type SdkMessage = Record<string, unknown>;

/**
 * Creates an async iterable over SDK messages.
 *
 * @param messages - Messages to yield.
 * @yields SDK messages in order.
 */
async function* yieldMessages(
  messages: SdkMessage[],
): AsyncGenerator<SdkMessage> {
  for (const message of messages) {
    yield message;
  }
}

/**
 * Collects all translated adapter messages.
 *
 * @param messages - Raw SDK messages to feed to the mocked query.
 * @returns Translated agent messages.
 */
async function collectMessages(messages: SdkMessage[]): Promise<unknown[]> {
  claudeMocks.query.mockReturnValueOnce(yieldMessages(messages));
  const adapter = createClaudeAdapter();
  const translated: unknown[] = [];

  for await (const message of adapter.run({
    prompt: 'hello',
    options: { maxTurns: 1 },
  })) {
    translated.push(message);
  }

  return translated;
}

describe('createClaudeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes prompt and options to Claude query', async () => {
    claudeMocks.query.mockReturnValueOnce(yieldMessages([]));

    const adapter = createClaudeAdapter();
    const translated: unknown[] = [];
    for await (const message of adapter.run({
      prompt: 'run this',
      options: { maxTurns: 2 },
    })) {
      translated.push(message);
    }

    expect(adapter.name).toBe('claude');
    expect(translated).toStrictEqual([]);
    expect(claudeMocks.query).toHaveBeenCalledWith({
      prompt: 'run this',
      options: { maxTurns: 2 },
    });
  });

  it('translates system init messages with optional model and tools', async () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      model: 'claude-sonnet',
      tools: ['Bash', 1, 'Read'],
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'init',
        sessionId: 'session-1',
        model: 'claude-sonnet',
        tools: ['Bash', 'Read'],
        raw,
      },
    ]);
  });

  it('translates system init messages with default fields', async () => {
    const raw = { type: 'system', subtype: 'init', session_id: 123 };

    expect(await collectMessages([raw])).toStrictEqual([
      { type: 'init', sessionId: '', raw },
    ]);
  });

  it('translates non-init system messages with subtype', async () => {
    const raw = { type: 'system', subtype: 'status', status: 'working' };

    expect(await collectMessages([raw])).toStrictEqual([
      { ...raw, type: 'system', subtype: 'status', raw },
    ]);
  });

  it('translates assistant messages from nested message content', async () => {
    const raw = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet',
        content: [
          { type: 'text', text: 'Using a tool. ' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'pwd' },
          },
          { type: 'text', text: 'Done.' },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
        stop_reason: 'tool_use',
      },
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'generation',
        model: 'claude-sonnet',
        text: 'Using a tool. Done.',
        toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
        },
        stopReason: 'tool_use',
        raw,
      },
    ]);
  });

  it('skips malformed assistant messages', async () => {
    expect(await collectMessages([{ type: 'assistant' }])).toStrictEqual([]);
  });

  it('translates user tool_result messages from nested content', async () => {
    const raw = {
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'ignored' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: 'tool output' }],
            is_error: true,
          },
        ],
      },
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'tool output',
        isError: true,
        raw,
      },
    ]);
  });

  it('translates string tool_result content and defaults isError', async () => {
    const raw = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'plain output',
          },
        ],
      },
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'plain output',
        isError: false,
        raw,
      },
    ]);
  });

  it('translates unsupported tool_result content to an empty string', async () => {
    const raw = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: { type: 'text', text: 'ignored' },
          },
        ],
      },
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: '',
        isError: false,
        raw,
      },
    ]);
  });

  it('translates multiple tool_result blocks from parallel tool use', async () => {
    const raw = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'first output',
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [{ type: 'text', text: 'second output' }],
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: 'third output',
          },
        ],
      },
    };

    expect(await collectMessages([raw])).toStrictEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'first output',
        isError: false,
        raw,
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-2',
        content: 'second output',
        isError: true,
        raw,
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-3',
        content: 'third output',
        isError: false,
        raw,
      },
    ]);
  });

  it('skips user messages without valid tool_result content', async () => {
    expect(
      await collectMessages([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'hello' }] },
        },
        { type: 'user', message: { content: 'not an array' } },
      ]),
    ).toStrictEqual([]);
  });

  it('translates progress, summary, result, and rate limit messages', async () => {
    const progress = {
      type: 'tool_progress',
      tool_name: 'Bash',
      elapsed_seconds: 4,
    };
    const summary = { type: 'tool_use_summary', summary: 'Ran Bash' };
    const success = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.5,
      num_turns: 3,
      duration_ms: 1000,
    };
    const error = { type: 'result', subtype: 'error', error: 'failed' };
    const rateLimit = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning' },
    };

    expect(
      await collectMessages([progress, summary, success, error, rateLimit]),
    ).toStrictEqual([
      {
        type: 'tool_progress',
        toolName: 'Bash',
        elapsedSeconds: 4,
        raw: progress,
      },
      { type: 'tool_use_summary', summary: 'Ran Bash', raw: summary },
      {
        type: 'result',
        success: true,
        result: 'done',
        costUsd: 0.5,
        turns: 3,
        durationMs: 1000,
        raw: success,
      },
      { type: 'result', success: false, error: 'failed', raw: error },
      { type: 'rate_limit', status: 'allowed_warning', raw: rateLimit },
    ]);
  });

  it('skips unknown message types', async () => {
    expect(await collectMessages([{ type: 'unknown' }])).toStrictEqual([]);
  });

  describe('assistant emission merging', () => {
    it('merges multiple emissions for the same model turn into one generation', async () => {
      const emission1 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [],
          usage: { input_tokens: 100, output_tokens: 20 },
          stop_reason: null,
        },
      };
      const emission2 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'Hello world' }],
          usage: { input_tokens: 100, output_tokens: 20 },
          stop_reason: null,
        },
      };
      const emission3 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
          stop_reason: 'tool_use',
        },
      };

      expect(
        await collectMessages([emission1, emission2, emission3]),
      ).toStrictEqual([
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'Hello world',
          toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
          usage: { inputTokens: 100, outputTokens: 20 },
          stopReason: 'tool_use',
          raw: emission3,
        },
      ]);
    });

    it('yields separate generations for different model turns', async () => {
      const turn1 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'First' }],
          usage: { input_tokens: 50, output_tokens: 10 },
          stop_reason: 'end_turn',
        },
      };
      const turn2 = {
        type: 'assistant',
        message: {
          id: 'msg_02def',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'Second' }],
          usage: { input_tokens: 60, output_tokens: 15 },
          stop_reason: 'end_turn',
        },
      };

      expect(await collectMessages([turn1, turn2])).toStrictEqual([
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'First',
          toolCalls: [],
          usage: { inputTokens: 50, outputTokens: 10 },
          stopReason: 'end_turn',
          raw: turn1,
        },
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'Second',
          toolCalls: [],
          usage: { inputTokens: 60, outputTokens: 15 },
          stopReason: 'end_turn',
          raw: turn2,
        },
      ]);
    });

    it('flushes pending generation before non-assistant messages', async () => {
      const assistant = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
          stop_reason: 'tool_use',
        },
      };
      const toolResult = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'file list',
            },
          ],
        },
      };

      const result = await collectMessages([assistant, toolResult]);

      expect(result).toHaveLength(2);
      expect(result[0]).toStrictEqual({
        type: 'generation',
        model: 'claude-sonnet',
        text: '',
        toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
        usage: { inputTokens: 50, outputTokens: 10 },
        stopReason: 'tool_use',
        raw: assistant,
      });
      expect(result[1]).toStrictEqual({
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'file list',
        isError: false,
        raw: toolResult,
      });
    });

    it('concatenates text from multiple emissions of the same turn', async () => {
      const emission1 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'Hello ' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: null,
        },
      };
      const emission2 = {
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'world' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        },
      };

      expect(await collectMessages([emission1, emission2])).toStrictEqual([
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'Hello world',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end_turn',
          raw: emission2,
        },
      ]);
    });

    it('yields immediately when inner message has no id', async () => {
      const raw = {
        type: 'assistant',
        message: {
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'no id' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        },
      };

      expect(await collectMessages([raw])).toStrictEqual([
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'no id',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end_turn',
          raw,
        },
      ]);
    });
  });
});
