import path from 'node:path';

import { SandboxConfigurationError } from '../../errors.js';
import type {
  DockerSandboxBridgeConfig,
  DockerSandboxCleanupPolicy,
  DockerSandboxConfig,
  DockerSandboxMount,
  DockerSandboxWorkspace,
} from '../types.js';
import {
  DEFAULT_DOCKER_SANDBOX_FORWARD_ENV,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH,
} from '../types.js';

/**
 * Default container cleanup policy applied when the caller does not
 * provide one in {@link DockerSandboxConfig.cleanup}.
 */
export const DEFAULT_DOCKER_SANDBOX_CLEANUP: DockerSandboxCleanupPolicy =
  'always';

/**
 * Default executable used to run Node.js inside the sandbox container when
 * {@link DockerSandboxBridgeConfig.nodeCommand} is not provided.
 */
export const DEFAULT_DOCKER_SANDBOX_BRIDGE_NODE_COMMAND = 'node';

/**
 * Default executable used to invoke npm inside the sandbox container when
 * {@link DockerSandboxBridgeConfig.npmCommand} is not provided.
 */
export const DEFAULT_DOCKER_SANDBOX_BRIDGE_NPM_COMMAND = 'npm';

/**
 * Default value applied to {@link DockerSandboxBridgeConfig.install} when
 * the caller does not provide one. The bridge runtime is installed by
 * default so that pristine images can host the SDK.
 */
export const DEFAULT_DOCKER_SANDBOX_BRIDGE_INSTALL = true;

/**
 * Patterns in `unsafeDockerArgs` that defeat container isolation. Each
 * entry is a regex tested against individual argv entries. When a match
 * is found during normalization, a `console.warn` is emitted so the
 * caller is aware that isolation guarantees no longer hold.
 */
const DANGEROUS_DOCKER_ARG_PATTERNS: readonly {
  /** Regex tested against individual argv entries. */
  pattern: RegExp;
  /**
   * When provided, the pattern only matches if the next argument
   * also satisfies this regex. Used for split `--flag value` forms.
   */
  checkNext?: RegExp;
  /** Human-readable explanation of why this flag is dangerous. */
  reason: string;
}[] = [
  {
    pattern: /^--privileged$/u,
    reason:
      'grants nearly all host capabilities and defeats container isolation',
  },
  {
    pattern: /^--cap-add$/u,
    checkNext: /.*/u,
    reason: 're-adds Linux capabilities dropped by the container runtime',
  },
  {
    pattern: /^--pid$/u,
    checkNext: /^host$/u,
    reason: 'shares the host PID namespace, exposing all host processes',
  },
  {
    pattern: /^--network$/u,
    checkNext: /^host$/u,
    reason:
      'shares the host network stack, bypassing network isolation entirely',
  },
  {
    pattern: /^--ipc$/u,
    checkNext: /^host$/u,
    reason: 'shares the host IPC namespace',
  },
  {
    pattern: /\/var\/run\/docker\.sock/u,
    reason:
      'exposes the Docker daemon socket, enabling full host control from inside the container',
  },
  {
    pattern: /^--security-opt$/u,
    reason:
      'may disable AppArmor or seccomp profiles that enforce mandatory access control',
  },
  {
    pattern: /^--device$/u,
    checkNext: /.*/u,
    reason: 'grants the container direct access to a host device',
  },
];

/**
 * A fully resolved bind mount destined for the sandbox container. All
 * fields are explicit; later lifecycle code can pass them verbatim to the
 * container runtime.
 */
export type NormalizedDockerSandboxMount = {
  /** Absolute host path, resolved against the supplied `hostCwd`. */
  hostPath: string;
  /** Absolute POSIX path inside the container. */
  containerPath: string;
  /** Whether the mount is read-only. */
  readOnly: boolean;
};

/**
 * A fully resolved workspace mount. Shape matches
 * {@link NormalizedDockerSandboxMount} so it can be treated like any
 * other mount when constructing container runtime arguments.
 */
export type NormalizedDockerSandboxWorkspace = NormalizedDockerSandboxMount;

/**
 * Bridge runtime configuration with all defaults filled in.
 */
export type NormalizedDockerSandboxBridgeConfig = {
  /** Whether the bridge runtime should be installed before each run. */
  install: boolean;
  /** Path or command used to execute Node.js inside the container. */
  nodeCommand: string;
  /** Path or command used to execute npm inside the container. */
  npmCommand: string;
  /** Version of `@anthropic-ai/claude-agent-sdk` to install, if pinned. */
  sdkVersion?: string;
};

/**
 * Fully normalized Docker sandbox configuration produced by
 * {@link normalizeDockerSandboxConfig}.
 *
 * The shape is what later lifecycle code consumes: every field is either
 * explicitly defaulted or carries a clearly documented optionality.
 * Unsafe escape hatches are kept under explicit names so consumers can
 * audit risk.
 */
export type NormalizedDockerSandboxConfig = {
  /** Resolved container image (after applying defaults). */
  image: string;
  /**
   * Resolved workspace mount, or `false` when the caller explicitly opted
   * out via {@link DockerSandboxConfig.workspace} set to `false`.
   */
  workspace: NormalizedDockerSandboxWorkspace | false;
  /**
   * Working directory inside the container for the agent process. Used
   * when the workspace is disabled and the caller still wants to pin
   * `options.cwd` mapping to a fixed container path.
   */
  workdir?: string;
  /** Additional bind mounts, with absolute host and container paths. */
  mounts: NormalizedDockerSandboxMount[];
  /**
   * Resolved environment to set inside the container. Keys with
   * `undefined` values have been pruned.
   */
  env: Record<string, string>;
  /**
   * Names of host env variables that should be forwarded into the
   * container. Kept on the normalized config so later code can decide
   * whether to re-read forwarded values at execution time, and `false`
   * is preserved as an explicit opt-out signal.
   */
  forwardEnv: readonly string[] | false;
  /** Container network mode (e.g. `host`, `none`). */
  network?: string;
  /** Container user override. */
  user?: string | 'current' | false;
  /** Size of `/dev/shm` (e.g. `512m`, `2g`). */
  shmSize?: string;
  /** Memory limit forwarded as `--memory` (e.g. `'4g'`). */
  memory?: string;
  /**
   * Raw runtime arguments forwarded verbatim. Named `unsafeDockerArgs`
   * because entries bypass other safety checks.
   */
  unsafeDockerArgs: string[];
  /** Shell commands executed inside the container before the agent. */
  setupCommands: string[];
  /**
   * Absolute host path to a Docker-compatible env file. Passed to the
   * container runtime via `--env-file`.
   */
  envFile?: string;
  /** Cleanup policy with defaults applied. */
  cleanup: DockerSandboxCleanupPolicy;
  /** Bridge runtime configuration with defaults applied. */
  bridge: NormalizedDockerSandboxBridgeConfig;
};

/**
 * Context required by {@link normalizeDockerSandboxConfig}.
 *
 * `hostCwd` is treated as authoritative for resolving any relative
 * paths supplied by the caller — it is normally the host runner's
 * `process.cwd()`. `env` may be supplied to override the host
 * environment (defaults to `process.env`) when forwarding variables.
 */
export type NormalizeDockerSandboxConfigContext = {
  /** Absolute path used to resolve relative host paths. */
  hostCwd: string;
  /** Source of host environment variables for forwarding. */
  env?: Record<string, string | undefined>;
};

/**
 * Normalizes a {@link DockerSandboxConfig} into a fully resolved shape
 * that later Docker lifecycle code can consume without re-applying
 * defaults.
 *
 * Behaviour:
 * - Fills the container image from {@link DEFAULT_DOCKER_SANDBOX_IMAGE}.
 * - Resolves `workspace.hostPath` against `context.hostCwd`, falling
 *   back to `context.hostCwd` when not provided.
 * - Defaults `workspace.containerPath` to
 *   {@link DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH}.
 * - Preserves `workspace === false` as an explicit opt-out; later cwd
 *   mapping in {@link prepareDockerSandboxRequest} will demand
 *   `sandbox.workdir` to be present when the caller still tries to set
 *   `options.cwd`.
 * - Validates that all mount host paths can be resolved absolute, that
 *   container paths are absolute POSIX paths, and that container paths
 *   do not collide with each other or with the workspace mount.
 * - Forwards environment variables listed by
 *   {@link DEFAULT_DOCKER_SANDBOX_FORWARD_ENV} (or the caller's override)
 *   from `context.env`/`process.env`. Explicit `config.env` entries win;
 *   `undefined` values remove a variable.
 * - Carries `shmSize` as a normalized field and preserves
 *   `unsafeDockerArgs` as a flat list under that explicit unsafe name.
 *
 * Inputs are never mutated.
 *
 * @param config - Docker sandbox config provided by the caller.
 * @param context - Resolution context (host cwd, env source).
 * @returns A fully resolved {@link NormalizedDockerSandboxConfig}.
 * @throws {SandboxConfigurationError} When validation fails (unknown
 * type, non-absolute paths, duplicate container paths).
 */
export function normalizeDockerSandboxConfig(
  config: DockerSandboxConfig,
  context: NormalizeDockerSandboxConfigContext,
): NormalizedDockerSandboxConfig {
  if (config.type !== 'docker') {
    const unknownType = (
      config as {
        /**
         *
         */
        type: unknown;
      }
    ).type;
    throw new SandboxConfigurationError(
      `Unsupported sandbox type: ${String(unknownType)}`,
    );
  }

  if (!path.isAbsolute(context.hostCwd)) {
    throw new SandboxConfigurationError(
      `Docker sandbox host cwd must be absolute, received: ${context.hostCwd}`,
    );
  }

  const envSource = context.env ?? process.env;

  const workspace = normalizeWorkspace(config.workspace, context.hostCwd);
  const mounts = normalizeMounts(config.mounts, context.hostCwd, workspace);
  const env = normalizeEnv(config.env, config.forwardEnv, envSource);
  const bridge = normalizeBridge(config.bridge);

  const unsafeDockerArgs = [...(config.unsafeDockerArgs ?? [])];
  warnOnDangerousDockerArgs(unsafeDockerArgs);
  warnOnDangerousTypedConfig(config);

  const normalized: NormalizedDockerSandboxConfig = {
    image: config.image ?? DEFAULT_DOCKER_SANDBOX_IMAGE,
    workspace,
    mounts,
    env,
    forwardEnv: normalizeForwardEnv(config.forwardEnv),
    unsafeDockerArgs,
    setupCommands: [...(config.setupCommands ?? [])],
    cleanup: config.cleanup ?? DEFAULT_DOCKER_SANDBOX_CLEANUP,
    bridge,
  };

  if (config.workdir !== undefined) {
    normalized.workdir = config.workdir;
  }
  if (config.network !== undefined) {
    normalized.network = config.network;
  }
  if (config.user !== undefined) {
    normalized.user = config.user;
  }
  if (config.shmSize !== undefined) {
    normalized.shmSize = config.shmSize;
  }
  if (config.memory !== undefined) {
    normalized.memory = config.memory;
  }
  if (config.envFile !== undefined) {
    normalized.envFile = config.envFile;
  }

  return normalized;
}

/**
 * Normalizes the workspace input into a fully resolved mount or
 * preserves the explicit `false` opt-out.
 *
 * @param workspace - Caller-provided workspace value.
 * @param hostCwd - Absolute host cwd used to resolve relative paths.
 * @returns The normalized workspace.
 */
function normalizeWorkspace(
  workspace: DockerSandboxConfig['workspace'],
  hostCwd: string,
): NormalizedDockerSandboxWorkspace | false {
  if (workspace === false) {
    return false;
  }

  const ws: DockerSandboxWorkspace = workspace ?? {};
  const hostPath = resolveAbsoluteHostPath(ws.hostPath ?? hostCwd, hostCwd);
  const containerPath =
    ws.containerPath ?? DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH;

  const normalizedContainerPath = assertContainerPath(
    containerPath,
    'workspace.containerPath',
  );

  return {
    hostPath,
    containerPath: normalizedContainerPath,
    readOnly: ws.readOnly ?? false,
  };
}

/**
 * Normalizes additional mounts and ensures no container path collides
 * with the workspace mount or another entry.
 *
 * @param mounts - Caller-provided mounts.
 * @param hostCwd - Absolute host cwd for resolving relative host paths.
 * @param workspace - Already normalized workspace.
 * @returns The normalized mount list.
 */
function normalizeMounts(
  mounts: DockerSandboxMount[] | undefined,
  hostCwd: string,
  workspace: NormalizedDockerSandboxWorkspace | false,
): NormalizedDockerSandboxMount[] {
  if (mounts === undefined) {
    return [];
  }

  const seenContainerPaths: string[] = [];
  if (workspace !== false) {
    seenContainerPaths.push(workspace.containerPath);
  }

  return mounts.map((mount, index) => {
    const hostPath = resolveAbsoluteHostPath(
      mount.hostPath,
      hostCwd,
      `mounts[${index}].hostPath`,
    );
    const containerPath = assertContainerPath(
      mount.containerPath,
      `mounts[${index}].containerPath`,
    );

    for (const seen of seenContainerPaths) {
      if (containerPathsOverlap(seen, containerPath)) {
        if (seen === containerPath) {
          throw new SandboxConfigurationError(
            `Duplicate Docker sandbox container path: ${containerPath}`,
          );
        }
        throw new SandboxConfigurationError(
          `Overlapping Docker sandbox container paths: ${seen} and ${containerPath}`,
        );
      }
    }

    seenContainerPaths.push(containerPath);

    return {
      hostPath,
      containerPath,
      readOnly: mount.readOnly ?? false,
    };
  });
}

/**
 * Builds the resolved env map by forwarding selected host env values
 * and then applying explicit `config.env` overrides.
 *
 * @param explicitEnv - The caller's `config.env`.
 * @param forwardEnv - The caller's `forwardEnv` (or `false`).
 * @param envSource - Source of host env values.
 * @returns The merged env map.
 */
function normalizeEnv(
  explicitEnv: DockerSandboxConfig['env'],
  forwardEnv: DockerSandboxConfig['forwardEnv'],
  envSource: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (forwardEnv !== false) {
    const forwardList = forwardEnv ?? DEFAULT_DOCKER_SANDBOX_FORWARD_ENV;
    for (const name of forwardList) {
      const value = envSource[name];
      if (typeof value === 'string') {
        env[name] = value;
      }
    }
  }

  if (explicitEnv) {
    for (const [key, value] of Object.entries(explicitEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Returns a defensive copy of the `forwardEnv` setting, preserving the
 * explicit `false` opt-out.
 *
 * @param forwardEnv - Caller-provided forwardEnv value.
 * @returns The normalized value.
 */
function normalizeForwardEnv(
  forwardEnv: DockerSandboxConfig['forwardEnv'],
): readonly string[] | false {
  if (forwardEnv === false) {
    return false;
  }
  if (forwardEnv === undefined) {
    return [...DEFAULT_DOCKER_SANDBOX_FORWARD_ENV];
  }
  return [...forwardEnv];
}

/**
 * Normalizes the bridge config, filling defaults for install flag,
 * node command, and npm command.
 *
 * @param bridge - Caller-provided bridge config, possibly absent.
 * @returns The normalized bridge config.
 */
function normalizeBridge(
  bridge: DockerSandboxBridgeConfig | undefined,
): NormalizedDockerSandboxBridgeConfig {
  const normalized: NormalizedDockerSandboxBridgeConfig = {
    install: bridge?.install ?? DEFAULT_DOCKER_SANDBOX_BRIDGE_INSTALL,
    nodeCommand:
      bridge?.nodeCommand ?? DEFAULT_DOCKER_SANDBOX_BRIDGE_NODE_COMMAND,
    npmCommand: bridge?.npmCommand ?? DEFAULT_DOCKER_SANDBOX_BRIDGE_NPM_COMMAND,
  };
  if (bridge?.sdkVersion !== undefined) {
    normalized.sdkVersion = bridge.sdkVersion;
  }
  return normalized;
}

/**
 * Resolves a host path to an absolute path. Relative paths are
 * resolved against `hostCwd`.
 *
 * @param candidate - Path supplied by the caller.
 * @param hostCwd - Absolute host cwd.
 * @param context - Optional context string used in error messages.
 * @returns The absolute host path.
 */
function resolveAbsoluteHostPath(
  candidate: string,
  hostCwd: string,
  context = 'host path',
): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} must be a non-empty string.`,
    );
  }
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(hostCwd, candidate);
}

/**
 * Validates that a path looks like an absolute POSIX container path.
 * Normalizes the path and rejects paths that escape the root via `..`.
 *
 * @param candidate - Path supplied by the caller.
 * @param context - Context string used in the error message.
 * @returns The normalized container path.
 */
function assertContainerPath(candidate: string, context: string): string {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    !candidate.startsWith('/')
  ) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} must be an absolute POSIX path, received: ${String(candidate)}`,
    );
  }

  if (candidate.split('/').includes('..')) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} must not contain parent directory references (".."): ${candidate}`,
    );
  }

  let normalized = path.posix.normalize(candidate);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Determines whether two normalized POSIX container paths overlap.
 * Overlap includes exact duplicates, ancestor relationships, and
 * descendant relationships.
 *
 * @param a - A normalized container path.
 * @param b - Another normalized container path.
 * @returns `true` if the paths overlap.
 */
function containerPathsOverlap(a: string, b: string): boolean {
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/**
 * Splits `--flag=value` forms into `['--flag', 'value']` so that downstream
 * pattern matching works regardless of how the argument was written.
 *
 * @param args - Raw docker argument strings.
 * @returns A flattened list where each `--flag=value` has been expanded.
 */
function normalizeDockerArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const equalIndex = arg.indexOf('=');
      result.push(arg.slice(0, equalIndex));
      result.push(arg.slice(equalIndex + 1));
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Emits a `console.warn` for each `unsafeDockerArgs` entry that matches
 * a known isolation-defeating pattern. Does not throw — the caller
 * explicitly opted in via the `unsafe` field — but makes the risk
 * visible at runtime.
 *
 * Handles both `--flag=value` and split `--flag value` forms.
 *
 * @param args - The resolved unsafe Docker args array.
 */
function warnOnDangerousDockerArgs(args: readonly string[]): void {
  const normalized = normalizeDockerArgs(args);

  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i] as string;
    for (const {
      pattern,
      checkNext,
      reason,
    } of DANGEROUS_DOCKER_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        if (checkNext !== undefined) {
          const nextArg = normalized[i + 1];
          if (nextArg === undefined || !checkNext.test(nextArg)) {
            continue;
          }
        }
        const value = checkNext === undefined ? undefined : normalized[i + 1];
        console.warn(
          `[agent-runner] unsafeDockerArgs contains \`${arg}\`${value === undefined ? '' : ` \`${value}\``}: ${reason}. ` +
            'Sandbox isolation guarantees no longer hold.',
        );
        break;
      }
    }
  }
}

/**
 * Emits a `console.warn` for typed {@link DockerSandboxConfig} fields that
 * are known to weaken container isolation.
 *
 * @param config - The raw sandbox config before defaults are applied.
 */
function warnOnDangerousTypedConfig(config: DockerSandboxConfig): void {
  if (config.network === 'host') {
    console.warn(
      '[agent-runner] Docker sandbox config sets `network: "host"`, which shares the host network stack and bypasses network isolation entirely. Sandbox isolation guarantees no longer hold.',
    );
  }

  if (config.user === 'root' || config.user === '0') {
    console.warn(
      '[agent-runner] Docker sandbox config sets `user: "root"` (or `"0"`), which runs the container as root and increases the attack surface. Sandbox isolation guarantees no longer hold.',
    );
  }
}

export {
  prepareDockerSandboxRequest,
  type PrepareDockerSandboxRequestInput,
  type PreparedDockerSandboxRequest,
} from './request.js';
