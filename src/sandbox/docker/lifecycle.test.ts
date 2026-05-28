import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerSandboxError } from '../../errors.js';
import {
  getActiveContainersForTesting,
  resetCleanupRegistryForTesting,
} from './cleanup-registry.js';
import type {
  DockerCommandResult,
  DockerCommandRunner,
} from './command-runner.js';
import { createDockerSandbox } from './lifecycle.js';
import type { NormalizedDockerSandboxConfig } from './options.js';

const commandRunnerMocks = vi.hoisted(() => ({
  createDefaultDockerCommandRunner: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn(),
}));

vi.mock('./command-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./command-runner.js')>();
  return {
    ...actual,
    createDefaultDockerCommandRunner:
      commandRunnerMocks.createDefaultDockerCommandRunner,
  };
});

/** Env file contents captured by the mocked writeFileSync. */
let capturedEnvFileContent: string | undefined;
/** Path of the last env file written. */
let capturedEnvFilePath: string | undefined;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: (prefix: string) => `${prefix}mock`,
    writeFileSync: (filePath: string, content: string, _options?: unknown) => {
      capturedEnvFilePath = filePath;
      capturedEnvFileContent = content;
    },
    unlinkSync: () => undefined,
    rmSync: () => undefined,
    statSync: (...args: Parameters<typeof actual.statSync>) =>
      fsMocks.statSync(...args),
  };
});

/**
 * Builds a normalized sandbox config with sensible defaults that
 * individual tests can override.
 *
 * @param overrides - Partial fields applied on top of the defaults.
 * @returns A normalized Docker sandbox config.
 */
function makeConfig(
  overrides: Partial<NormalizedDockerSandboxConfig> = {},
): NormalizedDockerSandboxConfig {
  const base: NormalizedDockerSandboxConfig = {
    image: 'metamask/agent-runner-test:latest',
    workspace: {
      hostPath: '/host/work',
      containerPath: '/workspace',
      readOnly: false,
    },
    mounts: [],
    env: {},
    forwardEnv: [],
    unsafeDockerArgs: [],
    setupCommands: [],
    cleanup: 'always',
    bridge: {
      install: true,
      nodeCommand: 'node',
      npmCommand: 'npm',
    },
  };
  return { ...base, ...overrides };
}

/**
 *
 */
type RunnerCall = {
  /**
   *
   */
  command: string;
  /**
   *
   */
  args: string[];
  /**
   *
   */
  options: Parameters<DockerCommandRunner['run']>[2];
};

/**
 * Builds a stub command runner that records all invocations and
 * returns canned results in order.
 *
 * @param impls - Optional per-call implementation functions; each is
 * invoked with the same arguments the real runner would receive and
 * returns the result/promise.
 * @returns A stub runner and its recorded call list.
 */
function makeStubRunner(
  impls: ((
    command: string,
    args: readonly string[],
    options?: Parameters<DockerCommandRunner['run']>[2],
  ) => Promise<DockerCommandResult> | DockerCommandResult)[] = [],
): {
  runner: DockerCommandRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const queue = [...impls];

  const runner: DockerCommandRunner = {
    /**
     *
     * @param command
     * @param args
     * @param options
     */
    async run(command, args, options) {
      calls.push({ command, args: [...args], options });
      const next = queue.shift();
      if (next) {
        return await next(command, args, options);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createDockerSandbox', () => {
  beforeEach(() => {
    resetCleanupRegistryForTesting();
    capturedEnvFileContent = undefined;
    capturedEnvFilePath = undefined;
    fsMocks.statSync.mockReset();
    fsMocks.statSync.mockImplementation(
      () =>
        ({ isDirectory: () => true }) as ReturnType<
          typeof import('node:fs').statSync
        >,
    );
  });

  afterEach(() => {
    resetCleanupRegistryForTesting();
  });

  describe('start command construction', () => {
    it('builds a minimal docker run with image, workspace mount, default workdir, and long-running sleep', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'container-1',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe('docker');
      expect(calls[0]?.args).toStrictEqual([
        'run',
        '-d',
        '--name',
        'container-1',
        '-v',
        '/host/work:/workspace',
        '--workdir',
        '/workspace',
        'metamask/agent-runner-test:latest',
        'sh',
        '-lc',
        'sleep infinity',
      ]);
      expect(handle.containerName).toBe('container-1');
      expect(handle.workdir).toBe('/workspace');

      await handle.close();
    });

    it('forwards env via --env-file, extra mounts, read-only flag, network, user, shmSize, and unsafe args', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(
        makeConfig({
          env: { FOO: 'bar', BAZ: 'qux' },
          mounts: [
            {
              hostPath: '/host/cache',
              containerPath: '/cache',
              readOnly: true,
            },
            {
              hostPath: '/host/data',
              containerPath: '/data',
              readOnly: false,
            },
          ],
          network: 'none',
          user: '1000:1000',
          shmSize: '512m',
          unsafeDockerArgs: ['--add-host', 'example.com:127.0.0.1'],
        }),
        {
          commandRunner: runner,
          containerName: 'container-2',
        },
      );

      const args = calls[0]?.args ?? [];

      // Env vars are passed via --env-file, never as -e KEY=value.
      expect(args).not.toContain('-e');
      expect(args).toContain('--env-file');
      expect(capturedEnvFileContent).toContain('FOO=bar');
      expect(capturedEnvFileContent).toContain('BAZ=qux');

      expect(args).toContain('/host/cache:/cache:ro');
      expect(args).toContain('/host/data:/data');
      expect(
        args.slice(args.indexOf('--network'), args.indexOf('--network') + 2),
      ).toStrictEqual(['--network', 'none']);
      expect(
        args.slice(args.indexOf('--user'), args.indexOf('--user') + 2),
      ).toStrictEqual(['--user', '1000:1000']);
      expect(
        args.slice(args.indexOf('--shm-size'), args.indexOf('--shm-size') + 2),
      ).toStrictEqual(['--shm-size', '512m']);
      // Unsafe args appear before the image; image is followed by the
      // long-running sh -lc sleep infinity payload.
      const imageIndex = args.indexOf('metamask/agent-runner-test:latest');
      expect(args.slice(imageIndex - 2, imageIndex)).toStrictEqual([
        '--add-host',
        'example.com:127.0.0.1',
      ]);
      expect(args.slice(imageIndex)).toStrictEqual([
        'metamask/agent-runner-test:latest',
        'sh',
        '-lc',
        'sleep infinity',
      ]);
    });

    it('passes a consumer-provided envFile via --env-file before the auto-generated one', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(
        makeConfig({
          envFile: '/host/secrets.env',
          env: { EXTRA: 'val' },
        }),
        { commandRunner: runner, containerName: 'envfile-test' },
      );

      const args = calls[0]?.args ?? [];
      const envFileIndices: number[] = [];
      args.forEach((arg, i) => {
        if (arg === '--env-file') {
          envFileIndices.push(i);
        }
      });

      // Consumer file first, auto-generated second.
      expect(envFileIndices).toHaveLength(2);
      const firstIdx = envFileIndices[0] as number;
      const secondIdx = envFileIndices[1] as number;
      expect(args[firstIdx + 1]).toBe('/host/secrets.env');
      expect(args[secondIdx + 1]).toBe(capturedEnvFilePath);
    });

    it('passes the configured memory limit via --memory', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(makeConfig({ memory: '4g' }), {
        commandRunner: runner,
        containerName: 'memory-test',
      });

      const args = calls[0]?.args ?? [];
      expect(
        args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 2),
      ).toStrictEqual(['--memory', '4g']);
    });

    it('omits --env-file when env is empty and no envFile is configured', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(makeConfig({ env: {} }), {
        commandRunner: runner,
        containerName: 'no-env',
      });

      const args = calls[0]?.args ?? [];
      expect(args).not.toContain('--env-file');
      expect(capturedEnvFileContent).toBeUndefined();
    });

    it('respects an explicit config.workdir over the workspace container path', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(
        makeConfig({ workdir: '/srv/app' }),
        { commandRunner: runner, containerName: 'wd-test' },
      );

      const args = calls[0]?.args ?? [];
      const wdIndex = args.indexOf('--workdir');
      expect(args[wdIndex + 1]).toBe('/srv/app');
      expect(handle.workdir).toBe('/srv/app');
    });

    it('omits the workspace mount and workdir when both are disabled', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(
        makeConfig({ workspace: false }),
        { commandRunner: runner, containerName: 'no-ws' },
      );

      const args = calls[0]?.args ?? [];
      expect(args).not.toContain('-v');
      expect(args).not.toContain('--workdir');
      expect(handle.workdir).toBeUndefined();
    });

    it('resolves `current` user using process.getuid/getgid', async () => {
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(makeConfig({ user: 'current' }), {
        commandRunner: runner,
        containerName: 'user-current',
      });

      const args = calls[0]?.args ?? [];
      const userIndex = args.indexOf('--user');
      expect(args[userIndex + 1]).toBe(`${uid}:${gid}`);
    });

    it('omits --user when user is false', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(makeConfig({ user: false }), {
        commandRunner: runner,
        containerName: 'no-user',
      });

      expect(calls[0]?.args).not.toContain('--user');
    });

    it('generates a metamask-agent-runner-<pid>-<random> container name when not injected', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
      });

      expect(handle.containerName).toMatch(
        new RegExp(`^metamask-agent-runner-${process.pid}-[0-9a-f]{12}$`, 'u'),
      );
      const args = calls[0]?.args ?? [];
      const nameIndex = args.indexOf('--name');
      expect(args[nameIndex + 1]).toBe(handle.containerName);
    });

    it('registers the container in the active registry after a successful start', async () => {
      const { runner } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'registered',
      });

      expect(getActiveContainersForTesting()).toContain('registered');

      await handle.close();

      expect(getActiveContainersForTesting()).not.toContain('registered');
    });

    it('does not register the container when cleanup is `never`', async () => {
      const { runner } = makeStubRunner();

      const handle = await createDockerSandbox(
        makeConfig({ cleanup: 'never' }),
        {
          commandRunner: runner,
          containerName: 'never-registered',
        },
      );

      expect(getActiveContainersForTesting()).not.toContain('never-registered');

      await handle.close();

      expect(getActiveContainersForTesting()).not.toContain('never-registered');
    });

    it('exposes unregisterCleanup to remove the container from the registry', async () => {
      const { runner } = makeStubRunner();

      const handle = await createDockerSandbox(
        makeConfig({ cleanup: 'on-success' }),
        {
          commandRunner: runner,
          containerName: 'unregister-test',
        },
      );

      expect(getActiveContainersForTesting()).toContain('unregister-test');

      handle.unregisterCleanup();

      expect(getActiveContainersForTesting()).not.toContain('unregister-test');
      await handle.close();
    });
  });

  describe('mount path validation', () => {
    it('validates workspace and mount host paths exist before starting', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(
        makeConfig({
          mounts: [
            {
              hostPath: '/host/cache',
              containerPath: '/cache',
              readOnly: true,
            },
          ],
        }),
        { commandRunner: runner, containerName: 'valid-paths' },
      );

      expect(fsMocks.statSync).toHaveBeenCalledWith('/host/work');
      expect(fsMocks.statSync).toHaveBeenCalledWith('/host/cache');
      expect(calls).toHaveLength(1);
    });

    it('throws DockerSandboxError when workspace host path does not exist', async () => {
      const { runner } = makeStubRunner();
      fsMocks.statSync.mockImplementation((hostPath) => {
        if (hostPath === '/host/work') {
          throw new Error('ENOENT: no such file or directory');
        }
        return { isDirectory: () => true } as ReturnType<
          typeof import('node:fs').statSync
        >;
      });

      const promise = createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'missing-workspace',
      });

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Workspace host path does not exist: \/host\/work/u,
      );
    });

    it('throws DockerSandboxError when a mount host path does not exist', async () => {
      const { runner } = makeStubRunner();
      fsMocks.statSync.mockImplementation((hostPath) => {
        if (hostPath === '/host/cache') {
          throw new Error('ENOENT: no such file or directory');
        }
        return { isDirectory: () => true } as ReturnType<
          typeof import('node:fs').statSync
        >;
      });

      const promise = createDockerSandbox(
        makeConfig({
          mounts: [
            {
              hostPath: '/host/cache',
              containerPath: '/cache',
              readOnly: true,
            },
          ],
        }),
        { commandRunner: runner, containerName: 'missing-mount' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Mount host path does not exist: \/host\/cache/u,
      );
    });

    it('skips validation when workspace is disabled', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(makeConfig({ workspace: false }), {
        commandRunner: runner,
        containerName: 'no-workspace',
      });

      expect(fsMocks.statSync).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });
  });

  describe('env file validation', () => {
    it('throws DockerSandboxError when an env key contains a space', async () => {
      const { runner } = makeStubRunner();

      const promise = createDockerSandbox(
        makeConfig({ env: { 'FOO BAR': 'baz' } }),
        { commandRunner: runner, containerName: 'bad-key-space' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Invalid environment variable key `FOO BAR`/u,
      );
    });

    it('throws DockerSandboxError when an env key contains an equals sign', async () => {
      const { runner } = makeStubRunner();

      const promise = createDockerSandbox(
        makeConfig({ env: { 'FOO=BAR': 'baz' } }),
        { commandRunner: runner, containerName: 'bad-key-equals' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Invalid environment variable key `FOO=BAR`/u,
      );
    });

    it('throws DockerSandboxError when an env key contains a newline', async () => {
      const { runner } = makeStubRunner();

      const promise = createDockerSandbox(
        makeConfig({ env: { 'FOO\nBAR': 'baz' } }),
        { commandRunner: runner, containerName: 'bad-key-newline' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Invalid environment variable key `FOO\nBAR`/u,
      );
    });

    it('throws DockerSandboxError when an env value contains a newline', async () => {
      const { runner } = makeStubRunner();

      const promise = createDockerSandbox(
        makeConfig({ env: { FOO: 'bar\nbaz=qux' } }),
        { commandRunner: runner, containerName: 'bad-value-newline' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Invalid environment variable value for key `FOO`/u,
      );
    });

    it('throws DockerSandboxError when an env value contains a carriage return', async () => {
      const { runner } = makeStubRunner();

      const promise = createDockerSandbox(
        makeConfig({ env: { FOO: 'bar\rbaz=qux' } }),
        { commandRunner: runner, containerName: 'bad-value-cr' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Invalid environment variable value for key `FOO`/u,
      );
    });
  });

  describe('setup commands', () => {
    it('runs setup commands inside the workdir via docker exec sh -lc', async () => {
      const { runner, calls } = makeStubRunner();

      await createDockerSandbox(
        makeConfig({
          setupCommands: ['npm install', 'echo done'],
        }),
        { commandRunner: runner, containerName: 'setup' },
      );

      expect(calls).toHaveLength(3);
      expect(calls[1]?.args).toStrictEqual([
        'exec',
        '--workdir',
        '/workspace',
        'setup',
        'sh',
        '-lc',
        'npm install',
      ]);
      expect(calls[2]?.args).toStrictEqual([
        'exec',
        '--workdir',
        '/workspace',
        'setup',
        'sh',
        '-lc',
        'echo done',
      ]);
    });

    it('cleans up and rethrows when a setup command fails', async () => {
      const { runner, calls } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => {
          throw new DockerSandboxError('setup failed');
        },
      ]);

      const promise = createDockerSandbox(
        makeConfig({ setupCommands: ['boom'] }),
        { commandRunner: runner, containerName: 'setup-fail' },
      );

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(/Failed to run setup commands/u);

      // run, exec, rm -f
      expect(calls).toHaveLength(3);
      expect(calls[2]?.args).toStrictEqual(['rm', '-f', 'setup-fail']);
      expect(getActiveContainersForTesting()).not.toContain('setup-fail');
    });

    it('swallows secondary cleanup errors when surfacing setup failure', async () => {
      const { runner } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => {
          throw new DockerSandboxError('setup failed');
        },
        () => {
          throw new Error('rm also exploded');
        },
      ]);

      await expect(
        createDockerSandbox(makeConfig({ setupCommands: ['boom'] }), {
          commandRunner: runner,
          containerName: 'rm-fails',
        }),
      ).rejects.toThrow(/Failed to run setup commands/u);
    });
  });

  describe('start failure', () => {
    it('wraps docker run errors in a DockerSandboxError and does not register the container', async () => {
      const { runner } = makeStubRunner([
        () => {
          throw new DockerSandboxError('docker not found');
        },
      ]);

      const promise = createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'never-started',
      });

      await expect(promise).rejects.toBeInstanceOf(DockerSandboxError);
      await expect(promise).rejects.toThrow(
        /Failed to start Docker sandbox container/u,
      );
      expect(getActiveContainersForTesting()).not.toContain('never-started');
    });

    it('wraps non-DockerSandboxError causes from start', async () => {
      const { runner } = makeStubRunner([
        () => {
          throw new Error('plain failure');
        },
      ]);

      await expect(
        createDockerSandbox(makeConfig(), {
          commandRunner: runner,
          containerName: 'plain-fail',
        }),
      ).rejects.toThrow(
        /Failed to start Docker sandbox container.*plain failure/u,
      );
    });
  });

  describe('exec', () => {
    it('runs commands using sh -lc and the resolved workdir by default', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'exec-test',
      });

      await handle.exec('ls -la');

      const execCall = calls.at(-1);
      expect(execCall?.args).toStrictEqual([
        'exec',
        '--workdir',
        '/workspace',
        'exec-test',
        'sh',
        '-lc',
        'ls -la',
      ]);
      expect(execCall?.options).toBeUndefined();
    });

    it('supports cwd, user, and stdin overrides', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'exec-opts',
      });

      await handle.exec('cat -', {
        cwd: '/srv/app',
        user: 'root',
        stdin: 'payload',
      });

      const execCall = calls.at(-1);
      expect(execCall?.args).toStrictEqual([
        'exec',
        '-i',
        '--workdir',
        '/srv/app',
        '--user',
        'root',
        'exec-opts',
        'sh',
        '-lc',
        'cat -',
      ]);
      expect(execCall?.options).toStrictEqual({ stdin: 'payload' });
    });

    it('returns the runner result verbatim', async () => {
      const { runner } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => ({ stdout: 'output', stderr: 'note', exitCode: 0 }),
      ]);

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'exec-result',
      });

      const result = await handle.exec('echo hi');
      expect(result).toStrictEqual({
        stdout: 'output',
        stderr: 'note',
        exitCode: 0,
      });
    });
  });

  describe('copyFileIn / copyFileOut', () => {
    it('issues docker cp host -> container for copyFileIn', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'cp-in',
      });

      await handle.copyFileIn('/host/file', '/workspace/file');

      expect(calls.at(-1)?.args).toStrictEqual([
        'cp',
        '/host/file',
        'cp-in:/workspace/file',
      ]);
    });

    it('issues docker cp container -> host for copyFileOut', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'cp-out',
      });

      await handle.copyFileOut('/workspace/out', '/host/out');

      expect(calls.at(-1)?.args).toStrictEqual([
        'cp',
        'cp-out:/workspace/out',
        '/host/out',
      ]);
    });
  });

  describe('close', () => {
    it('removes the container exactly once even when called multiple times', async () => {
      const { runner, calls } = makeStubRunner();

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'idempotent-close',
      });

      await handle.close();
      await handle.close();
      await handle.close();

      const removals = calls.filter(
        (call) =>
          call.args[0] === 'rm' &&
          call.args[1] === '-f' &&
          call.args[2] === 'idempotent-close',
      );
      expect(removals).toHaveLength(1);
    });

    it('does not unregister the container when rm fails transiently', async () => {
      const rmError = new DockerSandboxError('rm failed');
      const { runner } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => {
          throw rmError;
        },
      ]);

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'rm-fail',
      });

      await expect(handle.close()).rejects.toBe(rmError);
      expect(getActiveContainersForTesting()).toContain('rm-fail');
    });

    it('marks closed and unregisters when rm fails with No such container', async () => {
      const { runner } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => {
          throw new Error(
            'Error response from daemon: No such container: already-gone',
          );
        },
      ]);

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'already-gone',
      });

      await handle.close();
      expect(getActiveContainersForTesting()).not.toContain('already-gone');
    });

    it('allows retry after a transient rm failure', async () => {
      const rmError = new DockerSandboxError('rm failed');
      const { runner, calls } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        () => {
          throw rmError;
        },
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
      ]);

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'retry-close',
      });

      await expect(handle.close()).rejects.toBe(rmError);
      expect(getActiveContainersForTesting()).toContain('retry-close');

      await handle.close();
      const removals = calls.filter(
        (call) =>
          call.args[0] === 'rm' &&
          call.args[1] === '-f' &&
          call.args[2] === 'retry-close',
      );
      expect(removals).toHaveLength(2);
      expect(getActiveContainersForTesting()).not.toContain('retry-close');
    });

    it('coalesces concurrent close calls into a single rm attempt', async () => {
      let resolveRm: ((value: DockerCommandResult) => void) | undefined;
      const rmPromise = new Promise<DockerCommandResult>((resolve) => {
        resolveRm = resolve;
      });

      const { runner, calls } = makeStubRunner([
        () => ({ stdout: '', stderr: '', exitCode: 0 }),
        async () => rmPromise,
      ]);

      const handle = await createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'concurrent-close',
      });

      const close1 = handle.close();
      const close2 = handle.close();
      const close3 = handle.close();

      expect(
        calls.filter(
          (call) =>
            call.args[0] === 'rm' &&
            call.args[1] === '-f' &&
            call.args[2] === 'concurrent-close',
        ),
      ).toHaveLength(1);

      resolveRm?.({ stdout: '', stderr: '', exitCode: 0 });

      await Promise.all([close1, close2, close3]);

      expect(
        calls.filter(
          (call) =>
            call.args[0] === 'rm' &&
            call.args[1] === '-f' &&
            call.args[2] === 'concurrent-close',
        ),
      ).toHaveLength(1);
    });
  });

  it('uses the default runner when none is injected (only that field is observed)', async () => {
    const { runner } = makeStubRunner();
    commandRunnerMocks.createDefaultDockerCommandRunner.mockReturnValueOnce(
      runner,
    );

    const handle = await createDockerSandbox(makeConfig(), {
      containerName: 'no-runner',
    });

    expect(
      commandRunnerMocks.createDefaultDockerCommandRunner,
    ).toHaveBeenCalledTimes(1);
    expect(handle.containerName).toBe('no-runner');
    await handle.close();
  });

  it('does not expose `workdir` on the handle when neither workspace nor workdir is configured', async () => {
    const { runner } = makeStubRunner();

    const handle = await createDockerSandbox(makeConfig({ workspace: false }), {
      commandRunner: runner,
      containerName: 'no-wd',
    });

    expect('workdir' in handle).toBe(false);
    await handle.close();
  });

  it('omits --workdir from setup commands and execs when no workdir is configured', async () => {
    const { runner, calls } = makeStubRunner();

    const handle = await createDockerSandbox(
      makeConfig({
        workspace: false,
        setupCommands: ['echo hi'],
      }),
      { commandRunner: runner, containerName: 'no-wd-exec' },
    );

    expect(calls[1]?.args).toStrictEqual([
      'exec',
      'no-wd-exec',
      'sh',
      '-lc',
      'echo hi',
    ]);

    await handle.exec('ls');
    expect(calls.at(-1)?.args).toStrictEqual([
      'exec',
      'no-wd-exec',
      'sh',
      '-lc',
      'ls',
    ]);

    await handle.close();
  });

  it('wraps non-Error throw values surfaced from docker run', async () => {
    const { runner } = makeStubRunner([
      (): never => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      },
    ]);

    await expect(
      createDockerSandbox(makeConfig(), {
        commandRunner: runner,
        containerName: 'string-throw',
      }),
    ).rejects.toThrow(/plain string failure/u);
  });
});

describe('createDockerSandbox process.getuid fallback', () => {
  beforeEach(() => {
    resetCleanupRegistryForTesting();
    capturedEnvFileContent = undefined;
    capturedEnvFilePath = undefined;
  });

  afterEach(() => {
    resetCleanupRegistryForTesting();
  });

  it('throws when `current` user is requested without getuid/getgid', async () => {
    const originalGetuid = process.getuid;
    const originalGetgid = process.getgid;
    // Simulate Windows where process.getuid/getgid are not available.
    Object.defineProperty(process, 'getuid', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process, 'getgid', {
      value: undefined,
      configurable: true,
    });

    try {
      const { runner } = makeStubRunner();
      await expect(
        createDockerSandbox(makeConfig({ user: 'current' }), {
          commandRunner: runner,
          containerName: 'no-uid',
        }),
      ).rejects.toThrow(/process\.getuid\/getgid are not available/u);
    } finally {
      Object.defineProperty(process, 'getuid', {
        value: originalGetuid,
        configurable: true,
      });
      Object.defineProperty(process, 'getgid', {
        value: originalGetgid,
        configurable: true,
      });
    }
  });
});
