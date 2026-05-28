import { SandboxConfigurationError } from '../errors.js';
import type {
  DockerSandboxBridgeConfig,
  DockerSandboxConfig,
  DockerSandboxWorkspace,
  SandboxConfig,
} from './types.js';

/**
 * Resolves the sandbox configuration for a single run by merging the
 * runner-level default with the per-run override.
 *
 * The runner currently only supports Docker sandboxes. Any
 * config declaring a `type` other than `'docker'` will throw
 * {@link SandboxConfigurationError}.
 *
 * Semantics:
 * - If neither config is provided, returns `undefined`.
 * - If the run config is `false`, the sandbox is disabled and `undefined`
 *   is returned even when a default is present.
 * - If only one side is provided, a shallow clone of that side is returned
 *   so callers can safely mutate the result.
 * - Scalar fields on the run config replace those on the default.
 * - {@link DockerSandboxConfig.env} merges per-key. A `undefined` value in
 *   the run env deletes the key from the merged result so callers can
 *   mask runner-level defaults.
 * - Array-valued fields (`mounts`, `unsafeDockerArgs`, `setupCommands`)
 *   follow a replace-on-provide policy: when the run config provides the
 *   array, it replaces the default entirely.
 * - {@link DockerSandboxConfig.workspace} is `false` when the run sets it
 *   to `false`, otherwise the two objects are shallow merged; the default
 *   is preserved when the run omits it.
 * - {@link DockerSandboxConfig.bridge} is shallow merged.
 *
 * @param defaultSandbox - Sandbox config attached to the runner.
 * @param runSandbox - Sandbox config provided for this specific run.
 * @returns The merged sandbox configuration, or `undefined` when disabled
 * or no configuration is provided.
 * @throws {SandboxConfigurationError} When either input declares an
 * unsupported sandbox `type`.
 */
export function resolveSandboxConfig(
  defaultSandbox?: SandboxConfig | false,
  runSandbox?: SandboxConfig | false,
): SandboxConfig | undefined {
  if (runSandbox === false) {
    return undefined;
  }

  if (defaultSandbox === false && runSandbox === undefined) {
    return undefined;
  }

  const base = defaultSandbox === false ? undefined : defaultSandbox;

  if (!base && !runSandbox) {
    return undefined;
  }

  if (base) {
    assertSupportedType(base);
  }
  if (runSandbox) {
    assertSupportedType(runSandbox);
  }

  if (!base && runSandbox) {
    return cloneDockerSandbox(runSandbox);
  }

  if (base && !runSandbox) {
    return cloneDockerSandbox(base);
  }

  // Both sides defined and non-`false`.
  return mergeDockerSandbox(
    base as DockerSandboxConfig,
    runSandbox as DockerSandboxConfig,
  );
}

/**
 * Validates that the provided sandbox config has a supported `type`.
 *
 * @param config - The sandbox config to validate.
 * @throws {SandboxConfigurationError} When the type is not `docker`.
 */
function assertSupportedType(config: SandboxConfig): void {
  if (config.type !== 'docker') {
    const unknownType = (config as UnknownTypedConfig).type;
    throw new SandboxConfigurationError(
      `Unsupported sandbox type: ${String(unknownType)}`,
    );
  }
}

/**
 * Helper shape used to safely access the `type` field of an unvalidated
 * sandbox config when reporting an error.
 */
type UnknownTypedConfig = {
  /** Untyped sandbox discriminant for use in error messages. */
  type: unknown;
};

/**
 * Produces a shallow clone of a Docker sandbox config so callers do not
 * accidentally mutate inputs to {@link resolveSandboxConfig}.
 *
 * @param config - The Docker sandbox config to clone.
 * @returns A new Docker sandbox config carrying the same field values.
 */
function cloneDockerSandbox(config: DockerSandboxConfig): DockerSandboxConfig {
  const clone: DockerSandboxConfig = { type: 'docker' };

  if (config.image !== undefined) {
    clone.image = config.image;
  }
  if (config.workspace !== undefined) {
    clone.workspace =
      config.workspace === false ? false : { ...config.workspace };
  }
  if (config.workdir !== undefined) {
    clone.workdir = config.workdir;
  }
  if (config.mounts !== undefined) {
    clone.mounts = [...config.mounts];
  }
  if (config.env !== undefined) {
    clone.env = { ...config.env };
  }
  if (config.forwardEnv !== undefined) {
    clone.forwardEnv =
      config.forwardEnv === false ? false : [...config.forwardEnv];
  }
  if (config.network !== undefined) {
    clone.network = config.network;
  }
  if (config.user !== undefined) {
    clone.user = config.user;
  }
  if (config.shmSize !== undefined) {
    clone.shmSize = config.shmSize;
  }
  if (config.unsafeDockerArgs !== undefined) {
    clone.unsafeDockerArgs = [...config.unsafeDockerArgs];
  }
  if (config.setupCommands !== undefined) {
    clone.setupCommands = [...config.setupCommands];
  }
  if (config.memory !== undefined) {
    clone.memory = config.memory;
  }
  if (config.envFile !== undefined) {
    clone.envFile = config.envFile;
  }
  if (config.cleanup !== undefined) {
    clone.cleanup = config.cleanup;
  }
  if (config.bridge !== undefined) {
    clone.bridge = { ...config.bridge };
  }

  return clone;
}

/**
 * Merges two Docker sandbox configs following the rules documented on
 * {@link resolveSandboxConfig}.
 *
 * @param base - Runner-level default sandbox config.
 * @param override - Per-run sandbox config providing overrides.
 * @returns A freshly allocated merged Docker sandbox config.
 */
function mergeDockerSandbox(
  base: DockerSandboxConfig,
  override: DockerSandboxConfig,
): DockerSandboxConfig {
  const merged: DockerSandboxConfig = { type: 'docker' };

  const image = override.image ?? base.image;
  if (image !== undefined) {
    merged.image = image;
  }

  const workspace = mergeWorkspace(base.workspace, override.workspace);
  if (workspace !== undefined) {
    merged.workspace = workspace;
  }

  const workdir = override.workdir ?? base.workdir;
  if (workdir !== undefined) {
    merged.workdir = workdir;
  }

  const mounts = pickArray(base.mounts, override.mounts);
  if (mounts !== undefined) {
    merged.mounts = mounts;
  }

  const env = mergeEnv(base.env, override.env);
  if (env !== undefined) {
    merged.env = env;
  }

  const forwardEnv = mergeForwardEnv(base.forwardEnv, override.forwardEnv);
  if (forwardEnv !== undefined) {
    merged.forwardEnv = forwardEnv;
  }

  const network = override.network ?? base.network;
  if (network !== undefined) {
    merged.network = network;
  }

  const user = override.user ?? base.user;
  if (user !== undefined) {
    merged.user = user;
  }

  const shmSize = override.shmSize ?? base.shmSize;
  if (shmSize !== undefined) {
    merged.shmSize = shmSize;
  }

  const unsafeDockerArgs = pickArray(
    base.unsafeDockerArgs,
    override.unsafeDockerArgs,
  );
  if (unsafeDockerArgs !== undefined) {
    merged.unsafeDockerArgs = unsafeDockerArgs;
  }

  const setupCommands = pickArray(base.setupCommands, override.setupCommands);
  if (setupCommands !== undefined) {
    merged.setupCommands = setupCommands;
  }

  const memory = override.memory ?? base.memory;
  if (memory !== undefined) {
    merged.memory = memory;
  }

  const envFile = override.envFile ?? base.envFile;
  if (envFile !== undefined) {
    merged.envFile = envFile;
  }

  const cleanup = override.cleanup ?? base.cleanup;
  if (cleanup !== undefined) {
    merged.cleanup = cleanup;
  }

  const bridge = mergeBridge(base.bridge, override.bridge);
  if (bridge !== undefined) {
    merged.bridge = bridge;
  }

  return merged;
}

/**
 * Merges two workspace configs following replace-on-`false` semantics.
 *
 * @param base - Workspace setting from the default config.
 * @param override - Workspace setting from the run config.
 * @returns The merged workspace configuration.
 */
function mergeWorkspace(
  base: DockerSandboxConfig['workspace'],
  override: DockerSandboxConfig['workspace'],
): DockerSandboxConfig['workspace'] {
  if (override === false) {
    return false;
  }
  if (override === undefined) {
    if (base === undefined) {
      return undefined;
    }
    return base === false ? false : { ...base };
  }
  if (base === undefined || base === false) {
    return { ...override } satisfies DockerSandboxWorkspace;
  }
  return { ...base, ...override } satisfies DockerSandboxWorkspace;
}

/**
 * Merges two env maps per-key, treating `undefined` values on the override
 * as deletions.
 *
 * @param base - Base env from the default config.
 * @param override - Override env from the run config.
 * @returns The merged env map, or `undefined` if both inputs were absent.
 */
function mergeEnv(
  base: DockerSandboxConfig['env'],
  override: DockerSandboxConfig['env'],
): DockerSandboxConfig['env'] {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  const merged: Record<string, string | undefined> = { ...(base ?? {}) };

  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

/**
 * Shallow-merges two bridge configs.
 *
 * @param base - Bridge config from the default sandbox config.
 * @param override - Bridge config from the run sandbox config.
 * @returns The merged bridge config, or `undefined` when both are absent.
 */
function mergeBridge(
  base: DockerSandboxBridgeConfig | undefined,
  override: DockerSandboxBridgeConfig | undefined,
): DockerSandboxBridgeConfig | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }
  return { ...(base ?? {}), ...(override ?? {}) };
}

/**
 * Selects between two array values using the replace-on-provide policy:
 * if the override array is defined it wins, otherwise the base is used.
 * In both cases the returned array is a shallow clone of the source.
 *
 * @param base - Base array value, possibly absent.
 * @param override - Override array value, possibly absent.
 * @returns A cloned array, or `undefined` when neither side provided one.
 */
function pickArray<Value>(
  base: readonly Value[] | undefined,
  override: readonly Value[] | undefined,
): Value[] | undefined {
  if (override !== undefined) {
    return [...override];
  }
  if (base !== undefined) {
    return [...base];
  }
  return undefined;
}

/**
 * Merges two `forwardEnv` settings honouring `false` as an explicit
 * disable signal.
 *
 * @param base - `forwardEnv` from the default sandbox config.
 * @param override - `forwardEnv` from the run sandbox config.
 * @returns The merged value, or `undefined` when neither side provided one.
 */
function mergeForwardEnv(
  base: DockerSandboxConfig['forwardEnv'],
  override: DockerSandboxConfig['forwardEnv'],
): DockerSandboxConfig['forwardEnv'] {
  if (override !== undefined) {
    return override === false ? false : [...override];
  }
  if (base !== undefined) {
    return base === false ? false : [...base];
  }
  return undefined;
}
