import { describe, expect, it } from 'vitest';

import { createPiEventTranslator } from './pi-message-translator.js';
import type { PiEventDto } from './pi-types.js';

describe('createPiEventTranslator', () => {
  it('maps init, assistant, tool lifecycle, system, and terminal events', () => {
    const translator = createPiEventTranslator();
    const init: PiEventDto = {
      kind: 'init',
      sessionId: 'session-1',
      model: 'litellm/model',
      tools: ['read'],
    };
    expect(translator.translate(init)).toStrictEqual({
      type: 'init',
      sessionId: 'session-1',
      model: 'litellm/model',
      tools: ['read'],
      raw: init,
    });

    const assistant: PiEventDto = {
      kind: 'assistant_message_end',
      model: 'model',
      content: [
        { type: 'text', text: 'done' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'a' },
        },
      ],
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        cost: { total: 1.25 },
      },
      stopReason: 'toolUse',
    };
    expect(translator.translate(assistant)).toStrictEqual({
      type: 'generation',
      model: 'model',
      text: 'done',
      toolCalls: [{ id: 'call-1', name: 'read', input: { path: 'a' } }],
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheCreationTokens: 5,
      },
      stopReason: 'toolUse',
      raw: assistant,
    });

    expect(
      translator.translate({
        kind: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'call-1',
      }),
    ).toMatchObject({ type: 'system', subtype: 'tool_execution_start' });
    expect(
      translator.translate({
        kind: 'tool_execution_update',
        toolName: 'read',
        toolCallId: 'call-1',
        content: 'working',
      }),
    ).toMatchObject({ type: 'tool_progress', toolName: 'read' });
    expect(
      translator.translate({
        kind: 'tool_execution_end',
        toolName: 'read',
        toolCallId: 'call-1',
        content: 'ok',
        isError: false,
      }),
    ).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call-1',
      content: 'ok',
      isError: false,
    });
    expect(
      translator.translate({
        kind: 'system',
        subtype: 'auto_retry_start',
        details: { attempt: 1 },
      }),
    ).toMatchObject({
      type: 'system',
      subtype: 'auto_retry_start',
      attempt: 1,
    });

    expect(translator.translate({ kind: 'agent_settled' })).toMatchObject({
      type: 'result',
      success: true,
      result: 'done',
      costUsd: 1.25,
    });
    expect(translator.translate({ kind: 'agent_settled' })).toBeUndefined();
  });

  it.each([
    { costs: [0], expected: 0 },
    { costs: [1, 2.5], expected: 3.5 },
    { costs: [], expected: undefined },
    { costs: [Number.NaN, -1, Number.POSITIVE_INFINITY], expected: undefined },
  ])('aggregates valid finalized costs %#', ({ costs, expected }) => {
    const translator = createPiEventTranslator();
    for (const cost of costs) {
      translator.translate({
        kind: 'assistant_message_end',
        model: 'm',
        content: [],
        usage: { cost: { total: cost } },
      });
    }
    const result = translator.translate({ kind: 'agent_settled' });
    expect(result?.type === 'result' ? result.costUsd : undefined).toBe(
      expected,
    );
  });

  it('captures assistant and retry failures in the terminal result', () => {
    const assistant = createPiEventTranslator();
    assistant.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [],
      stopReason: 'error',
      errorMessage: 'provider failed',
    });
    expect(assistant.translate({ kind: 'agent_settled' })).toMatchObject({
      success: false,
      error: 'provider failed',
    });

    const retry = createPiEventTranslator();
    retry.translate({
      kind: 'system',
      subtype: 'auto_retry_end',
      details: {},
      error: 'retry failed',
    });
    expect(retry.translate({ kind: 'agent_settled' })).toMatchObject({
      success: false,
      error: 'retry failed',
    });
  });

  it('normalizes malformed token values to zero', () => {
    const translator = createPiEventTranslator();
    expect(
      translator.translate({
        kind: 'assistant_message_end',
        model: 'm',
        content: [{ type: 'text', text: '' }],
        usage: { input: -1, output: Number.NaN },
      }),
    ).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('preserves missing usage, empty text, null stop reason, and structured raw terminal data', () => {
    const translator = createPiEventTranslator();
    expect(
      translator.translate({
        kind: 'assistant_message_end',
        model: 'm',
        content: [],
      }),
    ).toStrictEqual({
      type: 'generation',
      model: 'm',
      text: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: null,
      raw: {
        kind: 'assistant_message_end',
        model: 'm',
        content: [],
      },
    });
    const settled: PiEventDto = {
      kind: 'agent_settled',
      structuredResult: { score: 1 },
    };
    expect(translator.translate(settled)).toStrictEqual({
      type: 'result',
      success: true,
      raw: settled,
    });
  });

  it('uses default assistant error text and lets later system failure replace it', () => {
    const translator = createPiEventTranslator();
    translator.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [{ type: 'text', text: 'partial' }],
      stopReason: 'error',
    });
    translator.translate({
      kind: 'system',
      subtype: 'auto_retry_end',
      details: { success: false },
      error: 'final failure',
    });
    expect(translator.translate({ kind: 'agent_settled' })).toStrictEqual({
      type: 'result',
      success: false,
      result: 'partial',
      error: 'final failure',
      raw: { kind: 'agent_settled' },
    });
  });

  it.each([
    {
      stopReason: 'aborted' as const,
      errorMessage: 'provider cancelled',
      expected: 'provider cancelled',
    },
    {
      stopReason: 'aborted' as const,
      errorMessage: undefined,
      expected: 'Pi assistant generation was aborted.',
    },
    {
      stopReason: 'length' as const,
      errorMessage: undefined,
      expected:
        'Pi assistant generation stopped after reaching the maximum output token limit.',
    },
    {
      stopReason: 'pending' as const,
      errorMessage: undefined,
      expected: 'Pi assistant generation did not complete.',
    },
  ])(
    'treats terminal %o as an unsuccessful result',
    ({ stopReason, errorMessage, expected }) => {
      const translator = createPiEventTranslator();
      const generation = translator.translate({
        kind: 'assistant_message_end',
        model: 'm',
        content: [{ type: 'text', text: 'partial' }],
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      });
      expect(generation).toMatchObject({ type: 'generation', stopReason });
      expect(translator.translate({ kind: 'agent_settled' })).toMatchObject({
        type: 'result',
        success: false,
        result: 'partial',
        error: expected,
      });
    },
  );

  it('clears an incomplete length truncation when a later generation completes', () => {
    const translator = createPiEventTranslator();
    translator.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [{ type: 'text', text: 'partial' }],
      stopReason: 'length',
    });
    translator.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [{ type: 'text', text: 'complete' }],
      stopReason: 'stop',
    });
    expect(translator.translate({ kind: 'agent_settled' })).toMatchObject({
      type: 'result',
      success: true,
      result: 'complete',
    });
  });

  it('keeps a provider error even after a later length truncation', () => {
    const translator = createPiEventTranslator();
    translator.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [{ type: 'text', text: 'partial' }],
      stopReason: 'error',
      errorMessage: 'provider failed',
    });
    translator.translate({
      kind: 'assistant_message_end',
      model: 'm',
      content: [{ type: 'text', text: 'more' }],
      stopReason: 'length',
    });
    expect(translator.translate({ kind: 'agent_settled' })).toMatchObject({
      type: 'result',
      success: false,
      error: 'provider failed',
    });
  });

  it('maps optional cache usage values independently and keeps tool progress raw', () => {
    const translator = createPiEventTranslator();
    expect(
      translator.translate({
        kind: 'assistant_message_end',
        model: 'm',
        content: [],
        usage: { cacheRead: -1, cacheWrite: Number.POSITIVE_INFINITY },
      }),
    ).toMatchObject({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    const progress: PiEventDto = {
      kind: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'tool',
    };
    expect(translator.translate(progress)).toStrictEqual({
      type: 'tool_progress',
      toolName: 'bash',
      elapsedSeconds: 0,
      raw: progress,
    });
  });
});
