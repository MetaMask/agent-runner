import { describe, expect, it } from 'vitest';

import {
  DockerSandboxError,
  DockerSandboxProtocolError,
} from '../../errors.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeEvent,
  serializeBridgeEvent,
} from './bridge-protocol.js';
import {
  BRIDGE_SDK_PACKAGE_NAME,
  DEFAULT_REMOTE_BRIDGE_DIR,
  DEFAULT_REMOTE_BRIDGE_FILE,
  MAX_BRIDGE_LINE_LENGTH,
  MAX_BRIDGE_QUEUE_SIZE,
  bootstrapDockerClaudeBridge,
  resolveBridgeSdkVersion,
  resolveDefaultBridgeHostPath,
  runDockerClaudeBridge,
} from './bridge.js';
import type {
  DockerCommandResult,
  DockerCommandRunOptions,
  DockerCommandRunner,
} from './command-runner.js';
import type { DockerSandboxHandle } from './lifecycle.js';
import type { NormalizedDockerSandboxConfig } from './options.js';

/**
 *
 */
type RecordedCall = {
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
  options: DockerCommandRunOptions | undefined;
};

/**
 *
 */
type RunnerImpl = (
  command: string,
  args: readonly string[],
  options?: DockerCommandRunOptions,
) => Promise<DockerCommandResult> | DockerCommandResult;

/**
 * Builds a stub command runner that records each invocation and
 * returns canned results in order.
 *
 * @param impls - Per-call implementations. Calls beyond the supplied
 * list default to a successful empty result.
 * @returns The stub runner alongside the recorded call list.
 */
function makeStubRunner(impls: RunnerImpl[] = []): {
  /**
   *
   */
  runner: DockerCommandRunner;
  /**
   *
   */
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...impls];

  const runner: DockerCommandRunner = {
    /**
     *
     * @param command
     * @param args
     * @param options
     */
    async run(command, args, options) {
      calls.push({
        command,
        args: [...args],
        options,
      });
      const next = queue.shift();
      if (next) {
        return await next(command, args, options);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

/**
 * Builds a fake sandbox handle exposing just enough surface for the
 * bridge tests (the container name and a noop close method).
 *
 * @param containerName - Container name to expose.
 * @returns A minimal handle suitable for the bridge module.
 */
function makeHandle(containerName: string): DockerSandboxHandle {
  return {
    containerName,
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyFileIn() {
      // Tests exercise the bridge's own docker cp call via the runner.
    },
    async copyFileOut() {
      // Unused.
    },
    async close() {
      // Unused.
    },
    unregisterCleanup() {
      // Unused.
    },
  };
}

/**
 * Builds a normalized sandbox config that exposes the bridge fields
 * tests care about; defaults are filled in with stable values so
 * snapshot-style assertions remain stable.
 *
 * @param overrides - Partial overrides for the bridge field.
 * @returns A normalized config.
 */
function makeConfig(
  overrides: Partial<NormalizedDockerSandboxConfig['bridge']> = {},
): NormalizedDockerSandboxConfig {
  return {
    image: 'sandbox-image:latest',
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
      ...overrides,
    },
  };
}

describe('resolveDefaultBridgeHostPath', () => {
  it('returns an absolute path ending in container/claude-bridge.mjs', () => {
    const resolved = resolveDefaultBridgeHostPath();
    expect(resolved).toMatch(/[/\\]container[/\\]claude-bridge\.mjs$/u);
  });
});

describe('resolveBridgeSdkVersion', () => {
  it('returns the explicit override when provided', () => {
    const config = makeConfig({ sdkVersion: '1.2.3' });
    expect(
      resolveBridgeSdkVersion({
        config,
        /**
         *
         */
        readHostSdkVersion: () => '9.9.9',
      }),
    ).toBe('1.2.3');
  });

  it('falls back to the host-installed SDK version', () => {
    const config = makeConfig();
    expect(
      resolveBridgeSdkVersion({
        config,
        /**
         *
         */
        readHostSdkVersion: () => '0.2.138',
      }),
    ).toBe('0.2.138');
  });

  it('uses the default host SDK reader when no override is supplied', () => {
    // Without the optional override, the function falls back to
    // reading the host package.json via createRequire. We do not
    // assert a specific version (it tracks the installed dep), only
    // that the lookup succeeds in this repo.
    const result = resolveBridgeSdkVersion({ config: makeConfig() });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws when neither an override nor the host SDK can be located', () => {
    expect(() =>
      resolveBridgeSdkVersion({
        config: makeConfig(),
        /**
         *
         */
        readHostSdkVersion: () => undefined,
      }),
    ).toThrow(/Could not determine .* version/u);
  });
});

describe('bootstrapDockerClaudeBridge', () => {
  it('executes preflight, mkdir, cp, package.json, and npm install in order', async () => {
    const { runner, calls } = makeStubRunner();

    const result = await bootstrapDockerClaudeBridge({
      sandbox: makeHandle('ct-1'),
      config: makeConfig(),
      commandRunner: runner,
      bridgeHostPath: '/host/bridge/claude-bridge.mjs',
      /**
       *
       */
      readHostSdkVersion: () => '0.2.99',
    });

    expect(result.remoteBridgeDir).toBe(DEFAULT_REMOTE_BRIDGE_DIR);
    expect(result.remoteBridgePath).toBe(
      `${DEFAULT_REMOTE_BRIDGE_DIR}/${DEFAULT_REMOTE_BRIDGE_FILE}`,
    );
    expect(result.nodeCommand).toBe('node');

    // 1: node --version, 2: npm --version, 3: mkdir, 4: docker cp,
    // 5: write package.json, 6: npm install
    expect(calls).toHaveLength(6);

    // Preflight node/npm.
    expect(calls[0]?.args).toStrictEqual([
      'exec',
      'ct-1',
      'sh',
      '-lc',
      `'node' --version`,
    ]);
    expect(calls[1]?.args).toStrictEqual([
      'exec',
      'ct-1',
      'sh',
      '-lc',
      `'npm' --version`,
    ]);

    // mkdir -p with shell-escaped bridge dir.
    expect(calls[2]?.args).toStrictEqual([
      'exec',
      'ct-1',
      'sh',
      '-lc',
      `mkdir -p '${DEFAULT_REMOTE_BRIDGE_DIR}'`,
    ]);

    // docker cp host -> container.
    expect(calls[3]?.args).toStrictEqual([
      'cp',
      '/host/bridge/claude-bridge.mjs',
      `ct-1:${DEFAULT_REMOTE_BRIDGE_DIR}/${DEFAULT_REMOTE_BRIDGE_FILE}`,
    ]);

    // package.json written via cat > path with stdin.
    expect(calls[4]?.args).toStrictEqual([
      'exec',
      '-i',
      '--workdir',
      DEFAULT_REMOTE_BRIDGE_DIR,
      'ct-1',
      'sh',
      '-lc',
      `cat > '${DEFAULT_REMOTE_BRIDGE_DIR}/package.json'`,
    ]);
    const pkgStdin = calls[4]?.options?.stdin;
    expect(typeof pkgStdin).toBe('string');
    const pkg = JSON.parse(pkgStdin as string);
    expect(pkg).toMatchObject({
      type: 'module',
      private: true,
    });
    expect(pkg.dependencies[BRIDGE_SDK_PACKAGE_NAME]).toBe('0.2.99');
    // Zod version is resolved from the host; assert it is a valid semver
    // string rather than a range (no ^ or ~ prefix).
    expect(pkg.dependencies.zod).toMatch(/^\d+\.\d+\.\d+/u);

    // npm install with --no-audit --no-fund --ignore-scripts and pinned dependencies.
    const npmArgs = calls[5]?.args ?? [];
    expect(npmArgs.slice(0, 9)).toStrictEqual([
      'exec',
      '--workdir',
      DEFAULT_REMOTE_BRIDGE_DIR,
      'ct-1',
      'npm',
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
    ]);
    expect(npmArgs[9]).toBe(`${BRIDGE_SDK_PACKAGE_NAME}@0.2.99`);
    expect(npmArgs[10]).toMatch(/^zod@\d+\.\d+\.\d+/u);
  });

  it('skips npm install when bridge.install === false', async () => {
    const { runner, calls } = makeStubRunner();

    await bootstrapDockerClaudeBridge({
      sandbox: makeHandle('ct-skip'),
      config: makeConfig({ install: false }),
      commandRunner: runner,
      bridgeHostPath: '/host/bridge.mjs',
      /**
       *
       */
      readHostSdkVersion: () => '0.2.99',
    });

    // 4 calls (no npm preflight, no npm install).
    expect(calls).toHaveLength(4);
    expect(
      calls.some(
        (call) => call.args[0] === 'exec' && call.args.includes('install'),
      ),
    ).toBe(false);
  });

  it('skips npm preflight when bridge.install is false', async () => {
    const { runner, calls } = makeStubRunner();

    await bootstrapDockerClaudeBridge({
      sandbox: makeHandle('ct-skip-npm-preflight'),
      config: makeConfig({ install: false }),
      commandRunner: runner,
      bridgeHostPath: '/host/bridge.mjs',
      /**
       *
       */
      readHostSdkVersion: () => '0.2.99',
    });

    const npmPreflight = calls.find(
      (call) =>
        call.command === 'docker' &&
        call.args[0] === 'exec' &&
        call.args.includes(`'npm' --version`),
    );
    expect(npmPreflight).toBeUndefined();
  });

  it('forwards an explicit sdkVersion override into npm install', async () => {
    const { runner, calls } = makeStubRunner();

    await bootstrapDockerClaudeBridge({
      sandbox: makeHandle('ct-override'),
      config: makeConfig({ sdkVersion: '0.9.0' }),
      commandRunner: runner,
      bridgeHostPath: '/host/bridge.mjs',
    });

    const npmCall = calls.at(-1);
    expect(npmCall?.args).toContain(`${BRIDGE_SDK_PACKAGE_NAME}@0.9.0`);
  });

  it('uses custom remoteBridgeDir / remoteBridgeFile / node / npm commands', async () => {
    const { runner, calls } = makeStubRunner();

    await bootstrapDockerClaudeBridge({
      sandbox: makeHandle('ct-custom'),
      config: makeConfig({
        nodeCommand: '/usr/local/bin/node',
        npmCommand: '/usr/local/bin/npm',
      }),
      commandRunner: runner,
      bridgeHostPath: '/host/bridge.mjs',
      remoteBridgeDir: '/srv/bridge',
      remoteBridgeFile: 'entry.mjs',
      /**
       *
       */
      readHostSdkVersion: () => '0.2.99',
    });

    expect(calls[0]?.args).toStrictEqual([
      'exec',
      'ct-custom',
      'sh',
      '-lc',
      `'/usr/local/bin/node' --version`,
    ]);
    expect(calls[1]?.args).toStrictEqual([
      'exec',
      'ct-custom',
      'sh',
      '-lc',
      `'/usr/local/bin/npm' --version`,
    ]);
    expect(calls[3]?.args).toStrictEqual([
      'cp',
      '/host/bridge.mjs',
      'ct-custom:/srv/bridge/entry.mjs',
    ]);
    expect(calls[5]?.args[0]).toBe('exec');
    expect(calls[5]?.args).toContain('/usr/local/bin/npm');
  });

  it('throws with guidance when node preflight fails', async () => {
    const { runner } = makeStubRunner([
      () => {
        throw new DockerSandboxError('node: command not found');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-no-node'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/missing Node\.js.*Install Node\.js/su);
  });

  it('throws with guidance when npm preflight fails', async () => {
    const { runner } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => {
        throw new DockerSandboxError('npm: command not found');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-no-npm'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/missing npm.*Install npm/su);
  });

  it('wraps docker cp failures with bridge-step context', async () => {
    const { runner } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // node
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // npm
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // mkdir
      () => {
        throw new Error('cp denied');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-cp-fail'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/copy bridge script.*ct-cp-fail.*cp denied/u);
  });

  it('wraps mkdir failures with bridge-step context', async () => {
    const { runner } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => {
        throw new Error('permission denied');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-mkdir'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/prepare bridge directory.*ct-mkdir/u);
  });

  it('wraps package.json write failures', async () => {
    const { runner } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => {
        throw new DockerSandboxError('write failed');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-pkg'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/write bridge package\.json.*ct-pkg.*write failed/u);
  });

  it('wraps npm install failures with bridge-step context', async () => {
    const { runner } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => {
        throw new Error('npm crash');
      },
    ]);

    await expect(
      bootstrapDockerClaudeBridge({
        sandbox: makeHandle('ct-npm'),
        config: makeConfig(),
        commandRunner: runner,
        bridgeHostPath: '/host/bridge.mjs',
        /**
         *
         */
        readHostSdkVersion: () => '0.2.99',
      }),
    ).rejects.toThrow(/install bridge runtime.*ct-npm.*npm crash/u);
  });
});

describe('runDockerClaudeBridge', () => {
  const preparedBridge = {
    remoteBridgePath: `${DEFAULT_REMOTE_BRIDGE_DIR}/${DEFAULT_REMOTE_BRIDGE_FILE}`,
    remoteBridgeDir: DEFAULT_REMOTE_BRIDGE_DIR,
    nodeCommand: 'node',
  };

  /**
   * Builds a runner that streams the supplied JSONL lines into the
   * stdout callback, then resolves with the given exit code.
   *
   * @param lines - JSONL lines to emit (without trailing newlines).
   * @param exitCode - Exit code the run resolves with.
   * @param stderr - Stderr text emitted alongside the run.
   * @returns The runner and recorded call list.
   */
  function makeStreamingRunner(
    lines: string[],
    exitCode = 0,
    stderr = '',
  ): {
    runner: DockerCommandRunner;
    calls: RecordedCall[];
  } {
    return makeStubRunner([
      (_command, _args, options) => {
        for (const line of lines) {
          options?.onStdoutLine?.(line);
        }
        return { stdout: lines.join('\n'), stderr, exitCode };
      },
    ]);
  }

  it('yields raw SDK messages in order and completes on done', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system', subtype: 'init', session_id: 's' },
      }),
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'assistant', message: { id: 'm1' } },
      }),
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    ];
    const { runner, calls } = makeStreamingRunner(lines);

    const messages: unknown[] = [];
    for await (const message of runDockerClaudeBridge({
      sandbox: makeHandle('ct-stream'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: { cwd: '/workspace' } },
      preparedBridge,
    })) {
      messages.push(message);
    }

    expect(messages).toStrictEqual([
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { id: 'm1' } },
    ]);

    // The single docker exec invocation runs node against the prepared
    // bridge path with the serialized request piped on stdin.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toStrictEqual([
      'exec',
      '-i',
      'ct-stream',
      'node',
      preparedBridge.remoteBridgePath,
    ]);
    const stdin = calls[0]?.options?.stdin as string;
    expect(JSON.parse(stdin)).toStrictEqual({
      version: BRIDGE_PROTOCOL_VERSION,
      type: 'run',
      prompt: 'hi',
      options: { cwd: '/workspace' },
    });
    expect(calls[0]?.options?.allowNonZeroExit).toBe(true);
  });

  it('ignores blank lines emitted between events', async () => {
    const lines = [
      '',
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'ping' },
      }),
      '',
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    ];
    const { runner } = makeStreamingRunner(lines);

    const messages: unknown[] = [];
    for await (const message of runDockerClaudeBridge({
      sandbox: makeHandle('ct-blank'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })) {
      messages.push(message);
    }

    expect(messages).toStrictEqual([{ type: 'ping' }]);
  });

  it('throws DockerSandboxProtocolError on invalid JSON lines', async () => {
    const { runner } = makeStreamingRunner(['not-json{'], 0);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-bad-json'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(
      DockerSandboxProtocolError,
    );
  });

  it('throws DockerSandboxProtocolError on malformed message events', async () => {
    const lines = [
      JSON.stringify({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        // missing `message` field
      }),
    ];
    const { runner } = makeStreamingRunner(lines, 0);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-malformed'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(
      /missing the `message` field/u,
    );
  });

  it('throws DockerSandboxError when the bridge emits an error event', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system', subtype: 'init' },
      }),
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: { name: 'BoomError', message: 'kaboom' },
      }),
    ];
    const { runner } = makeStreamingRunner(lines, 1);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-error'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })[Symbol.asyncIterator]();

    // First message is yielded.
    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Second iteration surfaces the error event without a cause.
    let error: unknown;
    try {
      await iterator.next();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toMatch(
      /reported an error: BoomError: kaboom/u,
    );
    expect((error as Error).cause).toBeUndefined();
  });

  it('throws DockerSandboxError with cause when the bridge emits an error event with a stack', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system', subtype: 'init' },
      }),
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        error: {
          name: 'BoomError',
          message: 'kaboom',
          stack: 'BoomError: kaboom\n    at foo (/app/index.js:1:1)',
        },
      }),
    ];
    const { runner } = makeStreamingRunner(lines, 1);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-error-stack'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })[Symbol.asyncIterator]();

    // First message is yielded.
    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Second iteration surfaces the error event with a cause carrying the remote stack.
    let error: unknown;
    try {
      await iterator.next();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toMatch(
      /reported an error: BoomError: kaboom/u,
    );
    expect((error as Error).cause).toBeInstanceOf(Error);
    const cause = (error as Error).cause as Error;
    expect(cause.name).toBe('BoomError');
    expect(cause.message).toBe('kaboom');
    expect(cause.stack).toBe(
      'BoomError: kaboom\n    at foo (/app/index.js:1:1)',
    );
  });

  it('throws DockerSandboxProtocolError when the run exits before done', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system' },
      }),
    ];
    const { runner } = makeStreamingRunner(lines, 0);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-no-done'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    });

    const collected: unknown[] = [];
    const error = await iterate(iterator, collected);

    expect(collected).toStrictEqual([{ type: 'system' }]);
    expect(error).toBeInstanceOf(DockerSandboxProtocolError);
    expect((error as Error).message).toMatch(/ct-no-done.*without emitting/u);
  });

  it('throws DockerSandboxError when the bridge process exits non-zero without an error event', async () => {
    const { runner } = makeStreamingRunner([], 7, 'fatal in container');

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-nonzero'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    });

    const error = await iterate(iterator, []);
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toMatch(
      /ct-nonzero.* exited with code 7/u,
    );
    expect((error as Error).message).toMatch(/stderr: fatal in container/u);
  });

  it('surfaces docker spawn errors from the runner', async () => {
    const { runner } = makeStubRunner([
      () => {
        throw new DockerSandboxError('docker missing');
      },
    ]);

    const iterator = runDockerClaudeBridge({
      sandbox: makeHandle('ct-spawn'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    });

    const error = await iterate(iterator, []);
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect((error as Error).message).toMatch(/docker missing/u);
  });

  it('bootstraps automatically when no preparedBridge is supplied', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    ];

    const { runner, calls } = makeStubRunner([
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // node --version
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // npm --version
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // mkdir
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // docker cp
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // pkg.json
      () => ({ stdout: '', stderr: '', exitCode: 0 }), // npm install
      (_command, _args, options) => {
        for (const line of lines) {
          options?.onStdoutLine?.(line);
        }
        return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
      },
    ]);

    const messages: unknown[] = [];
    for await (const message of runDockerClaudeBridge({
      sandbox: makeHandle('ct-auto'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      bridgeHostPath: '/host/bridge.mjs',
      /**
       *
       */
      readHostSdkVersion: () => '0.2.50',
    })) {
      messages.push(message);
    }

    expect(messages).toStrictEqual([]);
    expect(calls).toHaveLength(7);
    expect(calls.at(-1)?.args[0]).toBe('exec');
    expect(calls.at(-1)?.args).toContain('node');
  });

  it('forwards an AbortSignal and aborts the runner on early termination', async () => {
    let observedSignal: AbortSignal | undefined;
    const finished: { value: boolean } = { value: false };

    const { runner } = makeStubRunner([
      async (_command, _args, options) => {
        observedSignal = options?.signal;
        // Emit a single message synchronously so the consumer has
        // something to yield against before it breaks.
        options?.onStdoutLine?.(
          serializeBridgeEvent({
            version: BRIDGE_PROTOCOL_VERSION,
            type: 'message',
            message: { type: 'system', subtype: 'init' },
          }),
        );
        // Wait until the consumer aborts the run.
        await new Promise<void>((resolve) => {
          const currentSignal = options?.signal;
          if (currentSignal?.aborted) {
            resolve();
            return;
          }
          currentSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        finished.value = true;
        // Simulate the spawn-time signal failure surfaced by the
        // default runner when a child is killed via its AbortSignal.
        throw new DockerSandboxError(
          'Host command `docker exec` terminated by signal SIGTERM.',
        );
      },
    ]);

    const iterable = runDockerClaudeBridge({
      sandbox: makeHandle('ct-abort'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    });
    const iterator = iterable[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Consumer breaks early — simulated by invoking `iterator.return()`
    // directly. This must resolve promptly because the bridge aborts
    // the runner instead of waiting forever for the in-container
    // process to exit. The bridge always exposes `return` on the
    // generator iterator it produces; we cast to a fully-typed
    // generator alias here to satisfy the lint rules.
    const generator = iterator as AsyncGenerator<unknown>;
    const returned = await Promise.race([
      generator.return(undefined),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('iterator.return() did not resolve')),
          2000,
        ),
      ),
    ]);

    expect(returned.done).toBe(true);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(finished.value).toBe(true);
  });

  it('forwards the AbortSignal even when iteration completes naturally', async () => {
    let observedSignal: AbortSignal | undefined;
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    ];
    const { runner } = makeStubRunner([
      (_command, _args, options) => {
        observedSignal = options?.signal;
        for (const line of lines) {
          options?.onStdoutLine?.(line);
        }
        return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
      },
    ]);

    for await (const message of runDockerClaudeBridge({
      sandbox: makeHandle('ct-signal-natural'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })) {
      // No messages expected; assert the type guard fires only when
      // events actually arrive so this loop body is not dead code.
      expect(message).toBeDefined();
    }

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    // Natural completion does not need the abort path; the signal
    // should have stayed un-aborted.
    expect(observedSignal?.aborted).toBe(false);
  });

  it('round-trips event serialization with parseBridgeEvent on each line', async () => {
    const event = parseBridgeEvent(
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    );
    expect(event.type).toBe('done');
  });

  it('passes MAX_BRIDGE_LINE_LENGTH as maxLineLength to the command runner', async () => {
    const lines = [
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: { type: 'system', subtype: 'init', session_id: 's' },
      }),
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    ];
    const { runner, calls } = makeStreamingRunner(lines);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _message of runDockerClaudeBridge({
      sandbox: makeHandle('ct-maxline'),
      config: makeConfig(),
      commandRunner: runner,
      request: { prompt: 'hi', options: {} },
      preparedBridge,
    })) {
      // drain
    }

    expect(calls[0]?.options?.maxLineLength).toBe(MAX_BRIDGE_LINE_LENGTH);
  });

  it('throws DockerSandboxProtocolError when queue exceeds MAX_BRIDGE_QUEUE_SIZE', async () => {
    const lines = Array.from(
      { length: MAX_BRIDGE_QUEUE_SIZE + 1 },
      (_value, index) =>
        serializeBridgeEvent({
          version: BRIDGE_PROTOCOL_VERSION,
          type: 'message',
          message: { id: index },
        }),
    );
    lines.push(
      serializeBridgeEvent({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      }),
    );
    const { runner } = makeStreamingRunner(lines);

    const collected: unknown[] = [];
    const error = await iterate(
      runDockerClaudeBridge({
        sandbox: makeHandle('ct-overflow'),
        config: makeConfig(),
        commandRunner: runner,
        request: { prompt: 'hi', options: {} },
        preparedBridge,
      }),
      collected,
    );

    expect(error).toBeInstanceOf(DockerSandboxProtocolError);
    expect((error as Error).message).toContain('queued event limit');
  });
});

/**
 * Drains an async iterable, pushing yielded messages into `collected`
 * and returning any thrown error (or `undefined` if none).
 *
 * @param iterable - The iterable to drain.
 * @param collected - Mutated to record yielded values.
 * @returns The thrown error or `undefined`.
 */
async function iterate(
  iterable: AsyncIterable<unknown>,
  collected: unknown[],
): Promise<unknown> {
  try {
    for await (const value of iterable) {
      collected.push(value);
    }
    return undefined;
  } catch (error) {
    return error;
  }
}
