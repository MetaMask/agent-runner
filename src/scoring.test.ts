import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postScores } from './scoring.js';
import type { ScoreEntry, TelemetryConfig } from './types.js';

const envMocks = vi.hoisted(() => ({
  resolveTelemetryConfig: vi.fn(),
}));

vi.mock('./env.js', () => ({
  resolveTelemetryConfig: envMocks.resolveTelemetryConfig,
}));

const mockScoreCreate = vi.hoisted(() => vi.fn());
const mockFlush = vi.hoisted(() => vi.fn());
const mockShutdown = vi.hoisted(() => vi.fn());

const mockLangfuseClient = vi.hoisted(() =>
  vi.fn(function langfuseClient() {
    return {
      score: { create: mockScoreCreate },
      flush: mockFlush,
      shutdown: mockShutdown,
    };
  }),
);

vi.mock('@langfuse/client', () => ({
  LangfuseClient: mockLangfuseClient,
}));

const enabledConfig: TelemetryConfig = {
  mode: 'enabled',
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  baseUrl: 'https://langfuse.example.com',
};

const resolvedConfig = {
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  baseUrl: 'https://langfuse.example.com',
  serviceName: 'test',
  resourceAttributes: {},
};

const sampleScores: ScoreEntry[] = [
  { name: 'quality', value: 8, comment: 'Good work' },
  { name: 'accuracy', value: 5 },
];

describe('postScores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.resolveTelemetryConfig.mockReturnValue(resolvedConfig);
    mockFlush.mockResolvedValue(undefined);
    mockShutdown.mockResolvedValue(undefined);
  });

  it('is a no-op when telemetryConfig is undefined', async () => {
    await postScores('trace-1', sampleScores, undefined);
    expect(mockLangfuseClient).not.toHaveBeenCalled();
  });

  it('is a no-op when mode is disabled', async () => {
    await postScores('trace-1', sampleScores, { mode: 'disabled' });
    expect(mockLangfuseClient).not.toHaveBeenCalled();
  });

  it('is a no-op when traceId is undefined', async () => {
    await postScores(undefined, sampleScores, enabledConfig);
    expect(mockLangfuseClient).not.toHaveBeenCalled();
  });

  it('is a no-op when traceId is empty string', async () => {
    await postScores('', sampleScores, enabledConfig);
    expect(mockLangfuseClient).not.toHaveBeenCalled();
  });

  it('is a no-op when scores array is empty', async () => {
    await postScores('trace-1', [], enabledConfig);
    expect(mockLangfuseClient).not.toHaveBeenCalled();
  });

  it('creates a LangfuseClient with resolved credentials', async () => {
    await postScores('trace-1', sampleScores, enabledConfig);

    expect(mockLangfuseClient).toHaveBeenCalledExactlyOnceWith({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://langfuse.example.com',
    });
  });

  it('calls score.create for each score entry', async () => {
    await postScores('trace-1', sampleScores, enabledConfig);

    expect(mockScoreCreate).toHaveBeenCalledTimes(2);
    expect(mockScoreCreate).toHaveBeenCalledWith({
      traceId: 'trace-1',
      name: 'quality',
      value: 8,
      comment: 'Good work',
    });
    expect(mockScoreCreate).toHaveBeenCalledWith({
      traceId: 'trace-1',
      name: 'accuracy',
      value: 5,
    });
  });

  it('omits comment field when score comment is undefined', async () => {
    const scores: ScoreEntry[] = [{ name: 'speed', value: 3 }];
    await postScores('trace-1', scores, enabledConfig);

    expect(mockScoreCreate).toHaveBeenCalledWith({
      traceId: 'trace-1',
      name: 'speed',
      value: 3,
    });
    expect(mockScoreCreate.mock.calls[0]?.[0]).not.toHaveProperty('comment');
  });

  it('flushes the client after creating scores', async () => {
    await postScores('trace-1', sampleScores, enabledConfig);

    expect(mockFlush).toHaveBeenCalledOnce();
  });

  it('shuts down the client after posting', async () => {
    await postScores('trace-1', sampleScores, enabledConfig);

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('shuts down even when flush throws', async () => {
    mockFlush.mockRejectedValueOnce(new Error('flush failed'));

    await postScores('trace-1', sampleScores, enabledConfig);

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('silently swallows score.create errors', async () => {
    mockScoreCreate.mockImplementationOnce(() => {
      throw new Error('create failed');
    });

    expect(
      await postScores('trace-1', sampleScores, enabledConfig),
    ).toBeUndefined();
    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('silently swallows shutdown errors', async () => {
    mockShutdown.mockRejectedValueOnce(new Error('shutdown failed'));

    expect(
      await postScores('trace-1', sampleScores, enabledConfig),
    ).toBeUndefined();
  });
});
