import { DockerSandboxProtocolError } from '../../errors.js';
import { isPlainObject } from './utils.js';

/**
 * Version of the host/sandbox bridge protocol. Bumped when the wire
 * format changes in a way that requires both sides to be upgraded
 * together.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Request frame written by the host to the container bridge's stdin.
 *
 * Exactly one request is sent per bridge invocation; the bridge reads
 * stdin to EOF, parses a single JSON object matching this shape, and
 * then streams events to its stdout.
 */
export type BridgeRequest = {
  /** Protocol version; currently {@link BRIDGE_PROTOCOL_VERSION}. */
  version: typeof BRIDGE_PROTOCOL_VERSION;
  /** Discriminant; only `'run'` is supported in v1. */
  type: 'run';
  /** Validated prompt forwarded verbatim to the Claude SDK. */
  prompt: string;
  /** Sanitized SDK options forwarded verbatim to the Claude SDK. */
  options: Record<string, unknown>;
};

/**
 * Bridge event emitted once per raw Claude SDK message. The `message`
 * field is the unmodified JSON-serializable SDK value.
 */
export type BridgeMessageEvent = {
  /** Protocol version. */
  version: typeof BRIDGE_PROTOCOL_VERSION;
  /** Discriminant identifying a streamed SDK message. */
  type: 'message';
  /** Raw SDK message; opaque on the wire and shape-checked downstream. */
  message: unknown;
};

/**
 * Bridge event emitted when the in-container SDK invocation throws.
 *
 * The bridge always emits this event before exiting non-zero so the
 * host can surface a structured error instead of having to scrape the
 * process exit code.
 */
export type BridgeErrorEvent = {
  /** Protocol version. */
  version: typeof BRIDGE_PROTOCOL_VERSION;
  /** Discriminant identifying a structured bridge error. */
  type: 'error';
  /** Structured error information extracted from the underlying throw. */
  error: {
    /** Error class name (e.g. `TypeError`); always present. */
    name: string;
    /** Human-readable error message; always present. */
    message: string;
    /** Stack trace, when the underlying error carried one. */
    stack?: string;
  };
};

/**
 * Bridge event emitted exactly once after the SDK iterator completes.
 *
 * The host treats the absence of a `done` event before process exit as
 * a protocol error.
 */
export type BridgeDoneEvent = {
  /** Protocol version. */
  version: typeof BRIDGE_PROTOCOL_VERSION;
  /** Discriminant identifying a successful run termination. */
  type: 'done';
};

/**
 * Union of all events that can appear on the bridge's stdout.
 */
export type BridgeEvent =
  | BridgeMessageEvent
  | BridgeErrorEvent
  | BridgeDoneEvent;

/**
 * Serializes a {@link BridgeRequest} into the single JSON document the
 * container bridge consumes from stdin.
 *
 * No trailing newline is appended; the bridge reads stdin to EOF.
 *
 * @param request - The validated bridge request.
 * @returns The JSON-encoded request string.
 */
export function serializeBridgeRequest(request: BridgeRequest): string {
  return JSON.stringify(request);
}

/**
 * Serializes a single {@link BridgeEvent} into a JSON string suitable
 * for a single JSONL line. Callers are expected to append `\n` when
 * writing to a JSONL stream.
 *
 * @param event - The event to serialize.
 * @returns The JSON-encoded event string.
 */
export function serializeBridgeEvent(event: BridgeEvent): string {
  return JSON.stringify(event);
}

/**
 * Validates that an arbitrary value is a well-formed
 * {@link BridgeRequest}.
 *
 * @param value - Parsed JSON value to validate.
 * @returns The validated request, typed accordingly.
 * @throws {DockerSandboxProtocolError} When any field is missing or has
 * the wrong type, or when the version/type are unsupported.
 */
export function validateBridgeRequest(value: unknown): BridgeRequest {
  if (!isPlainObject(value)) {
    throw new DockerSandboxProtocolError(
      'Docker bridge request must be a JSON object.',
    );
  }

  if (value.version !== BRIDGE_PROTOCOL_VERSION) {
    throw new DockerSandboxProtocolError(
      `Docker bridge request has unsupported version: ${formatScalar(value.version)} (expected ${BRIDGE_PROTOCOL_VERSION}).`,
    );
  }

  if (value.type !== 'run') {
    throw new DockerSandboxProtocolError(
      `Docker bridge request has unsupported type: ${formatScalar(value.type)} (expected "run").`,
    );
  }

  if (typeof value.prompt !== 'string') {
    throw new DockerSandboxProtocolError(
      'Docker bridge request `prompt` must be a string.',
    );
  }

  if (!isPlainObject(value.options)) {
    throw new DockerSandboxProtocolError(
      'Docker bridge request `options` must be a JSON object.',
    );
  }

  return {
    version: BRIDGE_PROTOCOL_VERSION,
    type: 'run',
    prompt: value.prompt,
    options: value.options,
  };
}

/**
 * Parses and validates a single JSONL line received from the bridge's
 * stdout.
 *
 * Blank lines (after trimming) are rejected because the protocol
 * specifies one event per non-empty line; callers should filter
 * whitespace upstream when needed.
 *
 * @param line - A single line from the bridge stdout stream.
 * @returns The validated bridge event.
 * @throws {DockerSandboxProtocolError} When the line is not valid JSON,
 * the version/type are unsupported, or fields required by the
 * discriminant are missing or malformed.
 */
export function parseBridgeEvent(line: string): BridgeEvent {
  if (line.trim().length === 0) {
    throw new DockerSandboxProtocolError(
      'Docker bridge emitted an empty line; expected one JSON event per line.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DockerSandboxProtocolError(
      `Docker bridge emitted invalid JSON: ${reason}`,
      cause instanceof Error ? { cause } : undefined,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new DockerSandboxProtocolError(
      'Docker bridge event must be a JSON object.',
    );
  }

  if (parsed.version !== BRIDGE_PROTOCOL_VERSION) {
    throw new DockerSandboxProtocolError(
      `Docker bridge event has unsupported version: ${formatScalar(parsed.version)} (expected ${BRIDGE_PROTOCOL_VERSION}).`,
    );
  }

  if (parsed.type === 'message') {
    if (!('message' in parsed)) {
      throw new DockerSandboxProtocolError(
        'Docker bridge `message` event is missing the `message` field.',
      );
    }
    return {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'message',
      message: parsed.message,
    };
  }

  if (parsed.type === 'error') {
    if (!isPlainObject(parsed.error)) {
      throw new DockerSandboxProtocolError(
        'Docker bridge `error` event must include an `error` object.',
      );
    }
    const errorPayload = parsed.error;
    if (typeof errorPayload.message !== 'string') {
      throw new DockerSandboxProtocolError(
        'Docker bridge `error` event `error.message` must be a string.',
      );
    }
    const name =
      typeof errorPayload.name === 'string' && errorPayload.name.length > 0
        ? errorPayload.name
        : 'Error';
    const event: BridgeErrorEvent = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: {
        name,
        message: errorPayload.message,
      },
    };
    if (typeof errorPayload.stack === 'string') {
      event.error.stack = errorPayload.stack;
    }
    return event;
  }

  if (parsed.type === 'done') {
    return {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'done',
    };
  }

  throw new DockerSandboxProtocolError(
    `Docker bridge event has unsupported type: ${formatScalar(parsed.type)}.`,
  );
}

/**
 * Formats an arbitrary scalar for inclusion in protocol error
 * messages. Strings are quoted; other values fall back to `String()`.
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
