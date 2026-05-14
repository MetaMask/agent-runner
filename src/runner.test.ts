import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageHandlerError, TelemetryConfigurationError } from './errors.js';
import { createAgentRunner } from './runner.js';
import type {
  AgentMessage,
  AgentRunResult,
  JudgeConfig,
  JudgeResult,
  ProviderAdapter,
  ScoreEntry,
} from './types.js';

const judgeMocks = vi.hoisted(() => ({
  executeJudge: vi.fn(),
}));

const scoringMocks = vi.hoisted(() => ({
  postScores: vi.fn(),
}));

vi.mock('./judge.js', () => ({
  executeJudge: judgeMocks.executeJudge,
}));

vi.mock('./scoring.js', () => ({
  postScores: scoringMocks.postScores,
}));

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

  describe('judge', () => {
    const judgeRunResult: AgentRunResult = {
      messages: [
        { type: 'init', sessionId: 'sess-1', model: 'mock-model', tools: [] },
        { type: 'result', success: true, costUsd: 0.01 },
      ],
      resultMessage: { type: 'result', success: true, costUsd: 0.01 },
      sessionId: 'sess-1',
      traceId: 'trace-abc',
      totalCostUsd: 0.01,
      durationMs: 100,
      isPartial: false,
      metadata: {
        startedAt: '2025-01-01T00:00:00Z',
        endedAt: '2025-01-01T00:00:01Z',
        messageCount: 2,
      },
    };

    const judgeConfig: JudgeConfig = {
      rubric: 'Evaluate quality.',
      scoreFields: [
        { name: 'quality', min: 0, max: 10 },
        { name: 'accuracy', min: 0, max: 5 },
      ],
    };

    const judgeResult: JudgeResult = {
      scores: { quality: 8, accuracy: 4 },
      reasoning: 'Solid work.',
      raw: '{"quality":8,"accuracy":4,"reasoning":"Solid work."}',
    };

    beforeEach(() => {
      vi.clearAllMocks();
      judgeMocks.executeJudge.mockResolvedValue(judgeResult);
      scoringMocks.postScores.mockResolvedValue(undefined);
    });

    it('returns the judge evaluation result', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({ adapter });

      const result = await runner.judge(judgeRunResult, judgeConfig);

      expect(result).toStrictEqual(judgeResult);
      expect(judgeMocks.executeJudge).toHaveBeenCalledWith(
        judgeRunResult,
        judgeConfig,
        undefined,
        undefined,
      );
    });

    it('forwards context to executeJudge', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({ adapter });
      const context = { taskPrompt: 'Fix the bug', status: 'success' };

      await runner.judge(judgeRunResult, judgeConfig, context);

      expect(judgeMocks.executeJudge).toHaveBeenCalledWith(
        judgeRunResult,
        judgeConfig,
        context,
        undefined,
      );
    });

    it('does not post scores when postScores option is not set', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({
        adapter,
        telemetry: {
          mode: 'enabled',
          publicKey: 'pk-test',
          secretKey: 'sk-test',
          baseUrl: 'https://langfuse.example.com',
        },
      });

      await runner.judge(judgeRunResult, judgeConfig);

      expect(scoringMocks.postScores).not.toHaveBeenCalled();
    });

    it('does not post scores when telemetry is disabled', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({
        adapter,
        telemetry: { mode: 'disabled' },
      });

      await runner.judge(judgeRunResult, judgeConfig, undefined, {
        postScores: true,
      });

      expect(scoringMocks.postScores).not.toHaveBeenCalled();
    });

    it('does not post scores when traceId is missing', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({ adapter });
      const resultWithoutTrace = { ...judgeRunResult, traceId: undefined };

      await runner.judge(resultWithoutTrace, judgeConfig, undefined, {
        postScores: true,
      });

      expect(scoringMocks.postScores).not.toHaveBeenCalled();
    });

    it('posts judge-prefixed scores when postScores option is true', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({
        adapter,
        telemetry: {
          mode: 'enabled',
          publicKey: 'pk-test',
          secretKey: 'sk-test',
          baseUrl: 'https://langfuse.example.com',
        },
      });

      await runner.judge(judgeRunResult, judgeConfig, undefined, {
        postScores: true,
      });

      expect(scoringMocks.postScores).toHaveBeenCalledOnce();
      const [traceId, entries, telConfig] = scoringMocks.postScores.mock
        .calls[0] as [string, ScoreEntry[], unknown];
      expect(traceId).toBe('trace-abc');
      expect(entries).toStrictEqual([
        { name: 'judge_quality', value: 8, comment: 'Solid work.' },
        { name: 'judge_accuracy', value: 4, comment: 'Solid work.' },
      ]);
      expect(telConfig).toStrictEqual(
        expect.objectContaining({ mode: 'enabled' }),
      );
    });
  });

  describe('postScores', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      scoringMocks.postScores.mockResolvedValue(undefined);
    });

    it('delegates to the scoring module', async () => {
      const { adapter } = createMockAdapter();
      const runner = createAgentRunner({ adapter });
      const runResult: AgentRunResult = {
        messages: [],
        sessionId: 'sess-1',
        traceId: 'trace-xyz',
        totalCostUsd: 0,
        durationMs: 0,
        isPartial: false,
        metadata: {
          startedAt: '2025-01-01T00:00:00Z',
          endedAt: '2025-01-01T00:00:01Z',
          messageCount: 0,
        },
      };
      const scores: ScoreEntry[] = [{ name: 'custom', value: 7 }];

      await runner.postScores(runResult, scores);

      expect(scoringMocks.postScores).toHaveBeenCalledWith(
        'trace-xyz',
        scores,
        undefined,
      );
    });
  });
});
