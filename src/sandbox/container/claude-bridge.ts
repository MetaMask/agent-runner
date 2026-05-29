import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Container-side bridge script for the Docker Claude sandbox.
 *
 * This module is published as a single compiled `.mjs` file, copied
 * into the sandbox container, and executed by `node` over `docker
 * exec`. It speaks the host/sandbox bridge protocol on its stdio:
 *
 * - Stdin: a single JSON document matching the v1 `run` request shape.
 * - Stdout: one JSON event per line; `message`, `error`, then `done`.
 * - Stderr: free-form debug/log output (never machine-parsed).
 *
 * The script intentionally inlines the protocol shape so it can run
 * without any sibling files from this package. Host-side code keeps a
 * single source of truth in `src/sandbox/docker/bridge-protocol.ts`;
 * the protocol tests assert both sides agree on the wire format.
 */

/**
 * Wire-protocol version recognised by the bridge. Mirrored on the host
 * side as `BRIDGE_PROTOCOL_VERSION`.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Dependencies injected into {@link runClaudeBridge}. The default main
 * entry point binds these to the real Claude SDK and `process` streams;
 * tests inject fakes to exercise the bridge without spawning anything.
 */
export type ClaudeBridgeDeps = {
  /** SDK `query` function; defaults to the real `@anthropic-ai/claude-agent-sdk` export. */
  query: typeof defaultQuery;
  /** Stream the bridge reads the request from. */
  stdin: NodeJS.ReadableStream;
  /** Stream the bridge writes JSONL events to. */
  stdout: NodeJS.WritableStream;
  /** Stream the bridge writes free-form diagnostics to. */
  stderr: NodeJS.WritableStream;
};

/**
 * Reads `stdin` to EOF and parses it as the bridge request.
 *
 * @param stdin - Stream to drain.
 * @returns The parsed request object.
 * @throws {Error} When stdin is empty or does not contain valid JSON.
 */
async function readRequest(
  stdin: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  let raw = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    raw += chunk as string;
  }

  if (raw.trim().length === 0) {
    throw new Error('Bridge stdin was empty; expected a JSON request.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Bridge stdin is not valid JSON: ${reason}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('Bridge request must be a JSON object.');
  }

  if (parsed.version !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `Bridge request has unsupported version: ${formatScalar(parsed.version)} (expected ${BRIDGE_PROTOCOL_VERSION}).`,
    );
  }
  if (parsed.type !== 'run') {
    throw new Error(
      `Bridge request has unsupported type: ${formatScalar(parsed.type)} (expected "run").`,
    );
  }
  if (typeof parsed.prompt !== 'string') {
    throw new Error('Bridge request `prompt` must be a string.');
  }
  if (!isPlainObject(parsed.options)) {
    throw new Error('Bridge request `options` must be a JSON object.');
  }

  return parsed;
}

/**
 * Writes a single event as one JSONL line to the supplied stream,
 * respecting backpressure.
 *
 * When the stream's internal buffer is full (`write()` returns `false`),
 * this function awaits the `drain` event before resolving so callers do
 * not outpace the consumer. Without this, a fast producer combined with
 * a synchronous `process.exit()` could terminate the process before the
 * final frames (especially the `done` event) reach the host-side reader.
 *
 * @param stream - Output stream (usually stdout).
 * @param event - Event payload; must be JSON-serializable.
 */
async function writeEvent(
  stream: NodeJS.WritableStream,
  event: Record<string, unknown>,
): Promise<void> {
  const canContinue = stream.write(`${JSON.stringify(event)}\n`);
  if (!canContinue) {
    await new Promise<void>((resolve) => {
      stream.once('drain', resolve);
    });
  }
}

/**
 * Runs the bridge once, end-to-end. Reads the request, invokes the
 * SDK, streams `message` events, then emits exactly one terminator
 * event (`done` on success, `error` on failure).
 *
 * The function never throws: protocol failures are surfaced via an
 * `error` event and the returned exit code. Callers (the main entry
 * point and tests) use the exit code to drive the process status.
 *
 * @param deps - Injected SDK and streams.
 * @returns Process exit code: `0` on success, `1` on failure.
 */
export async function runClaudeBridge(deps: ClaudeBridgeDeps): Promise<number> {
  let request: Record<string, unknown>;
  try {
    request = await readRequest(deps.stdin);
  } catch (cause) {
    await writeEvent(deps.stdout, makeErrorEvent(cause));
    deps.stderr.write(
      `[claude-bridge] failed to read request: ${describeError(cause)}\n`,
    );
    return 1;
  }

  const prompt = request.prompt as string;
  const options = request.options as Record<string, unknown>;

  try {
    const iterator = deps.query({ prompt, options });
    for await (const message of iterator) {
      await writeEvent(deps.stdout, {
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message,
      });
    }
    await writeEvent(deps.stdout, {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'done',
    });
    return 0;
  } catch (cause) {
    await writeEvent(deps.stdout, makeErrorEvent(cause));
    deps.stderr.write(
      `[claude-bridge] query failed: ${describeError(cause)}\n`,
    );
    return 1;
  }
}

/**
 * Builds an `error` event payload from an arbitrary thrown value.
 *
 * @param cause - Value thrown by the SDK or request reader.
 * @returns A JSONL-ready event object.
 */
function makeErrorEvent(cause: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = {};
  if (cause instanceof Error) {
    error.name = cause.name || 'Error';
    error.message = cause.message;
    if (typeof cause.stack === 'string') {
      error.stack = cause.stack;
    }
  } else {
    error.name = 'Error';
    error.message = String(cause);
  }
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    type: 'error',
    error,
  };
}

/**
 * Renders an arbitrary thrown value as a short stderr message.
 *
 * @param cause - Value thrown.
 * @returns Human-readable description.
 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

/**
 * Type guard recognising plain (object-literal) records.
 *
 * @param value - Value to test.
 * @returns Whether `value` is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Formats an arbitrary scalar for inclusion in error messages.
 *
 * @param value - Value to format.
 * @returns The formatted scalar.
 */
function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  // Remaining primitives (number, boolean) stringify safely.
  return JSON.stringify(value);
}

/**
 * Detects whether this module is being executed directly as the
 * Node.js entry point.
 *
 * @returns `true` when invoked as `node claude-bridge.mjs`.
 */
function isMain(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const entry = path.resolve(process.argv[1]);
    const here = fileURLToPath(import.meta.url);
    return entry === here;
  } catch {
    return false;
  }
}

if (isMain()) {
  runClaudeBridge({
    query: defaultQuery,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((code) => {
      // Set exitCode instead of calling process.exit() so the event
      // loop can drain pending stdout/stderr writes. The unref'd
      // timeout acts as a safety net: if the SDK or another module
      // holds open handles that would keep the process alive
      // indefinitely, we still terminate after a short grace period.
      process.exitCode = code;
      setTimeout(() => {
        process.exit(code);
      }, 1000).unref();
      return undefined;
    })
    .catch((cause: unknown) => {
      // Defensive: runClaudeBridge swallows its own errors, but if
      // something escapes (e.g. an unhandled write) we still want a
      // non-zero exit with a stderr breadcrumb.
      process.stderr.write(`[claude-bridge] fatal: ${describeError(cause)}\n`);
      process.exitCode = 1;
      setTimeout(() => {
        process.exit(1);
      }, 1000).unref();
    });
}
