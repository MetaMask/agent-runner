/* eslint-disable @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/only-throw-error -- Verify normalization of non-Error SDK failures. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles infer their contracts from the runtime. */
import type {
  AgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { assertPiNodeVersion, runPiSession } from './pi-runtime.js';
import type { PiSessionFactory } from './pi-runtime.js';
import type { AgentMessage } from './types.js';

function fakeSession(
  run: (emit: (event: AgentSessionEvent) => void) => Promise<void> | void,
) {
  let listener: (event: AgentSessionEvent) => void = () => undefined;
  const abort = vi.fn();
  const unsubscribe = vi.fn();
  const dispose = vi.fn();
  const session = {
    sessionId: 'test',
    agent: { abort },
    getActiveToolNames: () => [],
    subscribe: (callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    },
    prompt: async () => {
      await run((event) => listener(event));
    },
    dispose,
  } as unknown as AgentSession;
  const factory: PiSessionFactory = async () => session;
  return { factory, abort, unsubscribe, dispose };
}
async function collect(
  stream: AsyncIterable<AgentMessage>,
): Promise<AgentMessage[]> {
  const messages = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}
function assistant(
  stopReason = 'stop',
  text = 'hello',
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text }],
      usage,
      stopReason,
    },
  } as AgentSessionEvent;
}

describe('pi lifecycle', () => {
  it('requires a supported Node version only for pi execution', () => {
    expect(() => assertPiNodeVersion('20.20.0')).toThrow('Node.js >=22.19.0');
    expect(() => assertPiNodeVersion('22.19.0')).not.toThrow();
    expect(() => assertPiNodeVersion('24.0.0')).not.toThrow();
  });
  it('rejects non-string prompts before session creation', async () => {
    const fake = fakeSession(() => undefined);
    await expect(
      collect(
        runPiSession(
          {} as string,
          { model: 'x' },
          undefined,
          undefined,
          fake.factory,
        ),
      ),
    ).rejects.toThrow('string prompt');
  });
  it('preserves the primary failure when dispose also fails', async () => {
    const failed = fakeSession(() => {
      throw new Error('primary');
    });
    failed.dispose.mockImplementation(() => {
      throw new Error('dispose');
    });
    await expect(
      collect(
        runPiSession(
          'hi',
          { model: 'x' },
          undefined,
          undefined,
          failed.factory,
        ),
      ),
    ).rejects.toThrow('primary');
    const completed = fakeSession((emit) => emit(assistant()));
    completed.dispose.mockImplementation(() => {
      throw new Error('dispose');
    });
    await expect(
      collect(
        runPiSession(
          'hi',
          { model: 'x' },
          undefined,
          undefined,
          completed.factory,
        ),
      ),
    ).rejects.toThrow('dispose');
  });
  it('does not emit success when prompt rejects after an assistant message', async () => {
    const fake = fakeSession((emit) => {
      emit(assistant());
      throw new Error('prompt failure');
    });
    const messages: AgentMessage[] = [];
    await expect(
      (async () => {
        for await (const message of runPiSession(
          'hi',
          { model: 'x' },
          undefined,
          undefined,
          fake.factory,
        )) {
          messages.push(message);
        }
      })(),
    ).rejects.toThrow('prompt failure');
    expect(messages.some((message) => message.type === 'result')).toBe(false);
    expect(fake.abort).toHaveBeenCalledOnce();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
  it('normalizes non-Error failures and empty runs', async () => {
    const failed = fakeSession(async () => Promise.reject('plain failure'));
    await expect(
      collect(
        runPiSession(
          'hi',
          { model: 'x' },
          undefined,
          undefined,
          failed.factory,
        ),
      ),
    ).rejects.toThrow('plain failure');
    const empty = fakeSession(() => undefined);
    expect(
      (
        await collect(
          runPiSession(
            'hi',
            { model: 'x' },
            undefined,
            undefined,
            empty.factory,
          ),
        )
      ).at(-1),
    ).toMatchObject({
      success: false,
      turns: 0,
      error: 'Pi produced no assistant response.',
    });
  });
  it('tracks real tool elapsed time and ignores unmatched progress', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fake = fakeSession((emit) => {
      emit({
        type: 'tool_execution_update',
        toolCallId: 'missing',
        toolName: 'bash',
        args: {},
        partialResult: {},
      });
      emit({
        type: 'tool_execution_start',
        toolCallId: 'id',
        toolName: 'bash',
        args: {},
      });
      now = 2500;
      emit({
        type: 'tool_execution_update',
        toolCallId: 'id',
        toolName: 'bash',
        args: {},
        partialResult: {},
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'id',
        toolName: 'bash',
        result: {
          content: [{ type: 'image' }, { type: 'text', text: 'done' }],
        },
        isError: false,
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'other',
        toolName: 'bash',
        result: null,
        isError: true,
      });
      emit(assistant());
    });
    try {
      const messages = await collect(
        runPiSession('hi', { model: 'x' }, undefined, undefined, fake.factory),
      );
      expect(
        messages.filter((message) => message.type === 'tool_progress'),
      ).toStrictEqual([expect.objectContaining({ elapsedSeconds: 2.5 })]);
      expect(
        messages.filter((message) => message.type === 'tool_result'),
      ).toMatchObject([{ content: 'done' }, { content: '', isError: true }]);
    } finally {
      clock.mockRestore();
    }
  });
  it('bounds queued messages and aborts an overflowing producer', async () => {
    const fake = fakeSession((emit) => {
      for (let index = 0; index < 10002; index += 1) {
        emit(assistant());
      }
    });
    await expect(
      collect(
        runPiSession('hi', { model: 'x' }, undefined, undefined, fake.factory),
      ),
    ).rejects.toThrow('queue exceeded');
    expect(fake.abort).toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
  it('normalizes non-Error setup and disposal failures', async () => {
    const factory: PiSessionFactory = async () =>
      Promise.reject('setup failed');
    await expect(
      collect(
        runPiSession('hi', { model: 'x' }, undefined, undefined, factory),
      ),
    ).rejects.toThrow('setup failed');
    const fake = fakeSession((emit) => emit(assistant()));
    fake.dispose.mockImplementation(() => {
      throw 'dispose failed';
    });
    await expect(
      collect(
        runPiSession('hi', { model: 'x' }, undefined, undefined, fake.factory),
      ),
    ).rejects.toThrow('dispose failed');
  });
  it('cleans up cancellation during session creation', async () => {
    const controller = new AbortController();
    const fake = fakeSession(() => undefined);
    const factory: PiSessionFactory = async (...args) => {
      controller.abort();
      return fake.factory(...args);
    };
    await expect(
      collect(
        runPiSession(
          'hi',
          { model: 'x' },
          undefined,
          controller.signal,
          factory,
        ),
      ),
    ).rejects.toThrow(/abort/iu);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
  it.each(['length', 'pending', 'error', 'aborted'])(
    'reports unsuccessful %s stop reasons',
    async (reason) => {
      const fake = fakeSession((emit) => emit(assistant(reason)));
      expect(
        (
          await collect(
            runPiSession(
              'hi',
              { model: 'x' },
              undefined,
              undefined,
              fake.factory,
            ),
          )
        ).at(-1),
      ).toMatchObject({ success: false });
    },
  );
  it('omits malformed and overflowing cost totals', async () => {
    const fake = fakeSession((emit) =>
      emit(
        assistant('stop', '', {
          input: Infinity,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ),
    );
    expect(
      (
        await collect(
          runPiSession(
            'hi',
            { model: 'x', cost: { input: 1, output: 1 } },
            undefined,
            undefined,
            fake.factory,
          ),
        )
      ).at(-1),
    ).not.toHaveProperty('costUsd');
  });
});
