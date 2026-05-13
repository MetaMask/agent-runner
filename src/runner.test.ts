import { describe, expect, it } from 'vitest';

import { MessageHandlerError, TelemetryConfigurationError } from './errors.js';
import { createAgentRunner } from './runner.js';
import type { AgentMessage, ProviderAdapter } from './types.js';

/** Mock adapter with captured run call arguments. */
type MockAdapter = {
  /** The mock provider adapter. */
  adapter: ProviderAdapter;
  /** Recorded adapter run call arguments. */
  runCalls: unknown[];
};

const initMessage: AgentMessage = {
  type: 'init',
  sessionId: 'session-123',
  model: 'mock-model',
  tools: [],
};
const generationMessage: AgentMessage = {
  type: 'generation',
  model: 'mock-model',
  text: 'hello',
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: null,
};
const resultMessage = {
  type: 'result',
  success: true,
  costUsd: 0.25,
} satisfies AgentMessage;

/**
 * Creates a mock provider adapter for testing.
 *
 * @param messages - Messages to yield from the mock run generator.
 * @returns The mock adapter and recorded run calls.
 */
const createMockAdapter = (
  messages: AgentMessage[] = [initMessage, generationMessage, resultMessage],
): MockAdapter => {
  const runCalls: unknown[] = [];
  const adapter: ProviderAdapter = {
    name: 'mock',
    /**
     * Mock run generator.
     *
     * @param config - The run config.
     * @yields Agent messages from the provided array.
     */
    async *run(config): AsyncGenerator<AgentMessage> {
      runCalls.push(config);
      for (const message of messages) {
        yield message;
      }
    },
  };

  return { adapter, runCalls };
};

describe('createAgentRunner', () => {
  it('defaults to isolated settingSources', async () => {
    const { adapter, runCalls } = createMockAdapter();
    const runner = createAgentRunner({ adapter });

    await runner.runAgent({ prompt: 'test prompt' });

    expect(runCalls).toStrictEqual([
      {
        prompt: 'test prompt',
        options: { settingSources: [] },
      },
    ]);
  });

  it('lets caller override default settings', async () => {
    const { adapter, runCalls } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      defaultOptions: { maxTurns: 2, settingSources: [] },
    });

    await runner.runAgent({
      prompt: 'test prompt',
      options: { maxTurns: 4, settingSources: ['user'] },
    });

    expect(runCalls).toStrictEqual([
      {
        prompt: 'test prompt',
        options: { maxTurns: 4, settingSources: ['user'] },
      },
    ]);
  });

  it('aggregates messages and extracts result metadata', async () => {
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.messages).toStrictEqual([
      initMessage,
      generationMessage,
      resultMessage,
    ]);
    expect(result.resultMessage).toStrictEqual(resultMessage);
    expect(result.sessionId).toBe('session-123');
    expect(result.totalCostUsd).toBe(0.25);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.messageCount).toBe(3);
  });

  it('streams each collected message through onMessage', async () => {
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({ adapter });
    const streamed: AgentMessage[] = [];

    await runner.runAgent({
      prompt: 'test prompt',
      /**
       * Collects streamed messages.
       *
       * @param message - The streamed agent message.
       */
      onMessage: (message) => {
        streamed.push(message);
      },
    });

    expect(streamed).toStrictEqual([
      initMessage,
      generationMessage,
      resultMessage,
    ]);
  });

  it('does not require Langfuse env vars when telemetry is disabled', () => {
    expect(() =>
      createAgentRunner({ telemetry: { mode: 'disabled' } }),
    ).not.toThrow();
    expect(() => createAgentRunner()).not.toThrow();
  });

  it('throws validation error when telemetry is enabled without Langfuse config', () => {
    /* eslint-disable n/no-process-env */
    const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;
    const originalBaseUrl = process.env.LANGFUSE_BASE_URL;
    /* eslint-enable n/no-process-env */

    /* eslint-disable n/no-process-env */
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    /* eslint-enable n/no-process-env */

    try {
      expect(() =>
        createAgentRunner({ telemetry: { mode: 'enabled' } }),
      ).toThrow(TelemetryConfigurationError);
    } finally {
      /* eslint-disable n/no-process-env */
      process.env.LANGFUSE_PUBLIC_KEY = originalPublicKey;
      process.env.LANGFUSE_SECRET_KEY = originalSecretKey;
      process.env.LANGFUSE_BASE_URL = originalBaseUrl;
      /* eslint-enable n/no-process-env */
    }
  });

  it('flush and shutdown are callable in disabled mode', async () => {
    const runner = createAgentRunner({ telemetry: { mode: 'disabled' } });

    expect(await runner.flush()).toBeUndefined();
    expect(await runner.shutdown()).toBeUndefined();
  });

  it('returns partial result with MessageHandlerError when onMessage throws an Error', async () => {
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({ adapter });
    const handlerError = new Error('handler broke');

    const result = await runner.runAgent({
      prompt: 'test prompt',
      /**
       *
       */
      onMessage: () => {
        throw handlerError;
      },
    });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBeInstanceOf(MessageHandlerError);
    expect(result.error?.cause).toBe(handlerError);
    expect(result.messages).toStrictEqual([initMessage]);
  });

  it('wraps non-Error values thrown by onMessage in MessageHandlerError', async () => {
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({
      prompt: 'test prompt',
      /**
       *
       */
      onMessage: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string failure';
      },
    });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBeInstanceOf(MessageHandlerError);
    expect((result.error?.cause as Error).message).toBe('string failure');
  });

  it('returns partial result with adapter error when run throws', async () => {
    const adapterError = new Error('Adapter connection failed');
    const adapter: ProviderAdapter = {
      name: 'mock',
      /**
       * Mock run that throws immediately.
       *
       * @param _config - The run config (unused).
       */
      // eslint-disable-next-line require-yield
      async *run(_config): AsyncGenerator<AgentMessage> {
        throw adapterError;
      },
    };
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(adapterError);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.messages).toStrictEqual([]);
  });

  it('returns partial result with adapter error when run throws mid-stream', async () => {
    const adapterError = new Error('Adapter mid-stream failure');
    const adapter: ProviderAdapter = {
      name: 'mock',
      /**
       * Mock run that yields then throws.
       *
       * @param _config - The run config (unused).
       * @yields A single init message before throwing.
       */
      async *run(_config): AsyncGenerator<AgentMessage> {
        yield initMessage;
        throw adapterError;
      },
    };
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(adapterError);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.messages).toStrictEqual([initMessage]);
  });

  it('returns success with no resultMessage when stream has no result message', async () => {
    const nonResultMessage: AgentMessage = {
      type: 'generation',
      model: 'mock-model',
      text: 'hello without result',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: null,
    };
    const { adapter } = createMockAdapter([nonResultMessage]);
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.resultMessage).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.totalCostUsd).toBeUndefined();
    expect(result.messages).toStrictEqual([nonResultMessage]);
    expect(result.metadata.messageCount).toBe(1);
  });

  it('wraps non-Error values thrown by adapter in AgentRunnerError', async () => {
    const adapter: ProviderAdapter = {
      name: 'mock',
      /**
       * Mock run that throws a non-Error value.
       *
       * @param _config - The run config (unused).
       */
      // eslint-disable-next-line require-yield
      async *run(_config): AsyncGenerator<AgentMessage> {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'raw string adapter error';
      },
    };
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.error?.message).toBe('raw string adapter error');
  });
});
