import { describe, expect, it } from 'vitest';

import { MessageHandlerError, TelemetryConfigurationError } from './errors.js';
import { createAgentRunner } from './runner.js';
import type { ClaudeSdkQueryModule, SdkMessage } from './types.js';

/** Mock SDK with captured query call arguments. */
type MockSdk = {
  /** The mock SDK module. */
  sdkModule: ClaudeSdkQueryModule;
  /** Recorded query call arguments. */
  queryCalls: unknown[];
};

const userMessage = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
} as SdkMessage;
const resultMessage = {
  type: 'result',
  subtype: 'success',
  session_id: 'session-123',
  total_cost_usd: 0.25,
} as SdkMessage;

/**
 * Creates a mock SDK module for testing.
 *
 * @param messages - Messages to yield from the mock query generator.
 * @returns The mock SDK module and recorded query calls.
 */
const createMockSdk = (
  messages: SdkMessage[] = [userMessage, resultMessage],
): MockSdk => {
  const queryCalls: unknown[] = [];
  const sdkModule: ClaudeSdkQueryModule = {
    /**
     * Mock query generator.
     *
     * @param input - The query input.
     * @yields SDK messages from the provided array.
     */
    async *query(input: unknown): AsyncGenerator<SdkMessage> {
      queryCalls.push(input);
      for (const message of messages) {
        yield message;
      }
    },
  } as ClaudeSdkQueryModule;

  return { sdkModule, queryCalls };
};

describe('createAgentRunner', () => {
  it('defaults to isolated settingSources', async () => {
    const { sdkModule, queryCalls } = createMockSdk();
    const runner = createAgentRunner({ sdkModule });

    await runner.runAgent({ prompt: 'test prompt' });

    expect(queryCalls).toStrictEqual([
      {
        prompt: 'test prompt',
        options: { settingSources: [] },
      },
    ]);
  });

  it('lets caller override default settings', async () => {
    const { sdkModule, queryCalls } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
      defaultOptions: { maxTurns: 2, settingSources: [] },
    });

    await runner.runAgent({
      prompt: 'test prompt',
      options: { maxTurns: 4, settingSources: ['user'] },
    });

    expect(queryCalls).toStrictEqual([
      {
        prompt: 'test prompt',
        options: { maxTurns: 4, settingSources: ['user'] },
      },
    ]);
  });

  it('aggregates messages and extracts result metadata', async () => {
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({ sdkModule });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.messages).toStrictEqual([userMessage, resultMessage]);
    expect(result.resultMessage).toStrictEqual(resultMessage);
    expect(result.sessionId).toBe('session-123');
    expect(result.totalCostUsd).toBe(0.25);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.messageCount).toBe(2);
  });

  it('streams each collected message through onMessage', async () => {
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({ sdkModule });
    const streamed: SdkMessage[] = [];

    await runner.runAgent({
      prompt: 'test prompt',
      /**
       * Collects streamed messages.
       *
       * @param message - The streamed SDK message.
       */
      onMessage: (message) => {
        streamed.push(message);
      },
    });

    expect(streamed).toStrictEqual([userMessage, resultMessage]);
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
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({ sdkModule });
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
    expect(result.messages).toStrictEqual([userMessage]);
  });

  it('wraps non-Error values thrown by onMessage in MessageHandlerError', async () => {
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({ sdkModule });

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

  it('returns partial result with SDK error when query throws', async () => {
    const sdkError = new Error('SDK connection failed');
    const sdkModule = {
      /**
       * Mock query that throws immediately.
       *
       * @param _input - The query input (unused).
       */
      // eslint-disable-next-line require-yield
      async *query(_input: unknown): AsyncGenerator<SdkMessage> {
        throw sdkError;
      },
    } as ClaudeSdkQueryModule;
    const runner = createAgentRunner({ sdkModule });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(sdkError);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.messages).toStrictEqual([]);
  });

  it('returns partial result with SDK error when query throws mid-stream', async () => {
    const sdkError = new Error('SDK mid-stream failure');
    const sdkModule = {
      /**
       * Mock query that yields then throws.
       *
       * @param _input - The query input (unused).
       * @yields A single user message before throwing.
       */
      async *query(_input: unknown): AsyncGenerator<SdkMessage> {
        yield userMessage;
        throw sdkError;
      },
    } as ClaudeSdkQueryModule;
    const runner = createAgentRunner({ sdkModule });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(sdkError);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.messages).toStrictEqual([userMessage]);
  });

  it('returns success with no resultMessage when stream has no result message', async () => {
    const nonResultMessage = {
      type: 'assistant',
      content: 'hello',
    } as unknown as SdkMessage;
    const { sdkModule } = createMockSdk([userMessage, nonResultMessage]);
    const runner = createAgentRunner({ sdkModule });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.resultMessage).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.totalCostUsd).toBeUndefined();
    expect(result.messages).toStrictEqual([userMessage, nonResultMessage]);
    expect(result.metadata.messageCount).toBe(2);
  });

  it('wraps non-Error values thrown by query in AgentRunnerError', async () => {
    const sdkModule = {
      /**
       * Mock query that throws a non-Error value.
       *
       * @param _input - The query input (unused).
       */
      // eslint-disable-next-line require-yield
      async *query(_input: unknown): AsyncGenerator<SdkMessage> {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'raw string SDK error';
      },
    } as ClaudeSdkQueryModule;
    const runner = createAgentRunner({ sdkModule });

    const result = await runner.runAgent({ prompt: 'test prompt' });

    expect(result.isPartial).toBe(true);
    expect(result.error).not.toBeInstanceOf(MessageHandlerError);
    expect(result.error?.message).toBe('raw string SDK error');
  });
});
