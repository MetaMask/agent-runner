import type { query } from '@anthropic-ai/claude-agent-sdk';

import type {
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  ScoreEntry,
} from './judge/types.js';
import type { SandboxConfig } from './sandbox/types.js';

export type {
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  JudgeScoreField,
  ScoreEntry,
} from './judge/types.js';
export type {
  DockerSandboxBridgeConfig,
  DockerSandboxCleanupPolicy,
  DockerSandboxConfig,
  DockerSandboxMount,
  DockerSandboxWorkspace,
  SandboxConfig,
} from './sandbox/types.js';

/**
 * A tool invocation requested by the agent during a generation.
 */
export type ToolCall = {
  /** Unique identifier for the tool call. */
  id: string;
  /** Name of the tool being invoked. */
  name: string;
  /** Arguments passed to the tool. */
  input: unknown;
};

/**
 * Token consumption for a single model generation.
 */
export type TokenUsage = {
  /** Number of input tokens consumed. */
  inputTokens: number;
  /** Number of output tokens generated. */
  outputTokens: number;
  /** Tokens read from the prompt cache. */
  cacheReadTokens?: number;
  /** Tokens used to create the prompt cache. */
  cacheCreationTokens?: number;
};

/**
 * Session initialization message emitted when the agent starts.
 */
export type AgentInitMessage = {
  /** Message type discriminant. */
  type: 'init';
  /** Agent session identifier. */
  sessionId: string;
  /** Model used for the session. */
  model?: string;
  /** Tools available to the agent. */
  tools?: string[];
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Model generation containing text output and/or tool calls.
 */
export type AgentGenerationMessage = {
  /** Message type discriminant. */
  type: 'generation';
  /** Model that produced the generation. */
  model: string;
  /** Concatenated text output from the generation. */
  text: string;
  /** Tool invocations requested in this generation. */
  toolCalls: ToolCall[];
  /** Token consumption for this generation. */
  usage: TokenUsage;
  /** Reason the model stopped generating, or null if unknown. */
  stopReason: string | null;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Result of a tool invocation, sent back by the SDK.
 */
export type AgentToolResultMessage = {
  /** Message type discriminant. */
  type: 'tool_result';
  /** Identifier linking this result to its originating tool call. */
  toolUseId: string;
  /** Text content returned by the tool. */
  content: string;
  /** Whether the tool execution produced an error. */
  isError: boolean;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Final result message emitted when the agent run completes.
 */
export type AgentResultMessage = {
  /** Message type discriminant. */
  type: 'result';
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Final text output from the agent. */
  result?: string;
  /** Total API cost in US dollars. */
  costUsd?: number;
  /** Number of conversational turns taken. */
  turns?: number;
  /** Total runtime in milliseconds. */
  durationMs?: number;
  /** Error message when the run failed. */
  error?: string;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Internal system event forwarded from the SDK.
 */
export type AgentSystemMessage = {
  /** Message type discriminant. */
  type: 'system';
  /** Category of system event (e.g. 'init', 'status', 'api_retry'). */
  subtype: string;
  /** Original SDK message before translation. */
  raw?: unknown;
  /** Additional event-specific properties. */
  [key: string]: unknown;
};

/**
 * Progress update for a long-running tool execution.
 */
export type AgentToolProgressMessage = {
  /** Message type discriminant. */
  type: 'tool_progress';
  /** Name of the tool reporting progress. */
  toolName: string;
  /** Seconds elapsed since the tool started. */
  elapsedSeconds: number;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Human-readable summary of a completed tool invocation.
 */
export type AgentToolUseSummaryMessage = {
  /** Message type discriminant. */
  type: 'tool_use_summary';
  /** Summary description of what the tool did. */
  summary: string;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Rate limiting notification from the API provider.
 */
export type AgentRateLimitMessage = {
  /** Message type discriminant. */
  type: 'rate_limit';
  /** Rate limit status or disposition. */
  status: string;
  /** Original SDK message before translation. */
  raw?: unknown;
};

/**
 * Discriminated union of all normalized agent message types.
 */
export type AgentMessage =
  | AgentInitMessage
  | AgentGenerationMessage
  | AgentToolResultMessage
  | AgentResultMessage
  | AgentSystemMessage
  | AgentToolProgressMessage
  | AgentToolUseSummaryMessage
  | AgentRateLimitMessage;

/**
 * Full Claude Agent SDK module type.
 */
export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/**
 * Claude SDK `query` function type.
 */
export type ClaudeQuery = typeof query;

/**
 * Input parameter type for the Claude SDK query function.
 */
export type ClaudeQueryInput = Parameters<ClaudeQuery>[0];

/**
 * Options accepted by the Claude SDK query function.
 */
export type ClaudeQueryOptions = NonNullable<ClaudeQueryInput['options']>;

/**
 * Configuration passed to a provider adapter's run method.
 */
export type RunConfig = {
  /** The prompt to send to the agent. */
  prompt: ClaudeQueryInput['prompt'];
  /** Query options forwarded to the provider. */
  options: Partial<ClaudeQueryOptions>;
  /**
   * Resolved sandbox configuration for this run. Adapters that do not
   * declare sandbox support via {@link ProviderAdapter.capabilities}
   * should treat the field as unsupported and surface a configuration
   * error to the caller.
   *
   * The runner currently only supports Docker sandboxes.
   */
  sandbox?: SandboxConfig;
};

/**
 * Optional capability descriptor advertised by a provider adapter.
 *
 * The runner currently only supports Docker sandboxes. The
 * `sandboxes` array is used for validation, not for registering custom
 * sandbox runtimes. Adapters cannot introduce new sandbox types without
 * changes to the runner core.
 */
export type ProviderAdapterCapabilities = {
  /**
   * Sandbox runtimes the adapter can execute. The runner uses this to
   * guard against passing an unsupported sandbox to the adapter.
   *
   * Because the runner only supports Docker sandboxes today,
   * this list is effectively limited to `['docker']`. It validates
   * compatibility rather than enabling extensibility.
   */
  sandboxes?: readonly SandboxConfig['type'][];
};

/**
 * Abstraction over an LLM agent provider, decoupling the runner from
 * any specific SDK.
 */
export type ProviderAdapter = {
  /** Identifier for the provider (e.g. 'claude'). */
  name: string;
  /** Executes an agent run and yields normalized messages. */
  run: (config: RunConfig) => AsyncIterable<AgentMessage>;
  /**
   * Optional capability descriptor advertised by the adapter. Used by the
   * runner to validate that requested features (e.g. sandboxes) are
   * supported before invoking {@link ProviderAdapter.run}.
   */
  capabilities?: ProviderAdapterCapabilities;
};

/**
 * Callback invoked for each streamed agent message during a run.
 */
export type RunnerMessageHandler = (
  message: AgentMessage,
) => void | Promise<void>;

/**
 * Whether telemetry collection is active or disabled.
 */
export type TelemetryMode = 'disabled' | 'enabled';

/**
 * Custom OpenTelemetry resource attributes for telemetry tagging.
 */
export type TelemetryResourceAttributes = Record<
  string,
  string | number | boolean
>;

/**
 * Configuration for Langfuse and OpenTelemetry telemetry.
 */
export type TelemetryConfig = {
  /** Whether telemetry is enabled or disabled. */
  mode?: TelemetryMode;
  /** Langfuse public key for authentication. */
  publicKey?: string;
  /** Langfuse secret key for authentication. */
  secretKey?: string;
  /** Langfuse API base URL. */
  baseUrl?: string;
  /** OpenTelemetry service name for resource tagging. */
  serviceName?: string;
  /** Additional OpenTelemetry resource attributes. */
  resourceAttributes?: TelemetryResourceAttributes;
  /** Whether to redact prompts and tool I/O from traces. */
  redact?: boolean;
};

/**
 * Flush and shutdown lifecycle hooks for telemetry infrastructure.
 */
export type TelemetryLifecycle = {
  /** Whether telemetry is currently active. */
  enabled: boolean;
  /** Force-flushes pending telemetry spans to the backend. */
  flush: () => Promise<void>;
  /** Shuts down telemetry infrastructure and releases resources. */
  shutdown: () => Promise<void>;
};

/**
 * Top-level configuration for creating an agent runner.
 */
export type AgentRunnerConfig = {
  /** Default query options applied to every run. */
  defaultOptions?: Partial<ClaudeQueryOptions>;
  /** Telemetry configuration for Langfuse/OTel integration. */
  telemetry?: TelemetryConfig;
  /** Provider adapter override; defaults to the Claude adapter. */
  adapter?: ProviderAdapter;
  /**
   * Default sandbox configuration applied to every run. Set to `false`
   * to explicitly disable sandboxing at the runner level; individual runs
   * may still opt in by supplying {@link AgentRunOptions.sandbox}.
   *
   * The runner currently only supports Docker sandboxes.
   */
  sandbox?: SandboxConfig | false;
};

/**
 * Per-run telemetry attributes propagated to Langfuse traces.
 */
export type AgentRunTelemetryAttributes = {
  /** Name for the root Langfuse trace. */
  traceName?: string;
  /** User identifier propagated to traces. */
  userId?: string;
  /** Session identifier propagated to traces. */
  sessionId?: string;
  /** Arbitrary metadata attached to the trace. */
  metadata?: Record<string, string>;
  /** Tags for filtering and categorisation in Langfuse. */
  tags?: string[];
  /** Application version for the trace. */
  version?: string;
};

/**
 * Options for a single agent run invocation.
 */
export type AgentRunOptions = {
  /** The prompt to send to the agent. */
  prompt: ClaudeQueryInput['prompt'];
  /** Per-run query options merged over runner defaults. */
  options?: Partial<ClaudeQueryOptions>;
  /** Callback invoked for each streamed message. */
  onMessage?: RunnerMessageHandler;
  /** Per-run Langfuse trace attributes. */
  telemetry?: AgentRunTelemetryAttributes;
  /**
   * Per-run sandbox configuration merged over the runner-level default.
   * Pass `false` to disable sandboxing for this run even when the runner
   * declares a default sandbox.
   *
   * The runner currently only supports Docker sandboxes.
   */
  sandbox?: SandboxConfig | false;
};

/**
 * Outcome of a completed (or partially completed) agent run.
 */
export type AgentRunResult = {
  /** All messages emitted during the run. */
  messages: AgentMessage[];
  /** Final result message, if one was emitted. */
  resultMessage?: AgentMessage | undefined;
  /** Agent session identifier from the init message. */
  sessionId?: string | undefined;
  /** Langfuse trace identifier for score posting and linking. */
  traceId?: string | undefined;
  /** Total API cost in US dollars. */
  totalCostUsd?: number | undefined;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Error that terminated the run, if any. */
  error?: Error | undefined;
  /** Whether the run was interrupted before the agent finished. */
  isPartial: boolean;
  /** Timing and count metadata for the run. */
  metadata: {
    /** ISO 8601 timestamp when the run started. */
    startedAt: string;
    /** ISO 8601 timestamp when the run ended. */
    endedAt: string;
    /** Total number of messages emitted during the run. */
    messageCount: number;
  };
};

/**
 * The main agent runner interface combining telemetry lifecycle
 * with agent execution, judging, and score posting.
 */
export type AgentRunner = TelemetryLifecycle & {
  /** Executes a single agent run with the given options. */
  runAgent: (options: AgentRunOptions) => Promise<AgentRunResult>;
  /**
   * Runs an LLM-as-a-judge evaluation on a completed agent run.
   * Scores are only posted to Langfuse when `options.postScores` is `true`.
   */
  judge: (
    runResult: AgentRunResult,
    judgeConfig: JudgeConfig,
    context?: JudgeContext,
    options?: JudgeOptions,
  ) => Promise<JudgeResult>;
  /** Posts scores to the telemetry backend for a completed agent run. */
  postScores: (
    runResult: AgentRunResult,
    scores: ScoreEntry[],
  ) => Promise<void>;
};
