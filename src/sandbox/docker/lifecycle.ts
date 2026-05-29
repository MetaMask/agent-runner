import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DockerSandboxError } from '../../errors.js';
import {
  registerActiveContainer,
  unregisterActiveContainer,
} from './cleanup-registry.js';
import { createDefaultDockerCommandRunner } from './command-runner.js';
import type {
  DockerCommandResult,
  DockerCommandRunner,
} from './command-runner.js';
import type {
  NormalizedDockerSandboxConfig,
  NormalizedDockerSandboxMount,
} from './options.js';
import { wrapDockerSandboxError } from './utils.js';

/**
 * Options accepted by {@link createDockerSandbox}.
 */
export type CreateDockerSandboxOptions = {
  /**
   * Injected command runner. When omitted, a default runner backed by
   * {@link createDefaultDockerCommandRunner} is used. Tests pass a stub
   * to exercise the lifecycle without a Docker daemon.
   */
  commandRunner?: DockerCommandRunner;
  /**
   * Override the generated container name. When omitted, a fresh name
   * of the form `metamask-agent-runner-<pid>-<random>` is generated.
   */
  containerName?: string;
};

/**
 * Result returned by {@link DockerSandboxHandle.exec}.
 */
export type DockerExecResult = DockerCommandResult;

/**
 * Options accepted by {@link DockerSandboxHandle.exec}.
 */
export type DockerExecOptions = {
  /** Working directory inside the container. */
  cwd?: string;
  /** Override the user the command runs as (e.g. `root`, `1000:1000`). */
  user?: string;
  /** Stdin payload delivered to the in-container command. */
  stdin?: string;
};

/**
 * Handle returned by {@link createDockerSandbox} representing a running
 * sandbox container. The handle is the only supported way to interact
 * with the container; callers must not bypass it.
 */
export type DockerSandboxHandle = {
  /** Name of the running container. */
  containerName: string;
  /**
   * Effective container working directory used as the default `cwd`
   * for execs that omit one. `undefined` when no workspace or workdir
   * was configured.
   */
  workdir?: string;
  /**
   * Runs a shell command inside the container.
   *
   * @param command - Shell command (run via `sh -lc`).
   * @param options - Per-exec overrides for cwd, user, and stdin.
   * @returns A promise resolving to the captured exec result.
   */
  exec(command: string, options?: DockerExecOptions): Promise<DockerExecResult>;
  /**
   * Copies a file from the host into the container.
   *
   * @param hostPath - Absolute host path to copy.
   * @param containerPath - Absolute container path destination.
   */
  copyFileIn(hostPath: string, containerPath: string): Promise<void>;
  /**
   * Copies a file from the container to the host.
   *
   * @param containerPath - Absolute container path source.
   * @param hostPath - Absolute host path destination.
   */
  copyFileOut(containerPath: string, hostPath: string): Promise<void>;
  /**
   * Removes the container. Idempotent: subsequent calls are no-ops.
   */
  close(): Promise<void>;
  /**
   * Removes the container from the process cleanup registry so it will
   * not be auto-removed on host process exit. Safe to call even when
   * the container was never registered.
   */
  unregisterCleanup(): void;
};

/**
 * Starts a sandbox container described by `config` and returns a
 * {@link DockerSandboxHandle} for interacting with it.
 *
 * The container is created with a long-running `sleep infinity` PID 1
 * so subsequent `docker exec` calls have something to attach to. After
 * a successful `docker run`, `setupCommands` are executed inside the
 * container in the resolved workdir. Any failure during setup tears
 * down the container before rethrowing.
 *
 * @param config - Normalized sandbox configuration.
 * @param options - Optional command runner and container name overrides.
 * @returns A handle representing the running container.
 * @throws {DockerSandboxError} When the container cannot be started or
 * its setup commands fail.
 */
export async function createDockerSandbox(
  config: NormalizedDockerSandboxConfig,
  options: CreateDockerSandboxOptions = {},
): Promise<DockerSandboxHandle> {
  const runner = options.commandRunner ?? createDefaultDockerCommandRunner();
  const containerName = options.containerName ?? generateContainerName();
  const workdir = resolveWorkdir(config);

  // Write resolved env vars to a temp file so secrets never appear in
  // the Docker argv (visible via `ps`, error messages, and telemetry).
  const envFilePath = writeEnvFile(config.env);

  // Pre-register so a signal between `docker run` success and setup
  // cannot leak the container. Unregistered on start failure since
  // `docker rm -f` on a non-existent name is harmless but we avoid
  // accumulating stale entries.
  if (config.cleanup !== 'never') {
    registerActiveContainer(containerName);
  }

  try {
    const runArgs = buildRunArgs(config, containerName, workdir, envFilePath);

    try {
      validateMountPaths(config);
      await runner.run('docker', runArgs);
    } catch (cause) {
      if (config.cleanup !== 'never') {
        unregisterActiveContainer(containerName);
      }
      throw wrapDockerSandboxError(
        `Failed to start Docker sandbox container \`${containerName}\``,
        cause,
      );
    }
  } finally {
    // The container captured the env on start; the temp file is no
    // longer needed and must not linger on the host filesystem.
    removeEnvFile(envFilePath);
  }

  try {
    await runSetupCommands(
      runner,
      containerName,
      workdir,
      config.setupCommands,
    );
  } catch (cause) {
    await bestEffortRemove(runner, containerName);
    unregisterActiveContainer(containerName);
    throw wrapDockerSandboxError(
      `Failed to run setup commands for Docker sandbox container \`${containerName}\``,
      cause,
    );
  }

  let closed = false;
  let closingPromise: Promise<void> | undefined;

  /**
   * Removes the container. Idempotent: subsequent calls are no-ops.
   * If a removal is already in-flight, returns the same promise so
   * concurrent callers do not race.
   *
   * @returns A promise that resolves when the container is removed.
   */
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    const pending = closingPromise;
    if (pending !== undefined) {
      await pending;
      return;
    }

    const promise = (async (): Promise<void> => {
      try {
        try {
          await runner.run('docker', ['rm', '-f', containerName]);
        } catch (error) {
          const isContainerAlreadyRemoved =
            error instanceof Error && /no such container/iu.test(error.message);

          if (!isContainerAlreadyRemoved) {
            throw error;
          }
        }
        closed = true;
        unregisterActiveContainer(containerName);
      } finally {
        closingPromise = undefined;
      }
    })();
    closingPromise = promise;
    await promise;
  };

  /**
   * Runs a command inside the container via `docker exec sh -lc`.
   *
   * @param command - Shell command to execute.
   * @param execOptions - Per-exec overrides (cwd, user, stdin).
   * @returns The captured exec result.
   */
  const exec = async (
    command: string,
    execOptions?: DockerExecOptions,
  ): Promise<DockerCommandResult> => {
    const effectiveCwd = execOptions?.cwd ?? workdir;
    const args = buildExecArgs(containerName, command, {
      ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
      ...(execOptions?.user === undefined ? {} : { user: execOptions.user }),
      ...(execOptions?.stdin === undefined ? {} : { stdin: true }),
    });
    const runOptions =
      execOptions?.stdin === undefined
        ? undefined
        : { stdin: execOptions.stdin };
    return runner.run('docker', args, runOptions);
  };

  /**
   * Copies a file from the host into the container.
   *
   * @param hostPath - Absolute host path to copy.
   * @param containerPath - Absolute container destination path.
   */
  const copyFileIn = async (
    hostPath: string,
    containerPath: string,
  ): Promise<void> => {
    await runner.run('docker', [
      'cp',
      hostPath,
      `${containerName}:${containerPath}`,
    ]);
  };

  /**
   * Copies a file from the container to the host.
   *
   * @param containerPath - Absolute container source path.
   * @param hostPath - Absolute host destination path.
   */
  const copyFileOut = async (
    containerPath: string,
    hostPath: string,
  ): Promise<void> => {
    await runner.run('docker', [
      'cp',
      `${containerName}:${containerPath}`,
      hostPath,
    ]);
  };

  /** Removes this container from the process-level cleanup registry. */
  const unregisterCleanup = (): void => {
    unregisterActiveContainer(containerName);
  };

  const handle: DockerSandboxHandle = {
    containerName,
    exec,
    copyFileIn,
    copyFileOut,
    close,
    unregisterCleanup,
  };

  if (workdir !== undefined) {
    handle.workdir = workdir;
  }

  return handle;
}

/**
 * Generates a unique container name combining the host pid with random
 * bytes so concurrent runs in the same host process do not collide.
 *
 * @returns A new container name.
 */
function generateContainerName(): string {
  return `metamask-agent-runner-${process.pid}-${randomBytes(6).toString('hex')}`;
}

/**
 * Resolves the effective container working directory. Explicit
 * `config.workdir` wins; otherwise the workspace container path (when
 * the workspace mount is enabled) is used.
 *
 * @param config - Normalized sandbox configuration.
 * @returns The resolved workdir, or `undefined` when neither is set.
 */
function resolveWorkdir(
  config: NormalizedDockerSandboxConfig,
): string | undefined {
  if (config.workdir !== undefined) {
    return config.workdir;
  }
  if (config.workspace !== false) {
    return config.workspace.containerPath;
  }
  return undefined;
}

/**
 * Validates that every host bind mount path referenced by the config
 * exists on disk before Docker silently creates missing directories.
 *
 * @param config - Normalized sandbox configuration.
 * @throws {DockerSandboxError} When a host path does not exist.
 */
function validateMountPaths(config: NormalizedDockerSandboxConfig): void {
  if (config.workspace !== false) {
    try {
      statSync(config.workspace.hostPath);
    } catch {
      throw new DockerSandboxError(
        `Workspace host path does not exist: ${config.workspace.hostPath}`,
      );
    }
  }

  for (const mount of config.mounts) {
    try {
      statSync(mount.hostPath);
    } catch {
      throw new DockerSandboxError(
        `Mount host path does not exist: ${mount.hostPath} (container path: ${mount.containerPath})`,
      );
    }
  }
}

/**
 * Builds the argv passed to `docker run` to start the long-running
 * sandbox container.
 *
 * @param config - Normalized sandbox configuration.
 * @param containerName - Container name to assign.
 * @param workdir - Resolved workdir, or `undefined` to skip `--workdir`.
 * @param envFilePath - Path to the temp env file containing resolved env vars.
 * @returns The argv array (excluding the `docker` executable).
 */
function buildRunArgs(
  config: NormalizedDockerSandboxConfig,
  containerName: string,
  workdir: string | undefined,
  envFilePath: string | undefined,
): string[] {
  const args: string[] = ['run', '-d', '--name', containerName];

  if (config.envFile !== undefined) {
    // User-provided env file is loaded first so that the auto-generated
    // env file (written below) can override colliding keys. Docker's
    // later --env-file wins for duplicate variables.
    args.push('--env-file', config.envFile);
  }
  if (envFilePath !== undefined) {
    args.push('--env-file', envFilePath);
  }

  if (config.workspace !== false) {
    args.push('-v', formatMount(config.workspace));
  }
  for (const mount of config.mounts) {
    args.push('-v', formatMount(mount));
  }

  if (workdir !== undefined) {
    args.push('--workdir', workdir);
  }
  if (config.network !== undefined) {
    args.push('--network', config.network);
  }

  const user = resolveUser(config.user);
  if (user !== undefined) {
    args.push('--user', user);
  }

  if (config.shmSize !== undefined) {
    args.push('--shm-size', config.shmSize);
  }

  if (config.memory !== undefined) {
    args.push('--memory', config.memory);
  }

  args.push(...config.unsafeDockerArgs);

  args.push(config.image);
  args.push('sh', '-lc', 'sleep infinity');

  return args;
}

/**
 * Resolves the configured `user` field into a value suitable for the
 * `docker run --user` flag.
 *
 * @param user - Normalized user setting.
 * @returns The user string to pass to Docker, or `undefined` when no
 * override should be applied.
 * @throws {DockerSandboxError} When `'current'` is requested on a
 * platform where `process.getuid`/`process.getgid` are unavailable.
 */
function resolveUser(
  user: NormalizedDockerSandboxConfig['user'],
): string | undefined {
  if (user === undefined || user === false) {
    return undefined;
  }
  if (user === 'current') {
    const getuid = process.getuid?.bind(process);
    const getgid = process.getgid?.bind(process);
    if (typeof getuid !== 'function' || typeof getgid !== 'function') {
      throw new DockerSandboxError(
        'Cannot resolve `current` user for Docker sandbox: process.getuid/getgid are not available on this platform.',
      );
    }
    return `${getuid()}:${getgid()}`;
  }
  return user;
}

/**
 * Formats a normalized mount as the value of a `docker run -v` flag.
 *
 * @param mount - Normalized mount to format.
 * @returns The `host:container[:ro]` form.
 */
function formatMount(mount: NormalizedDockerSandboxMount): string {
  const suffix = mount.readOnly ? ':ro' : '';
  return `${mount.hostPath}:${mount.containerPath}${suffix}`;
}

/**
 * Runs each configured setup command inside the container via
 * `docker exec`. Setup commands always run as the configured user and
 * within the resolved workdir (when one exists).
 *
 * @param runner - Injected command runner.
 * @param containerName - Container to run commands in.
 * @param workdir - Resolved workdir, or `undefined` when omitted.
 * @param commands - Commands to execute in order.
 * @throws Propagates the first failing command's error.
 */
async function runSetupCommands(
  runner: DockerCommandRunner,
  containerName: string,
  workdir: string | undefined,
  commands: readonly string[],
): Promise<void> {
  for (const command of commands) {
    const args = buildExecArgs(containerName, command, {
      ...(workdir === undefined ? {} : { cwd: workdir }),
    });
    await runner.run('docker', args);
  }
}

/**
 * Optional flags accepted by {@link buildExecArgs}.
 */
type BuildExecArgsOptions = {
  /** Optional working directory inside the container. */
  cwd?: string;
  /** Optional user override for the exec call. */
  user?: string;
  /** Whether the command receives data piped to stdin. */
  stdin?: boolean;
};

/**
 * Builds the argv for a `docker exec` call.
 *
 * @param containerName - Target container.
 * @param command - Shell command to run inside the container.
 * @param options - Optional `cwd`/`user` flags and whether stdin is piped.
 * @param options.cwd - Optional working directory inside the container.
 * @param options.user - Optional user override for the exec call.
 * @param options.stdin - Whether the command receives data piped to stdin.
 * @returns The argv array (excluding the `docker` executable).
 */
function buildExecArgs(
  containerName: string,
  command: string,
  options: BuildExecArgsOptions,
): string[] {
  const args: string[] = ['exec'];
  if (options.stdin === true) {
    args.push('-i');
  }
  if (options.cwd !== undefined) {
    args.push('--workdir', options.cwd);
  }
  if (options.user !== undefined) {
    args.push('--user', options.user);
  }
  args.push(containerName, 'sh', '-lc', command);
  return args;
}

/**
 * Attempts to remove a container, swallowing any errors. Used during
 * setup-failure cleanup so the original error is surfaced.
 *
 * @param runner - Injected command runner.
 * @param containerName - Container to remove.
 */
async function bestEffortRemove(
  runner: DockerCommandRunner,
  containerName: string,
): Promise<void> {
  try {
    await runner.run('docker', ['rm', '-f', containerName]);
  } catch {
    // Intentionally swallowed: the original failure is more useful to
    // surface than a follow-on cleanup error.
  }
}

/**
 * Writes the resolved env map to a temporary file in Docker env-file
 * format (`KEY=value`, one per line). The file is created with mode
 * 0o600 so only the owner can read it.
 *
 * Returns `undefined` when the env map is empty (no file needed).
 *
 * @param env - Resolved environment variables.
 * @returns Absolute path to the temp file, or `undefined`.
 */
function writeEnvFile(env: Record<string, string>): string | undefined {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return undefined;
  }

  const validKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
  for (const [key, value] of entries) {
    if (!validKeyPattern.test(key)) {
      throw new DockerSandboxError(
        `Invalid environment variable key \`${key}\`: keys must match [A-Za-z_][A-Za-z0-9_]*`,
      );
    }
    if (value.includes('\n') || value.includes('\r')) {
      throw new DockerSandboxError(
        `Invalid environment variable value for key \`${key}\`: values must not contain newlines or carriage returns`,
      );
    }
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'agent-runner-env-'));
  const filePath = path.join(dir, 'env');
  const content = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

/**
 * Best-effort removal of a temp env file and its parent directory.
 *
 * @param filePath - Path returned by {@link writeEnvFile}, or `undefined`.
 */
function removeEnvFile(filePath: string | undefined): void {
  if (filePath === undefined) {
    return;
  }
  try {
    unlinkSync(filePath);
    const dir = path.dirname(filePath);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: the OS will clean up the temp directory eventually.
  }
}
