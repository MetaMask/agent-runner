import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../pi-runtime.js', () => ({ runPiSession: mocks.run }));

describe('pi standalone entry point', () => {
  const oldCode = process.exitCode;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = oldCode;
  });

  it.each([false, true])(
    'settles the process exit code when stdout fails: %s',
    async (writeFails) => {
      vi.resetModules();
      const { Readable, Writable } = await import('node:stream');
      const stdout = new Writable({
        write(_chunk, _encoding, callback) {
          callback(writeFails ? new Error('broken pipe') : undefined);
        },
      });
      stdout.on('error', () => undefined);
      const fakeProcess = {
        ...process,
        argv: [
          'node',
          fileURLToPath(new URL('./pi-bridge.ts', import.meta.url)),
        ],
        stdin: Readable.from([
          JSON.stringify({
            version: 1,
            type: 'run',
            prompt: 'hi',
            options: {},
          }),
        ]),
        stdout,
        exitCode: undefined as number | undefined,
      };
      vi.stubGlobal('process', fakeProcess);
      mocks.run.mockImplementation(async function* () {
        yield { type: 'result', success: true };
      });
      await import('./pi-bridge.js');
      await vi.waitFor(() =>
        expect(fakeProcess.exitCode).toBe(writeFails ? 1 : 0),
      );
    },
  );
});
