import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage, ProviderAdapter } from '../types.js';

const telemetryMocks = vi.hoisted(() => ({
  forceFlush: vi.fn<() => Promise<void>>(async () => undefined),
  shutdown: vi.fn<() => Promise<void>>(async () => undefined),
  start: vi.fn<() => void>(() => undefined),
  setLangfuseProcessor: vi.fn<(processor: object | undefined) => void>(
    () => undefined,
  ),
  langfuseSpanProcessorConfigs: [] as object[],
  nodeSdkConfigs: [] as object[],
  messageHandlerConfigs: [] as object[],
}));

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class LangfuseSpanProcessor {
    /**
     * Mock LangfuseSpanProcessor constructor.
     *
     * @param config - The span processor configuration.
     */
    public constructor(config: object) {
      telemetryMocks.langfuseSpanProcessorConfigs.push(config);
    }

    public forceFlush = telemetryMocks.forceFlush;
  },
}));

vi.mock('@opentelemetry/resources', () => ({
  /**
   * Mock resource factory.
   *
   * @param attributes - The resource attributes.
   * @returns A mock resource wrapping the attributes.
   */
  resourceFromAttributes: (attributes: object): object => ({ attributes }),
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class NodeSDK {
    /**
     * Mock NodeSDK constructor.
     *
     * @param config - The SDK configuration.
     */
    public constructor(config: object) {
      telemetryMocks.nodeSdkConfigs.push(config);
    }

    public shutdown = telemetryMocks.shutdown;

    public start = telemetryMocks.start;
  },
}));

vi.mock('../telemetry/tracing.js', () => ({
  setLangfuseProcessor: telemetryMocks.setLangfuseProcessor,
  traceSpan: vi.fn(),
  createSessionSpan: vi.fn(),
  setOtelAttrs: vi.fn(),
  isTracingEnabled: vi.fn(() => false),
  flushTracing: vi.fn(async () => undefined),
}));

vi.mock('../telemetry/message-handler.js', () => ({
  createMessageHandler: vi.fn((config: object) => {
    telemetryMocks.messageHandlerConfigs.push(config);
    return {
      handleMessage: vi.fn(),
      recordError: vi.fn(),
      finalizePendingTools: vi.fn(),
      finalizeSessionSpan: vi.fn(),
      getState: vi.fn(() => ({ traceId: undefined })),
    };
  }),
}));

/** Mock adapter with captured run calls for test assertions. */
type MockAdapter = {
  /** Captured adapter run call arguments. */
  runCalls: unknown[];
  /** Provider adapter under test. */
  adapter: ProviderAdapter;
};

const initMessage: AgentMessage = {
  type: 'init',
  sessionId: 'telemetry-session',
  model: 'mock-model',
  tools: [],
};

const resultMessage: AgentMessage = {
  type: 'result',
  success: true,
  costUsd: 0.1,
};

/**
 * Creates a mock adapter for telemetry testing.
 *
 * @param messages - Messages emitted by the adapter.
 * @param getRunMetadata - Optional provider metadata hook.
 * @returns The mock adapter and recorded run calls.
 */
const createMockAdapter = (
  messages: AgentMessage[] = [initMessage, resultMessage],
  getRunMetadata?: ProviderAdapter['getRunMetadata'],
): MockAdapter => {
  const runCalls: unknown[] = [];
  const adapter: ProviderAdapter = {
    name: 'mock',
    /**
     * Mock adapter run generator.
     *
     * @param config - The run config.
     * @yields Configured agent messages.
     */
    async *run(config): AsyncGenerator<AgentMessage> {
      runCalls.push(config);
      for (const message of messages) {
        yield message;
      }
    },
    ...(getRunMetadata === undefined ? {} : { getRunMetadata }),
  };

  return { runCalls, adapter };
};

describe('telemetry lifecycle', () => {
  // eslint-disable-next-line n/no-process-env
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    telemetryMocks.langfuseSpanProcessorConfigs.length = 0;
    telemetryMocks.nodeSdkConfigs.length = 0;
    telemetryMocks.messageHandlerConfigs.length = 0;
    /* eslint-disable n/no-process-env */
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    process.env.LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
    /* eslint-enable n/no-process-env */
  });

  afterEach(() => {
    // eslint-disable-next-line n/no-process-env
    process.env = { ...originalEnv };
  });

  it('starts telemetry and delegates flush and shutdown', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    expect(runner.enabled).toBe(true);
    expect(telemetryMocks.start).toHaveBeenCalledOnce();
    expect(telemetryMocks.langfuseSpanProcessorConfigs).toStrictEqual([
      {
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://cloud.langfuse.com',
      },
    ]);
    expect(telemetryMocks.setLangfuseProcessor).toHaveBeenCalledWith(
      expect.objectContaining({ forceFlush: telemetryMocks.forceFlush }),
    );

    await runner.flush();
    await runner.shutdown();

    expect(telemetryMocks.forceFlush).toHaveBeenCalledOnce();
    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMocks.setLangfuseProcessor).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it('treats flush after shutdown as a no-op', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    await runner.shutdown();
    expect(await runner.flush()).toBeUndefined();

    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMocks.forceFlush).not.toHaveBeenCalled();
  });

  it('passes run config through the injected adapter when telemetry is enabled', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { runCalls, adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: 'instrumented run' });

    expect(result.sessionId).toBe('telemetry-session');
    expect(runCalls).toStrictEqual([
      {
        prompt: 'instrumented run',
        options: {},
      },
    ]);

    await runner.shutdown();
  });

  it('does not prepare adapter metadata when telemetry is disabled', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const getRunMetadata = vi.fn(() => ({ model: 'unused' }));
    const { adapter } = createMockAdapter(undefined, getRunMetadata);
    const runner = createAgentRunner({ adapter });

    const result = await runner.runAgent({ prompt: 'plain run' });

    expect(result.isPartial).toBe(false);
    expect(getRunMetadata).not.toHaveBeenCalled();
    expect(telemetryMocks.messageHandlerConfigs).toStrictEqual([]);
  });

  it('passes non-JSON prompts to the adapter when telemetry is disabled', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const runCalls: unknown[] = [];
    const adapter: ProviderAdapter<object, { value: bigint }> = {
      name: 'bigint-prompt',
      /**
       * Captures the generic prompt without serializing it.
       *
       * @param config - Generic provider run configuration.
       * @yields The normalized result message.
       */
      async *run(config): AsyncGenerator<AgentMessage> {
        runCalls.push(config);
        yield resultMessage;
      },
    };
    const runner = createAgentRunner({ adapter });
    const prompt = { value: 1n };

    const result = await runner.runAgent({ prompt });

    expect(result.isPartial).toBe(false);
    expect(runCalls).toStrictEqual([{ prompt, options: {} }]);
  });

  it('uses adapter-owned run metadata for telemetry', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter(undefined, () => ({
      model: 'provider-model',
      maxTurns: 6,
    }));
    const getRunMetadata = vi.spyOn(adapter, 'getRunMetadata');
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    await runner.runAgent({ prompt: 'instrumented run' });

    expect(getRunMetadata).toHaveBeenCalledWith({});
    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ model: 'provider-model', maxTurns: 6 }),
    );

    await runner.shutdown();
  });

  it('uses neutral telemetry fallbacks when adapter metadata is unavailable', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    await runner.runAgent({ prompt: 'instrumented run' });

    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ model: 'unknown', maxTurns: 0 }),
    );

    await runner.shutdown();
  });

  it('continues when adapter metadata extraction throws', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const getRunMetadata = vi.fn(() => {
      throw new Error('metadata failure');
    });
    const { adapter, runCalls } = createMockAdapter(undefined, getRunMetadata);
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: 'instrumented run' });

    expect(result.isPartial).toBe(false);
    expect(runCalls).toHaveLength(1);
    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ model: 'unknown', maxTurns: 0 }),
    );

    await runner.shutdown();
  });

  it('uses a safe telemetry prompt for non-JSON values', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const adapter: ProviderAdapter<object, { value: bigint }> = {
      name: 'bigint-prompt',
      /**
       * Emits a successful result for the generic prompt.
       *
       * @yields The normalized result message.
       */
      async *run(): AsyncGenerator<AgentMessage> {
        yield resultMessage;
      },
    };
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: { value: 1n } });

    expect(result.isPartial).toBe(false);
    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ prompt: '[object Object]' }),
    );

    await runner.shutdown();
  });

  it('serializes object prompts for telemetry when possible', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const adapter: ProviderAdapter<object, { task: string }> = {
      name: 'object-prompt',
      /**
       * Emits a successful result for the generic prompt.
       *
       * @yields The normalized result message.
       */
      async *run(): AsyncGenerator<AgentMessage> {
        yield resultMessage;
      },
    };
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: { task: 'inspect' } });

    expect(result.isPartial).toBe(false);
    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ prompt: '{"task":"inspect"}' }),
    );

    await runner.shutdown();
  });

  it('uses a neutral telemetry prompt when serialization and string conversion throw', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const adapter: ProviderAdapter<object, object> = {
      name: 'throwing-prompt',
      /**
       * Emits a successful result for the generic prompt.
       *
       * @yields The normalized result message.
       */
      async *run(): AsyncGenerator<AgentMessage> {
        yield resultMessage;
      },
    };
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });
    const prompt = {
      /** Throws during JSON serialization. */
      toJSON(): never {
        throw new Error('cannot serialize');
      },
      /** Throws during fallback string conversion. */
      toString(): never {
        throw new Error('cannot stringify');
      },
    };

    const result = await runner.runAgent({ prompt });

    expect(result.isPartial).toBe(false);
    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ prompt: '[unserializable prompt]' }),
    );

    await runner.shutdown();
  });

  it('falls back only missing adapter metadata fields', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter(undefined, () => ({ maxTurns: 4 }));
    vi.spyOn(adapter, 'getRunMetadata');
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    await runner.runAgent({ prompt: 'instrumented run' });

    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ model: 'unknown', maxTurns: 4 }),
    );

    await runner.shutdown();
  });

  it('preserves an adapter model while defaulting missing max turns', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter(undefined, () => ({
      model: 'provider-model',
    }));
    vi.spyOn(adapter, 'getRunMetadata');
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    await runner.runAgent({ prompt: 'instrumented run' });

    expect(telemetryMocks.messageHandlerConfigs).toContainEqual(
      expect.objectContaining({ model: 'provider-model', maxTurns: 0 }),
    );

    await runner.shutdown();
  });

  it('returns partial result when agent run fails under telemetry', async () => {
    const { createAgentRunner } = await import('../runner.js');
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
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({
      prompt: 'failing run',
      telemetry: { traceName: 'fail-trace' },
    });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(adapterError);

    await runner.shutdown();
  });

  it('does not mark successful runs as partial under telemetry', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({
      prompt: 'success run',
      telemetry: { traceName: 'success-trace' },
    });

    expect(result.isPartial).toBe(false);
    expect(result.error).toBeUndefined();

    await runner.shutdown();
  });

  it('shares telemetry infra when two runners use the same config', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter: adapterA } = createMockAdapter();
    const { adapter: adapterB } = createMockAdapter();

    const runnerA = createAgentRunner({
      adapter: adapterA,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });
    const runnerB = createAgentRunner({
      adapter: adapterB,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    expect(runnerA.enabled).toBe(true);
    expect(runnerB.enabled).toBe(true);
    expect(telemetryMocks.start).toHaveBeenCalledOnce();
    expect(telemetryMocks.setLangfuseProcessor).toHaveBeenCalledTimes(2);

    await runnerB.shutdown();
    expect(telemetryMocks.shutdown).not.toHaveBeenCalled();

    await runnerA.shutdown();
    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMocks.setLangfuseProcessor).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it('rejects a second runner with a different telemetry config', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();

    createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    expect(() =>
      createAgentRunner({
        adapter,
        telemetry: { mode: 'enabled', serviceName: 'different-service' },
      }),
    ).toThrow(
      'Telemetry infrastructure already exists with a different configuration',
    );
  });

  it('propagates shutdown rejection and allows new infra to be created', async () => {
    const shutdownError = new Error('OTel shutdown failed');
    telemetryMocks.shutdown.mockRejectedValueOnce(shutdownError);

    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();
    const runner = createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    await expect(runner.shutdown()).rejects.toThrow('OTel shutdown failed');

    // Controller is marked shut down — second call is a no-op, does not reject.
    expect(await runner.shutdown()).toBeUndefined();

    // sharedInfra was cleared before the await, so a new runner can start fresh infra.
    telemetryMocks.shutdown.mockResolvedValueOnce(undefined);
    const { adapter: adapter2 } = createMockAdapter();
    const runner2 = createAgentRunner({
      adapter: adapter2,
      telemetry: { mode: 'enabled' },
    });
    expect(runner2.enabled).toBe(true);
    expect(telemetryMocks.start).toHaveBeenCalledTimes(2);

    await runner2.shutdown();
  });

  it('always validates config even when shared infra exists', async () => {
    const { createAgentRunner } = await import('../runner.js');
    const { adapter } = createMockAdapter();

    createAgentRunner({
      adapter,
      telemetry: { mode: 'enabled' },
    });

    /* eslint-disable n/no-process-env */
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    /* eslint-enable n/no-process-env */

    expect(() =>
      createAgentRunner({
        adapter,
        telemetry: { mode: 'enabled' },
      }),
    ).toThrow(
      'Telemetry is enabled but required Langfuse configuration is missing',
    );
  });
});
