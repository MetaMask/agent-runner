import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DockerSandboxError,
  DockerSandboxProtocolError,
} from '../../errors.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeEvent,
  serializeBridgeRequest,
} from './bridge-protocol.js';
import type { BridgeEvent, BridgeRequest } from './bridge-protocol.js';
import type { DockerCommandRunner } from './command-runner.js';
import type { DockerSandboxHandle } from './lifecycle.js';
import type { NormalizedDockerSandboxConfig } from './options.js';
import { formatStderrExcerpt, wrapDockerSandboxError } from './utils.js';

/**
 * Default location for the bridge runtime tree inside the sandbox
 * container. The directory holds the compiled bridge script, a
 * minimal `package.json`, and the `node_modules` produced by
 * `npm install`.
 *
 * The path lives under `/tmp` so the bridge runtime can be installed
 * even on container images whose `/opt` (or other system paths) are
 * not writable for the default user.
 */
export const DEFAULT_REMOTE_BRIDGE_DIR = '/tmp/metamask-agent-runner-bridge';

/**
 * Filename used for the compiled bridge script inside the container.
 */
export const DEFAULT_REMOTE_BRIDGE_FILE = 'claude-bridge.mjs';

/**
 * Maximum character length of a single JSONL frame on the bridge
 * stdout stream. Frames exceeding this limit cause the child process
 * to be killed via the command runner's `maxLineLength` option.
 *
 * 10 MB is well above any realistic Claude SDK message size.
 */
export const MAX_BRIDGE_LINE_LENGTH = 10 * 1024 * 1024;

/**
 * Maximum number of parsed bridge events that may be queued before the
 * consumer drains them. When the limit is exceeded, the bridge
 * iterator treats the condition as a protocol error and aborts.
 */
export const MAX_BRIDGE_QUEUE_SIZE = 10_000;

/**
 * Fallback exact version used when installing `zod` as the SDK's peer
 * dependency. The host-installed version is preferred (via
 * {@link readHostZodVersion}); this value is only used when the host
 * does not have zod installed.
 */
export const DEFAULT_BRIDGE_ZOD_VERSION = '4.0.0';

/**
 * NPM package name of the Claude Agent SDK that the bridge installs
 * inside the container.
 */
export const BRIDGE_SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

/**
 * Resolves the on-disk path of the compiled container bridge `.mjs`
 * file shipped with this package. The build emits
 * `dist/sandbox/container/claude-bridge.mjs` next to the host-side
 * bridge module, so we resolve relative to `import.meta.url`.
 *
 * Tests inject an override via `bridgeHostPath`; do not rely on this
 * function in test code because it depends on the package layout.
 *
 * @returns Absolute path to the compiled bridge script.
 */
export function resolveDefaultBridgeHostPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(here),
    '..',
    'container',
    DEFAULT_REMOTE_BRIDGE_FILE,
  );
}

/**
 * Input for {@link resolveBridgeSdkVersion}.
 */
export type ResolveBridgeSdkVersionInput = {
  /** Normalized bridge configuration. */
  config: NormalizedDockerSandboxConfig;
  /**
   * Test seam returning the host-installed SDK version when present.
   * Production code falls back to {@link readHostSdkVersion}.
   */
  readHostSdkVersion?: () => string | undefined;
};

/**
 * Resolves the SDK version the bridge should install inside the
 * container.
 *
 * Resolution order:
 * 1. Explicit `sandbox.bridge.sdkVersion` if provided.
 * 2. Host-installed `@anthropic-ai/claude-agent-sdk/package.json`.
 *
 * The host `node_modules` tree is never copied into the container —
 * only the version string is borrowed to pin the in-container
 * `npm install`.
 *
 * @param input - Normalized config and an optional reader override.
 * @returns The exact version string suitable for `npm install`.
 * @throws {DockerSandboxError} When no version can be resolved.
 */
export function resolveBridgeSdkVersion(
  input: ResolveBridgeSdkVersionInput,
): string {
  const explicit = input.config.bridge.sdkVersion;
  if (explicit !== undefined) {
    return explicit;
  }

  const reader = input.readHostSdkVersion ?? readHostSdkVersion;
  const detected = reader();
  if (detected !== undefined) {
    return detected;
  }

  throw new DockerSandboxError(
    `Could not determine ${BRIDGE_SDK_PACKAGE_NAME} version: the host does not ` +
      'have it installed and `sandbox.bridge.sdkVersion` is not set. ' +
      'Install the SDK on the host or pin a version via `sandbox.bridge.sdkVersion`.',
  );
}

/**
 * Minimal shape we read from an SDK `package.json` to extract the
 * installed version.
 */
type PackageJsonHead = {
  /** Package name (when present). */
  name?: string;
  /** Installed semver-compatible version string. */
  version?: string;
};

/**
 * Reads the installed zod version from the host
 * `node_modules` tree. Uses `createRequire` so the resolution honours
 * the consumer's package layout (including `pnpm`, Yarn PnP, etc.).
 *
 * @returns The version string, or `undefined` when the package or its
 * `package.json` could not be resolved.
 */
function readHostZodVersion(): string | undefined {
  try {
    const requireFn = createRequire(import.meta.url);
    const pkgPath = requireFn.resolve('zod/package.json');
    const contents = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(contents) as PackageJsonHead;
    return parsed.version ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the installed Claude Agent SDK version from the host
 * `node_modules` tree.
 *
 * @returns The version string, or `undefined` when the package
 * could not be resolved.
 */
function readHostSdkVersion(): string | undefined {
  try {
    const requireFn = createRequire(import.meta.url);
    let pkgPath: string;
    try {
      pkgPath = requireFn.resolve(`${BRIDGE_SDK_PACKAGE_NAME}/package.json`);
    } catch {
      // Some packages do not export `./package.json`. Fall back to
      // resolving the entry point and looking alongside it.
      const entry = requireFn.resolve(BRIDGE_SDK_PACKAGE_NAME);
      pkgPath = path.join(path.dirname(entry), 'package.json');
    }
    const contents = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(contents) as PackageJsonHead;
    return parsed.version ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Input for {@link bootstrapDockerClaudeBridge}.
 */
export type BootstrapDockerClaudeBridgeInput = {
  /** Sandbox handle returned by {@link createDockerSandbox}. */
  sandbox: DockerSandboxHandle;
  /** Normalized sandbox configuration. */
  config: NormalizedDockerSandboxConfig;
  /** Injected command runner. */
  commandRunner: DockerCommandRunner;
  /**
   * Override path to the host-side compiled bridge script. Defaults to
   * {@link resolveDefaultBridgeHostPath}.
   */
  bridgeHostPath?: string;
  /**
   * Override directory used inside the container for the bridge tree.
   * Defaults to {@link DEFAULT_REMOTE_BRIDGE_DIR}.
   */
  remoteBridgeDir?: string;
  /**
   * Override filename used inside the container for the bridge script.
   * Defaults to {@link DEFAULT_REMOTE_BRIDGE_FILE}.
   */
  remoteBridgeFile?: string;
  /**
   * Test seam returning the host-installed SDK version. Forwarded to
   * {@link resolveBridgeSdkVersion}.
   */
  readHostSdkVersion?: () => string | undefined;
};

/**
 * Result of {@link bootstrapDockerClaudeBridge}.
 */
export type BootstrapDockerClaudeBridgeResult = {
  /** Absolute container path to the bridge script. */
  remoteBridgePath: string;
  /** Node.js command (path or PATH-resolved name) to invoke the bridge. */
  nodeCommand: string;
  /** Container directory holding the bridge tree. */
  remoteBridgeDir: string;
};

/**
 * Prepares the sandbox container to host the Claude bridge runtime.
 *
 * Steps performed in order:
 * 1. Preflight `node --version` and `npm --version` inside the
 *    container; missing binaries fail fast with actionable guidance.
 * 2. `mkdir -p <remoteBridgeDir>`.
 * 3. `docker cp` the compiled bridge script into the bridge directory.
 * 4. Write a minimal `package.json` describing the bridge runtime.
 * 5. Unless `config.bridge.install === false`, run `npm install` for
 *    `@anthropic-ai/claude-agent-sdk@<version>` and `zod@^4.0.0`.
 *
 * @param input - Inputs and overrides.
 * @returns The resolved remote bridge path and node command.
 * @throws {DockerSandboxError} When any bootstrap step fails.
 */
export async function bootstrapDockerClaudeBridge(
  input: BootstrapDockerClaudeBridgeInput,
): Promise<BootstrapDockerClaudeBridgeResult> {
  const { sandbox } = input;
  const runner = input.commandRunner;
  const bridgeConfig = input.config.bridge;
  const bridgeHostPath = input.bridgeHostPath ?? resolveDefaultBridgeHostPath();
  const remoteBridgeDir = input.remoteBridgeDir ?? DEFAULT_REMOTE_BRIDGE_DIR;
  const remoteBridgeFile = input.remoteBridgeFile ?? DEFAULT_REMOTE_BRIDGE_FILE;
  const remoteBridgePath = `${remoteBridgeDir}/${remoteBridgeFile}`;

  await preflightNodeAndNpm(runner, sandbox.containerName, bridgeConfig);

  await runDockerExec(
    runner,
    sandbox.containerName,
    ['sh', '-lc', `mkdir -p ${shellEscape(remoteBridgeDir)}`],
    `prepare bridge directory (${remoteBridgeDir})`,
  );

  try {
    await runner.run('docker', [
      'cp',
      bridgeHostPath,
      `${sandbox.containerName}:${remoteBridgePath}`,
    ]);
  } catch (cause) {
    throw wrapDockerSandboxError(
      `Failed to copy bridge script into container \`${sandbox.containerName}\` at ${remoteBridgePath}`,
      cause,
    );
  }

  const sdkVersion = resolveBridgeSdkVersion({
    config: input.config,
    ...(input.readHostSdkVersion === undefined
      ? {}
      : { readHostSdkVersion: input.readHostSdkVersion }),
  });

  const zodVersion = readHostZodVersion() ?? DEFAULT_BRIDGE_ZOD_VERSION;

  const pkgJson = buildBridgePackageJson(sdkVersion, zodVersion);
  try {
    await runner.run(
      'docker',
      [
        'exec',
        '-i',
        '--workdir',
        remoteBridgeDir,
        sandbox.containerName,
        'sh',
        '-lc',
        `cat > ${shellEscape(`${remoteBridgeDir}/package.json`)}`,
      ],
      { stdin: pkgJson },
    );
  } catch (cause) {
    throw wrapDockerSandboxError(
      `Failed to write bridge package.json in container \`${sandbox.containerName}\``,
      cause,
    );
  }

  if (bridgeConfig.install) {
    try {
      await runner.run('docker', [
        'exec',
        '--workdir',
        remoteBridgeDir,
        sandbox.containerName,
        bridgeConfig.npmCommand,
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        `${BRIDGE_SDK_PACKAGE_NAME}@${sdkVersion}`,
        `zod@${zodVersion}`,
      ]);
    } catch (cause) {
      throw wrapDockerSandboxError(
        `Failed to install bridge runtime in container \`${sandbox.containerName}\` ` +
          `(npm install ${BRIDGE_SDK_PACKAGE_NAME}@${sdkVersion} zod@${zodVersion})`,
        cause,
      );
    }
  }

  return {
    remoteBridgePath,
    nodeCommand: bridgeConfig.nodeCommand,
    remoteBridgeDir,
  };
}

/**
 * Input for {@link runDockerClaudeBridge}.
 */
export type RunDockerClaudeBridgeInput = {
  /** Sandbox handle. */
  sandbox: DockerSandboxHandle;
  /** Normalized sandbox configuration. */
  config: NormalizedDockerSandboxConfig;
  /** Injected command runner. */
  commandRunner: DockerCommandRunner;
  /** Prepared bridge request (prompt + sanitized options). */
  request: {
    /** Prompt forwarded to the bridge entry point. */
    prompt: string;
    /** Sanitized SDK options forwarded to the bridge entry point. */
    options: Record<string, unknown>;
  };
  /**
   * Override path to the host-side compiled bridge script. When
   * supplied, also forwarded to bootstrap.
   */
  bridgeHostPath?: string;
  /** Override directory used inside the container for the bridge tree. */
  remoteBridgeDir?: string;
  /** Override filename used inside the container for the bridge script. */
  remoteBridgeFile?: string;
  /**
   * Test seam returning the host-installed SDK version. Forwarded to
   * the bootstrap step.
   */
  readHostSdkVersion?: () => string | undefined;
  /**
   * When provided, the runner skips the bootstrap step and uses these
   * values to invoke the bridge directly. Intended for callers that
   * have already bootstrapped (or for tests that exercise the
   * streaming layer in isolation).
   */
  preparedBridge?: BootstrapDockerClaudeBridgeResult;
};

/**
 * Bootstraps the bridge (when not already prepared), invokes it via
 * `docker exec`, and exposes the SDK message stream as an
 * `AsyncIterable<unknown>`.
 *
 * The iterator yields one raw SDK message per `message` event. It
 * completes after the bridge emits `done` and the docker process
 * exits cleanly; otherwise it throws:
 *
 * - {@link DockerSandboxProtocolError} for invalid JSON, malformed
 *   events, or a process exit without a preceding `done` event.
 * - {@link DockerSandboxError} when the bridge emits an `error` event
 *   or the docker process exits with a non-zero status. Messages
 *   include the container name to ease diagnosis.
 *
 * @param input - Run parameters.
 * @returns An `AsyncIterable` over raw SDK messages.
 */
export function runDockerClaudeBridge(
  input: RunDockerClaudeBridgeInput,
): AsyncIterable<unknown> {
  /**
   * AsyncIterator factory wired into the returned AsyncIterable.
   *
   * @returns A fresh streaming iterator for the bridge run.
   */
  const iteratorFactory = (): AsyncGenerator<unknown> =>
    createBridgeIterator(input);
  return {
    [Symbol.asyncIterator]: iteratorFactory,
  };
}

/**
 * Creates the streaming async iterator returned by
 * {@link runDockerClaudeBridge}.
 *
 * @param input - Run parameters.
 * @yields Each raw SDK message reported by the in-container bridge.
 */
async function* createBridgeIterator(
  input: RunDockerClaudeBridgeInput,
): AsyncGenerator<unknown> {
  const prepared =
    input.preparedBridge ??
    (await bootstrapDockerClaudeBridge({
      sandbox: input.sandbox,
      config: input.config,
      commandRunner: input.commandRunner,
      ...(input.bridgeHostPath === undefined
        ? {}
        : { bridgeHostPath: input.bridgeHostPath }),
      ...(input.remoteBridgeDir === undefined
        ? {}
        : { remoteBridgeDir: input.remoteBridgeDir }),
      ...(input.remoteBridgeFile === undefined
        ? {}
        : { remoteBridgeFile: input.remoteBridgeFile }),
      ...(input.readHostSdkVersion === undefined
        ? {}
        : { readHostSdkVersion: input.readHostSdkVersion }),
    }));

  const { containerName } = input.sandbox;
  const request: BridgeRequest = {
    version: BRIDGE_PROTOCOL_VERSION,
    type: 'run',
    prompt: input.request.prompt,
    options: input.request.options,
  };

  const queue: BridgeEvent[] = [];
  let parseError: DockerSandboxProtocolError | null = null;
  let runError: Error | null = null;
  let runCompleted = false;
  const wakerHolder: WakerHolder = { current: null };

  /**
   * Wakes the consumer loop if it is currently awaiting more input.
   */
  const wake = (): void => {
    const pending = wakerHolder.current;
    wakerHolder.current = null;
    pending?.();
  };

  const execArgs = [
    'exec',
    '-i',
    containerName,
    prepared.nodeCommand,
    prepared.remoteBridgePath,
  ];

  /**
   * Handles a single line of bridge stdout, pushing the parsed event
   * (or capturing a parse error) and waking the consumer loop.
   *
   * @param line - Newline-terminated stdout fragment.
   */
  const handleStdoutLine = (line: string): void => {
    if (parseError !== null) {
      return;
    }
    if (line.length === 0) {
      return;
    }
    if (queue.length >= MAX_BRIDGE_QUEUE_SIZE) {
      parseError = new DockerSandboxProtocolError(
        `Docker bridge for container \`${containerName}\` exceeded the maximum ` +
          `queued event limit (${MAX_BRIDGE_QUEUE_SIZE}); aborting to prevent ` +
          `unbounded memory growth.`,
      );
      wake();
      return;
    }
    try {
      queue.push(parseBridgeEvent(line));
    } catch (cause) {
      parseError =
        cause instanceof DockerSandboxProtocolError
          ? cause
          : new DockerSandboxProtocolError(
              `Docker bridge for container \`${containerName}\` emitted an unparseable line.`,
              cause instanceof Error ? { cause } : undefined,
            );
    }
    wake();
  };

  // AbortController used to cancel the in-container docker exec when
  // the consumer abandons iteration (via `break`, `iterator.return()`,
  // or by throwing inside its `for await` body). The signal is
  // forwarded into the command runner so the child process is killed
  // promptly instead of leaving the host waiting forever for the
  // bridge to finish.
  const abortController = new AbortController();

  const runPromise = input.commandRunner
    .run('docker', execArgs, {
      stdin: serializeBridgeRequest(request),
      allowNonZeroExit: true,
      onStdoutLine: handleStdoutLine,
      signal: abortController.signal,
      maxLineLength: MAX_BRIDGE_LINE_LENGTH,
    })
    .then(
      (result) => {
        if (result.exitCode !== 0) {
          runError = new DockerSandboxError(
            `Docker bridge for container \`${containerName}\` exited with code ${result.exitCode}.${formatStderrExcerpt(result.stderr)}`,
          );
        }
        return undefined;
      },
      (cause: unknown) => {
        runError =
          cause instanceof Error
            ? cause
            : new DockerSandboxError(
                `Docker bridge for container \`${containerName}\` failed: ${String(cause)}`,
              );
        return undefined;
      },
    )
    .finally(() => {
      runCompleted = true;
      wake();
    });

  let doneSeen = false;
  try {
    while (true) {
      if (parseError !== null) {
        const errorToThrow: DockerSandboxProtocolError = parseError;
        throw errorToThrow;
      }
      while (queue.length > 0) {
        const event = queue.shift() as BridgeEvent;
        if (event.type === 'message') {
          yield event.message;
          continue;
        }
        if (event.type === 'error') {
          const named = event.error.name || 'Error';
          const message = `Docker bridge for container \`${containerName}\` reported an error: ${named}: ${event.error.message}`;
          if (event.error.stack !== undefined) {
            const remoteCause = new Error(event.error.message);
            remoteCause.name = named;
            remoteCause.stack = event.error.stack;
            throw new DockerSandboxError(message, { cause: remoteCause });
          }
          throw new DockerSandboxError(message);
        }
        // Done event.
        doneSeen = true;
      }
      if (runCompleted) {
        if (runError !== null) {
          const errorToThrow: Error = runError;
          throw errorToThrow;
        }
        if (!doneSeen) {
          throw new DockerSandboxProtocolError(
            `Docker bridge for container \`${containerName}\` exited without emitting a \`done\` event.`,
          );
        }
        return;
      }
      await waitForBridgeEvent(wakerHolder);
    }
  } finally {
    // Cancel the docker exec if the consumer abandoned iteration
    // before the bridge naturally finished. Without this, an early
    // `break` would leave the host blocked on `await runPromise`
    // below until the in-container SDK happened to exit on its own.
    if (!runCompleted) {
      abortController.abort();
    }
    // Always await the underlying docker process so we never leak the
    // promise. The `.then(success, failure)` arms above swallow all
    // rejections into `runError`, so this await never throws — abort
    // errors are intentionally discarded here because the consumer
    // has already decided to stop iterating, and any genuine bridge
    // failure that arrived before the abort has already been surfaced
    // (or replaced by the original termination cause).
    await runPromise;
  }
}

/**
 * Mutable holder used by the consumer loop to register a one-shot
 * waker that fires when the next bridge event is available.
 */
type WakerHolder = {
  /** Active waker, or `null` when no consumer is currently waiting. */
  current: (() => void) | null;
};

/**
 * Awaits the next bridge event by recording the promise resolver into
 * the supplied holder, then waiting until something calls `wake()`.
 *
 * Extracted so the consumer loop's `new Promise(...)` does not trip the
 * `no-loop-func` lint rule on the outer `waker` reference.
 *
 * @param holder - Mutable holder storing the active resolver.
 */
async function waitForBridgeEvent(holder: WakerHolder): Promise<void> {
  /**
   * Promise executor that records the resolver into the holder.
   *
   * @param resolve - Callback to invoke when the next event arrives.
   */
  const executor = (resolve: () => void): void => {
    holder.current = resolve;
  };
  await new Promise<void>(executor);
}

/**
 * Preflights node/npm inside the container, throwing a descriptive
 * error when either binary is missing.
 *
 * @param runner - Command runner.
 * @param containerName - Container to probe.
 * @param bridgeConfig - Normalized bridge config (for the node/npm
 * command overrides).
 */
async function preflightNodeAndNpm(
  runner: DockerCommandRunner,
  containerName: string,
  bridgeConfig: NormalizedDockerSandboxConfig['bridge'],
): Promise<void> {
  await preflightBinary(
    runner,
    containerName,
    bridgeConfig.nodeCommand,
    'Node.js',
    'Install Node.js in the sandbox image (or set `sandbox.bridge.nodeCommand` to its path) before running the Claude bridge.',
  );
  if (bridgeConfig.install) {
    await preflightBinary(
      runner,
      containerName,
      bridgeConfig.npmCommand,
      'npm',
      'Install npm in the sandbox image (or set `sandbox.bridge.npmCommand` to its path) before running the Claude bridge. Pass `sandbox.bridge.install: false` to skip in-container installation.',
    );
  }
}

/**
 * Probes a single binary for `--version` and throws when it cannot be
 * invoked.
 *
 * @param runner - Command runner.
 * @param containerName - Container to probe.
 * @param command - Binary path or PATH-resolved name.
 * @param friendlyName - Display name used in the error message.
 * @param guidance - Remediation hint included in the error message.
 */
async function preflightBinary(
  runner: DockerCommandRunner,
  containerName: string,
  command: string,
  friendlyName: string,
  guidance: string,
): Promise<void> {
  try {
    await runner.run('docker', [
      'exec',
      containerName,
      'sh',
      '-lc',
      `${shellEscape(command)} --version`,
    ]);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DockerSandboxError(
      `Docker sandbox \`${containerName}\` is missing ${friendlyName} (\`${command} --version\` failed): ${reason}\n${guidance}`,
      cause instanceof Error ? { cause } : undefined,
    );
  }
}

/**
 * Builds the minimal `package.json` document written into the bridge
 * directory inside the container.
 *
 * @param sdkVersion - SDK version that `npm install` will pin.
 * @param zodVersion - Zod version that `npm install` will pin.
 * @returns A JSON string ready to be piped over stdin.
 */
function buildBridgePackageJson(
  sdkVersion: string,
  zodVersion: string,
): string {
  return `${JSON.stringify(
    {
      name: 'metamask-agent-runner-bridge',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: {
        [BRIDGE_SDK_PACKAGE_NAME]: sdkVersion,
        zod: zodVersion,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Runs `docker exec <args>` and wraps any failure with context about
 * which bridge step failed.
 *
 * @param runner - Command runner.
 * @param containerName - Container target.
 * @param trailingArgs - Args after the container name.
 * @param contextDescription - Human-readable step description for errors.
 */
async function runDockerExec(
  runner: DockerCommandRunner,
  containerName: string,
  trailingArgs: readonly string[],
  contextDescription: string,
): Promise<void> {
  try {
    await runner.run('docker', ['exec', containerName, ...trailingArgs]);
  } catch (cause) {
    throw wrapDockerSandboxError(
      `Failed to ${contextDescription} in container \`${containerName}\``,
      cause,
    );
  }
}

/**
 * Escapes a string for inclusion in a single-quoted POSIX shell
 * argument. We use single quotes because the bridge paths never
 * contain them by construction.
 *
 * @param value - String to escape.
 * @returns The quoted form.
 */
function shellEscape(value: string): string {
  // Single-quote and escape any embedded single quotes.
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
