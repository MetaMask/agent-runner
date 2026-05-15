import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TelemetryConfigurationError } from '../errors.js';
import { isTelemetryEnabled, resolveTelemetryConfig } from './env.js';
import {
  createSessionSpan,
  flushTracing,
  isTracingEnabled,
  recordSpanError,
  setLangfuseProcessor,
  setOtelAttrs,
  traceSpan,
} from './tracing.js';
import type { SpanHandle } from './tracing.js';

const tracingMocks = vi.hoisted(() => ({
  propagateAttributes: vi.fn(
    (_attrs: Record<string, unknown>, fn: () => void) => fn(),
  ),
  startObservation: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    end: vi.fn(),
    startObservation: vi.fn().mockReturnThis(),
    traceId: 'trace-123',
    otelSpan: { setAttribute: vi.fn() },
  })),
}));

vi.mock('@langfuse/tracing', () => ({
  propagateAttributes: tracingMocks.propagateAttributes,
  startObservation: tracingMocks.startObservation,
}));

describe('telemetry env helpers', () => {
  it('detects whether telemetry mode is enabled', () => {
    expect(isTelemetryEnabled(undefined)).toBe(false);
    expect(isTelemetryEnabled({ mode: 'disabled' })).toBe(false);
    expect(isTelemetryEnabled({ mode: 'enabled' })).toBe(true);
  });

  it('resolves explicit telemetry config and validates base URL', () => {
    expect(
      resolveTelemetryConfig(
        {
          publicKey: ' pk ',
          secretKey: ' sk ',
          baseUrl: ' https://example.com ',
          serviceName: 'svc',
          resourceAttributes: { test: true },
        },
        {},
      ),
    ).toStrictEqual({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://example.com',
      serviceName: 'svc',
      resourceAttributes: { test: true },
    });

    expect(() =>
      resolveTelemetryConfig(
        { publicKey: 'pk', secretKey: 'sk', baseUrl: 'not a url' },
        {},
      ),
    ).toThrow(TelemetryConfigurationError);
  });
});

describe('tracing helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLangfuseProcessor(undefined);
  });

  it('toggles tracing enabled state with setLangfuseProcessor', () => {
    expect(isTracingEnabled()).toBe(false);

    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });

    expect(isTracingEnabled()).toBe(true);
  });

  it('traceSpan propagates attributes only when enabled with a session id', () => {
    const callback = vi.fn();

    traceSpan({ sessionId: 'session-1', userId: 'user-1' }, callback);
    expect(callback).not.toHaveBeenCalled();

    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });
    traceSpan({ sessionId: undefined, userId: 'user-1' }, callback);
    expect(callback).not.toHaveBeenCalled();

    traceSpan({ sessionId: 'session-1', userId: 'user-1' }, callback);

    expect(tracingMocks.propagateAttributes).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'user-1' },
      callback,
    );
    expect(callback).toHaveBeenCalledOnce();
  });

  it('traceSpan propagates metadata, tags, and version when provided', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });
    const callback = vi.fn();

    traceSpan(
      {
        sessionId: 'session-1',
        userId: 'user-1',
        metadata: { repo: 'metamask' },
        tags: ['eval', 'ci'],
        version: '1.0.0',
      },
      callback,
    );

    expect(tracingMocks.propagateAttributes).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        userId: 'user-1',
        metadata: { repo: 'metamask' },
        tags: ['eval', 'ci'],
        version: '1.0.0',
      },
      callback,
    );
  });

  it('traceSpan omits undefined optional attributes from propagation', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });
    const callback = vi.fn();

    traceSpan({ sessionId: 'session-1', userId: 'user-1' }, callback);

    expect(tracingMocks.propagateAttributes).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'user-1' },
      callback,
    );
  });

  it('traceSpan swallows propagation errors', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });
    tracingMocks.propagateAttributes.mockImplementationOnce(() => {
      throw new Error('propagation failed');
    });

    expect(() =>
      traceSpan({ sessionId: 'session-1', userId: 'user-1' }, vi.fn()),
    ).not.toThrow();
  });

  it('createSessionSpan returns undefined when disabled', () => {
    expect(
      createSessionSpan('agent-runner', 'prompt', {}, false),
    ).toBeUndefined();
    expect(tracingMocks.startObservation).not.toHaveBeenCalled();
  });

  it('createSessionSpan starts agent observation and returns span with trace id', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });

    const session = createSessionSpan(
      'agent-runner',
      'prompt',
      { model: 'claude' },
      false,
    );

    expect(tracingMocks.startObservation).toHaveBeenCalledWith(
      'agent-runner',
      { input: 'prompt', metadata: { model: 'claude' } },
      { asType: 'agent' },
    );
    expect(session?.traceId).toBe('trace-123');
    expect(session?.span).toBe(
      tracingMocks.startObservation.mock.results[0]?.value,
    );
  });

  it('createSessionSpan uses custom trace name', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });

    createSessionSpan('my-eval-trace', 'prompt', { model: 'claude' }, false);

    expect(tracingMocks.startObservation).toHaveBeenCalledWith(
      'my-eval-trace',
      { input: 'prompt', metadata: { model: 'claude' } },
      { asType: 'agent' },
    );
  });

  it('createSessionSpan redacts prompt input when requested', () => {
    setLangfuseProcessor({ forceFlush: vi.fn(async () => undefined) });

    createSessionSpan('agent-runner', 'secret prompt', {}, true);

    expect(tracingMocks.startObservation).toHaveBeenCalledWith(
      'agent-runner',
      { input: '[REDACTED]', metadata: {} },
      { asType: 'agent' },
    );
  });

  it('setOtelAttrs sets defined attributes and skips undefined values', () => {
    const setAttribute = vi.fn();
    const span = {
      traceId: 'test-trace',
      update: vi.fn().mockReturnThis(),
      end: vi.fn(),
      startObservation: vi.fn().mockReturnThis(),
      otelSpan: { setAttribute },
    } as unknown as SpanHandle;

    setOtelAttrs(span, {
      string: 'value',
      number: 1,
      bool: false,
      missing: undefined,
    });

    expect(setAttribute).toHaveBeenCalledTimes(3);
    expect(setAttribute).toHaveBeenCalledWith('string', 'value');
    expect(setAttribute).toHaveBeenCalledWith('number', 1);
    expect(setAttribute).toHaveBeenCalledWith('bool', false);
  });

  it('recordSpanError sets error status and records exception on the OTel span', () => {
    const setStatus = vi.fn();
    const recordException = vi.fn();
    const span = {
      traceId: 'test-trace',
      update: vi.fn().mockReturnThis(),
      end: vi.fn(),
      startObservation: vi.fn().mockReturnThis(),
      otelSpan: { setAttribute: vi.fn(), setStatus, recordException },
    } as unknown as SpanHandle;

    const error = new Error('test failure');
    recordSpanError(span, error);

    expect(setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'test failure',
    });
    expect(recordException).toHaveBeenCalledWith(error);
  });

  it('flushTracing delegates to processor forceFlush when set', async () => {
    const forceFlush = vi.fn(async () => undefined);
    await flushTracing();

    setLangfuseProcessor({ forceFlush });
    await flushTracing();

    expect(forceFlush).toHaveBeenCalledOnce();
  });
});
