import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../../types.js';
import { runPiBridge } from './pi-bridge.js';

async function invoke(
  request: unknown,
  run?: Parameters<typeof runPiBridge>[2],
) {
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  const code = await runPiBridge(
    Readable.from([
      typeof request === 'string' ? request : JSON.stringify(request),
    ]),
    stdout,
    run,
  );
  return {
    code,
    frames: output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}

describe('pi container bridge', () => {
  it('bounds input and output frame sizes', async () => {
    const oversized = await invoke('x'.repeat(10 * 1024 * 1024 + 1));
    expect(oversized.frames[0].error.message).toContain('request exceeds');
    const result = await invoke(
      { version: 1, type: 'run', prompt: 'hi', options: {} },
      async function* (): AsyncGenerator<AgentMessage> {
        yield {
          type: 'result',
          success: true,
          result: 'x'.repeat(10 * 1024 * 1024),
        };
      },
    );
    expect(result.frames[0].error.message).toContain('frame exceeds');
  });
  it('uses the real runtime by default and reports validation errors', async () => {
    const result = await invoke({
      version: 1,
      type: 'run',
      prompt: 'hi',
      options: {},
    });
    expect(result.frames[0].error.message).toContain('options.model');
  });
  it('normalizes non-Error failures', async () => {
    const run: Parameters<typeof runPiBridge>[2] = () =>
      ({
        [Symbol.asyncIterator]: () => ({
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Test non-Error normalization.
          next: async () => Promise.reject('non-error'),
        }),
      }) as AsyncGenerator<AgentMessage>;
    const result = await invoke(
      { version: 1, type: 'run', prompt: 'hi', options: {} },
      run,
    );
    expect(result.frames[0].error.message).toBe('non-error');
  });
  it('streams the shared runtime messages and terminates with done', async () => {
    const run = vi.fn(async function* (): AsyncGenerator<AgentMessage> {
      yield { type: 'init', sessionId: 'session' };
      yield { type: 'result', success: true };
    });
    const structured = { schema: { type: 'object' }, systemPrompt: 'Judge.' };
    const result = await invoke(
      {
        version: 1,
        type: 'run',
        prompt: 'hi',
        options: { model: 'test', structured },
      },
      run,
    );
    expect(result.code).toBe(0);
    expect(result.frames.map((frame) => frame.type)).toStrictEqual([
      'message',
      'message',
      'done',
    ]);
    expect(run).toHaveBeenCalledWith('hi', { model: 'test' }, structured);
  });
  it.each([
    'not json',
    'null',
    {},
    { version: 2 },
    { version: 1, type: 'run', prompt: 'hi', options: [] },
    { version: 1, type: 'run', prompt: 'hi', options: { structured: {} } },
  ])('rejects invalid input %j', async (request) => {
    const run = vi.fn();
    const result = await invoke(request, run);
    expect(result.code).toBe(1);
    expect(result.frames[0].type).toBe('error');
    expect(run).not.toHaveBeenCalled();
  });
  it('scrubs thrown errors before writing protocol frames', async () => {
    vi.stubEnv('LITELLM_API_KEY', 'short');
    try {
      const result = await invoke(
        { version: 1, type: 'run', prompt: 'hi', options: {} },
        // eslint-disable-next-line require-yield -- Failure before the first message.
        async function* () {
          throw new Error('short failure');
        },
      );
      expect(result.code).toBe(1);
      expect(JSON.stringify(result.frames)).not.toContain('short');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('closes the runtime iterator when stdout fails', async () => {
    let closed = false;
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('broken pipe'));
      },
    });
    stdout.on('error', () => undefined);
    const run = async function* (): AsyncGenerator<AgentMessage> {
      try {
        yield { type: 'init', sessionId: 'x' };
      } finally {
        closed = true;
      }
    };
    await expect(
      runPiBridge(
        Readable.from([
          JSON.stringify({
            version: 1,
            type: 'run',
            prompt: 'hi',
            options: {},
          }),
        ]),
        stdout,
        run,
      ),
    ).rejects.toThrow('broken pipe');
    expect(closed).toBe(true);
  });
});
