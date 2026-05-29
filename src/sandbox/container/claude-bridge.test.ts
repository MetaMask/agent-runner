import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { ClaudeBridgeDeps } from './claude-bridge.js';
import { BRIDGE_PROTOCOL_VERSION, runClaudeBridge } from './claude-bridge.js';

/**
 * SDK `query` call parameters consumed by the bridge fakes. Extracted
 * so JSDoc on inline function parameters does not need to enumerate
 * `prompt`/`options` for every fake.
 */
type FakeQueryParams = {
  /** SDK prompt. */
  prompt: unknown;
  /** SDK options. */
  options?: unknown;
};

/**
 * Captures everything written to a {@link Writable} stream as a single
 * string for assertions.
 */
type CapturedStream = {
  /** The writable stream passed to the bridge. */
  stream: Writable;
  /** Returns the accumulated utf-8 text written to the stream. */
  read: () => string;
};

/**
 * Shape used by assertions on parsed `error` events.
 */
type ErrorEvent = {
  /** Event-type discriminant emitted by the bridge. */
  type: string;
  /** Error payload emitted by the bridge. */
  error: {
    /** Error constructor name (`Error` for non-`Error` causes). */
    name: string;
    /** Human-readable error message. */
    message: string;
    /** Optional stack trace when the cause was a real `Error`. */
    stack?: string;
  };
};

/**
 * Builds a writable stream that records all written chunks for later
 * inspection.
 *
 * @returns The stream and a reader returning the captured utf-8 text.
 */
function makeCapturedStream(): CapturedStream {
  const chunks: string[] = [];
  const stream = new Writable({
    /**
     * Records each chunk as utf-8 text.
     *
     * @param chunk - Bytes or string written to the stream.
     * @param _encoding - Stream encoding (ignored; chunks are decoded
     * explicitly via {@link toUtf8}).
     * @param callback - Standard writable callback.
     */
    write(chunk, _encoding, callback): void {
      chunks.push(toUtf8(chunk));
      callback();
    },
  });
  return {
    stream,
    /**
     * Returns the accumulated utf-8 text written to the stream.
     *
     * @returns The combined chunks.
     */
    read: () => chunks.join(''),
  };
}

/**
 * Builds a readable stream that emits the supplied utf-8 payload then
 * ends, mimicking the container bridge's stdin.
 *
 * @param payload - The payload (already JSON-encoded, or arbitrary
 * bytes for negative tests).
 * @returns The readable stream.
 */
function makeStdin(payload: string): NodeJS.ReadableStream {
  return Readable.from([payload]);
}

/**
 * Parses the captured stdout into an array of JSON event objects, one
 * per newline-terminated line. Blank trailing lines are ignored.
 *
 * @param raw - Full captured stdout buffer.
 * @returns Parsed JSON objects in order.
 */
function parseStdoutEvents(raw: string): unknown[] {
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Builds a fake `query` function returning an async iterable over the
 * supplied messages.
 *
 * @param messages - Messages to yield in order.
 * @returns A fake query implementation.
 */
function makeFakeQuery(messages: unknown[]): ClaudeBridgeDeps['query'] {
  /**
   * Fake `query` returning an async iterable over `messages`.
   *
   * @param _params - SDK call parameters (ignored by the fake).
   * @returns An async iterable yielding each message in order.
   */
  const fake = (_params: FakeQueryParams): AsyncIterable<unknown> => ({
    /**
     * Yields each message in order.
     *
     * @yields The supplied messages.
     */
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const message of messages) {
        yield message;
      }
    },
  });
  // Cast through unknown: the real return type is the SDK's `Query`
  // (an async iterator with extra methods); the bridge only consumes
  // the iterator protocol, so the fake suffices here.
  return fake as unknown as ClaudeBridgeDeps['query'];
}

/**
 * Builds a fake `query` function that throws the supplied error before
 * yielding anything.
 *
 * @param error - Value to throw from the iterator.
 * @returns A fake query implementation.
 */
function makeThrowingQuery(error: unknown): ClaudeBridgeDeps['query'] {
  // Hand-rolled async iterable so we can throw on `.next()` without
  // an async generator (which would either fail `require-yield` or
  // require an `await Promise.reject` dance that trips other rules).
  /**
   * Fake `query` whose iterator throws on first `next()`.
   *
   * @param _params - SDK call parameters (ignored by the fake).
   * @returns An async iterable whose `next()` rejects with `error`.
   */
  const fake = (_params: FakeQueryParams): AsyncIterable<unknown> => ({
    /**
     * Returns an iterator whose `next()` throws on first call.
     *
     * @returns The throwing iterator.
     */
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        /**
         * Throws the captured error on first invocation.
         *
         * @returns Never; always throws.
         */
        async next(): Promise<IteratorResult<unknown>> {
          throw error;
        },
      };
    },
  });
  return fake as unknown as ClaudeBridgeDeps['query'];
}

/**
 * Converts a Buffer/string chunk emitted by a writable stream into a
 * utf-8 string.
 *
 * @param chunk - Chunk delivered to the writable's `write` hook.
 * @returns The chunk decoded as utf-8.
 */
function toUtf8(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  return String(chunk);
}

/**
 * Serializes a JSON value into a single-line request payload.
 *
 * @param value - The value to encode.
 * @returns The JSON-encoded string.
 */
function encode(value: unknown): string {
  return JSON.stringify(value);
}

describe('runClaudeBridge', () => {
  it('streams SDK messages as JSONL message events then a done event', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'assistant', message: { id: 'm1' } },
      ]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'hello',
          options: { cwd: '/workspace' },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);

    const events = parseStdoutEvents(stdout.read());
    expect(events).toStrictEqual([
      {
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system', subtype: 'init', session_id: 's' },
      },
      {
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'assistant', message: { id: 'm1' } },
      },
      { version: BRIDGE_PROTOCOL_VERSION, type: 'done' },
    ]);

    // No diagnostics on the success path.
    expect(stderr.read()).toBe('');
  });

  it('forwards the request prompt and options to the query function', async () => {
    let capturedParams: FakeQueryParams | undefined;
    /**
     * Captures the prompt/options the bridge forwards into the SDK,
     * returning an empty message stream so the bridge still emits
     * `done`.
     *
     * @param params - Parameters supplied by the bridge.
     * @returns An empty async iterable.
     */
    const queryImpl = (params: FakeQueryParams): AsyncIterable<unknown> => {
      capturedParams = {
        prompt: params.prompt,
        options: params.options,
      };
      return {
        /**
         * Empty iterator that emits no messages.
         *
         * @returns A finished async iterator on first `next()`.
         */
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            /**
             * Signals end of stream immediately.
             *
             * @returns A resolved "done" iterator result.
             */
            async next(): Promise<IteratorResult<unknown>> {
              return { value: undefined, done: true };
            },
          };
        },
      };
    };
    const query = queryImpl as unknown as ClaudeBridgeDeps['query'];

    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query,
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'do the thing',
          options: { model: 'claude-3', cwd: '/workspace' },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(capturedParams).toStrictEqual({
      prompt: 'do the thing',
      options: { model: 'claude-3', cwd: '/workspace' },
    });
    expect(parseStdoutEvents(stdout.read())).toStrictEqual([
      { version: BRIDGE_PROTOCOL_VERSION, type: 'done' },
    ]);
  });

  it('emits an error event with stack and exits non-zero when query throws', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();
    const cause = new TypeError('bad call');

    const exitCode = await runClaudeBridge({
      query: makeThrowingQuery(cause),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'hi',
          options: {},
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);

    const events = parseStdoutEvents(stdout.read());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: {
        name: 'TypeError',
        message: 'bad call',
      },
    });
    // A real Error.stack is a string; the bridge forwards it verbatim.
    const errorEvent = events[0] as ErrorEvent;
    expect(typeof errorEvent.error.stack).toBe('string');

    // Stderr breadcrumb references the bridge.
    expect(stderr.read()).toMatch(/\[claude-bridge\] query failed:/u);
  });

  it('falls back to name "Error" and stringifies non-Error throws', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeThrowingQuery('plain string failure'),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'hi',
          options: {},
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);

    const events = parseStdoutEvents(stdout.read());
    expect(events).toStrictEqual([
      {
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: { name: 'Error', message: 'plain string failure' },
      },
    ]);
  });

  it('emits an error event when stdin is empty', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(''),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);

    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.error.message).toMatch(/stdin was empty/u);
    expect(stderr.read()).toMatch(/failed to read request/u);
  });

  it('emits an error event when stdin is not valid JSON', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin('not-json{'),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);

    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.error.message).toMatch(/not valid JSON/u);
  });

  it('emits an error event when stdin is not a JSON object', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin('42'),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);

    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/must be a JSON object/u);
  });

  it('rejects unsupported protocol versions', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(
        encode({ version: 99, type: 'run', prompt: 'hi', options: {} }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/unsupported version: 99/u);
  });

  it('formats undefined version in the error message', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(encode({ type: 'run', prompt: 'hi', options: {} })),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/unsupported version: undefined/u);
  });

  it('formats null version in the error message', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(
        encode({ version: null, type: 'run', prompt: 'hi', options: {} }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/unsupported version: null/u);
  });

  it('rejects unsupported request types', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'cancel',
          prompt: 'hi',
          options: {},
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/unsupported type: "cancel"/u);
  });

  it('rejects non-string prompts', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 42,
          options: {},
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(/`prompt` must be a string/u);
  });

  it('rejects non-object options', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'hi',
          options: null,
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    const events = parseStdoutEvents(stdout.read()) as ErrorEvent[];
    expect(events[0]?.error.message).toMatch(
      /`options` must be a JSON object/u,
    );
  });

  it('awaits backpressure drain before continuing when stdout is full', async () => {
    const writtenChunks: string[] = [];
    let drainCallback: (() => void) | undefined;
    let writeCallCount = 0;

    const backpressuredStream = new Writable({
      /**
       * Accepts chunks and simulates backpressure on the second write
       * by returning false, then emits drain asynchronously.
       *
       * @param chunk - Bytes or string written to the stream.
       * @param _encoding - Stream encoding (unused).
       * @param callback - Standard writable callback.
       */
      write(chunk, _encoding, callback): void {
        writtenChunks.push(toUtf8(chunk));
        writeCallCount += 1;
        callback();
      },
      highWaterMark: 1,
    });

    // Override write to simulate backpressure on the second call.
    const originalWrite = backpressuredStream.write.bind(backpressuredStream);
    backpressuredStream.write = function (
      ...args: Parameters<typeof backpressuredStream.write>
    ): boolean {
      const result = originalWrite(...args);
      writeCallCount += 1;
      if (writeCallCount === 2) {
        // Signal backpressure; schedule drain on next tick.
        setTimeout(() => {
          drainCallback?.();
          backpressuredStream.emit('drain');
        }, 1);
        return false;
      }
      return result;
    } as typeof backpressuredStream.write;

    backpressuredStream.once('drain', () => {
      drainCallback?.();
    });

    const stderr = makeCapturedStream();

    const exitCode = await runClaudeBridge({
      query: makeFakeQuery([{ first: true }, { second: true }]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'backpressure test',
          options: {},
        }),
      ),
      stdout: backpressuredStream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    const events = parseStdoutEvents(writtenChunks.join(''));
    const types = events.map(
      (event) => (event as Record<string, unknown>).type,
    );
    expect(types).toStrictEqual(['message', 'message', 'done']);
  });

  it('writes only one JSONL event per line on stdout', async () => {
    const stdout = makeCapturedStream();
    const stderr = makeCapturedStream();

    await runClaudeBridge({
      query: makeFakeQuery([{ a: 1 }, { b: 2 }]),
      stdin: makeStdin(
        encode({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'run',
          prompt: 'hi',
          options: {},
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const raw = stdout.read();
    // Each event is followed by exactly one newline; the bridge does
    // not emit blank lines.
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n');
    // Trailing empty entry from final newline.
    expect(lines.at(-1)).toBe('');
    const nonEmpty = lines.slice(0, -1);
    expect(nonEmpty).toHaveLength(3);
    for (const line of nonEmpty) {
      expect(line).not.toMatch(/\n/u);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
