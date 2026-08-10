import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../types.js';
import { createMessageHandler } from './message-handler.js';

const tracingMocks = vi.hoisted(() => {
  /** Mock span calls captured for assertions. */
  type SpanCalls = {
    /** Span update mock. */
    update: ReturnType<typeof vi.fn>;
    /** Span end mock. */
    end: ReturnType<typeof vi.fn>;
    /** Child observation factory mock. */
    startObservation: ReturnType<typeof vi.fn>;
  };

  const spans: SpanCalls[] = [];

  /**
   * Creates a mock Langfuse span.
   *
   * @returns Mock span handle.
   */
  const mockSpan = (): SpanCalls => {
    const span: SpanCalls = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn(),
      startObservation: vi.fn(() => mockSpan()),
    };
    spans.push(span);
    return span;
  };

  return {
    spans,
    mockSpan,
    traceSpan: vi.fn((_attrs: Record<string, unknown>, fn: () => void) => fn()),
    createSessionSpan: vi.fn(() => ({ span: mockSpan(), traceId: 'trace-1' })),
    setOtelAttrs: vi.fn(),
    recordSpanError: vi.fn(),
  };
});

vi.mock('../telemetry/tracing.js', () => ({
  traceSpan: tracingMocks.traceSpan,
  createSessionSpan: tracingMocks.createSessionSpan,
  setOtelAttrs: tracingMocks.setOtelAttrs,
  recordSpanError: tracingMocks.recordSpanError,
}));

/**
 * Creates a message handler with common test defaults.
 *
 * @param overrides - Config overrides.
 * @returns A configured message handler.
 */
const createHandler = (
  overrides: Partial<Parameters<typeof createMessageHandler>[0]> = {},
): ReturnType<typeof createMessageHandler> =>
  createMessageHandler({
    prompt: 'initial prompt',
    model: 'default-model',
    maxTurns: 3,
    redact: false,
    userId: 'user-1',
    initialSessionId: undefined,
    ...overrides,
  });

/**
 * Creates a generation message for handler tests.
 *
 * @param overrides - Generation fields to override.
 * @returns A generation agent message.
 */
const createGeneration = (
  overrides: Partial<
    AgentMessage & {
      /**
       *
       */
      type: 'generation';
    }
  > = {},
): AgentMessage => ({
  type: 'generation',
  model: 'claude-sonnet',
  text: 'assistant output',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 4 },
  stopReason: 'end_turn',
  ...overrides,
});

describe('createMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tracingMocks.spans.length = 0;
  });

  it('handles init messages by creating and storing a session span', () => {
    const handler = createHandler();

    handler.handleMessage({
      type: 'init',
      sessionId: 'session-1',
      model: 'init-model',
      tools: ['Bash', 'Read'],
    });

    expect(tracingMocks.traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', userId: 'user-1' }),
      expect.any(Function),
    );
    expect(tracingMocks.createSessionSpan).toHaveBeenCalledWith(
      'agent-runner',
      'initial prompt',
      { model: 'init-model', maxTurns: 3, tools: ['Bash', 'Read'] },
      false,
    );
    expect(handler.getState().sessionSpan).toBe(tracingMocks.spans[0]);
    expect(handler.getState().traceId).toBe('trace-1');
    expect(handler.getState().langfuseSessionId).toBe('session-1');
  });

  it('uses config model and empty tools when init omits optional fields', () => {
    const handler = createHandler();

    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    expect(tracingMocks.createSessionSpan).toHaveBeenCalledWith(
      'agent-runner',
      'initial prompt',
      { model: 'default-model', maxTurns: 3, tools: [] },
      false,
    );
  });

  it('handles generation messages by creating generation and pending tool spans', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    const { sessionSpan } = handler.getState();

    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
          { id: 'custom-1', name: 'Custom', input: { foo: 'bar' } },
        ],
        usage: {
          inputTokens: 11,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        },
      }),
    );

    expect(sessionSpan?.startObservation).toHaveBeenNthCalledWith(
      1,
      'claude-sonnet',
      {
        input: 'initial prompt',
        output: 'assistant output',
        metadata: { stopReason: 'end_turn' },
      },
      { asType: 'generation' },
    );
    expect(tracingMocks.setOtelAttrs).toHaveBeenCalledWith(
      tracingMocks.spans[1],
      {
        'langfuse.observation.model.name': 'claude-sonnet',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 5,
        'gen_ai.usage.cache_read_input_tokens': 2,
        'gen_ai.usage.cache_creation_input_tokens': 1,
      },
    );
    expect(tracingMocks.spans[1]?.end).toHaveBeenCalledOnce();
    expect(sessionSpan?.startObservation).toHaveBeenNthCalledWith(
      2,
      'Bash: npm test',
      { input: { command: 'npm test' } },
      { asType: 'tool' },
    );
    expect(sessionSpan?.startObservation).toHaveBeenNthCalledWith(
      3,
      'tool:Custom',
      { input: { foo: 'bar' } },
      { asType: 'tool' },
    );
    expect(handler.getState().turns).toBe(1);
    expect(handler.getState().totalInputTokens).toBe(11);
    expect(handler.getState().totalOutputTokens).toBe(5);
    expect([...handler.getState().pendingTools.keys()]).toStrictEqual([
      'bash-1',
      'custom-1',
    ]);
  });

  it('uses fallback model and JSON tool call output for generation spans', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    handler.handleMessage(
      createGeneration({
        model: '',
        text: '',
        toolCalls: [
          { id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        ],
      }),
    );

    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      1,
      'default-model',
      {
        input: 'initial prompt',
        output: JSON.stringify([
          { id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        ]),
        metadata: { stopReason: 'end_turn' },
      },
      { asType: 'generation' },
    );
  });

  it('handles generation messages without a session span as token-only state updates', () => {
    const handler = createHandler();

    handler.handleMessage(createGeneration());

    expect(handler.getState().turns).toBe(1);
    expect(handler.getState().totalInputTokens).toBe(10);
    expect(handler.getState().totalOutputTokens).toBe(4);
    expect(handler.getState().pendingTools.size).toBe(0);
    expect(tracingMocks.setOtelAttrs).not.toHaveBeenCalled();
  });

  it('handles tool_result messages by closing pending tool span with output', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'tool-1', name: 'Read', input: { file_path: '/tmp/file.ts' } },
        ],
      }),
    );
    const toolSpan = handler.getState().pendingTools.get('tool-1')?.span;

    handler.handleMessage({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'file contents',
      isError: false,
    });

    expect(toolSpan?.update).toHaveBeenCalledWith({
      output: 'file contents',
      metadata: { isError: false },
    });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
    expect(handler.getState().pendingTools.size).toBe(0);
    expect(handler.getState().lastTurnInput).toBe('file contents');
  });

  it('ignores tool_result messages without a pending tool span', () => {
    const handler = createHandler();

    handler.handleMessage({
      type: 'tool_result',
      toolUseId: 'missing',
      content: 'output',
      isError: true,
    });

    expect(handler.getState().pendingTools.size).toBe(0);
  });

  it('stores final result and error messages', () => {
    const handler = createHandler();

    handler.handleMessage({ type: 'result', success: true, result: 'done' });
    expect(handler.getState().finalResult).toBe('done');

    handler.handleMessage({ type: 'result', success: false, error: 'failed' });
    expect(handler.getState().finalResult).toBe('failed');
  });

  it('finalizePendingTools closes all unclosed spans', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
          { id: 'tool-2', name: 'Edit', input: { file_path: '/tmp/b.ts' } },
        ],
      }),
    );
    const pendingSpans = [...handler.getState().pendingTools.values()].map(
      (pendingTool) => pendingTool.span,
    );

    handler.finalizePendingTools();

    for (const span of pendingSpans) {
      expect(span.update).toHaveBeenCalledWith({
        output: '[no result received]',
      });
      expect(span.end).toHaveBeenCalledOnce();
    }
    expect(handler.getState().pendingTools.size).toBe(0);
  });

  it('finalizeSessionSpan updates summary, ends span, and clears it', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(createGeneration());
    handler.handleMessage({
      type: 'result',
      success: true,
      result: 'final output',
    });
    const { sessionSpan } = handler.getState();

    handler.finalizeSessionSpan();

    expect(sessionSpan?.update).toHaveBeenCalledWith({
      output: 'final output',
      level: undefined,
      statusMessage: undefined,
      metadata: {
        status: 'completed',
        totalInputTokens: 10,
        totalOutputTokens: 4,
        turns: 1,
      },
    });
    expect(sessionSpan?.end).toHaveBeenCalledOnce();
    expect(handler.getState().sessionSpan).toBeUndefined();
  });

  it('finalizeSessionSpan reports unknown status without a final result', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    handler.finalizeSessionSpan();

    expect(tracingMocks.spans[0]?.update).toHaveBeenCalledWith({
      output: undefined,
      level: undefined,
      statusMessage: undefined,
      metadata: {
        status: 'unknown',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turns: 0,
      },
    });
  });

  it('finalizers no-op when there is no session span', () => {
    const handler = createHandler();

    expect(() => handler.finalizeSessionSpan()).not.toThrow();
    expect(() => handler.finalizePendingTools()).not.toThrow();
  });

  it('redacts prompts, generation output, tool inputs and results', () => {
    const handler = createHandler({ redact: true });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(
      createGeneration({
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'run', password: 'secret' },
          },
        ],
      }),
    );
    const toolSpan = handler.getState().pendingTools.get('tool-1')?.span;
    handler.handleMessage({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'sensitive output',
      isError: false,
    });
    handler.handleMessage({
      type: 'result',
      success: true,
      result: 'final output',
    });
    handler.finalizeSessionSpan();

    expect(tracingMocks.createSessionSpan).toHaveBeenCalledWith(
      'agent-runner',
      'initial prompt',
      { model: 'default-model', maxTurns: 3, tools: [] },
      true,
    );
    expect(handler.getState().sessionSpan).toBeUndefined();
    expect(tracingMocks.spans[0]?.startObservation).toHaveBeenNthCalledWith(
      1,
      'claude-sonnet',
      {
        input: '[REDACTED]',
        output: '[REDACTED]',
        metadata: { stopReason: 'end_turn' },
      },
      { asType: 'generation' },
    );
    expect(tracingMocks.spans[0]?.startObservation).toHaveBeenNthCalledWith(
      2,
      'Bash: run',
      { input: { command: 'run', password: '[REDACTED]' } },
      { asType: 'tool' },
    );
    expect(toolSpan?.update).toHaveBeenCalledWith({
      output: '[REDACTED]',
      metadata: { isError: false },
    });
    expect(tracingMocks.spans[0]?.update).toHaveBeenCalledWith({
      output: '[REDACTED]',
      level: undefined,
      statusMessage: undefined,
      metadata: {
        status: 'completed',
        totalInputTokens: 10,
        totalOutputTokens: 4,
        turns: 1,
      },
    });
  });

  it('scrubs secret leaves of a Bash tool input while preserving structure', () => {
    const mnemonic =
      'test test test test test test test test test test test junk';
    const redactor = (text: string): string =>
      text.replace(mnemonic, '[SCRUBBED]');
    const handler = createHandler({ redact: false, redactor });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    handler.handleMessage(
      createGeneration({
        toolCalls: [
          {
            id: 'bash-1',
            name: 'Bash',
            input: {
              command: `mm clipboard write '${mnemonic}'`,
              args: [mnemonic, 'plain'],
              timeout: 5000,
            },
          },
        ],
      }),
    );

    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      2,
      "Bash: mm clipboard write '[SCRUBBED]'",
      {
        input: {
          command: "mm clipboard write '[SCRUBBED]'",
          args: ['[SCRUBBED]', 'plain'],
          timeout: 5000,
        },
      },
      { asType: 'tool' },
    );
  });

  it('scrubs secret leaves across prompt, generation, tool result, and final output', () => {
    const redactor = (text: string): string =>
      text.replaceAll('SECRET', '[SCRUBBED]');
    const handler = createHandler({
      prompt: 'prompt with SECRET value',
      redact: false,
      redactor,
    });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(
      createGeneration({ text: 'assistant SECRET output' }),
    );

    expect(tracingMocks.createSessionSpan).toHaveBeenCalledWith(
      'agent-runner',
      'prompt with [SCRUBBED] value',
      expect.any(Object),
      false,
    );
    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      1,
      'claude-sonnet',
      {
        input: 'prompt with [SCRUBBED] value',
        output: 'assistant [SCRUBBED] output',
        metadata: { stopReason: 'end_turn' },
      },
      { asType: 'generation' },
    );

    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        ],
      }),
    );
    const toolSpan = handler.getState().pendingTools.get('tool-1')?.span;
    handler.handleMessage({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'result with SECRET data',
      isError: false,
    });

    expect(toolSpan?.update).toHaveBeenCalledWith({
      output: 'result with [SCRUBBED] data',
      metadata: { isError: false },
    });
    expect(handler.getState().lastTurnInput).toBe(
      'result with [SCRUBBED] data',
    );

    handler.handleMessage({
      type: 'result',
      success: true,
      result: 'final SECRET output',
    });
    const { sessionSpan } = handler.getState();
    handler.finalizeSessionSpan();

    expect(sessionSpan?.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'final [SCRUBBED] output' }),
    );
  });

  it('does not invoke the redactor when blanket redact is enabled', () => {
    const redactor = vi.fn((text: string) => text);
    const handler = createHandler({ redact: true, redactor });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'tool-1', name: 'Bash', input: { command: 'run secret' } },
        ],
      }),
    );
    handler.handleMessage({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'secret output',
      isError: false,
    });
    handler.handleMessage({
      type: 'result',
      success: true,
      result: 'final output',
    });
    handler.finalizeSessionSpan();

    expect(redactor).not.toHaveBeenCalled();
  });

  it('leaves span I/O unchanged when no redactor is configured', () => {
    const handler = createHandler({ redact: false });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
        ],
      }),
    );

    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      2,
      'Bash: npm test',
      { input: { command: 'npm test' } },
      { asType: 'tool' },
    );
  });

  it('formats Bash, Read, Edit, and long Bash tool labels', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    const longCommand = 'x'.repeat(90);

    handler.handleMessage(
      createGeneration({
        toolCalls: [
          { id: 'bash-1', name: 'Bash', input: { command: longCommand } },
          {
            id: 'read-1',
            name: 'Read',
            input: { file_path: '/tmp/read-file.ts' },
          },
          {
            id: 'edit-1',
            name: 'Edit',
            input: { file_path: '/tmp/edit-file.ts' },
          },
        ],
      }),
    );

    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      2,
      `Bash: ${'x'.repeat(77)}...`,
      { input: { command: longCommand } },
      { asType: 'tool' },
    );
    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      3,
      'Read: read-file.ts',
      { input: { file_path: '/tmp/read-file.ts' } },
      { asType: 'tool' },
    );
    expect(
      handler.getState().sessionSpan?.startObservation,
    ).toHaveBeenNthCalledWith(
      4,
      'Edit: edit-file.ts',
      { input: { file_path: '/tmp/edit-file.ts' } },
      { asType: 'tool' },
    );
  });

  it('ignores non-tracing message types', () => {
    const handler = createHandler();

    handler.handleMessage({ type: 'system', subtype: 'status' });
    handler.handleMessage({
      type: 'tool_progress',
      toolName: 'Bash',
      elapsedSeconds: 1,
    });
    handler.handleMessage({ type: 'tool_use_summary', summary: 'summary' });
    handler.handleMessage({ type: 'rate_limit', status: 'allowed' });

    expect(handler.getState().turns).toBe(0);
    expect(tracingMocks.createSessionSpan).not.toHaveBeenCalled();
  });

  it('propagates custom traceName to createSessionSpan', () => {
    const handler = createHandler({ traceName: 'my-eval-trace' });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    expect(tracingMocks.createSessionSpan).toHaveBeenCalledWith(
      'my-eval-trace',
      'initial prompt',
      expect.any(Object),
      false,
    );
  });

  it('propagates metadata, tags, and version to traceSpan', () => {
    const handler = createHandler({
      traceMetadata: { repo: 'metamask' },
      traceTags: ['eval', 'ci'],
      traceVersion: '1.0.0',
    });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });

    expect(tracingMocks.traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        userId: 'user-1',
        metadata: { repo: 'metamask', agentSessionId: 'session-1' },
        tags: ['eval', 'ci'],
        version: '1.0.0',
      }),
      expect.any(Function),
    );
  });

  it('prefers the caller-provided session id over the SDK session id', () => {
    const handler = createHandler({ initialSessionId: 'workflow-run-42' });

    handler.handleMessage({ type: 'init', sessionId: 'sdk-session-9' });

    expect(tracingMocks.traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'workflow-run-42' }),
      expect.any(Function),
    );
    expect(handler.getState().langfuseSessionId).toBe('workflow-run-42');
  });

  it('records the SDK session id as agentSessionId metadata', () => {
    const handler = createHandler({
      initialSessionId: 'workflow-run-42',
      traceMetadata: { repo: 'metamask' },
    });

    handler.handleMessage({ type: 'init', sessionId: 'sdk-session-9' });

    expect(tracingMocks.traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { repo: 'metamask', agentSessionId: 'sdk-session-9' },
      }),
      expect.any(Function),
    );
  });

  it('falls back to the SDK session id when no caller session id is set', () => {
    const handler = createHandler({ initialSessionId: undefined });

    handler.handleMessage({ type: 'init', sessionId: 'sdk-session-9' });

    expect(handler.getState().langfuseSessionId).toBe('sdk-session-9');
    expect(tracingMocks.traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sdk-session-9',
        metadata: { agentSessionId: 'sdk-session-9' },
      }),
      expect.any(Function),
    );
  });

  it('propagates trace attributes on generation spans', () => {
    const handler = createHandler({
      traceTags: ['eval'],
      traceVersion: '2.0.0',
    });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage(createGeneration());

    const generationTraceCall = tracingMocks.traceSpan.mock.calls[1];
    expect(generationTraceCall?.[0]).toStrictEqual(
      expect.objectContaining({
        tags: ['eval'],
        version: '2.0.0',
      }),
    );
  });

  it('recordError stores error and finalizeSessionSpan marks error status', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    const { sessionSpan } = handler.getState();
    const runError = new Error('adapter failed');

    handler.recordError(runError);
    handler.finalizeSessionSpan();

    expect(sessionSpan?.update).toHaveBeenCalledWith({
      output: 'adapter failed',
      level: 'ERROR',
      statusMessage: 'adapter failed',
      metadata: {
        status: 'error',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turns: 0,
      },
    });
    expect(tracingMocks.recordSpanError).toHaveBeenCalledWith(
      sessionSpan,
      runError,
    );
    expect(sessionSpan?.end).toHaveBeenCalledOnce();
  });

  it('recordError redacts error output when redact is enabled', () => {
    const handler = createHandler({ redact: true });
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    const { sessionSpan } = handler.getState();

    handler.recordError(new Error('secret error'));
    handler.finalizeSessionSpan();

    expect(sessionSpan?.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: '[REDACTED]' }),
    );
  });

  it('finalizeSessionSpan does not record error when none is set', () => {
    const handler = createHandler();
    handler.handleMessage({ type: 'init', sessionId: 'session-1' });
    handler.handleMessage({
      type: 'result',
      success: true,
      result: 'done',
    });

    handler.finalizeSessionSpan();

    expect(tracingMocks.recordSpanError).not.toHaveBeenCalled();
  });
});
