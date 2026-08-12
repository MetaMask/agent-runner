/**
 * Default image used when running an agent inside a Docker sandbox.
 *
 * Adapters may override this via {@link DockerSandboxConfig.image}, but most
 * setups should rely on the bundled template image which already ships with
 * Node.js, the Claude Agent SDK runtime, and a writable workspace mount.
 */
export const DEFAULT_DOCKER_SANDBOX_IMAGE = 'docker/sandbox-templates:shell';

/**
 * Default mount point used when the host workspace is bind-mounted into the
 * sandbox container. Resolved configurations apply this when
 * {@link DockerSandboxWorkspace.containerPath} is not set.
 */
export const DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH = '/workspace';

/**
 * Environment variables forwarded from the host process into the sandbox
 * container by default.
 *
 * The list focuses on values required for the agent to talk to Anthropic and
 * any corporate proxy: API/auth credentials and standard proxy variables.
 * Consumers can opt out entirely by setting
 * {@link DockerSandboxConfig.forwardEnv} to `false` or narrow the list by
 * providing their own array.
 */
export const CLAUDE_DOCKER_SANDBOX_FORWARD_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

/** Environment forwarded by the Pi adapter when `forwardEnv` is omitted. */
export const PI_DOCKER_SANDBOX_FORWARD_ENV: readonly string[] = [
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

/** Backward-compatible alias for the original Claude Docker defaults. */
export const DEFAULT_DOCKER_SANDBOX_FORWARD_ENV =
  CLAUDE_DOCKER_SANDBOX_FORWARD_ENV;

/**
 * Describes a single bind mount to add to the sandbox container.
 *
 * Both paths are forwarded verbatim to the container runtime, so the host
 * path must already exist and be accessible to the user creating the
 * container.
 */
export type DockerSandboxMount = {
  /** Absolute path on the host machine to mount into the container. */
  hostPath: string;
  /** Absolute path inside the container where the host path is mounted. */
  containerPath: string;
  /**
   * When `true`, mounts the path read-only. Defaults to `false` so the agent
   * can write back to the host workspace.
   */
  readOnly?: boolean;
};

/**
 * Configuration for the primary workspace mount.
 *
 * Setting {@link DockerSandboxConfig.workspace} to `false` disables the
 * implicit workspace mount entirely.
 */
export type DockerSandboxWorkspace = {
  /**
   * Absolute path on the host to mount as the workspace. When omitted, the
   * adapter falls back to the current working directory.
   */
  hostPath?: string;
  /**
   * Absolute path inside the container where the workspace is mounted.
   * Defaults to {@link DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH}.
   */
  containerPath?: string;
  /** When `true`, mounts the workspace read-only. Defaults to `false`. */
  readOnly?: boolean;
};

/**
 * Controls how the in-container bridge between the host runner and the
 * sandboxed Claude Agent SDK is installed and invoked.
 */
export type DockerSandboxBridgeConfig = {
  /**
   * When `true`, the runner installs the bridge runtime inside the container
   * before each run. Defaults to `true` when the configured image does not
   * already ship with it.
   */
  install?: boolean;
  /** Path or command used to execute Node.js inside the container. */
  nodeCommand?: string;
  /** Path or command used to execute npm inside the container. */
  npmCommand?: string;
  /** Version of `@anthropic-ai/claude-agent-sdk` to install for the bridge. */
  sdkVersion?: string;
};

/**
 * When the runner should remove the sandbox container after a run.
 *
 * - `always`  Remove the container regardless of outcome.
 * - `on-success`  Keep the container when the run errors so it can be
 *   inspected. Kept containers retain their environment variables, which
 *   may include forwarded secrets. See the security note on
 *   {@link DockerSandboxConfig.envFile}.
 * - `never`  Always keep the container; the caller is responsible for
 *   removing it. Kept containers retain their environment variables, which
 *   may include forwarded secrets. See the security note on
 *   {@link DockerSandboxConfig.envFile}.
 */
export type DockerSandboxCleanupPolicy = 'always' | 'on-success' | 'never';

/**
 * Configuration for running an agent inside a Docker sandbox container.
 *
 * All fields except {@link DockerSandboxConfig.type} are optional; the
 * runner fills in defaults during configuration resolution.
 */
export type DockerSandboxConfig = {
  /** Discriminant identifying this configuration as a Docker sandbox. */
  type: 'docker';
  /**
   * Container image to use. Defaults to {@link DEFAULT_DOCKER_SANDBOX_IMAGE}
   * when not provided.
   */
  image?: string;
  /**
   * Workspace mount configuration, or `false` to disable the implicit
   * workspace mount entirely.
   */
  workspace?: DockerSandboxWorkspace | false;
  /** Working directory inside the container for the agent process. */
  workdir?: string;
  /** Additional bind mounts to add to the container. */
  mounts?: DockerSandboxMount[];
  /**
   * Environment variables to set inside the container. A value of
   * `undefined` deletes a previously merged entry, allowing run-level
   * configs to mask runner-level defaults.
   */
  env?: Record<string, string | undefined>;
  /**
   * Names of host environment variables to forward into the container.
   * Defaults to {@link DEFAULT_DOCKER_SANDBOX_FORWARD_ENV} when omitted.
   * Pass `false` to disable forwarding entirely.
   */
  forwardEnv?: readonly string[] | false;
  /** Container network mode forwarded to the runtime (e.g. `host`, `none`). */
  network?: string;
  /**
   * Container user. `current` resolves to the host user/group at runtime so
   * files written into mounts retain host ownership; `false` disables the
   * user override and runs as the image default.
   */
  user?: string | 'current' | false;
  /**
   * Size of `/dev/shm` (e.g. `512m`, `2g`). Preferred over passing
   * `--shm-size` through {@link DockerSandboxConfig.unsafeDockerArgs}.
   */
  shmSize?: string;
  /**
   * Memory limit for the container (e.g. `'4g'`, `'512m'`). Forwarded
   * as `--memory` to the container runtime. When omitted, no memory
   * limit is applied.
   */
  memory?: string;
  /**
   * Additional raw arguments forwarded to the container runtime. Provided
   * as an escape hatch; entries are not validated and bypass other
   * safety checks, hence the `unsafe` prefix.
   *
   * **Security warning:** The following flags defeat container isolation
   * and should only be used when the security implications are fully
   * understood:
   *
   * - `--privileged` — grants the container almost all host capabilities.
   * - `--cap-add` — re-adds dropped Linux capabilities.
   * - `-v /var/run/docker.sock:...` — exposes the Docker daemon to the
   *   container, enabling host breakout.
   * - `--pid=host` / `--network=host` / `--ipc=host` — shares the host
   *   namespace, breaking process/network/IPC isolation.
   * - `--security-opt apparmor:unconfined` / `--security-opt seccomp:unconfined`
   *   — disables mandatory access-control profiles.
   *
   * The normalizer emits a `console.warn` when any of these patterns are
   * detected. Treat warnings as a review-required signal.
   */
  unsafeDockerArgs?: string[];
  /**
   * Shell commands executed inside the container before the agent starts.
   * Useful for installing extra dependencies or seeding state.
   */
  setupCommands?: string[];
  /**
   * Absolute path to a Docker-compatible env file on the host. When
   * provided, the file is passed to the container runtime via
   * `--env-file` so that secrets never appear in process argv or error
   * messages. The file must follow the Docker env-file format
   * (`KEY=value`, one per line).
   *
   * This is the recommended way to forward secrets into the container.
   * Variables defined in the env file take effect **before** any
   * explicit {@link DockerSandboxConfig.env} entries are applied, so
   * explicit values win on key collisions.
   *
   * **Security note:** Using `envFile` (or the auto-generated temp env
   * file created for {@link DockerSandboxConfig.env} and
   * {@link DockerSandboxConfig.forwardEnv}) prevents secrets from
   * appearing in `ps` output, error messages, and Docker argv.
   * However, Docker stores environment variables in the container
   * metadata. When {@link DockerSandboxConfig.cleanup} is set to
   * `'on-success'` or `'never'`, the kept container's environment
   * remains inspectable via `docker inspect`. For maximum security, use
   * `cleanup: 'always'` (the default) when forwarding sensitive
   * credentials.
   */
  envFile?: string;
  /** Container cleanup policy. Defaults to `always`. */
  cleanup?: DockerSandboxCleanupPolicy;
  /** Bridge runtime configuration. */
  bridge?: DockerSandboxBridgeConfig;
};

/**
 * Union of all supported sandbox configurations.
 *
 * The runner currently only supports Docker sandboxes. The
 * discriminant on `type` is reserved for future expansion, but custom
 * runtimes cannot be added without changing core runner types.
 */
export type SandboxConfig = DockerSandboxConfig;
