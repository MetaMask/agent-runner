import type { query } from '@anthropic-ai/claude-agent-sdk';

/**
 *
 */
export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
/**
 *
 */
export type ClaudeQuery = typeof query;
/**
 *
 */
export type ClaudeQueryInput = Parameters<ClaudeQuery>[0];
/**
 *
 */
export type ClaudeQueryOptions = NonNullable<ClaudeQueryInput['options']>;
/**
 *
 */
export type SdkMessage = Awaited<
  ReturnType<ClaudeQuery> extends AsyncGenerator<infer T> ? T : never
>;

/**
 *
 */
export type RunnerMessageHandler = (
  message: SdkMessage,
) => void | Promise<void>;

/**
 *
 */
export type TelemetryMode = 'disabled' | 'enabled';

/**
 *
 */
export type TelemetryResourceAttributes = Record<
  string,
  string | number | boolean
>;

/**
 *
 */
export type TelemetryConfig = {
  /**
   *
   */
  mode?: TelemetryMode;
  /**
   *
   */
  publicKey?: string;
  /**
   *
   */
  secretKey?: string;
  /**
   *
   */
  baseUrl?: string;
  /**
   *
   */
  serviceName?: string;
  /**
   *
   */
  resourceAttributes?: TelemetryResourceAttributes;
};

/**
 *
 */
export type TelemetryLifecycle = {
  /**
   *
   */
  enabled: boolean;
  /**
   *
   */
  flush: () => Promise<void>;
  /**
   *
   */
  shutdown: () => Promise<void>;
};

/**
 *
 */
export type ClaudeSdkQueryModule = Pick<ClaudeSdkModule, 'query'>;

/**
 *
 */
export type AgentRunnerConfig = {
  /**
   *
   */
  defaultOptions?: Partial<ClaudeQueryOptions>;
  /**
   *
   */
  telemetry?: TelemetryConfig;
  /**
   *
   */
  sdkModule?: ClaudeSdkQueryModule;
};

/**
 *
 */
export type AgentRunTelemetryAttributes = {
  /**
   *
   */
  traceName?: string;
  /**
   *
   */
  userId?: string;
  /**
   *
   */
  sessionId?: string;
  /**
   *
   */
  metadata?: Record<string, string>;
  /**
   *
   */
  tags?: string[];
  /**
   *
   */
  version?: string;
};

/**
 *
 */
export type AgentRunOptions = {
  /**
   *
   */
  prompt: ClaudeQueryInput['prompt'];
  /**
   *
   */
  options?: Partial<ClaudeQueryOptions>;
  /**
   *
   */
  onMessage?: RunnerMessageHandler;
  /**
   *
   */
  telemetry?: AgentRunTelemetryAttributes;
};

/**
 *
 */
export type AgentRunResult = {
  /**
   *
   */
  messages: SdkMessage[];
  /**
   *
   */
  resultMessage?: SdkMessage | undefined;
  /**
   *
   */
  sessionId?: string | undefined;
  /**
   *
   */
  totalCostUsd?: number | undefined;
  /**
   *
   */
  durationMs: number;
  /**
   *
   */
  error?: Error | undefined;
  /**
   *
   */
  isPartial: boolean;
  /**
   *
   */
  metadata: {
    /**
     *
     */
    startedAt: string;
    /**
     *
     */
    endedAt: string;
    /**
     *
     */
    messageCount: number;
  };
};

/**
 *
 */
export type AgentRunner = TelemetryLifecycle & {
  /**
   *
   */
  runAgent: (options: AgentRunOptions) => Promise<AgentRunResult>;
};

/**
 *
 */
export type MutableClaudeSdkModule = {
  [Key in keyof ClaudeSdkModule]: ClaudeSdkModule[Key];
};
