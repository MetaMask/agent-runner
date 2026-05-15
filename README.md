# @metamask/agent-runner

Reusable TypeScript runner for `@anthropic-ai/claude-agent-sdk` with optional Langfuse/OpenTelemetry lifecycle support.

This package wraps the Claude Agent SDK `query()` behind a provider adapter, normalizes the streamed message types into a discriminated union, collects result metadata, and exposes `flush()` / `shutdown()` so short-lived CI and eval processes do not lose telemetry spans.

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
  status: result.resultMessage?.type === 'result' && result.resultMessage.success ? 'success' : 'failure',
});

console.log(verdict.scores);    // { correctness: 8, completeness: 7 }
console.log(verdict.reasoning); // "The agent correctly identified..."
```

Key design points:

- **Structured output** — the judge's score fields are compiled into a JSON schema and passed via the SDK `outputFormat` option. The response is parsed and validated against the declared ranges.
- **Prompt injection defence** — all untrusted content (transcript, task prompt, outcome) is XML-escaped and wrapped in delimited tags with an explicit instruction to treat tagged content as evidence, not instructions.
- **Telemetry integration** — when `options.postScores` is `true` and telemetry is enabled, scores are posted to Langfuse on the agent run's trace via `runner.postScores()`.
- **Best-effort scoring** — score posting failures are silently swallowed to match the runner's telemetry contract.

### Error handling

Four error classes form a hierarchy rooted at `AgentRunnerError`:

- **`AgentRunnerError`** — base class for all runner failures.
- **`TelemetryConfigurationError`** — missing or invalid Langfuse/OTel config.
- **`MessageHandlerError`** — wraps errors thrown by the `onMessage` callback. When `onMessage` throws, the run terminates early and the error is captured in `result.error`.
- **`JudgeError`** — thrown when an LLM-as-a-judge evaluation fails (invalid config, parse failure, non-success termination, or `onMessage` callback error).

The run loop catches all errors and returns them in the result rather than throwing, so callers always get a partial result with `isPartial: true` and `error` populated.

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

| Field            | Type                          | Description                                        |
| ---------------- | ----------------------------- | -------------------------------------------------- |
| `defaultOptions` | `Partial<ClaudeQueryOptions>` | Default query options applied to every run.        |
| `telemetry`      | `TelemetryConfig`             | Langfuse/OTel configuration.                       |
| `adapter`        | `ProviderAdapter`             | Provider override; defaults to the Claude adapter. |

### `runAgent(options)`

#### `AgentRunOptions`

| Field       | Type                          | Description                                                                                |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `prompt`    | `string \| object`            | The prompt to send to the agent.                                                           |
| `options`   | `Partial<ClaudeQueryOptions>` | Per-run query options merged over runner defaults.                                         |
| `onMessage` | `RunnerMessageHandler`        | Callback invoked for each streamed message.                                                |
| `telemetry` | `AgentRunTelemetryAttributes` | Per-run Langfuse trace attributes (traceName, userId, sessionId, tags, version, metadata). |

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

| Field          | Type                          | Description                                                                 |
| -------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `rubric`       | `string`                      | System prompt / evaluation rubric for the judge.                            |
| `scoreFields`  | `JudgeScoreField[]`           | Score dimensions with `name`, `min`, and `max`.                             |
| `queryOptions` | `Partial<ClaudeQueryOptions>` | Optional SDK query options (defaults: model `claude-sonnet-4-20250514`, tools `[]`, maxTurns `5`). |

#### `JudgeContext`

| Field       | Type     | Description                                          |
| ----------- | -------- | ---------------------------------------------------- |
| `taskPrompt`| `string` | The original task prompt given to the agent.         |
| `status`    | `string` | The terminal status or outcome of the agent run.     |

#### `JudgeOptions`

| Field        | Type                   | Description                                                                 |
| ------------ | ---------------------- | --------------------------------------------------------------------------- |
| `postScores` | `boolean`              | When `true`, posts scores to Langfuse after evaluation. Defaults to `false`.|
| `onMessage`  | `RunnerMessageHandler` | Callback invoked for each raw SDK message during the judge run.             |

#### `JudgeResult`

| Field       | Type                    | Description                            |
| ----------- | ----------------------- | -------------------------------------- |
| `scores`    | `Record<string, number>`| Scores keyed by dimension name.        |
| `reasoning` | `string`                | The judge's reasoning explanation.     |
| `raw`       | `string`                | Raw JSON response from the judge model.|

### `postScores(runResult, scores)`

Posts score entries to the telemetry backend for a completed agent run. No-op when telemetry is disabled, the trace ID is missing, or the scores array is empty.

#### `ScoreEntry`

| Field     | Type     | Description                       |
| --------- | -------- | --------------------------------- |
| `name`    | `string` | Name of the score dimension.      |
| `value`   | `number` | Numeric score value.              |
| `comment` | `string` | Optional comment or reasoning.    |

### Exported error classes

```ts
import {
  AgentRunnerError,
  TelemetryConfigurationError,
  MessageHandlerError,
  JudgeError,
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
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  JudgeScoreField,
  RunnerMessageHandler,
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
