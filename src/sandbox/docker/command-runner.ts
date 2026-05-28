import { spawn } from 'node:child_process';
import type { ChildProcessByStdio, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { DockerSandboxError } from '../../errors.js';
import { formatStderrExcerpt } from './utils.js';

/**
 * Result of running a Docker (or Docker-related) host command.
 */
export type DockerCommandResult = {
  /** Decoded stdout text (utf-8). */
  stdout: string;
  /** Decoded stderr text (utf-8). */
  stderr: string;
  /** Final exit code reported by the child process. */
  exitCode: number;
};

/**
 * Options accepted by {@link DockerCommandRunner.run}.
 */
export type DockerCommandRunOptions = {
  /** When provided, the string is written to the child's stdin then closed. */
  stdin?: string;
  /** Working directory for the spawned process on the host. */
  cwd?: string;
  /**
   * Environment variables for the spawned host process. When omitted the
   * current process environment is inherited (the typical case so the
   * runner can locate the `docker` binary).
   */
  env?: Record<string, string | undefined>;
  /**
   * Called once per newline-terminated chunk of stdout. Intended for the
   * later bridge implementation which streams JSON frames out of the
   * container. The line callback is invoked synchronously while the
   * command is still running; trailing data without a newline is also
   * delivered when the process exits.
   */
  onStdoutLine?: (line: string) => void;
  /**
   * When `true`, the runner returns the result for non-zero exit codes
   * instead of throwing. Spawn errors (the binary cannot be launched,
   * the process is killed by a signal) still throw.
   */
  allowNonZeroExit?: boolean;
  /**
   * Optional cancellation signal. When the signal aborts, the spawned
   * child process is killed and the run promise rejects. The default
   * implementation forwards the signal to {@link spawn} so the child is
   * terminated promptly. Aborted runs surface as a {@link DockerSandboxError}
   * just like any other spawn-time failure; callers that intentionally
   * abort the run should swallow that error.
   */
  signal?: AbortSignal;
  /**
   * Maximum character length of a single stdout line (data accumulated
   * between newlines) when {@link DockerCommandRunOptions.onStdoutLine}
   * is provided. When the internal line buffer exceeds this limit after
   * newline processing, the child process is killed and the run rejects
   * with a {@link DockerSandboxError}.
   *
   * Only meaningful when `onStdoutLine` is set. Defaults to no limit.
   */
  maxLineLength?: number;
};

/**
 * A pluggable host-side command runner. The default implementation is
 * backed by {@link spawn}; tests replace it with a stub so the Docker
 * lifecycle can be exercised without a real Docker daemon.
 */
export type DockerCommandRunner = {
  /**
   * Runs `command` with the supplied argv array. Arguments are passed as
   * an array (never via a shell) so callers do not need to escape user
   * input.
   *
   * @param command - Executable to launch (typically `docker`).
   * @param args - Argv array; entries are forwarded verbatim.
   * @param options - Optional stdin/cwd/env/stdout-line behaviour.
   * @returns A {@link DockerCommandResult} for successful runs.
   * @throws {DockerSandboxError} When the process cannot be spawned or
   * exits with a non-zero code (unless `allowNonZeroExit` is set).
   */
  run(
    command: string,
    args: readonly string[],
    options?: DockerCommandRunOptions,
  ): Promise<DockerCommandResult>;
};

const STDERR_CAP = 65536;

/**
 * Default implementation of {@link DockerCommandRunner} backed by
 * {@link spawn}.
 *
 * Behaviour:
 * - Captures the full stdout and stderr buffers in memory.
 * - Invokes the optional stdout line callback as data arrives.
 * - Writes the optional stdin payload exactly once and closes the input.
 * - Throws a {@link DockerSandboxError} carrying the command, argv, and a
 *   bounded stderr excerpt when spawn fails or the process exits with a
 *   non-zero status (unless `allowNonZeroExit` is set).
 *
 * @returns A {@link DockerCommandRunner} instance.
 */
export function createDefaultDockerCommandRunner(): DockerCommandRunner {
  /**
   * Runs `command` via {@link spawn} and aggregates output.
   *
   * @param command - Executable to launch.
   * @param args - Argv array forwarded verbatim.
   * @param options - Optional run behaviour overrides.
   * @returns The captured {@link DockerCommandResult}.
   */
  const run = async (
    command: string,
    args: readonly string[],
    options?: DockerCommandRunOptions,
  ): Promise<DockerCommandResult> => runWithSpawn(command, args, options);
  return { run };
}

/**
 * Runs a command using {@link spawn} and aggregates output.
 *
 * @param command - Executable to launch.
 * @param args - Argv array.
 * @param options - Run options.
 * @returns The aggregated {@link DockerCommandResult}.
 */
async function runWithSpawn(
  command: string,
  args: readonly string[],
  options: DockerCommandRunOptions | undefined,
): Promise<DockerCommandResult> {
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (options?.cwd !== undefined) {
    spawnOptions.cwd = options.cwd;
  }
  if (options?.env !== undefined) {
    spawnOptions.env = sanitizeEnv(options.env);
  }
  if (options?.signal !== undefined) {
    spawnOptions.signal = options.signal;
  }

  const argsArray = [...args];

  return await new Promise<DockerCommandResult>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(command, argsArray, spawnOptions) as ChildProcessByStdio<
        Writable,
        Readable,
        Readable
      >;
    } catch (cause) {
      reject(buildSpawnError(command, argsArray, cause));
      return;
    }

    let stdout = '';
    let stderrChunks: string[] = [];
    let stderrByteLength = 0;
    let stderrTruncated = false;
    let stdoutBuffer = '';
    let settled = false;
    const isStreamingStdout = options?.onStdoutLine !== undefined;
    const maxLineLength = options?.maxLineLength;

    /**
     * Resolves or rejects exactly once.
     *
     * @param resolution - Callback that performs settlement.
     */
    const settle = (resolution: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolution();
    };

    /**
     * Appends a stderr chunk to the rolling buffer, evicting the oldest
     * data when the total exceeds the cap.
     *
     * @param chunk - A UTF-8 string chunk received from the child stderr stream.
     */
    const appendStderr = (chunk: string): void => {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (chunkBytes > STDERR_CAP) {
        const raw = Buffer.from(chunk, 'utf8');
        const tail = raw.subarray(-STDERR_CAP).toString('utf8');
        stderrChunks = [tail];
        stderrByteLength = Buffer.byteLength(tail, 'utf8');
        stderrTruncated = true;
        return;
      }

      stderrChunks.push(chunk);
      stderrByteLength += chunkBytes;

      while (stderrByteLength > STDERR_CAP && stderrChunks.length > 0) {
        const excess = stderrByteLength - STDERR_CAP;
        const first = stderrChunks[0] as string;
        const firstBytes = Buffer.byteLength(first, 'utf8');

        if (firstBytes <= excess) {
          stderrChunks.shift();
          stderrByteLength -= firstBytes;
          stderrTruncated = true;
        } else {
          const raw = Buffer.from(first, 'utf8');
          const kept = raw.subarray(excess).toString('utf8');
          stderrChunks[0] = kept;
          stderrByteLength -= firstBytes - Buffer.byteLength(kept, 'utf8');
          stderrTruncated = true;
          break;
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      if (settled) {
        return;
      }
      if (!isStreamingStdout) {
        stdout += chunk;
      }
      if (options?.onStdoutLine) {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          options.onStdoutLine(line);
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
        if (
          maxLineLength !== undefined &&
          stdoutBuffer.length > maxLineLength
        ) {
          child.kill();
          settle(() => {
            reject(
              new DockerSandboxError(
                `Stdout line from \`${formatArgv(command, argsArray)}\` exceeded the ` +
                  `${maxLineLength} character limit without a newline; the child ` +
                  `process was killed to prevent unbounded memory growth.`,
              ),
            );
          });
        }
      }
    });

    child.stderr.on('data', (chunk: string) => {
      appendStderr(chunk);
    });

    child.on('error', (cause: Error) => {
      settle(() => {
        reject(buildSpawnError(command, argsArray, cause));
      });
    });

    child.on('close', (code, signal) => {
      // Flush any trailing stdout fragment without a newline.
      if (options?.onStdoutLine && stdoutBuffer.length > 0) {
        const trailing = stdoutBuffer;
        stdoutBuffer = '';
        options.onStdoutLine(trailing);
      }

      let stderr = stderrChunks.join('');
      if (stderrTruncated) {
        stderr = `[stderr truncated — showing last ~64KB]\n${stderr}`;
      }

      if (signal !== null || code === null) {
        // The signal branch covers both `signal !== null` and the rare
        // case where `code` is null without a signal (process was
        // terminated abnormally). Treat both as signal-like failures.
        settle(() => {
          reject(
            buildExitError(command, argsArray, {
              stdout,
              stderr,
              signal: signal ?? 'SIGKILL',
            }),
          );
        });
        return;
      }

      const exitCode = code;
      const result: DockerCommandResult = { stdout, stderr, exitCode };

      if (exitCode !== 0 && !options?.allowNonZeroExit) {
        settle(() => {
          reject(
            buildExitError(command, argsArray, { stdout, stderr, exitCode }),
          );
        });
        return;
      }

      settle(() => {
        resolve(result);
      });
    });

    if (options?.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.stdin);
    }
  });
}

/**
 * Removes `undefined` values from an env object so {@link spawn} does not
 * reject the input.
 *
 * @param env - Source env map possibly containing `undefined` values.
 * @returns A new env map with only string values retained.
 */
function sanitizeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Builds a {@link DockerSandboxError} for a spawn-time failure.
 *
 * @param command - Executable that failed to launch.
 * @param args - Argv array.
 * @param cause - Underlying error from spawn.
 * @returns The constructed error.
 */
function buildSpawnError(
  command: string,
  args: string[],
  cause: unknown,
): DockerSandboxError {
  // `child_process.spawn` only ever reports failures via Error
  // instances (both for the synchronous throw and the `error` event),
  // so the Error-instance branch is the only realistic path.
  const reason = cause instanceof Error ? cause.message : String(cause);
  const options =
    cause instanceof Error ? ({ cause } as ErrorOptions) : undefined;
  return new DockerSandboxError(
    `Failed to spawn host command \`${formatArgv(command, args)}\`: ${reason}`,
    options,
  );
}

/**
 * Builds a {@link DockerSandboxError} for a non-zero exit or signal.
 *
 * @param command - Executable that exited unsuccessfully.
 * @param args - Argv array.
 * @param details - Captured output and exit metadata.
 * @returns The constructed error.
 */
function buildExitError(
  command: string,
  args: string[],
  details:
    | {
        /** Captured standard output. */
        stdout: string;
        /** Captured standard error. */
        stderr: string;
        /** Exit code reported by the child process. */
        exitCode: number;
      }
    | {
        /** Captured standard output. */
        stdout: string;
        /** Captured standard error. */
        stderr: string;
        /** Signal that terminated the child process. */
        signal: NodeJS.Signals;
      },
): DockerSandboxError {
  const formatted = formatArgv(command, args);
  const reason =
    'signal' in details
      ? `terminated by signal ${details.signal}`
      : `exited with code ${details.exitCode}`;
  const excerpt = formatStderrExcerpt(details.stderr);
  return new DockerSandboxError(
    `Host command \`${formatted}\` ${reason}.${excerpt}`,
  );
}

/**
 * Returns the formatted argv for inclusion in error messages. Redacts
 * the values of `-e` flags and the paths following `--env-file` so
 * that secrets forwarded to Docker containers do not leak into error
 * messages, logs, or telemetry.
 *
 * @param command - Executable name.
 * @param args - Argv array.
 * @returns A space-joined display string with env values redacted.
 */
function formatArgv(command: string, args: string[]): string {
  const redacted: string[] = [command];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-e' && i + 1 < args.length) {
      const envArg = args[i + 1] as string;
      const eqIndex = envArg.indexOf('=');
      redacted.push(
        arg,
        eqIndex === -1 ? envArg : `${envArg.slice(0, eqIndex)}=***`,
      );
      i += 1;
    } else if (arg === '--env-file' && i + 1 < args.length) {
      redacted.push(arg, '***');
      i += 1;
    } else {
      redacted.push(arg);
    }
  }
  return redacted.join(' ');
}
