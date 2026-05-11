# @metamask/agent-runner

Reusable TypeScript runner for `@anthropic-ai/claude-agent-sdk` with optional Langfuse/OpenTelemetry lifecycle support.

This package is intentionally thin: it wraps Claude Agent SDK `query({ prompt, options })`, collects streamed messages, surfaces result metadata, and exposes `flush()` / `shutdown()` so short-lived CI and eval processes do not lose telemetry spans.

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
import { createAgentRunner } from '@metamask/agent-runner';

const runner = createAgentRunner();

const result = await runner.runAgent({
  prompt: 'Summarize the package architecture.',
  options: {
    cwd: process.cwd(),
    maxTurns: 3,
    disallowedTools: ['Bash(rm:*)'],
  },
  onMessage: (message) => {
    console.log(message);
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

Telemetry-enabled runs use a shallow mutable copy of `@anthropic-ai/claude-agent-sdk` manually instrumented with `ClaudeAgentSDKInstrumentation`, because ESM module namespace objects are read-only.

## API

### `createAgentRunner(config?)`

Creates a runner with:

- `runAgent(options)` — executes Claude SDK `query()`, streams messages to `onMessage`, and returns collected messages plus result metadata.
- `flush()` — force-flushes telemetry processors when telemetry is enabled; no-op otherwise.
- `shutdown()` — shuts down telemetry when enabled; no-op otherwise.
- `enabled` — boolean indicating whether telemetry is active.

### `runAgent()` result

The result includes:

- `messages` — all SDK messages emitted by the async generator.
- `resultMessage` — final SDK result message when emitted.
- `sessionId` — extracted from `session_id` on the result message.
- `totalCostUsd` — extracted from `total_cost_usd` on the result message.
- `durationMs` — wall-clock duration for the run.
- `metadata` — timestamps and message count.

## Extension and mm CLI integration notes

This MVP is deliberately not coupled to MetaMask Extension internals, `mm`, or `@metamask/client-mcp-core`. Future adapters can sit above this package and provide:

- preconfigured `cwd`, tools, MCP servers, hooks, and permission callbacks;
- Extension worktree/session naming conventions;
- Knowledge Store or evaluation callbacks;
- mm CLI orchestration around `runAgent()`.

Keep those adapters outside this core runner so the npm package remains reusable for generic Claude Agent SDK execution.
