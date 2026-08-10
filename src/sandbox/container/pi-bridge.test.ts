import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
/* eslint-disable consistent-return, @typescript-eslint/prefer-promise-reject-errors */
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createPiCredentialStore } from '../../adapters/pi-credential-store.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_LINE_LENGTH,
  MAX_BRIDGE_QUEUE_SIZE,
  createDefaultAgentSession,
  createBridgeCredentialStore,
  createIsolatedSession,
  createModelDeclaration,
  defaultSdk,
  describeBridgeError,
  isMain,
  makeBridgeErrorEvent,
  normalizeBridgeContent,
  normalizeBridgeToolEvent,
  normalizeBridgeUsage,
  ignoreBridgeQueueFailure,
  runPiBridge,
  settleIgnored,
  settleMain,
  stringifyJsonSafe,
  validateBridgeOptions,
} from './pi-bridge.js';
import type {
  BridgePiOptions,
  PiBridgeDeps,
  PiBridgeSession,
  PiBridgeSessionResult,
  PiBridgeSdk,
} from './pi-bridge.js';

/** Captured writable output. */
type Capture = { stream: Writable; read: () => string };

/** Creates a writable capture stream. */
function capture(): Capture {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback): void {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
        );
        callback();
      },
    }),
    read: (): string => chunks.join(''),
  };
}

/**
 * Encodes one bridge request.
 *
 * @param options
 */
function request(options: Record<string, unknown> = {}): Readable {
  return Readable.from([
    JSON.stringify({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'run',
      prompt: 'hello',
      options: { model: 'model', cwd: '/workspace', tools: [], ...options },
    }),
  ]);
}

/**
 * Parses captured JSONL frames.
 *
 * @param raw
 */
function frames(raw: string): Record<string, unknown>[] {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Creates an injected session and exposes lifecycle spies.
 *
 * @param events
 * @param promptFailure
 * @param structuredResult - Structured parameters returned at settlement.
 */
function fakeSession(
  events: unknown[],
  promptFailure?: unknown,
  structuredResult?: unknown,
): {
  result: PiBridgeSessionResult;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const abort = vi.fn(async (): Promise<void> => undefined);
  const dispose = vi.fn();
  const unsubscribe = vi.fn();
  const session: PiBridgeSession = {
    sessionId: 'session-1',
    model: { provider: 'litellm', id: 'model' },
    isStreaming: promptFailure !== undefined,
    getActiveToolNames: (): string[] => ['read'],
    subscribe(next): () => void {
      listener = next;
      return unsubscribe;
    },
    async prompt(): Promise<void> {
      for (const event of events) {
        listener?.(event as AgentSessionEvent);
      }
      if (promptFailure !== undefined) {
        return await Promise.reject(promptFailure);
      }
    },
    async setModel(): Promise<void> {
      return undefined;
    },
    abort,
    dispose,
  };
  return {
    result: { session, getStructuredResult: (): unknown => structuredResult },
    abort,
    dispose,
    unsubscribe,
  };
}

/** Awaits currently queued microtasks so pending writes settle. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/** Deferred bridge harness whose prompt settles under test control. */
type DeferredHarness = {
  result: PiBridgeSessionResult;
  stdout: Writable;
  stderr: Writable;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  started: Promise<void>;
  emit: (event: unknown) => void;
  resolvePrompt: () => void;
  written: () => string;
  stderrText: () => string;
};

/**
 * Creates a bridge harness whose prompt stays pending until resolved.
 *
 * @param config - Optional behavior toggles.
 * @param config.abortResolvesPrompt - Resolve the prompt when abort runs.
 * @returns The deferred harness controls.
 */
function deferredSession(
  config: { abortResolvesPrompt?: boolean } = {},
): DeferredHarness {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let resolvePrompt: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const promptPromise = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  const abort = vi.fn(async (): Promise<void> => {
    if (config.abortResolvesPrompt) {
      resolvePrompt?.();
    }
  });
  const dispose = vi.fn();
  const stdoutCapture = capture();
  const stderrCapture = capture();
  const session: PiBridgeSession = {
    sessionId: 'session-deferred',
    model: { provider: 'litellm', id: 'model' },
    isStreaming: true,
    getActiveToolNames: (): string[] => ['read'],
    subscribe(next): () => void {
      listener = next;
      return vi.fn();
    },
    async prompt(): Promise<void> {
      markStarted?.();
      await promptPromise;
    },
    async setModel(): Promise<void> {
      return undefined;
    },
    abort,
    dispose,
  };
  return {
    result: { session, getStructuredResult: (): unknown => undefined },
    stdout: stdoutCapture.stream,
    stderr: stderrCapture.stream,
    abort,
    dispose,
    started,
    emit: (event): void => listener?.(event as AgentSessionEvent),
    resolvePrompt: (): void => resolvePrompt?.(),
    written: (): string => stdoutCapture.read(),
    stderrText: (): string => stderrCapture.read(),
  };
}

/**
 * Runs the bridge against a deferred harness using its own streams.
 *
 * @param harness - Deferred harness to drive.
 * @returns The bridge exit code.
 */
async function runDeferred(harness: DeferredHarness): Promise<number> {
  return runPiBridge({
    stdin: request(),
    stdout: harness.stdout,
    stderr: harness.stderr,
    env: {
      LITELLM_API_KEY: 'secret',
      LITELLM_BASE_URL: 'https://litellm.example',
    },
    async createSession(): Promise<PiBridgeSessionResult> {
      return harness.result;
    },
  });
}

/**
 * Runs the bridge with injected dependencies.
 *
 * @param sessionResult
 * @param stdin
 * @param env
 */
async function run(
  sessionResult: PiBridgeSessionResult,
  stdin: NodeJS.ReadableStream = request(),
  env: Record<string, string | undefined> = {
    LITELLM_API_KEY: 'secret',
    LITELLM_BASE_URL: 'https://litellm.example',
  },
): Promise<{
  code: number;
  output: Record<string, unknown>[];
  stderr: string;
}> {
  const stdout = capture();
  const errorOutput = capture();
  const createSession: NonNullable<PiBridgeDeps['createSession']> = async (
    _options: BridgePiOptions,
  ): Promise<PiBridgeSessionResult> => sessionResult;
  const code = await runPiBridge({
    stdin,
    stdout: stdout.stream,
    stderr: errorOutput.stream,
    env,
    createSession,
  });
  return { code, output: frames(stdout.read()), stderr: errorOutput.read() };
}

describe('runPiBridge', () => {
  it('writes init, normalized events, settled, then done in strict order', async () => {
    const fake = fakeSession([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'model',
          content: [
            { type: 'text', text: 'answer' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'read',
              input: { path: 'a' },
            },
          ],
          usage: { input: 1, output: 2, cost: { total: 0 } },
          stopReason: 'stop',
        },
      },
      { type: 'agent_settled' },
    ]);
    const result = await run(fake.result);
    expect(result.code).toBe(0);
    expect(result.output.map((frame) => frame.type)).toStrictEqual([
      'message',
      'message',
      'message',
      'done',
    ]);
    expect(
      result.output.map((frame) =>
        typeof frame.message === 'object' &&
        frame.message !== null &&
        'kind' in frame.message
          ? frame.message.kind
          : frame.type,
      ),
    ).toStrictEqual(['init', 'assistant_message_end', 'agent_settled', 'done']);
    expect(result.output[1]?.message).toMatchObject({
      content: [
        { type: 'text', text: 'answer' },
        {
          type: 'toolCall',
          id: 'tool-1',
          name: 'read',
          arguments: { path: 'a' },
        },
      ],
    });
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('passes an aborted assistant DTO through without classifying it as a failure', async () => {
    const fake = fakeSession([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'model',
          content: [{ type: 'text', text: 'partial' }],
          stopReason: 'aborted',
          errorMessage: 'cancelled',
        },
      },
      { type: 'agent_settled' },
    ]);
    const result = await run(fake.result);
    expect(result.code).toBe(0);
    expect(result.output.at(-1)?.type).toBe('done');
    const assistant = result.output
      .filter((frame) => frame.type === 'message')
      .map((frame) => frame.message as Record<string, unknown>)
      .find((message) => message.kind === 'assistant_message_end');
    expect(assistant).toMatchObject({
      stopReason: 'aborted',
      errorMessage: 'cancelled',
    });
  });

  it('fails when prompt resolves without agent_settled and never emits done', async () => {
    const fake = fakeSession([]);
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(result.output.map((frame) => frame.type)).toStrictEqual([
      'message',
      'error',
    ]);
    expect(result.stderr).toMatch(/without agent_settled/u);
  });

  it('normalizes prompt errors, aborts active work, and disposes', async () => {
    const fake = fakeSession([], 'provider failed');
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(result.output.at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'provider failed' },
    });
    expect(fake.abort).toHaveBeenCalledOnce();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    [Readable.from(['not json']), /JSON/u],
    [
      Readable.from([JSON.stringify({ version: 2, type: 'run' })]),
      /protocol-v1/u,
    ],
  ])('rejects malformed protocol input %#', async (stdin, expected) => {
    const result = await run(fakeSession([]).result, stdin);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(expected);
  });

  it('rejects missing credentials before creating a session', async () => {
    const result = await run(fakeSession([]).result, request(), {});
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/LITELLM_BASE_URL and LITELLM_API_KEY/u);
  });

  it('rejects host endpoint injection and unknown bridge options', async () => {
    const result = await run(
      fakeSession([]).result,
      request({ baseUrl: 'https://host.example' }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown option `baseUrl`/u);
  });

  it.each([
    { model: '', cwd: '/workspace', tools: [] },
    { model: 'm', cwd: 'relative', tools: [] },
    { model: 'm', cwd: '/workspace', tools: ['unknown'] },
    { model: 'm', cwd: '/workspace', tools: [], maxTokens: 0 },
    { model: 'm', cwd: '/workspace', tools: [], input: ['text', 'text'] },
    { model: 'm', cwd: '/workspace', tools: [], cost: { typo: 1 } },
  ])('rejects invalid exact bridge options %#', async (options) => {
    const result = await run(fakeSession([]).result, request(options));
    expect(result.code).toBe(1);
  });

  it('includes captured structured result in agent_settled', async () => {
    const result = await run(
      fakeSession([{ type: 'agent_settled' }], undefined, { score: 10 }).result,
    );
    expect(result.output[1]?.message).toStrictEqual({
      kind: 'agent_settled',
      structuredResult: { score: 10 },
    });
  });

  it('normalizes tool lifecycle and retry/compaction events and ignores unrelated events', async () => {
    const result = await run(
      fakeSession([
        { type: 'message_end', message: { role: 'user' } },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'a' },
              {
                type: 'toolCall',
                id: 't',
                name: 'bash',
                arguments: { command: 'pwd' },
              },
              { type: 'ignored' },
            ],
            usage: {
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              cost: { total: 0 },
            },
            stopReason: 'toolUse',
            errorMessage: 'detail',
          },
        },
        { type: 'tool_execution_start', toolName: 'bash', toolCallId: 't' },
        {
          type: 'tool_execution_update',
          toolName: 'bash',
          toolCallId: 't',
          partialResult: { line: 'working' },
        },
        {
          type: 'tool_execution_end',
          toolName: 'bash',
          toolCallId: 't',
          result: { output: 'done' },
          isError: false,
        },
        { type: 'auto_retry_start', attempt: 1 },
        { type: 'auto_retry_end', finalError: 'exhausted' },
        { type: 'compaction_start', reason: 'threshold' },
        { type: 'ignored' },
        { type: 'agent_settled' },
      ]).result,
    );
    const messages = result.output
      .filter((frame) => frame.type === 'message')
      .map((frame) => frame.message as Record<string, unknown>);
    expect(messages.map((message) => message.kind)).toStrictEqual([
      'init',
      'assistant_message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'system',
      'system',
      'system',
      'agent_settled',
    ]);
    expect(messages[1]).toMatchObject({
      model: 'litellm/model',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: 0 },
      },
    });
    expect(messages[3]?.content).toBe('{"line":"working"}');
    expect(messages[4]).toMatchObject({
      content: '{"output":"done"}',
      isError: false,
    });
    expect(messages[6]).toMatchObject({ error: 'exhausted' });
  });

  it('normalizes malformed assistant content and usage', async () => {
    const result = await run(
      fakeSession([
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'm',
            content: [null, 1, { type: 'text', text: 1 }, { type: 'tool_use' }],
            usage: { input: 'bad', cost: { total: 'bad' } },
          },
        },
        { type: 'agent_settled' },
      ]).result,
    );
    expect(result.output[1]?.message).toMatchObject({ content: [], usage: {} });
  });

  it('normalizes absent assistant fields and empty tool updates', async () => {
    const session = fakeSession([
      {
        type: 'message_end',
        message: { role: 'assistant', content: null, usage: null },
      },
      { type: 'tool_execution_start' },
      { type: 'tool_execution_update', content: undefined },
      { type: 'tool_execution_end', result: 'done', isError: true },
      { type: 'agent_settled' },
    ]);
    session.result.session.model = undefined;
    const result = await run(session.result);
    const messages = result.output
      .filter((frame) => frame.type === 'message')
      .map((frame) => frame.message as Record<string, unknown>);
    expect(messages[0]?.model).toBe('litellm/model');
    expect(messages[1]).toMatchObject({ content: [] });
    expect(messages[1]).not.toHaveProperty('usage');
    expect(messages[2]).toMatchObject({ toolName: '', toolCallId: '' });
    expect(messages[3]).not.toHaveProperty('content');
    expect(messages[4]).toMatchObject({ content: 'done', isError: true });
  });

  it('reports session factory failure without invoking a session', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runPiBridge({
      stdin: request(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
      async createSession(): Promise<PiBridgeSessionResult> {
        throw new Error('factory failed');
      },
    });
    expect(code).toBe(1);
    expect(frames(stdout.read()).at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'factory failed' },
    });
  });

  it('waits for stdout drain before done and preserves frame order', async () => {
    const chunks: string[] = [];
    let first = true;
    const stdout = new Writable({
      write(chunk, _encoding, callback): void {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
        );
        callback();
      },
    });
    const originalWrite = stdout.write.bind(stdout);
    vi.spyOn(stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array): boolean => {
        if (first) {
          first = false;
          setTimeout(() => stdout.emit('drain'), 0);
          originalWrite(chunk);
          return false;
        }
        return originalWrite(chunk);
      },
    );
    const stderr = capture();
    const fake = fakeSession([
      {
        type: 'message_end',
        message: { role: 'assistant', model: 'm', content: [] },
      },
      { type: 'agent_settled' },
    ]);
    const code = await runPiBridge({
      stdin: request(),
      stdout,
      stderr: stderr.stream,
      env: { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
      async createSession(): Promise<PiBridgeSessionResult> {
        return fake.result;
      },
    });
    expect(code).toBe(0);
    expect(frames(chunks.join('')).map((frame) => frame.type)).toStrictEqual([
      'message',
      'message',
      'message',
      'done',
    ]);
  });

  it('turns a stdout write failure into a deterministic bridge failure', async () => {
    const stdout = capture().stream;
    let writes = 0;
    vi.spyOn(stdout, 'write').mockImplementation((): boolean => {
      writes += 1;
      if (writes === 2) {
        throw new Error('write failed');
      }
      return true;
    });
    const stderr = capture();
    const code = await runPiBridge({
      stdin: request(),
      stdout,
      stderr: stderr.stream,
      env: { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
      async createSession(): Promise<PiBridgeSessionResult> {
        return fakeSession([
          {
            type: 'message_end',
            message: { role: 'assistant', model: 'm', content: [] },
          },
          { type: 'agent_settled' },
        ]).result;
      },
    });
    expect(code).toBe(1);
    expect(stderr.read()).toMatch(/write failed/u);
  });

  it('attempts cleanup when abort itself fails', async () => {
    const fake = fakeSession([], new Error('prompt failed'));
    fake.abort.mockRejectedValueOnce(new Error('abort failed'));
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the prompt failure when disposal also throws', async () => {
    const fake = fakeSession([], new Error('provider failed'));
    fake.dispose.mockImplementation(() => {
      throw new Error('dispose failed');
    });
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(result.output.at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'provider failed' },
    });
    expect(result.stderr).toMatch(/provider failed/u);
    expect(result.stderr).not.toMatch(/dispose failed/u);
  });

  it('surfaces a disposal failure after an otherwise clean run', async () => {
    const fake = fakeSession([{ type: 'agent_settled' }]);
    fake.dispose.mockImplementation(() => {
      throw new Error('dispose failed');
    });
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(result.output.at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'dispose failed' },
    });
  });

  it.each([
    [{ version: 1, type: 'other', prompt: 'x', options: {} }, /protocol-v1/u],
    [{ version: 1, type: 'run', prompt: 1, options: {} }, /string prompt/u],
    [{ version: 1, type: 'run', prompt: 'x', options: [] }, /object options/u],
  ])('validates protocol request branch %#', async (payload, expected) => {
    const result = await run(
      fakeSession([]).result,
      Readable.from([JSON.stringify(payload)]),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(expected);
  });

  it.each([
    [{ model: 1, cwd: '/workspace', tools: [] }, /invalid model/u],
    [{ model: 'm', cwd: 1, tools: [] }, /invalid model/u],
    [{ model: 'm', cwd: '/workspace', tools: [1] }, /invalid model/u],
  ])('validates option branch %#', async (options, expected) => {
    const result = await run(fakeSession([]).result, request(options));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(expected);
  });

  it('suppresses the terminal frame when the prompt rejects after settling', async () => {
    const fake = fakeSession([{ type: 'agent_settled' }], 'provider failed');
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(result.output.map((frame) => frame.type)).toStrictEqual([
      'message',
      'error',
    ]);
    const kinds = result.output
      .filter((frame) => frame.type === 'message')
      .map((frame) => (frame.message as Record<string, unknown>).kind);
    expect(kinds).toStrictEqual(['init']);
    expect(result.stderr).toMatch(/provider failed/u);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it('withholds the terminal frame until a deferred prompt fulfills', async () => {
    const deferred = deferredSession();
    const codePromise = runDeferred(deferred);
    await deferred.started;
    deferred.emit({ type: 'agent_settled' });
    await flushMicrotasks();
    expect(deferred.written()).not.toMatch(/"type":"done"/u);
    deferred.resolvePrompt();
    const code = await codePromise;
    expect(code).toBe(0);
    const kinds = frames(deferred.written())
      .filter((frame) => frame.type === 'message')
      .map((frame) => (frame.message as Record<string, unknown>).kind);
    expect(kinds).toStrictEqual(['init', 'agent_settled']);
    expect(frames(deferred.written()).at(-1)?.type).toBe('done');
  });

  it('aborts promptly on a mid-run write failure without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const deferred = deferredSession({ abortResolvesPrompt: true });
      let writes = 0;
      vi.spyOn(deferred.stdout, 'write').mockImplementation((): boolean => {
        writes += 1;
        if (writes === 2) {
          throw new Error('write failed');
        }
        return true;
      });
      const codePromise = runDeferred(deferred);
      await deferred.started;
      deferred.emit({
        type: 'message_end',
        message: { role: 'assistant', model: 'm', content: [] },
      });
      const code = await codePromise;
      expect(code).toBe(1);
      expect(deferred.abort).toHaveBeenCalledOnce();
      expect(deferred.written()).not.toMatch(/"type":"done"/u);
      expect(deferred.stderrText()).toMatch(/write failed/u);
      await flushMicrotasks();
      expect(rejections).toStrictEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('resolves to a failure code when every stdout write throws', async () => {
    const deferred = deferredSession();
    vi.spyOn(deferred.stdout, 'write').mockImplementation((): boolean => {
      throw new Error('stdout gone');
    });
    const codePromise = runDeferred(deferred);
    await deferred.started;
    deferred.emit({ type: 'agent_settled' });
    deferred.resolvePrompt();
    const code = await codePromise;
    expect(code).toBe(1);
    expect(deferred.stderrText()).toMatch(/stdout gone/u);
  });

  it('aborts once and emits no done when the pending write queue overflows', async () => {
    const overflow = Array.from({ length: MAX_BRIDGE_QUEUE_SIZE + 1 }, () => ({
      type: 'compaction_start' as const,
      reason: 'threshold',
    }));
    const fake = fakeSession([...overflow, { type: 'agent_settled' }]);
    let held = false;
    vi.spyOn(fake.result.session, 'isStreaming', 'get').mockReturnValue(true);
    const stdout = new Writable({
      write(_chunk, _encoding, callback): void {
        if (!held) {
          held = true;
          setTimeout(callback, 0);
          return;
        }
        callback();
      },
    });
    const stderr = capture();
    const code = await runPiBridge({
      stdin: request(),
      stdout,
      stderr: stderr.stream,
      env: { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
      async createSession(): Promise<PiBridgeSessionResult> {
        return fake.result;
      },
    });
    expect(code).toBe(1);
    expect(fake.abort).toHaveBeenCalledOnce();
    expect(stderr.read()).toMatch(/exceeded 10000/u);
  });

  it('aborts and emits no done when a frame exceeds the maximum line length', async () => {
    const fake = fakeSession([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'x'.repeat(MAX_BRIDGE_LINE_LENGTH) }],
        },
      },
      { type: 'agent_settled' },
    ]);
    vi.spyOn(fake.result.session, 'isStreaming', 'get').mockReturnValue(true);
    const result = await run(fake.result);
    expect(result.code).toBe(1);
    expect(fake.abort).toHaveBeenCalledOnce();
    expect(result.output.some((frame) => frame.type === 'done')).toBe(false);
    expect(result.stderr).toMatch(/maximum line length/u);
  });

  it('drops callbacks delivered after the writer is sealed', async () => {
    const deferred = deferredSession();
    const codePromise = runDeferred(deferred);
    await deferred.started;
    deferred.emit({ type: 'agent_settled' });
    deferred.resolvePrompt();
    const code = await codePromise;
    deferred.emit({
      type: 'message_end',
      message: { role: 'assistant', model: 'm', content: [] },
    });
    await flushMicrotasks();
    const output = frames(deferred.written());
    expect(code).toBe(0);
    expect(output.at(-1)?.type).toBe('done');
    const kinds = output
      .filter((frame) => frame.type === 'message')
      .map((frame) => (frame.message as Record<string, unknown>).kind);
    expect(kinds).toStrictEqual(['init', 'agent_settled']);
  });

});

describe('settleIgnored', () => {
  it('observes fulfilled, rejected, and chained settlements', async () => {
    const caught = vi.fn((handler: (cause: unknown) => unknown) => {
      expect(handler(new Error('chained failure'))).toBeUndefined();
      return undefined;
    });
    const chained = { catch: caught };
    const then = vi.fn(
      (
        fulfilled: (value: unknown) => unknown,
        rejected: (cause: unknown) => unknown,
      ) => {
        expect(fulfilled('done')).toBeUndefined();
        expect(rejected(new Error('cleanup failed'))).toBeUndefined();
        return chained;
      },
    );
    settleIgnored({ then } as unknown as Promise<unknown>);
    expect(then).toHaveBeenCalledOnce();
    expect(caught).toHaveBeenCalledOnce();
  });
});

describe('createIsolatedSession', () => {
  /**
   * Creates an injected SDK boundary and captures all inputs.
   *
   * @param resolved - Whether model resolution succeeds.
   * @returns Injected SDK, captures, fake session, and loader.
   */
  function sdkHarness(resolved = true): {
    sdk: PiBridgeSdk;
    captured: Record<string, unknown>;
    session: PiBridgeSession;
    loader: { reload: ReturnType<typeof vi.fn> };
  } {
    const captured: Record<string, unknown> = {};
    const session: PiBridgeSession = {
      sessionId: 's',
      model: { provider: 'litellm', id: 'm' },
      isStreaming: false,
      getActiveToolNames: (): string[] => [],
      subscribe: (): (() => void) => (): void => undefined,
      async prompt(): Promise<void> {
        return undefined;
      },
      async setModel(): Promise<void> {
        return undefined;
      },
      async abort(): Promise<void> {
        return undefined;
      },
      dispose: vi.fn(),
    };
    const loader = { reload: vi.fn(async (): Promise<void> => undefined) };
    const sdk: PiBridgeSdk = {
      async createModelRuntime(options) {
        captured.runtime = options;
        return { runtime: true } as never;
      },
      createSettings(options) {
        captured.settings = options;
        return { settings: true } as never;
      },
      createSessionManager(cwd) {
        captured.cwd = cwd;
        return { manager: true } as never;
      },
      createResourceLoader(options) {
        captured.loader = options;
        return loader as never;
      },
      defineTool(tool) {
        captured.tool = tool;
        return tool as never;
      },
      async createAgentSession(options) {
        captured.session = options;
        return { session, extensionsResult: {} as never };
      },
      resolveCliModel(options) {
        captured.resolve = options;
        return resolved
          ? { model: {}, error: undefined }
          : { model: undefined, error: 'not found' };
      },
    };
    return { sdk, captured, session, loader };
  }

  it('constructs exact isolated normal session and provider model declaration', async () => {
    const harness = sdkHarness();
    const result = await createIsolatedSession(
      {
        model: 'model-x',
        cwd: '/workspace',
        tools: ['read'],
        systemPrompt: 'system',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 100,
        maxTokens: 20,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
      {
        LITELLM_API_KEY: 'secret',
        LITELLM_BASE_URL: 'https://litellm.example/',
      },
      harness.sdk,
    );
    expect(result.session).toBe(harness.session);
    expect(harness.captured.runtime).toMatchObject({
      modelsPath: null,
      credentials: expect.any(Object),
      allowModelNetwork: false,
    });
    expect(harness.captured.settings).toMatchObject({
      retry: { enabled: false },
      compaction: { enabled: false },
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    });
    expect(harness.captured.cwd).toBe('/workspace');
    expect(harness.captured.session).toMatchObject({ tools: ['read'] });
    const loaderOptions = harness.captured.loader as Record<string, unknown>;
    expect(loaderOptions).toMatchObject({
      cwd: '/workspace',
      agentDir: '/workspace/.metamask-agent-runner-pi',
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPrompt: 'system',
    });
    const factories = loaderOptions.extensionFactories;
    const registerProvider = vi.fn();
    const registerFactory = requireFirstFunction(factories);
    registerFactory({ registerProvider });
    expect(registerProvider).toHaveBeenCalledWith(
      'litellm',
      expect.objectContaining({
        baseUrl: 'https://litellm.example/v1',
        models: [
          expect.objectContaining({
            id: 'model-x',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 100,
            maxTokens: 20,
          }),
        ],
      }),
    );
    expect(harness.loader.reload).toHaveBeenCalledOnce();
  });

  it('constructs structured tool, disables built-ins, and captures result', async () => {
    const harness = sdkHarness();
    const result = await createIsolatedSession(
      {
        model: 'm',
        cwd: '/workspace',
        tools: [],
        structured: { schema: { type: 'object' }, systemPrompt: 'rubric' },
      },
      { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'https://litellm' },
      harness.sdk,
    );
    expect(harness.captured.session).toMatchObject({
      noTools: 'builtin',
      tools: ['submit_judgment'],
    });
    const tool = harness.captured.tool as Record<string, unknown>;
    expect(tool).toMatchObject({
      name: 'submit_judgment',
      parameters: { type: 'object' },
      constrainedSampling: { type: 'json_schema', strict: 'require' },
    });
    const { execute } = tool;
    const executeTool = requireFunction(execute);
    await executeTool('id', { score: 8 });
    expect(result.getStructuredResult()).toStrictEqual({ score: 8 });
  });

  it('uses default model metadata and omits an absent system prompt', async () => {
    const harness = sdkHarness();
    await createIsolatedSession(
      { model: 'm', cwd: '/workspace', tools: [] },
      { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'https://litellm/' },
      harness.sdk,
    );
    const loader = harness.captured.loader as Record<string, unknown>;
    expect(loader).not.toHaveProperty('systemPrompt');
    const register = vi.fn();
    requireFirstFunction(loader.extensionFactories)({
      registerProvider: register,
    });
    expect(register).toHaveBeenCalledWith(
      'litellm',
      expect.objectContaining({
        baseUrl: 'https://litellm/v1',
        models: [
          expect.objectContaining({
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8192,
          }),
        ],
      }),
    );
  });

  it('disposes and errors when model resolution fails', async () => {
    const harness = sdkHarness(false);
    await expect(
      createIsolatedSession(
        { model: 'missing', cwd: '/workspace', tools: [] },
        { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
        harness.sdk,
      ),
    ).rejects.toThrow(/Could not resolve litellm\/missing/u);
    expect(harness.session.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the resolution failure when setup disposal also throws', async () => {
    const harness = sdkHarness(false);
    const dispose = vi.spyOn(harness.session, 'dispose').mockImplementation(
      () => {
        throw new Error('dispose failed');
      },
    );
    await expect(
      createIsolatedSession(
        { model: 'missing', cwd: '/workspace', tools: [] },
        { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
        harness.sdk,
      ),
    ).rejects.toThrow(/Could not resolve litellm\/missing/u);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the session and keeps the failure when setModel rejects', async () => {
    const harness = sdkHarness(true);
    vi.spyOn(harness.session, 'setModel').mockRejectedValue(
      new Error('set model failed'),
    );
    const dispose = vi.spyOn(harness.session, 'dispose').mockImplementation(
      () => {
        throw new Error('dispose failed');
      },
    );
    await expect(
      createIsolatedSession(
        { model: 'm', cwd: '/workspace', tools: [] },
        { LITELLM_API_KEY: 'key', LITELLM_BASE_URL: 'url' },
        harness.sdk,
      ),
    ).rejects.toThrow('set model failed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('exercises the standalone SDK boundary factories', async () => {
    expect(
      await defaultSdk.createModelRuntime({
        modelsPath: null,
        credentials: createPiCredentialStore(),
        allowModelNetwork: false,
      }),
    ).toBeDefined();
    expect(defaultSdk.createSettings({})).toBeDefined();
    expect(defaultSdk.createSessionManager('/tmp')).toBeDefined();
    expect(
      defaultSdk.createResourceLoader({
        cwd: '/tmp',
        agentDir: '/tmp/.pi',
        settingsManager: defaultSdk.createSettings({}),
      }),
    ).toBeDefined();
    expect(
      defaultSdk.resolveCliModel({
        cliProvider: 'missing',
        cliModel: 'missing',
        modelRuntime: await defaultSdk.createModelRuntime({
          modelsPath: null,
          credentials: createPiCredentialStore(),
          allowModelNetwork: false,
        }),
      }),
    ).toMatchObject({ model: undefined });
  });

  it('creates and disposes a real isolated SDK session boundary', async () => {
    const runtime = await defaultSdk.createModelRuntime({
      modelsPath: null,
      credentials: createPiCredentialStore(),
      allowModelNetwork: false,
    });
    const settings = defaultSdk.createSettings({});
    const manager = defaultSdk.createSessionManager('/tmp');
    const loader = defaultSdk.createResourceLoader({
      cwd: '/tmp',
      agentDir: '/tmp/.pi',
      settingsManager: settings,
    });
    await loader.reload();
    const { session } = await createDefaultAgentSession({
      cwd: '/tmp',
      agentDir: '/tmp/.pi',
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: manager,
      tools: [],
    });
    expect(session.sessionId).toStrictEqual(expect.any(String));
    session.dispose();
  });
});

describe('bridge utility behavior', () => {
  it('settles rejected standalone queue predecessors', () => {
    expect(ignoreBridgeQueueFailure()).toBeUndefined();
  });
  it('implements standalone credential mutation and rejection recovery', async () => {
    const store = createBridgeCredentialStore();
    expect(await store.modify('p', async () => undefined)).toBeUndefined();
    expect(
      await store.modify('p', async () => ({ type: 'api_key', key: 'one' })),
    ).toMatchObject({ key: 'one' });
    expect(await store.modify('p', async () => undefined)).toMatchObject({
      key: 'one',
    });
    await expect(
      store.modify('p', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(
      await store.modify('p', async () => ({ type: 'api_key', key: 'two' })),
    ).toMatchObject({ key: 'two' });
    expect(await store.list()).toStrictEqual([
      { providerId: 'p', type: 'api_key' },
    ]);
    await store.delete('p');
    expect(await store.read('p')).toBeUndefined();
  });

  it('serializes bridge credential writes and isolates providers', async () => {
    const store = createBridgeCredentialStore();
    const order: string[] = [];
    const first = store.modify('p', async () => {
      order.push('first');
      await Promise.resolve();
      return { type: 'api_key', key: 'one' };
    });
    const second = store.modify('p', async (current) => {
      order.push(current?.type ?? 'missing');
      return { type: 'api_key', key: 'two' };
    });
    expect(
      await store.modify('other', async () => ({
        type: 'api_key',
        key: 'other',
      })),
    ).toMatchObject({ key: 'other' });
    await Promise.all([first, second]);
    expect(order).toStrictEqual(['first', 'api_key']);
  });

  it('accepts complete exact bridge options from container env', () => {
    expect(
      validateBridgeOptions(
        {
          model: 'm',
          cwd: '/workspace',
          systemPrompt: 'system',
          tools: ['read', 'bash'],
          contextWindow: 100,
          maxTokens: 10,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          structured: { schema: { type: 'object' }, systemPrompt: 'rubric' },
        },
        { LITELLM_BASE_URL: 'https://container', LITELLM_API_KEY: 'key' },
      ),
    ).toMatchObject({ model: 'm', cwd: '/workspace' });
  });

  it('rejects non-plain and malformed optional bridge records', () => {
    const env = {
      LITELLM_BASE_URL: 'https://container',
      LITELLM_API_KEY: 'key',
    };
    expect(() => validateBridgeOptions([] as never, env)).toThrow(
      /plain object/u,
    );
    expect(() =>
      validateBridgeOptions(
        { model: 'm', cwd: '/workspace', tools: [], systemPrompt: 1 },
        env,
      ),
    ).toThrow(/systemPrompt/u);
    expect(() =>
      validateBridgeOptions(
        { model: 'm', cwd: '/workspace', tools: [], reasoning: 'yes' },
        env,
      ),
    ).toThrow(/reasoning/u);
    expect(() =>
      validateBridgeOptions(
        { model: 'm', cwd: '/workspace', tools: [], cost: [] },
        env,
      ),
    ).toThrow(/cost.*plain object/u);
    expect(() =>
      validateBridgeOptions(
        { model: 'm', cwd: '/workspace', tools: [], structured: {} },
        env,
      ),
    ).toThrow(/structured/u);
  });
  it('keeps bridge queue and line limits aligned with the host contract', async () => {
    const host = await import('../docker/bridge.js');
    expect(MAX_BRIDGE_QUEUE_SIZE).toBe(host.MAX_BRIDGE_QUEUE_SIZE);
    expect(MAX_BRIDGE_LINE_LENGTH).toBe(host.MAX_BRIDGE_LINE_LENGTH);
  });
  it('serializes strings, absent values, objects, and circular tool output', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyJsonSafe('text')).toBe('text');
    expect(stringifyJsonSafe(undefined)).toBe('');
    expect(stringifyJsonSafe({ ok: true })).toBe('{"ok":true}');
    expect(stringifyJsonSafe(circular)).toBe('[object Object]');
  });

  it('reports a rejected standalone promise without rethrowing it', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    settleMain(Promise.reject(new Error('main failed')));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('[pi-bridge] fatal: Error: main failed'),
    );
    stderr.mockRestore();
  });

  it('reports that the imported Pi bridge is not the main entry point', () => {
    expect(isMain()).toBe(false);
  });

  it('covers provider normalization defaults and optional metadata', () => {
    expect(
      createModelDeclaration({ model: 'm', cwd: '/tmp', tools: [] }),
    ).toMatchObject({
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    });
    expect(normalizeBridgeContent(null)).toStrictEqual([]);
    expect(
      normalizeBridgeContent({ type: 'text', text: 'hello' }),
    ).toStrictEqual([{ type: 'text', text: 'hello' }]);
    expect(
      normalizeBridgeContent({
        type: 'tool_use',
        id: 'id',
        name: 'read',
        input: { path: 'a' },
      }),
    ).toStrictEqual([
      {
        type: 'toolCall',
        id: 'id',
        name: 'read',
        arguments: { path: 'a' },
      },
    ]);
    expect(normalizeBridgeContent({ type: 'unknown' })).toStrictEqual([]);
    expect(normalizeBridgeUsage({})).toStrictEqual({});
    expect(
      normalizeBridgeUsage({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: 5 },
      }),
    ).toStrictEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: { total: 5 },
    });
  });

  it('covers empty, update, and terminal tool normalization branches', () => {
    expect(
      normalizeBridgeToolEvent({ type: 'tool_execution_start' }),
    ).toStrictEqual({
      kind: 'tool_execution_start',
      toolName: '',
      toolCallId: '',
    });
    expect(
      normalizeBridgeToolEvent({
        type: 'tool_execution_update',
        content: '',
      }),
    ).toStrictEqual({
      kind: 'tool_execution_update',
      toolName: '',
      toolCallId: '',
    });
    expect(
      normalizeBridgeToolEvent({
        type: 'tool_execution_end',
        result: 'done',
        isError: true,
      }),
    ).toMatchObject({ content: 'done', isError: true });
  });

  it('normalizes error and non-error bridge failures', () => {
    const error = new Error('failure');
    error.name = '';
    delete error.stack;
    expect(makeBridgeErrorEvent(error)).toMatchObject({
      error: { name: 'Error', message: 'failure' },
    });
    expect(makeBridgeErrorEvent('failure')).toMatchObject({
      error: { name: 'Error', message: 'failure' },
    });
    expect(describeBridgeError(error)).toBe(': failure');
    expect(describeBridgeError('failure')).toBe('failure');
  });
});

/**
 * Requires a callable test value.
 *
 * @param value - Candidate callback.
 * @returns The callable value.
 */
function requireFunction(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError('Expected a function.');
  }
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
}

/**
 * Requires an array whose first element is callable.
 *
 * @param value - Candidate callback array.
 * @returns The first callback.
 */
function requireFirstFunction(value: unknown): (...args: unknown[]) => unknown {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an array.');
  }
  return requireFunction(value[0]);
}
