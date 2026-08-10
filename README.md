# @metamask/agent-runner

Reusable TypeScript runner for the Claude Agent SDK and Pi coding-agent harness with optional Langfuse/OpenTelemetry lifecycle support and Docker isolation.

This package provides runtime-selectable Claude and Pi adapters, normalizes both event streams into one discriminated union, collects result metadata, and exposes `flush()` / `shutdown()` so short-lived CI and eval processes do not lose telemetry spans. Node.js **22.19.0 or newer** is required (Node 24+ is also supported).

## Install

```bash
npm install @metamask/agent-runner
```

## Environment variables

Telemetry is disabled by default and does not require Langfuse variables.

When telemetry is enabled, configure Langfuse with either explicit `telemetry` config or these environment variables:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

`ANTHROPIC_API_KEY` is not validated at runner construction time. The Claude Agent SDK remains responsible for auth and execution errors.

The Pi harness routes through a LiteLLM-compatible OpenAI completions endpoint and requires environment-only credentials:

```bash
LITELLM_BASE_URL=https://litellm.example
LITELLM_API_KEY=sk-litellm-...
```

Credentials are never serialized into Pi options or bridge requests. Docker forwards only the active adapter's default environment list: Claude receives its `ANTHROPIC_*`/proxy keys, while Pi receives `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and proxy keys. An explicit `forwardEnv` list or `false` still overrides those defaults.

### Using with LiteLLM Proxy

This package supports routing requests through a [LiteLLM proxy](https://docs.litellm.ai/docs/tutorials/claude_agent_sdk) to use any LLM provider (Bedrock, Azure, Vertex AI, etc.) instead of direct Anthropic API calls. No code changes are needed in this package — the Claude Agent SDK reads the following environment variables automatically:

| Variable             | Description                                       |
| -------------------- | ------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL (e.g. `http://localhost:4000`)  |
| `ANTHROPIC_API_KEY`  | Your LiteLLM API key (replaces the Anthropic key) |

Set these in the consuming application's environment, or pass them via the SDK `env` option:

```ts
const runner = createAgentRunner();

const result = await runner.runAgent({
  prompt: 'Summarize the architecture.',
  options: {
    model: 'bedrock-claude-sonnet-4', // any model name from LiteLLM config
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'sk-litellm-...',
    },
  },
});
```

The `model` option accepts any string, so LiteLLM model aliases (e.g. `bedrock-claude-sonnet-4`, `azure-gpt-4o`) work out of the box. `fallbackModel` is also supported.

For LiteLLM proxy setup and model configuration, see the [LiteLLM docs](https://docs.litellm.ai/docs/tutorials/claude_agent_sdk).

## Minimal usage

```ts
import { createAgentRunner, formatMessage } from '@metamask/agent-runner';

const runner = createAgentRunner();

const result = await runner.runAgent({
  prompt: 'Summarize the package architecture.',
  options: {
    cwd: process.cwd(),
    maxTurns: 3,
    disallowedTools: ['Bash(rm:*)'],
  },
  onMessage: (message) => {
    const line = formatMessage(message);
    if (line !== null) {
      process.stdout.write(line + '\n');
    }
  },
});

console.log(result.sessionId, result.totalCostUsd, result.durationMs);
```

### Runtime harness selection

Claude remains the default. Select Pi explicitly with the synchronous adapter factory or literal selector:

```ts
import {
  createAgentRunner,
  createHarnessAdapter,
  createPiAdapter,
} from '@metamask/agent-runner';

const piRunner = createAgentRunner({
  adapter: createPiAdapter(), // equivalent: createHarnessAdapter('pi')
  defaultOptions: {
    model: 'gpt-5.6-luna',
    cwd: process.cwd(),
    tools: ['read', 'bash', 'edit', 'write'],
  },
});

await piRunner.runAgent({ prompt: 'Run the focused tests and fix failures.' });
```

`PiQueryOptions` is package-owned and supports `model`, `cwd`, `systemPrompt`, an exact built-in `tools` allowlist, and safe provider model metadata (`contextWindow`, `maxTokens`, `reasoning`, `input`, and optional `cost`). Supported tool names are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; the Phase 3 default is `read`/`bash`/`edit`/`write`, and `tools: []` disables all built-ins.

Pi deliberately rejects Claude policy fields (`allowedTools`, `disallowedTools`, `canUseTool`, `permissionMode`, and `dangerouslySkipPermissions`), unknown tool names, and command-scoped selectors such as `bash(rm:*)`. These policies cannot be represented faithfully by Pi, so the adapter fails closed rather than silently weakening them. Structured judge runs also reject caller tool customization and expose only the terminating `submit_judgment` tool. A Pi judge inherits its `model` (and other model metadata) from the runner's `defaultOptions`, so `runner.judge()` works without repeating the model in `JudgeConfig.queryOptions`; the inherited `tools` policy is never carried into the judge run.

> **Direct Pi tool warning:** Direct runs execute enabled Pi tools on the host with the permissions of the current process. Use Docker for untrusted prompts or tool workloads. Docker does not make credentials invisible to a model running in the container; forward only the keys the run needs.

When Docker cleanup is `on-success` or `never`, failed or retained containers
may continue to contain forwarded credentials in their environment. Remove
retained containers promptly and avoid these policies for sensitive keys.

Pi usage cost is derived from declared model pricing and finalized assistant events. LiteLLM commonly supplies no trustworthy pricing; zero is preserved as `0`, while entirely missing or malformed cost data remains `undefined`.

By default the runner passes `settingSources: []` to the Claude SDK for isolated settings. Callers can override that in `defaultOptions` or per-run `options` when they intentionally want SDK settings loaded from other sources.

## Telemetry usage

```ts
import { createAgentRunner } from '@metamask/agent-runner';

const runner = createAgentRunner({
  telemetry: {
    mode: 'enabled',
    serviceName: 'metamask-evals',
  },
});

try {
  const result = await runner.runAgent({
    prompt: 'Run the evaluation task.',
    telemetry: {
      traceName: 'agent-eval',
      userId: 'ci',
      sessionId: 'eval-123',
      tags: ['ci', 'eval'],
      version: '0.1.0',
      metadata: { repository: 'metamask-extension' },
    },
  });

  console.log(result.metadata);
} finally {
  await runner.flush();
  await runner.shutdown();
}
```

## Architecture

```
src/
  index.ts              Public API surface (re-exports)
  runner.ts             createAgentRunner() factory and run loop
  types.ts              All public type definitions
  errors.ts             Error class hierarchy
  message-parser.ts     SDK message content extraction and redaction
  formatter.ts          Human-readable message formatting
  adapters/
    claude-adapter.ts   Claude SDK provider adapter
    pi-adapter.ts       Lazy Pi SDK provider adapter and isolated lifecycle
    pi-types.ts         Package-owned Pi options and JSON-safe event DTOs
    pi-message-translator.ts Shared direct/Docker Pi event translation
    sdk-accessors.ts    Type-safe accessors for raw SDK message fields
  telemetry/
    index.ts            Barrel re-exports for telemetry module
    controller.ts       OTel/Langfuse infrastructure lifecycle
    message-handler.ts  Telemetry-aware message handler (Langfuse spans)
    tracing.ts          Langfuse span creation and trace propagation
    env.ts              Telemetry config resolution from env vars
  judge/
    index.ts            Barrel re-exports for judge module
    executor.ts         LLM-as-a-judge evaluation runner
    scoring.ts          Langfuse score posting
    types.ts            Judge type definitions
  sandbox/
    types.ts            Public sandbox config types and defaults
    config.ts           Runner/run sandbox config merge logic
    docker/
      options.ts        Normalize DockerSandboxConfig into argv inputs
      command-runner.ts Default host process runner (spawn + spawnSync)
      lifecycle.ts      docker run/exec/cp/rm orchestration
      cleanup-registry.ts Process-wide container cleanup on exit/signal
      bridge.ts         Host side of the host↔container bridge
      bridge-protocol.ts JSON frame schema and parser for the bridge
    container/
      claude-bridge.ts  In-container Node.js bridge that drives the SDK
      pi-bridge.ts      Self-contained in-container isolated Pi bridge
```

### Provider adapter pattern

The runner is decoupled from the Claude SDK through the `ProviderAdapter` interface:

```ts
type ProviderAdapter = {
  name: string;
  run: (config: RunConfig) => AsyncIterable<AgentMessage>;
};
```

The built-in `createClaudeAdapter()` wraps `query()` from `@anthropic-ai/claude-agent-sdk` and translates raw SDK messages into normalized `AgentMessage` types. Callers can supply a custom adapter via `createAgentRunner({ adapter })` to swap the underlying LLM provider without changing run logic.

### Message normalization

Raw SDK messages (snake_case, untyped `Record<string, unknown>`) are translated by the Claude adapter into a discriminated union of typed messages:

| `AgentMessage.type` | Source SDK type           | Description                                                      |
| ------------------- | ------------------------- | ---------------------------------------------------------------- |
| `init`              | `system` (subtype `init`) | Session start with model and available tools                     |
| `generation`        | `assistant`               | Model output with text, tool calls, token usage, and stop reason |
| `tool_result`       | `user`                    | Tool execution result (one per parallel tool result block)       |
| `result`            | `result`                  | Final run outcome with cost, turns, and duration                 |
| `system`            | `system`                  | Internal SDK events (status, retries, task progress)             |
| `tool_progress`     | `tool_progress`           | Long-running tool heartbeat                                      |
| `tool_use_summary`  | `tool_use_summary`        | Human-readable tool execution summary                            |
| `rate_limit`        | `rate_limit_event`        | API rate limit notification                                      |

All message types carry an optional `raw` field with the original SDK message for debugging.

### Telemetry infrastructure

When telemetry is enabled, the runner creates shared OTel/Langfuse infrastructure with reference counting:

1. A `NodeSDK` instance with a `LangfuseSpanProcessor` starts on the first `createAgentRunner({ telemetry: { mode: 'enabled' } })` call.
2. Subsequent runners with matching config reuse the same infrastructure (ref count incremented).
3. `shutdown()` decrements the ref count; infrastructure is torn down when the last runner shuts down.
4. Mismatched telemetry configs across concurrent runners throw `TelemetryConfigurationError`.

The `createMessageHandler()` builds a span tree per run:

```
agent-runner (root session span)
  ├── generation (one per model turn, with token usage OTel attributes)
  │     ├── tool:Bash: ls -la  (pending until tool_result arrives)
  │     └── tool:Read: index.ts
  └── generation
        └── ...
```

When `redact: true` is set on telemetry config, prompts and tool I/O are replaced with `[REDACTED]` in spans. Sensitive keys (`password`, `secret`, `srp`, `mnemonic`, `privatekey`, `token`, `apikey`, etc.) are recursively redacted from tool inputs regardless of the redact flag.

#### Value-level redaction

For full-fidelity traces that still strip secret values, provide a `redactor` function. It receives each string leaf of span input/output (the prompt, generation input/output, tool inputs, tool results, and the final output) and returns a scrubbed string. Structure is preserved: for tool inputs the redactor is applied recursively to string leaves only, so the surrounding command and argument shape stay intact.

```ts
import { createAgentRunner } from '@metamask/agent-runner';
import type { TelemetryRedactor } from '@metamask/agent-runner';

const redactSecrets: TelemetryRedactor = (text) =>
  text.replaceAll(process.env.AI_CLI_SRP ?? '\0', '[REDACTED_SRP]');

const runner = createAgentRunner({
  telemetry: {
    mode: 'enabled',
    serviceName: 'metamask-evals',
    // Keep spans readable but scrub secrets:
    redact: false,
    redactor: redactSecrets,
  },
});
```

The `redactor` runs regardless of the `redact` flag and defaults to a no-op (behavior-preserving). When `redact: true`, the blanket `[REDACTED]` replacement takes precedence and the redactor is not invoked for that value.

### LLM-as-a-judge

The runner exposes a `judge()` method that runs a second LLM pass to evaluate a completed agent run. The judge receives the full message transcript, a rubric (system prompt), and a structured output schema derived from the configured score fields.

```ts
const judgeConfig: JudgeConfig = {
  rubric: 'Evaluate the agent run on correctness and completeness.',
  scoreFields: [
    { name: 'correctness', min: 0, max: 10 },
    { name: 'completeness', min: 0, max: 10 },
  ],
};

const result = await runner.runAgent({ prompt: 'Fix the login bug.' });

const verdict = await runner.judge(result, judgeConfig, {
  taskPrompt: 'Fix the login bug.',
  status:
    result.resultMessage?.type === 'result' && result.resultMessage.success
      ? 'success'
      : 'failure',
});

console.log(verdict.scores); // { correctness: 8, completeness: 7 }
console.log(verdict.reasoning); // "The agent correctly identified..."
```

Key design points:

- **Structured output** — the judge's score fields are compiled into a JSON schema and passed via the SDK `outputFormat` option. The response is parsed and validated against the declared ranges.
- **Prompt injection defence** — all untrusted content (transcript, task prompt, outcome) is XML-escaped and wrapped in delimited tags with an explicit instruction to treat tagged content as evidence, not instructions.
- **Telemetry integration** — when `options.postScores` is `true` and telemetry is enabled, scores are posted to Langfuse on the agent run's trace via `runner.postScores()`.
- **Best-effort scoring** — score posting failures are silently swallowed to match the runner's telemetry contract.

### Error handling

The error classes form a hierarchy rooted at `AgentRunnerError`:

- **`AgentRunnerError`** — base class for all runner failures.
- **`TelemetryConfigurationError`** — missing or invalid Langfuse/OTel config.
- **`MessageHandlerError`** — wraps errors thrown by the `onMessage` callback. When `onMessage` throws, the run terminates early and the error is captured in `result.error`.
- **`JudgeError`** — thrown when an LLM-as-a-judge evaluation fails (invalid config, parse failure, non-success termination, or `onMessage` callback error).
- **`SandboxConfigurationError`** — invalid sandbox config (unknown `type`, missing required field).
- **`DockerSandboxError`** — Docker runtime failure (image pull, container start, exec, copy, or cleanup).
- **`DockerSandboxProtocolError`** — invalid frame received over the in-container bridge protocol. Subclass of `DockerSandboxError`.

The run loop catches all errors and returns them in the result rather than throwing, so callers always get a partial result with `isPartial: true` and `error` populated.

## Docker sandbox

The Claude and Pi adapters can execute agent runs inside a Docker container instead of
the host process. This isolates filesystem writes, environment variables, and
spawned subprocesses (including the Claude Agent SDK's own tools) from the
host. The sandbox is opt-in: when no `sandbox` is configured the adapter runs
the SDK in-process exactly as before.

The runner attaches a default sandbox via `createAgentRunner({ sandbox })`,
and individual calls can override it with `runAgent({ sandbox })`. Pass
`sandbox: false` at either level to disable sandboxing.

```ts
import { createAgentRunner } from '@metamask/agent-runner';

const runner = createAgentRunner({
  sandbox: {
    type: 'docker',
    image: 'node:22-bookworm',
    workspace: {
      hostPath: process.cwd(),
      containerPath: '/workspace',
    },
    workdir: '/workspace',
    forwardEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
    cleanup: 'always',
  },
});

const result = await runner.runAgent({
  prompt: 'Run the test suite and summarize failures.',
});
```

### How it works

1. The adapter normalizes the `DockerSandboxConfig` (filling in defaults
   such as the workspace mount, forwarded env vars, and the cleanup
   policy).
2. A container is started with `docker run -d` using the resolved
   workspace mount, extra bind mounts, env vars, network mode, user
   override, and `--shm-size`. Any `setupCommands` run inside the
   container via `docker exec` after it starts.
3. A runtime-specific Node.js bridge (`claude-bridge.mjs` or `pi-bridge.mjs`) is
   copied into the container and the descriptor-pinned SDK package is `npm install`ed alongside it. Pi is locked to `@earendil-works/pi-coding-agent@0.83.0` and preflights Node >=22.19.0. The host streams a JSON
   request to the bridge over stdin and reads newline-delimited JSON
   events back over stdout.
4. The adapter translates those events into the same `AgentMessage`
   union the in-process Claude adapter emits, so consumers do not need
   to special-case sandboxed runs.
5. When the run completes the container is removed according to the
   `cleanup` policy. A process-level cleanup registry also tears down
   any containers still tracked when the host process exits or receives
   a termination signal.

### `DockerSandboxConfig`

| Field              | Type                                  | Description                                                                                                                                              |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`             | `'docker'`                            | Discriminant identifying the sandbox runtime.                                                                                                            |
| `image`            | `string`                              | Container image. Defaults to `DEFAULT_DOCKER_SANDBOX_IMAGE`.                                                                                             |
| `workspace`        | `DockerSandboxWorkspace \| false`     | Workspace bind mount, or `false` to disable. Defaults to a writable mount of `process.cwd()` at `DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH` (`/workspace`).  |
| `workdir`          | `string`                              | Working directory inside the container for the agent process.                                                                                            |
| `mounts`           | `DockerSandboxMount[]`                | Additional bind mounts (`hostPath`, `containerPath`, `readOnly?`).                                                                                       |
| `env`              | `Record<string, string \| undefined>` | Env vars set inside the container. `undefined` deletes a key inherited from the runner-level default.                                                    |
| `forwardEnv`       | `readonly string[] \| false`          | Host env vars copied into the container. Defaults to `DEFAULT_DOCKER_SANDBOX_FORWARD_ENV` (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `*_PROXY`).         |
| `network`          | `string`                              | Container `--network` mode (e.g. `host`, `none`, `bridge`).                                                                                              |
| `user`             | `string \| 'current' \| false`        | Container user. `'current'` resolves to the host UID/GID so files written to mounts retain host ownership; `false` runs as the image default.            |
| `shmSize`          | `string`                              | Size of `/dev/shm` (e.g. `512m`, `2g`).                                                                                                                  |
| `unsafeDockerArgs` | `string[]`                            | Extra raw arguments forwarded to `docker run`. Not validated.                                                                                            |
| `setupCommands`    | `string[]`                            | Shell commands executed inside the container before the agent starts. Useful for installing extra dependencies or seeding state.                         |
| `cleanup`          | `'always' \| 'on-success' \| 'never'` | When to remove the container. Defaults to `'always'`. `'on-success'` keeps the container on failure for inspection.                                      |
| `bridge`           | `DockerSandboxBridgeConfig`           | Bridge runtime options: `install`, `nodeCommand`, `npmCommand`, `sdkVersion`. Defaults install the host's installed Claude Agent SDK version on the fly. |

`SandboxConfig` is a discriminated union on `type`; today only `'docker'`
is supported but the surface is reserved for future runtimes.

### Docker defaults

When callers provide only `sandbox: { type: 'docker' }`, the runner uses
these defaults:

| Setting                  | Default                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Image                    | `docker/sandbox-templates:shell` (`DEFAULT_DOCKER_SANDBOX_IMAGE`)                                                                     |
| Workspace host path      | `options.cwd` when it is a string, otherwise `process.cwd()`                                                                          |
| Workspace container path | `/workspace` (`DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH`)                                                                                |
| Workspace access         | Writable bind mount (`readOnly: false`)                                                                                               |
| Workdir                  | Workspace container path (`/workspace`) when the workspace mount is enabled; otherwise unset unless `workdir` is provided             |
| Extra mounts             | None (`[]`)                                                                                                                           |
| Forwarded env vars       | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` |
| Explicit env             | None (`{}`), then merged over forwarded env vars                                                                                      |
| Network                  | Docker runtime default (no `--network` flag)                                                                                          |
| User                     | Image default (no `--user` flag). Set `user: 'current'` to run as the host UID/GID.                                                   |
| Shared memory            | Docker runtime default (no `--shm-size` flag)                                                                                         |
| Unsafe Docker args       | None (`[]`)                                                                                                                           |
| Setup commands           | None (`[]`)                                                                                                                           |
| Cleanup policy           | `always`                                                                                                                              |
| Bridge install           | `true`; installs `@anthropic-ai/claude-agent-sdk` plus `zod` inside the container before the run                                      |
| Bridge commands          | `node` and `npm`                                                                                                                      |
| Bridge SDK version       | Host-installed `@anthropic-ai/claude-agent-sdk` version unless `bridge.sdkVersion` is set                                             |
| Bridge directory         | `/tmp/metamask-agent-runner-bridge`                                                                                                   |

### Per-run override

`runAgent({ sandbox })` merges with the runner-level default:

- Scalar fields on the per-run config replace the runner-level value.
- `env` merges per key (`undefined` deletes a key).
- Array-valued fields (`mounts`, `unsafeDockerArgs`, `setupCommands`)
  follow replace-on-provide semantics.
- `workspace` is `false` only when the per-run value is `false`; otherwise
  the two objects are shallow merged.
- `bridge` is shallow merged.
- Passing `sandbox: false` at the run level disables sandboxing for that
  run even when the runner declares a default.

### Security considerations

The Docker sandbox provides **convenience isolation**, not adversarial
sandboxing. It is designed to prevent accidental side effects — runaway
shell commands, unintended file writes, and environment bleed — rather
than to contain a deliberately malicious agent.

**What the sandbox does:**

- Runs agent tools (Bash, file I/O, subprocesses) inside a container so
  they cannot directly access host paths outside the mounted workspace.
- Limits environment variable exposure to the explicit `forwardEnv`
  list instead of inheriting the full host environment.
- Automatically removes the container on completion (or process exit)
  so orphaned containers do not accumulate.

**What the sandbox does NOT do:**

- **Harden against a compromised model.** The default container runs as
  the image's default user (often `root`), retains Docker's default
  Linux capabilities, and has full network access. A malicious agent
  can read forwarded credentials from the environment, reach external
  endpoints over the network, and mutate the writable workspace mount.
- **Enforce resource limits.** No `--memory`, `--cpus`, or
  `--pids-limit` flags are applied by default. A runaway process can
  consume unbounded host resources.
- **Restrict the workspace mount.** The workspace is writable by default
  so the agent can modify project files. Set `workspace.readOnly: true`
  when the agent should only read the codebase.

**Hardening recommendations for sensitive environments:**

```ts
createAgentRunner({
  sandbox: {
    type: 'docker',
    user: 'current', // avoid root; match host UID/GID
    network: 'none', // block all network access
    workspace: { readOnly: true }, // prevent host file mutation
    forwardEnv: ['ANTHROPIC_API_KEY'], // narrow to only required secrets
    unsafeDockerArgs: [
      '--cap-drop',
      'ALL', // drop all Linux capabilities
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--memory',
      '4g',
      '--read-only', // immutable rootfs
      '--tmpfs',
      '/tmp:rw,noexec,nosuid', // writable scratch space
    ],
  },
});
```

> **`unsafeDockerArgs` warning:** Entries in this array bypass all
> sandbox safety checks. Flags such as `--privileged`,
> `--cap-add SYS_ADMIN`, or `-v /var/run/docker.sock` can completely
> defeat container isolation. The normalizer emits a `console.warn`
> when it detects known-dangerous flags; treat any such warning as a
> review-required signal.

### Requirements and caveats

- The `docker` CLI must be on `PATH` and the user must be able to create
  containers. Rootless Docker, Podman with a `docker` shim, and remote
  daemons via `DOCKER_HOST` all work as long as the CLI obeys.
- The container image must include Node.js 22.19.0+ for Pi (and a compatible
  runtime for Claude). The bridge installs the SDK via `npm`, so
  `npm` must also be available (override with `bridge.nodeCommand` /
  `bridge.npmCommand` if you ship a custom binary).
- The bridge runs `npm install` on every fresh container by default. For
  faster startup, bake the SDK into a custom image and set
  `bridge.install: false`.
- The first run after a fresh container may pull the image; subsequent
  runs reuse the local layer cache.
- Streaming-input prompts (`AsyncIterable`) are not supported when running
  inside a Docker sandbox; pass a string `prompt`.
- All sandbox runtime errors surface as `DockerSandboxError` (or the
  `DockerSandboxProtocolError` subclass) wrapped in the standard
  `AgentRunResult.error` field; runs are not retried automatically.
- The real Docker integration smoke test is skipped by default. To run it
  against a working Docker daemon, use:
  `RUN_DOCKER_TESTS=1 yarn vitest run src/sandbox/docker/integration.test.ts`.

## API

### `createAgentRunner(config?)`

Creates a runner with:

- `runAgent(options)` — executes the provider adapter, streams messages to `onMessage`, and returns collected messages plus result metadata.
- `judge(runResult, judgeConfig, context?, options?)` — runs an LLM-as-a-judge evaluation on a completed agent run. Optionally posts scores to Langfuse when `options.postScores` is `true`.
- `postScores(runResult, scores)` — posts score entries to the telemetry backend for a completed agent run.
- `flush()` — force-flushes telemetry processors when telemetry is enabled; no-op otherwise.
- `shutdown()` — shuts down telemetry when enabled; no-op otherwise.
- `enabled` — boolean indicating whether telemetry is active.

#### `AgentRunnerConfig`

| Field            | Type                            | Description                                                        |
| ---------------- | ------------------------------- | ------------------------------------------------------------------ |
| `defaultOptions` | Provider-specific query options | Default query options applied to every run.                        |
| `telemetry`      | `TelemetryConfig`               | Langfuse/OTel configuration.                                       |
| `adapter`        | `ProviderAdapter`               | Provider override; defaults to the Claude adapter.                 |
| `sandbox`        | `SandboxConfig \| false`        | Default sandbox applied to every run. `false` disables explicitly. |

### `runAgent(options)`

#### `AgentRunOptions`

| Field       | Type                            | Description                                                                                |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `prompt`    | `string \| object`              | The prompt to send to the agent.                                                           |
| `options`   | Provider-specific query options | Per-run query options merged over runner defaults.                                         |
| `onMessage` | `RunnerMessageHandler`          | Callback invoked for each streamed message.                                                |
| `telemetry` | `AgentRunTelemetryAttributes`   | Per-run Langfuse trace attributes (traceName, userId, sessionId, tags, version, metadata). |
| `sandbox`   | `SandboxConfig \| false`        | Per-run sandbox config merged over runner default. `false` disables for this run.          |

#### `AgentRunResult`

| Field           | Type             | Description                                                         |
| --------------- | ---------------- | ------------------------------------------------------------------- |
| `messages`      | `AgentMessage[]` | All messages emitted during the run.                                |
| `resultMessage` | `AgentMessage`   | Final result message, if one was emitted.                           |
| `sessionId`     | `string`         | Agent session identifier from the init message.                     |
| `traceId`       | `string`         | Langfuse trace identifier for score posting and linking.            |
| `totalCostUsd`  | `number`         | Total API cost in US dollars.                                       |
| `durationMs`    | `number`         | Wall-clock duration of the run in milliseconds.                     |
| `error`         | `Error`          | Error that terminated the run, if any.                              |
| `isPartial`     | `boolean`        | Whether the run was interrupted before the agent finished.          |
| `metadata`      | `object`         | `{ startedAt, endedAt, messageCount }` — timing and count metadata. |

### `formatMessage(message)`

Formats an `AgentMessage` for human-readable console output. Returns `null` for messages that should be skipped (empty content, internal bookkeeping).

```ts
import { formatMessage } from '@metamask/agent-runner';

// Typical output:
// [init] model=claude-sonnet-4-20250514 tools=12
// [tool_use] Bash: npm test
// [tool_output] All tests passed.
// [result] done in 5 turns ($0.0342)
```

### `judge(runResult, judgeConfig, context?, options?)`

Evaluates a completed agent run using a second LLM pass.

#### `JudgeConfig`

| Field          | Type                          | Description                                                                                        |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `rubric`       | `string`                      | System prompt / evaluation rubric for the judge.                                                   |
| `scoreFields`  | `JudgeScoreField[]`           | Score dimensions with `name`, `min`, and `max`.                                                    |
| `queryOptions` | `Partial<ClaudeQueryOptions>` | Optional SDK query options, merged over any runner defaults the adapter inherits for structured runs. Claude applies `tools` (`[]`), `maxTurns` (`5`), and `settingSources` (`[]`) when unset; the model falls back to the SDK default. The Pi adapter inherits `model` (and other model metadata) from `defaultOptions`, so a Pi judge no longer needs the model repeated here. |

#### `JudgeContext`

| Field        | Type     | Description                                      |
| ------------ | -------- | ------------------------------------------------ |
| `taskPrompt` | `string` | The original task prompt given to the agent.     |
| `status`     | `string` | The terminal status or outcome of the agent run. |

#### `JudgeOptions`

| Field        | Type                   | Description                                                                  |
| ------------ | ---------------------- | ---------------------------------------------------------------------------- |
| `postScores` | `boolean`              | When `true`, posts scores to Langfuse after evaluation. Defaults to `false`. |
| `onMessage`  | `RunnerMessageHandler` | Callback invoked for each raw SDK message during the judge run.              |

#### `JudgeResult`

| Field       | Type                     | Description                             |
| ----------- | ------------------------ | --------------------------------------- |
| `scores`    | `Record<string, number>` | Scores keyed by dimension name.         |
| `reasoning` | `string`                 | The judge's reasoning explanation.      |
| `raw`       | `string`                 | Raw JSON response from the judge model. |

### `postScores(runResult, scores)`

Posts score entries to the telemetry backend for a completed agent run. No-op when telemetry is disabled, the trace ID is missing, or the scores array is empty.

#### `ScoreEntry`

| Field     | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `name`    | `string` | Name of the score dimension.   |
| `value`   | `number` | Numeric score value.           |
| `comment` | `string` | Optional comment or reasoning. |

### Exported error classes

```ts
import {
  AgentRunnerError,
  TelemetryConfigurationError,
  MessageHandlerError,
  JudgeError,
  SandboxConfigurationError,
  DockerSandboxError,
  DockerSandboxProtocolError,
} from '@metamask/agent-runner';
```

### Exported types

```ts
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunTelemetryAttributes,
  AgentRunner,
  AgentRunnerConfig,
  DockerSandboxBridgeConfig,
  DockerSandboxCleanupPolicy,
  DockerSandboxConfig,
  DockerSandboxMount,
  DockerSandboxWorkspace,
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  JudgeScoreField,
  RunnerMessageHandler,
  SandboxConfig,
  ScoreEntry,
  TelemetryConfig,
  TelemetryLifecycle,
  TokenUsage,
  ToolCall,
} from '@metamask/agent-runner';
```

## Coding patterns

### Pure functions over classes

The codebase uses factory functions (`createAgentRunner`, `createClaudeAdapter`, `createMessageHandler`, `createTelemetryController`) that return plain object interfaces. No `class` or `this` — state is captured via closures.

### Discriminated unions for messages

All agent messages use `type` as the discriminant field. Consumers switch on `message.type` for exhaustive handling. Each variant is a separate named type (`AgentInitMessage`, `AgentGenerationMessage`, etc.) unioned into `AgentMessage`.

### Defensive SDK boundary

The Claude adapter treats all SDK values as `Record<string, unknown>` and uses safe accessor helpers (`getString`, `getNumber`, `getOptionalString`, `getRecord`, etc.) to extract fields. This prevents runtime crashes from SDK wire-format changes.

### Spread-optional pattern

Optional fields on message types are conditionally included via `spreadOptional(key, value)`, which returns `{ [key]: value }` when defined or `{}` otherwise. This avoids setting fields to `undefined` and keeps serialized output clean.

### Best-effort telemetry

Telemetry failures never crash agent runs. All tracing calls are wrapped in try/catch at the runner level, and the `traceSpan` helper silently swallows errors from `propagateAttributes`. Span finalization (`finalizePendingTools`, `finalizeSessionSpan`) runs in `finally` blocks.

### Dual CJS/ESM output

The package builds both CommonJS and ESM via `@ts-bridge/cli` and uses conditional `exports` in `package.json` so consumers get the right format automatically.
