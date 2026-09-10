import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultDockerCommandRunner } from './command-runner.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

describe('Docker command cancellation event order', () => {
  it.each(['error-first', 'close-first'])(
    'preserves AbortError when %s',
    async (order) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      mocks.spawn.mockReturnValue(child);
      const controller = new AbortController();
      const pending = createDefaultDockerCommandRunner().run(
        'docker',
        ['run'],
        { signal: controller.signal },
      );
      controller.abort();
      const abort = new DOMException('aborted', 'AbortError');
      // eslint-disable-next-line vitest/no-conditional-in-test -- Exercise both process event orders.
      if (order === 'error-first') {
        child.emit('error', abort);
        child.emit('close', null, 'SIGTERM');
      } else {
        child.emit('close', null, 'SIGTERM');
        child.emit('error', abort);
      }
      await expect(pending).rejects.toMatchObject({
        cause: { name: 'AbortError' },
      });
    },
  );
});
