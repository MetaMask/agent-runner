import { describe, expect, it } from 'vitest';

import { DockerSandboxProtocolError } from '../../errors.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeEvent,
  serializeBridgeEvent,
  serializeBridgeRequest,
  validateBridgeRequest,
} from './bridge-protocol.js';
import type { BridgeEvent, BridgeRequest } from './bridge-protocol.js';

describe('serializeBridgeRequest', () => {
  it('produces a JSON document with version, type, prompt, and options', () => {
    const request: BridgeRequest = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'run',
      prompt: 'hello',
      options: { model: 'claude-3', cwd: '/workspace' },
    };

    expect(JSON.parse(serializeBridgeRequest(request))).toStrictEqual(request);
  });
});

describe('serializeBridgeEvent', () => {
  it('round-trips through parseBridgeEvent for message events', () => {
    const event: BridgeEvent = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'message',
      message: { type: 'system', subtype: 'init' },
    };

    expect(parseBridgeEvent(serializeBridgeEvent(event))).toStrictEqual(event);
  });

  it('round-trips through parseBridgeEvent for error events', () => {
    const event: BridgeEvent = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: { name: 'BoomError', message: 'kaboom', stack: 'trace' },
    };

    expect(parseBridgeEvent(serializeBridgeEvent(event))).toStrictEqual(event);
  });

  it('round-trips through parseBridgeEvent for done events', () => {
    const event: BridgeEvent = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'done',
    };

    expect(parseBridgeEvent(serializeBridgeEvent(event))).toStrictEqual(event);
  });
});

describe('validateBridgeRequest', () => {
  it('accepts a well-formed request', () => {
    const value = {
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'run',
      prompt: 'hi',
      options: { cwd: '/workspace' },
    };

    expect(validateBridgeRequest(value)).toStrictEqual(value);
  });

  it('rejects non-object inputs', () => {
    expect(() => validateBridgeRequest(null)).toThrow(
      DockerSandboxProtocolError,
    );
    expect(() => validateBridgeRequest('hello')).toThrow(
      /must be a JSON object/u,
    );
    expect(() => validateBridgeRequest(42)).toThrow(/must be a JSON object/u);
  });

  it('rejects unsupported versions', () => {
    expect(() =>
      validateBridgeRequest({
        version: 2,
        type: 'run',
        prompt: 'hi',
        options: {},
      }),
    ).toThrow(/unsupported version: 2 \(expected 1\)/u);
  });

  it('formats object-typed version in error messages', () => {
    expect(() =>
      validateBridgeRequest({
        version: { v: 2 },
        type: 'run',
        prompt: 'hi',
        options: {},
      }),
    ).toThrow(/unsupported version: \{"v":2\}/u);
  });

  it('rejects unsupported types', () => {
    expect(() =>
      validateBridgeRequest({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'cancel',
        prompt: 'hi',
        options: {},
      }),
    ).toThrow(/unsupported type: "cancel"/u);
  });

  it('rejects non-string prompts', () => {
    expect(() =>
      validateBridgeRequest({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'run',
        prompt: 42,
        options: {},
      }),
    ).toThrow(/`prompt` must be a string/u);
  });

  it('rejects non-object options', () => {
    expect(() =>
      validateBridgeRequest({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'run',
        prompt: 'ok',
        options: null,
      }),
    ).toThrow(/`options` must be a JSON object/u);
  });
});

describe('parseBridgeEvent', () => {
  it('rejects blank lines', () => {
    expect(() => parseBridgeEvent('')).toThrow(DockerSandboxProtocolError);
    expect(() => parseBridgeEvent('   ')).toThrow(/expected one JSON event/u);
  });

  it('throws DockerSandboxProtocolError on invalid JSON', () => {
    const error = catchError(() => parseBridgeEvent('not-json{'));
    expect(error).toBeInstanceOf(DockerSandboxProtocolError);
    expect((error as Error).message).toMatch(/emitted invalid JSON/u);
  });

  it('preserves the underlying JSON parse error as `cause`', () => {
    const error = catchError(() => parseBridgeEvent('{"version":1'));
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('rejects non-object frames', () => {
    expect(() => parseBridgeEvent('42')).toThrow(/must be a JSON object/u);
    expect(() => parseBridgeEvent('null')).toThrow(/must be a JSON object/u);
    expect(() => parseBridgeEvent('"hello"')).toThrow(/must be a JSON object/u);
  });

  it('rejects unsupported protocol versions', () => {
    expect(() =>
      parseBridgeEvent(JSON.stringify({ version: 99, type: 'done' })),
    ).toThrow(/unsupported version: 99/u);
  });

  it('formats null version in error messages', () => {
    expect(() =>
      parseBridgeEvent(JSON.stringify({ version: null, type: 'done' })),
    ).toThrow(/unsupported version: null/u);
  });

  it('rejects unknown event types', () => {
    expect(() =>
      parseBridgeEvent(
        JSON.stringify({ version: BRIDGE_PROTOCOL_VERSION, type: 'ping' }),
      ),
    ).toThrow(/unsupported type: "ping"/u);
  });

  it('formats object-typed type values in error messages', () => {
    expect(() =>
      parseBridgeEvent(
        JSON.stringify({
          version: BRIDGE_PROTOCOL_VERSION,
          type: { nested: true },
        }),
      ),
    ).toThrow(/unsupported type: \{"nested":true\}/u);
  });

  it('rejects message events missing the `message` field', () => {
    expect(() =>
      parseBridgeEvent(
        JSON.stringify({ version: BRIDGE_PROTOCOL_VERSION, type: 'message' }),
      ),
    ).toThrow(/missing the `message` field/u);
  });

  it('parses message events with arbitrary payloads', () => {
    const event = parseBridgeEvent(
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'assistant', message: { id: 'abc' } },
      }),
    );

    expect(event).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'message',
      message: { type: 'assistant', message: { id: 'abc' } },
    });
  });

  it('parses message events whose payload is null', () => {
    const event = parseBridgeEvent(
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: null,
      }),
    );

    expect(event).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'message',
      message: null,
    });
  });

  it('rejects error events with a non-object `error` field', () => {
    expect(() =>
      parseBridgeEvent(
        JSON.stringify({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'error',
          error: 'boom',
        }),
      ),
    ).toThrow(/must include an `error` object/u);
  });

  it('rejects error events with a non-string error.message', () => {
    expect(() =>
      parseBridgeEvent(
        JSON.stringify({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'error',
          error: { message: 42 },
        }),
      ),
    ).toThrow(/`error.message` must be a string/u);
  });

  it('defaults missing error.name to "Error"', () => {
    const event = parseBridgeEvent(
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: { message: 'something broke' },
      }),
    );

    expect(event).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: { name: 'Error', message: 'something broke' },
    });
  });

  it('preserves error.stack when supplied as a string', () => {
    const event = parseBridgeEvent(
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: { name: 'Boom', message: 'kaboom', stack: 'trace' },
      }),
    );

    expect(event).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: { name: 'Boom', message: 'kaboom', stack: 'trace' },
    });
  });

  it('drops error.stack when not a string', () => {
    const event = parseBridgeEvent(
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: { name: 'Boom', message: 'kaboom', stack: 42 },
      }),
    );

    expect(event).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      error: { name: 'Boom', message: 'kaboom' },
    });
  });

  it('parses done events with no payload fields', () => {
    expect(
      parseBridgeEvent(
        JSON.stringify({ version: BRIDGE_PROTOCOL_VERSION, type: 'done' }),
      ),
    ).toStrictEqual({ version: BRIDGE_PROTOCOL_VERSION, type: 'done' });
  });

  it('formats undefined type/version helpfully', () => {
    expect(() =>
      parseBridgeEvent(JSON.stringify({ version: 1, type: undefined })),
    ).toThrow(/unsupported type: undefined/u);
  });
});

/**
 * Captures the synchronous error thrown by `fn`, or returns a marker
 * indicating no throw occurred.
 *
 * @param fn - Function expected to throw.
 * @returns The thrown error or a sentinel marker.
 */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return new Error('expected fn to throw');
}
