import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSdkQueryModule, SdkMessage } from './types.js';

const telemetryMocks = vi.hoisted(() => ({
  forceFlush: vi.fn<() => Promise<void>>(async () => undefined),
  shutdown: vi.fn<() => Promise<void>>(async () => undefined),
  start: vi.fn<() => void>(() => undefined),
  manuallyInstrument: vi.fn<(sdkModule: object) => void>(() => undefined),
  startActiveObservation: vi.fn(
    async <Result>(_name: string, callback: () => Promise<Result>) =>
      callback(),
  ),
  propagateAttributes: vi.fn(
    async <Result>(_attributes: object, callback: () => Promise<Result>) =>
      callback(),
  ),
  updateActiveObservation: vi.fn<(attributes: object) => void>(() => undefined),
  setStatus: vi.fn<(status: object) => void>(() => undefined),
  recordException: vi.fn<(error: Error) => void>(() => undefined),
  defaultQueryCalls: [] as unknown[],
  langfuseSpanProcessorConfigs: [] as object[],
  nodeSdkConfigs: [] as object[],
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

vi.mock('@langfuse/tracing', () => ({
  propagateAttributes: telemetryMocks.propagateAttributes,
  startActiveObservation: telemetryMocks.startActiveObservation,
  updateActiveObservation: telemetryMocks.updateActiveObservation,
}));

vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: { ERROR: 2 },
  trace: {
    /**
     * Returns a mock active span.
     *
     * @returns A mock span with setStatus and recordException.
     */
    getActiveSpan: (): object => ({
      setStatus: telemetryMocks.setStatus,
      recordException: telemetryMocks.recordException,
    }),
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

vi.mock('@arizeai/openinference-instrumentation-claude-agent-sdk', () => ({
  ClaudeAgentSDKInstrumentation: class ClaudeAgentSDKInstrumentation {
    public manuallyInstrument = telemetryMocks.manuallyInstrument;
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  /**
   * Mock Claude SDK query generator.
   *
   * @param input - The query input.
   * @yields A single result message.
   */
  async *query(input: unknown): AsyncGenerator<object> {
    telemetryMocks.defaultQueryCalls.push(input);
    yield {
      type: 'result',
      subtype: 'success',
      session_id: 'default-sdk-session',
      total_cost_usd: 0.05,
    };
  },
}));

/** Mock SDK module with captured query calls for test assertions. */
type MockSdk = {
  /** Captured SDK query call arguments. */
  queryCalls: unknown[];
  /** Instrumented SDK module under test. */
  sdkModule: ClaudeSdkQueryModule;
};

const resultMessage = {
  type: 'result',
  subtype: 'success',
  session_id: 'telemetry-session',
  total_cost_usd: 0.1,
} as SdkMessage;

/**
 * Creates a mock SDK module for telemetry testing.
 *
 * @returns The mock SDK module and recorded query calls.
 */
const createMockSdk = (): MockSdk => {
  const queryCalls: unknown[] = [];
  const sdkModule: ClaudeSdkQueryModule = {
    /**
     * Mock query generator.
     *
     * @param input - The query input.
     * @yields A single result message.
     */
    async *query(input: unknown): AsyncGenerator<SdkMessage> {
      queryCalls.push(input);
      yield resultMessage;
    },
  } as ClaudeSdkQueryModule;

  return { queryCalls, sdkModule };
};

describe('telemetry lifecycle', () => {
  // eslint-disable-next-line n/no-process-env
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    telemetryMocks.defaultQueryCalls.length = 0;
    telemetryMocks.langfuseSpanProcessorConfigs.length = 0;
    telemetryMocks.nodeSdkConfigs.length = 0;
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
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
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

    await runner.flush();
    await runner.shutdown();

    expect(telemetryMocks.forceFlush).toHaveBeenCalledOnce();
    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
  });

  it('instruments a mutable SDK copy when no sdkModule is injected', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const runner = createAgentRunner({
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: 'instrumented run' });

    expect(result.sessionId).toBe('default-sdk-session');
    expect(telemetryMocks.defaultQueryCalls).toStrictEqual([
      {
        prompt: 'instrumented run',
        options: { settingSources: [] },
      },
    ]);
    expect(telemetryMocks.manuallyInstrument).toHaveBeenCalledOnce();

    const instrumentedModule =
      telemetryMocks.manuallyInstrument.mock.calls[0]?.[0];
    expect(instrumentedModule).toBeDefined();
    expect(instrumentedModule).toHaveProperty('query');
  });

  it('skips instrumentation when sdkModule is injected', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { queryCalls, sdkModule } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({ prompt: 'injected run' });

    expect(result.sessionId).toBe('telemetry-session');
    expect(queryCalls).toStrictEqual([
      {
        prompt: 'injected run',
        options: { settingSources: [] },
      },
    ]);
    expect(telemetryMocks.manuallyInstrument).not.toHaveBeenCalled();
  });

  it('propagates Langfuse run attributes around the agent execution', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    await runner.runAgent({
      prompt: 'tagged run',
      telemetry: {
        traceName: 'metamask-agent-eval',
        userId: 'ci',
        sessionId: 'eval-123',
        tags: ['eval', 'metamask'],
        version: '0.1.0',
        metadata: { scenario: 'llm-workflow' },
      },
    });

    expect(telemetryMocks.startActiveObservation).toHaveBeenCalledWith(
      'metamask-agent-eval',
      expect.any(Function),
    );
    expect(telemetryMocks.propagateAttributes).toHaveBeenCalledWith(
      {
        userId: 'ci',
        sessionId: 'eval-123',
        metadata: { scenario: 'llm-workflow' },
        tags: ['eval', 'metamask'],
        version: '0.1.0',
      },
      expect.any(Function),
    );
  });

  it('records error on telemetry observation when agent run fails', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const sdkError = new Error('SDK connection failed');
    const sdkModule: ClaudeSdkQueryModule = {
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
    const runner = createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({
      prompt: 'failing run',
      telemetry: { traceName: 'fail-trace' },
    });

    expect(result.isPartial).toBe(true);
    expect(result.error).toBe(sdkError);
    expect(telemetryMocks.updateActiveObservation).toHaveBeenCalledWith({
      level: 'ERROR',
      statusMessage: 'SDK connection failed',
    });
    expect(telemetryMocks.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'SDK connection failed',
    });
    expect(telemetryMocks.recordException).toHaveBeenCalledWith(sdkError);

    await runner.shutdown();
  });

  it('does not record error on telemetry observation for successful runs', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    const result = await runner.runAgent({
      prompt: 'success run',
      telemetry: { traceName: 'success-trace' },
    });

    expect(result.isPartial).toBe(false);
    expect(telemetryMocks.updateActiveObservation).not.toHaveBeenCalled();
    expect(telemetryMocks.setStatus).not.toHaveBeenCalled();
    expect(telemetryMocks.recordException).not.toHaveBeenCalled();

    await runner.shutdown();
  });

  it('shares telemetry infra when two runners use the same config', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule: sdkA } = createMockSdk();
    const { sdkModule: sdkB } = createMockSdk();

    const runnerA = createAgentRunner({
      sdkModule: sdkA,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });
    const runnerB = createAgentRunner({
      sdkModule: sdkB,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    expect(runnerA.enabled).toBe(true);
    expect(runnerB.enabled).toBe(true);
    expect(telemetryMocks.start).toHaveBeenCalledOnce();

    await runnerB.shutdown();
    expect(telemetryMocks.shutdown).not.toHaveBeenCalled();

    await runnerA.shutdown();
    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
  });

  it('rejects a second runner with a different telemetry config', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();

    createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled', serviceName: 'metamask-evals' },
    });

    expect(() =>
      createAgentRunner({
        sdkModule,
        telemetry: { mode: 'enabled', serviceName: 'different-service' },
      }),
    ).toThrow(
      'Telemetry infrastructure already exists with a different configuration',
    );
  });

  it('propagates shutdown rejection and allows new infra to be created', async () => {
    const shutdownError = new Error('OTel shutdown failed');
    telemetryMocks.shutdown.mockRejectedValueOnce(shutdownError);

    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();
    const runner = createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    await expect(runner.shutdown()).rejects.toThrow('OTel shutdown failed');

    // Controller is marked shut down — second call is a no-op, does not reject
    expect(await runner.shutdown()).toBeUndefined();

    // sharedInfra was cleared before the await, so a new runner can start fresh infra
    telemetryMocks.shutdown.mockResolvedValueOnce(undefined);
    const { sdkModule: sdkModule2 } = createMockSdk();
    const runner2 = createAgentRunner({
      sdkModule: sdkModule2,
      telemetry: { mode: 'enabled' },
    });
    expect(runner2.enabled).toBe(true);
    expect(telemetryMocks.start).toHaveBeenCalledTimes(2);

    await runner2.shutdown();
  });

  it('always validates config even when shared infra exists', async () => {
    const { createAgentRunner } = await import('./runner.js');
    const { sdkModule } = createMockSdk();

    createAgentRunner({
      sdkModule,
      telemetry: { mode: 'enabled' },
    });

    /* eslint-disable n/no-process-env */
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    /* eslint-enable n/no-process-env */

    expect(() =>
      createAgentRunner({
        sdkModule,
        telemetry: { mode: 'enabled' },
      }),
    ).toThrow(
      'Telemetry is enabled but required Langfuse configuration is missing',
    );
  });
});
