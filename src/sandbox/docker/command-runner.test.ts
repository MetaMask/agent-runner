import { describe, expect, it, vi } from 'vitest';

import { DockerSandboxError } from '../../errors.js';
import {
  createDefaultDockerCommandRunner,
  createStderrAccumulator,
} from './command-runner.js';
import type { DockerCommandRunner } from './command-runner.js';

const runner: DockerCommandRunner = createDefaultDockerCommandRunner();

describe('createDefaultDockerCommandRunner', () => {
  it('captures stdout, stderr, and exit code on success', async () => {
    const result = await runner.run('node', [
      '-e',
      'process.stdout.write("out");process.stderr.write("err");process.exit(0);',
    ]);

    expect(result).toStrictEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 0,
    });
  });

  it('forwards stdin to the child process', async () => {
    const result = await runner.run(
      'node',
      [
        '-e',
        'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(d.toUpperCase())});',
      ],
      { stdin: 'hello' },
    );

    expect(result.stdout).toBe('HELLO');
    expect(result.exitCode).toBe(0);
  });

  it('invokes the stdout line callback for each newline-terminated chunk', async () => {
    const lines: string[] = [];

    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write("a\\nbb\\nccc");'],
      {
        onStdoutLine: (line) => lines.push(line),
      },
    );

    expect(lines).toStrictEqual(['a', 'bb', 'ccc']);
    expect(result.stdout).toBe('');
  });

  it('throws a DockerSandboxError for non-zero exit codes including stderr excerpt', async () => {
    const error = await runner
      .run('node', ['-e', 'process.stderr.write("boom");process.exit(3);'])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toContain('exited with code 3');
    expect((error as Error).message).toContain('stderr: boom');
    expect((error as Error).message).toContain('node');
    expect((error as Error).message).toContain('-e');
  });

  it('redacts --env-file paths in error messages', async () => {
    const error = await runner
      .run('node', [
        '-e',
        'process.exit(1)',
        '--',
        '--env-file',
        '/secret/env.conf',
      ])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    const { message } = error as Error;
    expect(message).toContain('--env-file');
    expect(message).toContain('***');
    expect(message).not.toContain('/secret/env.conf');
  });

  it('redacts -e flag values containing equals signs in error messages', async () => {
    const error = await runner
      .run('node', [
        '-e',
        'process.exit(1)',
        '--',
        '-e',
        'SECRET_KEY=my_secret_value',
      ])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    const { message } = error as Error;
    expect(message).toContain('SECRET_KEY=***');
    expect(message).not.toContain('my_secret_value');
  });

  it('returns the result for non-zero exits when allowNonZeroExit is set', async () => {
    const result = await runner.run('node', ['-e', 'process.exit(2);'], {
      allowNonZeroExit: true,
    });

    expect(result.exitCode).toBe(2);
  });

  it('throws a DockerSandboxError when the binary cannot be launched', async () => {
    const error = await runner
      .run('this-binary-definitely-does-not-exist-xyz', ['--help'])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toContain('Failed to spawn host command');
  });

  it('honours injected env when running the child', async () => {
    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write(process.env.FOO ?? "missing")'],
      {
        env: {
          // Preserve PATH so the `node` binary can be located.
          PATH: process.env.PATH,
          FOO: 'bar',
          UNSET: undefined,
        },
      },
    );

    expect(result.stdout).toBe('bar');
  });

  it('truncates very long stderr in the error excerpt', async () => {
    const error = await runner
      .run('node', [
        '-e',
        'process.stderr.write("x".repeat(5000));process.exit(1);',
      ])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toContain('stderr (truncated):');
    expect((error as Error).message).toContain('…');
  });

  it('throws a DockerSandboxError when the child is terminated by a signal', async () => {
    const error = await runner
      .run('node', ['-e', 'process.kill(process.pid, "SIGKILL");'])
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toMatch(/terminated by signal SIG/u);
  });

  it('forwards cwd to the spawned process', async () => {
    const { realpathSync } = await import('node:fs');
    const tmp = realpathSync('/tmp');
    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write(process.cwd())'],
      { cwd: tmp },
    );

    expect(result.stdout).toBe(tmp);
  });

  it('wraps synchronous spawn errors in a DockerSandboxError', async () => {
    // Passing a non-string command makes child_process.spawn throw
    // synchronously rather than reporting via the `error` event. Cast
    // through `unknown` so the call type-checks while still exercising
    // the synchronous catch branch.
    const error = await runner.run(null as unknown as string, []).then(
      () => {
        throw new Error('expected runner.run to reject');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DockerSandboxError);
  });

  it('aborts the child when the supplied AbortSignal fires', async () => {
    const controller = new AbortController();
    const promise = runner.run('node', ['-e', 'setTimeout(() => {}, 60000);'], {
      signal: controller.signal,
    });

    // Give the child a tick to actually start before aborting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    const error = await promise.then(
      () => {
        throw new Error('expected runner.run to reject after abort');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DockerSandboxError);
    // Either the `error` event (AbortError) or the `close` signal
    // branch can win the race; both produce a sandbox error pointing
    // back at the failed spawn or signal termination.
    expect((error as Error).message).toMatch(
      /Failed to spawn host command|terminated by signal/u,
    );
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await runner
      .run('node', ['-e', 'setTimeout(() => {}, 60000);'], {
        signal: controller.signal,
      })
      .then(
        () => {
          throw new Error('expected runner.run to reject after pre-abort');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
  });

  it('invokes the line callback for trailing data without a newline', async () => {
    const lines: string[] = [];
    const onLine = vi.fn((line: string) => {
      lines.push(line);
    });

    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write("no-newline")'],
      {
        onStdoutLine: onLine,
      },
    );

    expect(lines).toStrictEqual(['no-newline']);
    expect(result.stdout).toBe('');
  });

  it('accumulates stdout normally when onStdoutLine is not supplied', async () => {
    const result = await runner.run('node', [
      '-e',
      'process.stdout.write("captured-output");',
    ]);

    expect(result.stdout).toBe('captured-output');
  });

  it('kills the child when stdout exceeds maxLineLength without a newline', async () => {
    const error = await runner
      .run(
        'node',
        ['-e', 'process.stdout.write("x".repeat(200));setTimeout(()=>{},5000)'],
        {
          onStdoutLine: () => undefined,
          maxLineLength: 100,
        },
      )
      .then(
        () => {
          throw new Error('expected runner.run to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toContain('character limit');
    expect((error as Error).message).toContain('memory growth');
  });

  it('does not kill the child when lines are under maxLineLength', async () => {
    const lines: string[] = [];
    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write("short\\nlines\\n")'],
      {
        onStdoutLine: (line) => lines.push(line),
        maxLineLength: 1000,
      },
    );

    expect(lines).toStrictEqual(['short', 'lines']);
    expect(result.exitCode).toBe(0);
  });

  it('does not enforce any limit when maxLineLength is omitted', async () => {
    const lines: string[] = [];
    const result = await runner.run(
      'node',
      ['-e', 'process.stdout.write("x".repeat(500) + "\\n")'],
      {
        onStdoutLine: (line) => lines.push(line),
      },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(500);
    expect(result.exitCode).toBe(0);
  });
});

describe('createStderrAccumulator', () => {
  const HEADER = '[stderr truncated — showing last ~64KB]\n';

  it('returns the full stderr when total bytes are under the cap', () => {
    const acc = createStderrAccumulator(20);
    acc.append('hello');
    acc.append(' world');
    expect(acc.getResult()).toBe('hello world');
  });

  it('returns the full stderr when total bytes exactly equal the cap', () => {
    const acc = createStderrAccumulator(10);
    acc.append('abcde');
    acc.append('fghij');
    expect(acc.getResult()).toBe('abcdefghij');
  });

  it('truncates when a single chunk exceeds the cap', () => {
    const acc = createStderrAccumulator(10);
    // 20 bytes in one shot — exercises the "single oversized chunk" branch.
    acc.append('abcdefghijklmnopqrst');
    const result = acc.getResult();
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result.slice(HEADER.length)).toBe('klmnopqrst');
  });

  it('partially trims the leading chunk when it is larger than the excess', () => {
    const acc = createStderrAccumulator(10);
    acc.append('abcdefgh'); // 8 bytes
    acc.append('ijklm'); // +5 = 13 total, excess = 3
    // 'abcdefgh' (8) > excess (3) → partial trim → keep 'defgh'
    const result = acc.getResult();
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result.slice(HEADER.length)).toBe('defghijklm');
  });

  it('fully discards leading chunks that fit within the excess', () => {
    const acc = createStderrAccumulator(10);
    acc.append('ab'); // 2
    acc.append('cd'); // 4
    acc.append('efghijklm'); // +9 = 13, excess = 3
    // 'ab' (2) <= excess (3) → discard, excess → 1
    // 'cd' (2) > excess (1) → partial trim → keep 'd'
    const result = acc.getResult();
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result.slice(HEADER.length)).toBe('defghijklm');
  });

  it('discards multiple leading chunks in a single append', () => {
    const acc = createStderrAccumulator(10);
    acc.append('aa'); // 2
    acc.append('bb'); // 4
    acc.append('cc'); // 6
    acc.append('dddddddddd'); // +10 = 16, excess = 6
    // 'aa' (2) <= 6 → discard, excess → 4
    // 'bb' (2) <= 4 → discard, excess → 2
    // 'cc' (2) <= 2 → discard, excess → 0  (exactly at cap)
    const result = acc.getResult();
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result.slice(HEADER.length)).toBe('dddddddddd');
  });

  it('handles repeated appends that each trigger eviction', () => {
    const acc = createStderrAccumulator(6);
    acc.append('aaa'); // 3
    acc.append('bbb'); // 6 — at cap, no eviction
    expect(acc.getResult()).toBe('aaabbb');

    acc.append('cc'); // 8, excess = 2 → trim 'aaa' partially → 'a'
    const result = acc.getResult();
    expect(result.startsWith(HEADER)).toBe(true);
    expect(result.slice(HEADER.length)).toBe('abbbcc');
  });
});
