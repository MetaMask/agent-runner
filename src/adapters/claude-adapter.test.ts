import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage, DockerSandboxConfig } from '../types.js';
import { createClaudeAdapter } from './claude-adapter.js';

const claudeMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeMocks.query,
}));

const sandboxMocks = vi.hoisted(() => ({
  createDefaultDockerCommandRunner: vi.fn(),
  createDockerSandbox: vi.fn(),
  runDockerClaudeBridge: vi.fn(),
}));

vi.mock('../sandbox/docker/command-runner.js', () => ({
  createDefaultDockerCommandRunner:
    sandboxMocks.createDefaultDockerCommandRunner,
}));

vi.mock('../sandbox/docker/lifecycle.js', () => ({
  createDockerSandbox: sandboxMocks.createDockerSandbox,
}));

vi.mock('../sandbox/docker/bridge.js', () => ({
  runDockerClaudeBridge: sandboxMocks.runDockerClaudeBridge,
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
async function collectMessages(
  messages: SdkMessage[],
): Promise<AgentMessage[]> {
  claudeMocks.query.mockReturnValueOnce(yieldMessages(messages));
  const adapter = createClaudeAdapter();
  const translated: AgentMessage[] = [];

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
      options: { maxTurns: 2, settingSources: [] },
    });
  });

  it('extracts Claude run metadata from provider options', () => {
    const adapter = createClaudeAdapter();

    expect(
      adapter.getRunMetadata?.({ model: 'claude-opus', maxTurns: 7 }),
    ).toStrictEqual({ model: 'claude-opus', maxTurns: 7 });
    expect(adapter.getRunMetadata?.({ model: 'claude-opus' })).toStrictEqual({
      model: 'claude-opus',
      maxTurns: 0,
    });
    expect(adapter.getRunMetadata?.({ maxTurns: 7 })).toStrictEqual({
      model: 'unknown',
      maxTurns: 7,
    });
    expect(adapter.getRunMetadata?.({})).toStrictEqual({
      model: 'unknown',
      maxTurns: 0,
    });
  });

  it('lets callers override the isolated settings default without mutating options', async () => {
    claudeMocks.query.mockReturnValueOnce(yieldMessages([]));
    const options = {
      maxTurns: 2,
      settingSources: ['user'] satisfies ('user' | 'project' | 'local')[],
    };
    const snapshot = structuredClone(options);

    const adapter = createClaudeAdapter();
    await collectAsyncIterable(adapter.run({ prompt: 'run this', options }));

    expect(claudeMocks.query).toHaveBeenCalledWith({
      prompt: 'run this',
      options: { maxTurns: 2, settingSources: ['user'] },
    });
    expect(options).toStrictEqual(snapshot);
  });

  it('runs structured queries with overridable defaults and locked contract fields', async () => {
    const structuredData = { score: 8 };
    const raw = {
      type: 'result',
      subtype: 'success',
      structured_output: structuredData,
    };
    claudeMocks.query.mockReturnValueOnce(yieldMessages([raw]));
    const options = {
      tools: ['Read'],
      maxTurns: 9,
      settingSources: ['project'] satisfies ('user' | 'project' | 'local')[],
      systemPrompt: 'consumer system',
      outputFormat: { type: 'json_schema' as const, schema: {} },
      persistSession: true,
    };
    const snapshot = structuredClone(options);
    const adapter = createClaudeAdapter();
    const messages: unknown[] = [];

    for await (const message of adapter.runStructured?.({
      prompt: 'judge this',
      systemPrompt: 'locked rubric',
      schema: { type: 'object' },
      options,
    }) ?? []) {
      messages.push(message);
    }

    expect(claudeMocks.query).toHaveBeenCalledWith({
      prompt: 'judge this',
      options: {
        tools: ['Read'],
        maxTurns: 9,
        settingSources: ['project'],
        systemPrompt: 'locked rubric',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
        persistSession: false,
      },
    });
    expect(messages).toStrictEqual([
      {
        type: 'result',
        success: true,
        result: JSON.stringify(structuredData),
        raw,
      },
    ]);
    expect(options).toStrictEqual(snapshot);
  });

  it('normalizes all serializable structured output values without falling back', async () => {
    const structuredValues = [{ score: 10 }, false, 0, ''];
    const rawMessages = structuredValues.map((structuredOutput) => ({
      type: 'result',
      subtype: 'success',
      result: 'fallback',
      structured_output: structuredOutput,
    }));

    const messages = await collectMessages(rawMessages);

    expect(
      messages.map((message) =>
        message.type === 'result' ? message.result : undefined,
      ),
    ).toStrictEqual(structuredValues.map((value) => JSON.stringify(value)));
  });

  it('falls back to the plain result when structured output cannot be serialized', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rawMessages = [circular, 1n].map((structuredOutput) => ({
      type: 'result',
      subtype: 'success',
      result: 'fallback',
      structured_output: structuredOutput,
    }));

    const messages = await collectMessages(rawMessages);

    expect(
      messages.map((message) =>
        message.type === 'result' ? message.result : undefined,
      ),
    ).toStrictEqual(['fallback', 'fallback']);
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
      errors: ['must be ignored for successful results'],
      total_cost_usd: 0.5,
      num_turns: 3,
      duration_ms: 1000,
    };
    const error = {
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['first failure', '', 'second failure'],
    };
    const subtypeOnlyError = {
      type: 'result',
      subtype: 'error_during_execution',
      errors: [],
    };
    const rateLimit = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning' },
    };

    expect(
      await collectMessages([
        progress,
        summary,
        success,
        error,
        subtypeOnlyError,
        rateLimit,
      ]),
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
      {
        type: 'result',
        success: false,
        error: 'first failure; second failure',
        raw: error,
      },
      {
        type: 'result',
        success: false,
        error: 'error_during_execution',
        raw: subtypeOnlyError,
      },
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

  describe('sandbox path', () => {
    /** Fake handle returned by the mocked Docker lifecycle. */
    type FakeHandle = {
      /** Stub container name exposed to the adapter. */
      containerName: string;
      /** Spyable close hook the adapter calls during cleanup. */
      close: ReturnType<typeof vi.fn>;
      /** Spyable unregister hook the adapter calls when preserving. */
      unregisterCleanup: ReturnType<typeof vi.fn>;
    };

    /**
     * Drains an async iterable into a list of values.
     *
     * @param iterable - The async iterable to drain.
     * @returns The collected values in order.
     */
    const drain = async <Value>(
      iterable: AsyncIterable<Value>,
    ): Promise<Value[]> => {
      const collected: Value[] = [];
      for await (const value of iterable) {
        collected.push(value);
      }
      return collected;
    };

    /**
     * Builds a fake sandbox handle exposing only the fields the adapter
     * touches in the sandbox path.
     *
     * @returns A handle with a spyable `close` method.
     */
    const makeHandle = (): FakeHandle => ({
      containerName: 'sandbox-test',
      close: vi.fn().mockResolvedValue(undefined),
      unregisterCleanup: vi.fn(),
    });

    /**
     * Builds a bridge mock that yields the supplied SDK messages as an
     * async iterable.
     *
     * @param messages - Raw SDK messages to yield.
     * @returns An async-iterable bridge result.
     */
    const makeBridge = (messages: SdkMessage[]): AsyncIterable<unknown> => ({
      /**
       * Yields raw SDK messages.
       *
       * @yields Raw SDK messages.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const message of messages) {
          yield message;
        }
      },
    });

    /**
     * Builds a bridge mock that throws after optionally yielding the
     * supplied messages.
     *
     * @param error - Error to throw.
     * @param messages - Optional messages to yield before throwing.
     * @returns An async-iterable bridge result.
     */
    const makeFailingBridge = (
      error: Error,
      messages: SdkMessage[] = [],
    ): AsyncIterable<unknown> => ({
      /**
       * Yields messages then throws.
       *
       * @yields Raw SDK messages until the error is thrown.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const message of messages) {
          yield message;
        }
        throw error;
      },
    });

    /** Shared Docker sandbox config used by the sandbox-path tests. */
    const baseSandbox: DockerSandboxConfig = {
      type: 'docker',
      workspace: { hostPath: '/tmp/workspace' },
    };

    /** Captured runner returned by the mocked factory. */
    const fakeRunner = { run: vi.fn() };

    beforeEach(() => {
      vi.clearAllMocks();
      fakeRunner.run.mockReset();
      sandboxMocks.createDefaultDockerCommandRunner.mockReturnValue(fakeRunner);
    });

    it('declares Docker sandbox support via capabilities', () => {
      const adapter = createClaudeAdapter();
      expect(adapter.capabilities).toStrictEqual({ sandboxes: ['docker'] });
    });

    it('runs in-process and bypasses the sandbox machinery when no sandbox is set', async () => {
      claudeMocks.query.mockReturnValueOnce(yieldMessages([]));

      const adapter = createClaudeAdapter();
      const translated: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'plain run',
        options: { maxTurns: 1 },
      })) {
        translated.push(message);
      }

      expect(translated).toStrictEqual([]);
      expect(claudeMocks.query).toHaveBeenCalledWith({
        prompt: 'plain run',
        options: { maxTurns: 1, settingSources: [] },
      });
      expect(sandboxMocks.createDockerSandbox).not.toHaveBeenCalled();
      expect(sandboxMocks.runDockerClaudeBridge).not.toHaveBeenCalled();
    });

    it('normalizes, creates the sandbox, runs the bridge, and closes on success', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const bridgeMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 's1',
      };
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeBridge([bridgeMessage]),
      );

      const adapter = createClaudeAdapter();
      const translated: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'sandboxed',
        options: {},
        sandbox: baseSandbox,
      })) {
        translated.push(message);
      }

      expect(translated).toStrictEqual([
        { type: 'init', sessionId: 's1', raw: bridgeMessage },
      ]);

      expect(
        sandboxMocks.createDefaultDockerCommandRunner,
      ).toHaveBeenCalledTimes(1);

      expect(sandboxMocks.createDockerSandbox).toHaveBeenCalledTimes(1);
      const [normalized, lifecycleOptions] = sandboxMocks.createDockerSandbox
        .mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
      expect(normalized.workspace).toStrictEqual({
        hostPath: '/tmp/workspace',
        containerPath: '/workspace',
        readOnly: false,
      });
      expect(normalized.cleanup).toBe('always');
      expect(lifecycleOptions.commandRunner).toBe(fakeRunner);

      expect(sandboxMocks.runDockerClaudeBridge).toHaveBeenCalledTimes(1);
      const bridgeInput = sandboxMocks.runDockerClaudeBridge.mock
        .calls[0]?.[0] as Record<string, unknown>;
      expect(bridgeInput.sandbox).toBe(handle);
      expect(bridgeInput.commandRunner).toBe(fakeRunner);
      expect(bridgeInput.request).toStrictEqual({
        prompt: 'sandboxed',
        options: { settingSources: [] },
      });

      expect(handle.close).toHaveBeenCalledTimes(1);
    });

    it('uses options.cwd as the host cwd when it is a string', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(makeBridge([]));

      const adapter = createClaudeAdapter();
      await drain(
        adapter.run({
          prompt: 'sandboxed',
          options: { cwd: '/tmp/workspace/sub' },
          sandbox: baseSandbox,
        }),
      );

      const bridgeInput = sandboxMocks.runDockerClaudeBridge.mock
        .calls[0]?.[0] as Record<string, unknown>;
      // `options.cwd` lives inside the workspace and is rewritten to its
      // container equivalent by `prepareDockerSandboxRequest`.
      expect(
        (bridgeInput.request as Record<string, unknown>).options,
      ).toStrictEqual({ cwd: '/workspace/sub', settingSources: [] });
    });

    it('does not mutate caller options or sandbox config', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(makeBridge([]));

      const sandbox: DockerSandboxConfig = {
        type: 'docker',
        workspace: { hostPath: '/tmp/workspace' },
        env: { FOO: 'bar' },
      };
      const sandboxSnapshot = structuredClone(sandbox);
      const options = { maxTurns: 3, cwd: '/tmp/workspace' };
      const optionsSnapshot = structuredClone(options);

      const adapter = createClaudeAdapter();
      await drain(
        adapter.run({
          prompt: 'sandboxed',
          options,
          sandbox,
        }),
      );

      expect(sandbox).toStrictEqual(sandboxSnapshot);
      expect(options).toStrictEqual(optionsSnapshot);
    });

    it('closes the container on bridge error when cleanup is `always`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const cause = new Error('bridge boom');
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeFailingBridge(cause),
      );

      const adapter = createClaudeAdapter();

      await expect(
        drain(
          adapter.run({
            prompt: 'sandboxed',
            options: {},
            sandbox: { ...baseSandbox, cleanup: 'always' },
          }),
        ),
      ).rejects.toBe(cause);

      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(handle.unregisterCleanup).not.toHaveBeenCalled();
    });

    it('does not close the container on bridge error when cleanup is `on-success`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const cause = new Error('bridge boom');
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeFailingBridge(cause),
      );

      const adapter = createClaudeAdapter();

      await expect(
        drain(
          adapter.run({
            prompt: 'sandboxed',
            options: {},
            sandbox: { ...baseSandbox, cleanup: 'on-success' },
          }),
        ),
      ).rejects.toBe(cause);

      expect(handle.close).not.toHaveBeenCalled();
      expect(handle.unregisterCleanup).toHaveBeenCalledTimes(1);
    });

    it('closes the container on bridge success when cleanup is `on-success`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(makeBridge([]));

      const adapter = createClaudeAdapter();
      await drain(
        adapter.run({
          prompt: 'sandboxed',
          options: {},
          sandbox: { ...baseSandbox, cleanup: 'on-success' },
        }),
      );

      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(handle.unregisterCleanup).not.toHaveBeenCalled();
    });

    it('re-throws close errors when the bridge run succeeds but cleanup fails', async () => {
      const handle = makeHandle();
      handle.close.mockRejectedValueOnce(new Error('close boom'));
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(makeBridge([]));

      const adapter = createClaudeAdapter();

      await expect(
        drain(
          adapter.run({
            prompt: 'sandboxed',
            options: {},
            sandbox: { ...baseSandbox, cleanup: 'always' },
          }),
        ),
      ).rejects.toThrow('close boom');
    });

    it('closes the container when the consumer breaks early under cleanup `always`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const first = { type: 'system', subtype: 'init', session_id: 's1' };
      const second = { type: 'system', subtype: 'status', status: 'working' };
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeBridge([first, second]),
      );

      const adapter = createClaudeAdapter();
      const collected: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'sandboxed',
        options: {},
        sandbox: { ...baseSandbox, cleanup: 'always' },
      })) {
        collected.push(message);
        break;
      }

      expect(collected).toHaveLength(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(handle.unregisterCleanup).not.toHaveBeenCalled();
    });

    it('closes the container on early break even when cleanup is `on-success`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const first = { type: 'system', subtype: 'init', session_id: 's1' };
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeBridge([first, { type: 'system', subtype: 'status' }]),
      );

      const adapter = createClaudeAdapter();
      const collected: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'sandboxed',
        options: {},
        sandbox: { ...baseSandbox, cleanup: 'on-success' },
      })) {
        collected.push(message);
        break;
      }

      expect(collected).toHaveLength(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(handle.unregisterCleanup).not.toHaveBeenCalled();
    });

    it('closes the container on early break even when cleanup is `never`', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const first = { type: 'system', subtype: 'init', session_id: 's1' };
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeBridge([first, { type: 'system', subtype: 'status' }]),
      );

      const adapter = createClaudeAdapter();
      const collected: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'sandboxed',
        options: {},
        sandbox: { ...baseSandbox, cleanup: 'never' },
      })) {
        collected.push(message);
        break;
      }

      expect(collected).toHaveLength(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(handle.unregisterCleanup).not.toHaveBeenCalled();
    });

    it('does not close the container when cleanup is `never` and the bridge runs to completion', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(makeBridge([]));

      const adapter = createClaudeAdapter();
      await drain(
        adapter.run({
          prompt: 'sandboxed',
          options: {},
          sandbox: { ...baseSandbox, cleanup: 'never' },
        }),
      );

      expect(handle.close).not.toHaveBeenCalled();
      expect(handle.unregisterCleanup).toHaveBeenCalledTimes(1);
    });

    it('translates streamed bridge messages through the SDK translator', async () => {
      const handle = makeHandle();
      sandboxMocks.createDockerSandbox.mockResolvedValueOnce(handle);
      const assistant = {
        type: 'assistant',
        message: {
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        },
      };
      sandboxMocks.runDockerClaudeBridge.mockReturnValueOnce(
        makeBridge([assistant]),
      );

      const adapter = createClaudeAdapter();
      const translated: unknown[] = [];
      for await (const message of adapter.run({
        prompt: 'sandboxed',
        options: {},
        sandbox: baseSandbox,
      })) {
        translated.push(message);
      }

      expect(translated).toStrictEqual([
        {
          type: 'generation',
          model: 'claude-sonnet',
          text: 'hi',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
          raw: assistant,
        },
      ]);
    });
  });
});

/**
 * Drains an async iterable without retaining its values.
 *
 * @param iterable - Iterable to consume.
 */
async function collectAsyncIterable(
  iterable: AsyncIterable<unknown>,
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }
}
