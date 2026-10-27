import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMessageHandler } from './message-handler.js';
import { setLangfuseProcessor } from './tracing.js';

type CapturedSpan = {
  name: string;
  traceId: string;
  attributes: Record<string, unknown>;
};

describe('Langfuse trace-name attributes', () => {
  const spans: CapturedSpan[] = [];
  const processor = new LangfuseSpanProcessor({
    exporter: {
      export: (batch, callback): void => {
        for (const span of batch) {
          spans.push({
            name: span.name,
            traceId: span.spanContext().traceId,
            attributes: { ...span.attributes },
          });
        }
        callback({ code: 0 });
      },
      shutdown: async (): Promise<void> => undefined,
    },
  });
  const sdk = new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [processor],
    metricReaders: [],
    logRecordProcessors: [],
  });

  beforeAll(() => {
    sdk.start();
    setLangfuseProcessor(processor);
  });

  beforeEach(() => {
    spans.length = 0;
  });

  afterAll(async () => {
    setLangfuseProcessor(undefined);
    await sdk.shutdown();
  });

  it('emits a trace name on every observation without leaking it between runs in one session', async () => {
    for (const traceName of ['pr-visual-validation.plan', undefined]) {
      const handler = createMessageHandler({
        prompt: 'Inspect a fixture.',
        model: 'fixture-model',
        maxTurns: 1,
        redact: false,
        userId: 'fixture-user',
        initialSessionId: 'shared-workflow-session',
        traceName,
      });
      handler.handleMessage({ type: 'init', sessionId: 'sdk-session' });
      handler.handleMessage({
        type: 'generation',
        model: 'fixture-model',
        text: '',
        toolCalls: [
          { id: 'read-1', name: 'Read', input: { file_path: '/fixture.txt' } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      });
      handler.handleMessage({
        type: 'tool_result',
        toolUseId: 'read-1',
        content: 'Fixture contents.',
        isError: false,
      });
      handler.handleMessage({ type: 'result', success: true, result: 'Done.' });
      handler.finalizeSessionSpan();
      await processor.forceFlush();

      const runSpans = spans.filter(
        (span) => span.traceId === handler.getState().traceId,
      );
      const expectedName = traceName ?? 'agent-runner';
      expect(runSpans.map((span) => span.name)).toStrictEqual([
        'fixture-model',
        'Read: fixture.txt',
        expectedName,
      ]);
      for (const span of runSpans) {
        expect(span.attributes).toMatchObject({
          'langfuse.trace.name': expectedName,
          'session.id': 'shared-workflow-session',
        });
      }
    }

    expect(spans).toHaveLength(6);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
  });
});
