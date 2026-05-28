import path from 'node:path';

import { SandboxConfigurationError } from '../../errors.js';
import type {
  NormalizedDockerSandboxConfig,
  NormalizedDockerSandboxMount,
} from './options.js';
import { isPlainObject } from './utils.js';

/**
 * SDK option keys that the Docker sandbox MVP cannot safely forward into
 * the container because they carry callbacks, controllers, or other
 * non-serializable values whose host-side semantics cannot be reproduced
 * over the bridge protocol.
 */
const UNSUPPORTED_SDK_OPTION_KEYS = [
  'canUseTool',
  'hooks',
  'onElicitation',
  'stderr',
  'sessionStore',
  'abortController',
  'signal',
  'spawnClaudeCodeProcess',
] as const;

/**
 * Input accepted by {@link prepareDockerSandboxRequest}.
 */
export type PrepareDockerSandboxRequestInput = {
  /** The Claude SDK prompt. Must be a string for the sandbox MVP. */
  prompt: unknown;
  /** Caller-supplied SDK options. May be omitted. */
  options?: Record<string, unknown> | undefined;
  /** Normalized sandbox configuration produced by `normalizeDockerSandboxConfig`. */
  sandbox: NormalizedDockerSandboxConfig;
};

/**
 * Result of {@link prepareDockerSandboxRequest}: a fully JSON-serializable
 * payload that the host runner can hand off to the in-container bridge.
 */
export type PreparedDockerSandboxRequest = {
  /** Validated string prompt. */
  prompt: string;
  /**
   * Sanitized SDK options with host paths rewritten to container paths.
   * Always a freshly allocated plain object; never the caller's input.
   */
  options: Record<string, unknown>;
};

/**
 * Validates the provided prompt and SDK options, then produces a
 * JSON-safe payload with host paths rewritten to their in-container
 * equivalents.
 *
 * Path mapping rules:
 * - `options.cwd`: must be inside a mounted host path (workspace or any
 *   additional mount); the host path is rewritten to the corresponding
 *   container path. When the workspace is disabled and no additional
 *   mounts are configured, the caller must instead supply
 *   `sandbox.workdir` explicitly — any `options.cwd` value is rejected
 *   because it cannot be mapped.
 * - `options.additionalDirectories`: each entry must be inside a mounted
 *   host path; entries outside all mounts are rejected.
 * - `options.settings`: when a string, treated as a host path that must
 *   live inside a mounted host path; otherwise (object) it is passed
 *   through JSON sanitization unchanged.
 * - `options.plugins[i]`: entries with `type === 'local'` must point at
 *   a host path inside a mounted host path; other plugin types pass
 *   through JSON sanitization.
 *
 * Rejection rules:
 * - Non-string prompts (including async iterables) are rejected.
 * - SDK options listed in {@link UNSUPPORTED_SDK_OPTION_KEYS} are
 *   rejected when present with non-`undefined` values.
 * - Functions, symbols, bigint, streams, class instances, and circular
 *   references anywhere in `options` are rejected.
 * - `undefined` entries inside arrays are rejected; `undefined` values
 *   on object fields are stripped silently because plain serializers do
 *   the same.
 *
 * The caller's `options` object is never mutated.
 *
 * @param input - Prompt, options, and resolved sandbox configuration.
 * @returns A {@link PreparedDockerSandboxRequest} carrying the validated
 * prompt and sanitized options.
 * @throws {SandboxConfigurationError} When any of the rules above fail.
 */
export function prepareDockerSandboxRequest(
  input: PrepareDockerSandboxRequestInput,
): PreparedDockerSandboxRequest {
  const { prompt, options, sandbox } = input;

  if (typeof prompt !== 'string') {
    throw new SandboxConfigurationError(
      'Docker sandbox prompt must be a string; async iterable prompts are not supported in the sandbox MVP.',
    );
  }

  const sourceOptions: Record<string, unknown> = options ?? {};
  assertNoUnsupportedSdkOptions(sourceOptions);

  const sanitized = sanitizeJsonSafe(sourceOptions, 'options');
  if (!isPlainObject(sanitized)) {
    // Defensive: sanitizing a plain object always returns a plain object.
    throw new SandboxConfigurationError(
      'Docker sandbox options must serialize to a plain object.',
    );
  }

  rewriteOptionsPaths(sanitized, sandbox);

  return { prompt, options: sanitized };
}

/**
 * Throws when an SDK option key listed in {@link UNSUPPORTED_SDK_OPTION_KEYS}
 * is present with a non-`undefined` value.
 *
 * @param options - Caller-provided options record.
 */
function assertNoUnsupportedSdkOptions(options: Record<string, unknown>): void {
  for (const key of UNSUPPORTED_SDK_OPTION_KEYS) {
    if (key in options && options[key] !== undefined) {
      throw new SandboxConfigurationError(
        `Docker sandbox does not support Claude SDK option \`${key}\`; remove it before passing to a sandboxed run.`,
      );
    }
  }
}

/**
 * Deeply clones a value into a JSON-safe equivalent, rejecting any
 * construct that would not survive a JSON round trip.
 *
 * @param value - Value to sanitize.
 * @param pathDescription - Dotted path used to identify the value in
 * error messages.
 * @param seen - Set of objects currently on the traversal stack, used
 * for cycle detection.
 * @returns The sanitized value (may be `undefined` for object values
 * whose serialization is "absent"; callers handle stripping).
 */
function sanitizeJsonSafe(
  value: unknown,
  pathDescription: string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null) {
    return null;
  }

  const valueType = typeof value;

  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return value;
  }

  if (valueType === 'undefined') {
    return undefined;
  }

  if (valueType === 'function') {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a function, which cannot be forwarded into the container.`,
    );
  }

  if (valueType === 'symbol') {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a symbol, which cannot be serialized.`,
    );
  }

  if (valueType === 'bigint') {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a bigint, which cannot be JSON-serialized.`,
    );
  }

  // value is a non-null object from here on.
  const object = value as object;

  if (seen.has(object)) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a circular reference, which cannot be serialized.`,
    );
  }

  if (isStreamLike(object)) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a stream-like value, which cannot be forwarded into the container.`,
    );
  }

  if (Array.isArray(object)) {
    seen.add(object);
    try {
      const result: unknown[] = [];
      for (let index = 0; index < object.length; index += 1) {
        const entry = object[index];
        if (entry === undefined) {
          throw new SandboxConfigurationError(
            `Docker sandbox ${pathDescription}[${index}] is undefined; arrays may not contain undefined entries.`,
          );
        }
        result.push(
          sanitizeJsonSafe(entry, `${pathDescription}[${index}]`, seen),
        );
      }
      return result;
    } finally {
      seen.delete(object);
    }
  }

  if (!isPlainObject(object)) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${pathDescription} contains a non-plain object (likely a class instance), which cannot be forwarded into the container.`,
    );
  }

  seen.add(object);
  try {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      if (entry === undefined) {
        continue;
      }
      const sanitizedEntry = sanitizeJsonSafe(
        entry,
        `${pathDescription}.${key}`,
        seen,
      );
      if (sanitizedEntry !== undefined) {
        result[key] = sanitizedEntry;
      }
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

/**
 * Duck-types a value as a Node.js stream by checking for a `pipe`
 * method. Streams cannot be JSON-serialized.
 *
 * @param value - Value to test.
 * @returns Whether the value looks like a stream.
 */
function isStreamLike(value: object): boolean {
  return 'pipe' in value && typeof value.pipe === 'function';
}

/**
 * Mutates the already sanitized options object in place to rewrite the
 * path-bearing fields documented on {@link prepareDockerSandboxRequest}.
 *
 * Operates on the cloned `sanitized` payload, never on the caller's
 * input.
 *
 * @param sanitized - Sanitized options clone produced by
 * {@link sanitizeJsonSafe}.
 * @param sandbox - Normalized sandbox config.
 */
function rewriteOptionsPaths(
  sanitized: Record<string, unknown>,
  sandbox: NormalizedDockerSandboxConfig,
): void {
  if (typeof sanitized.cwd === 'string') {
    sanitized.cwd = mapCwd(sanitized.cwd, sandbox);
  }

  if (Array.isArray(sanitized.additionalDirectories)) {
    sanitized.additionalDirectories = sanitized.additionalDirectories.map(
      (entry, index) => {
        if (typeof entry !== 'string') {
          throw new SandboxConfigurationError(
            `Docker sandbox options.additionalDirectories[${index}] must be a string.`,
          );
        }
        return mapHostPathToContainer(
          entry,
          sandbox,
          `options.additionalDirectories[${index}]`,
        );
      },
    );
  }

  if (typeof sanitized.settings === 'string') {
    sanitized.settings = mapHostPathToContainer(
      sanitized.settings,
      sandbox,
      'options.settings',
    );
  }

  if (Array.isArray(sanitized.plugins)) {
    sanitized.plugins = sanitized.plugins.map((entry, index) => {
      if (!isPlainObject(entry)) {
        // Sanitizer already enforces plain records, so this is defensive.
        return entry;
      }
      if (entry.type === 'local' && typeof entry.path === 'string') {
        return {
          ...entry,
          path: mapHostPathToContainer(
            entry.path,
            sandbox,
            `options.plugins[${index}].path`,
          ),
        };
      }
      return entry;
    });
  }
}

/**
 * Maps `options.cwd` from a host path into a container path by checking
 * all configured mounts.
 *
 * @param cwd - Host path supplied via `options.cwd`.
 * @param sandbox - Normalized sandbox config.
 * @returns The container path.
 */
function mapCwd(cwd: string, sandbox: NormalizedDockerSandboxConfig): string {
  return mapHostPathToContainer(cwd, sandbox, 'options.cwd');
}

/**
 * Maps a host path to its container equivalent by checking against all
 * configured mounts (workspace plus any additional mounts). When
 * multiple mounts match, the most specific one (longest hostPath prefix)
 * is chosen.
 *
 * @param hostPath - Host path to map.
 * @param sandbox - Normalized sandbox config.
 * @param context - Path context used in error messages.
 * @returns The corresponding container path.
 */
function mapHostPathToContainer(
  hostPath: string,
  sandbox: NormalizedDockerSandboxConfig,
  context: string,
): string {
  if (!path.isAbsolute(hostPath)) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} must be an absolute host path, received: ${hostPath}`,
    );
  }

  const allMounts: NormalizedDockerSandboxMount[] = [];
  if (sandbox.workspace !== false) {
    allMounts.push(sandbox.workspace);
  }
  allMounts.push(...sandbox.mounts);

  if (allMounts.length === 0) {
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} cannot be mapped because the workspace mount is disabled; ${context} must live inside a mounted workspace.`,
    );
  }

  const matching = allMounts.filter((mount) => {
    const relative = path.relative(mount.hostPath, hostPath);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        relative !== '..')
    );
  });

  if (matching.length === 0) {
    if (sandbox.workspace !== false) {
      throw new SandboxConfigurationError(
        `Docker sandbox ${context} (${hostPath}) is outside the workspace host path (${sandbox.workspace.hostPath}); only paths inside the workspace can be mapped.`,
      );
    }
    throw new SandboxConfigurationError(
      `Docker sandbox ${context} (${hostPath}) is not inside any mounted host path; only paths inside mounted directories can be mapped.`,
    );
  }

  const best = matching.reduce((a, b) =>
    a.hostPath.length >= b.hostPath.length ? a : b,
  );

  const relative = path.relative(best.hostPath, hostPath);
  if (relative === '') {
    return best.containerPath;
  }

  const relativePosix = relative.split(path.sep).join('/');
  return `${best.containerPath}/${relativePosix}`;
}
