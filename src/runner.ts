import { createClaudeAdapter } from './adapters/claude-adapter.js';
import { AgentRunnerError, MessageHandlerError } from './errors.js';
import { createMessageHandler } from './message-handler.js';
import { createTelemetryController } from './telemetry.js';
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  AgentRunnerConfig,
  ClaudeQueryOptions,
  ProviderAdapter,
  RunConfig,
} from './types.js';

/**
 * Returns default query options with isolated settings.
 *
 * @returns Default query options.
 */
function defaultQueryOptions(): Partial<ClaudeQueryOptions> {
  return { settingSources: [] };
}

/**
 * Assembles an agent run result from collected messages and timing data.
 *
 * @param messages - The collected agent messages.
 * @param startedAtMs - Run start timestamp in milliseconds.
 * @param endedAtMs - Run end timestamp in milliseconds.
 * @param error - Optional error if the run failed or was interrupted.
 * @returns The structured agent run result.
 */
function createResult(
  messages: AgentMessage[],
  startedAtMs: number,
  endedAtMs: number,
  error?: Error,
): AgentRunResult {
  const resultMessage = [...messages]
    .reverse()
    .find((message) => message.type === 'result');
  const initMessage = messages.find((message) => message.type === 'init');
  const sessionId =
    initMessage?.type === 'init' ? initMessage.sessionId : undefined;

  return {
    messages,
    resultMessage,
    sessionId,
    totalCostUsd:
      resultMessage?.type === 'result' ? resultMessage.costUsd : undefined,
    durationMs: endedAtMs - startedAtMs,
    error,
    isPartial: error !== undefined,
    metadata: {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      messageCount: messages.length,
    },
  };
}

/**
 * Creates an agent runner with optional telemetry support.
 *
 * @param config - Runner configuration including telemetry and default options.
 * @returns The agent runner instance.
 */
export function createAgentRunner(config: AgentRunnerConfig = {}): AgentRunner {
  const telemetry = createTelemetryController(config.telemetry);
  const adapter: ProviderAdapter = config.adapter ?? createClaudeAdapter();

  return {
    enabled: telemetry.enabled,
    flush: telemetry.flush,
    shutdown: telemetry.shutdown,
    /**
     * Executes a single agent run, streaming messages through the optional callback.
     *
     * @param runOptions - Options for this agent run.
     * @returns The agent run result with collected messages and metadata.
     */
    runAgent: async (runOptions: AgentRunOptions): Promise<AgentRunResult> => {
      const options = {
        ...defaultQueryOptions(),
        ...config.defaultOptions,
        ...runOptions.options,
      };
      const messages: AgentMessage[] = [];
      const startedAtMs = Date.now();
      const promptText =
        typeof runOptions.prompt === 'string'
          ? runOptions.prompt
          : JSON.stringify(runOptions.prompt);
      const handler = telemetry.enabled
        ? createMessageHandler({
            prompt: promptText,
            model: (options.model as string) ?? 'unknown',
            maxTurns: (options.maxTurns as number) ?? 0,
            redact: telemetry.redact,
            userId: runOptions.telemetry?.userId ?? 'unknown',
            initialSessionId: runOptions.telemetry?.sessionId,
            traceName: runOptions.telemetry?.traceName,
            traceMetadata: runOptions.telemetry?.metadata,
            traceTags: runOptions.telemetry?.tags,
            traceVersion: runOptions.telemetry?.version,
          })
        : undefined;

      let runError: Error | undefined;

      try {
        const runConfig: RunConfig = { prompt: runOptions.prompt, options };
        for await (const message of adapter.run(runConfig)) {
          messages.push(message);
          handler?.handleMessage(message);

          if (runOptions.onMessage) {
            try {
              await runOptions.onMessage(message);
            } catch (handlerError) {
              const cause =
                handlerError instanceof Error
                  ? handlerError
                  : new Error(String(handlerError));
              runError = new MessageHandlerError(cause);
              break;
            }
          }
        }
      } catch (error) {
        runError =
          error instanceof Error ? error : new AgentRunnerError(String(error));
      } finally {
        if (runError) {
          try {
            handler?.recordError(runError);
          } catch {
            // Telemetry is best-effort; error recording must not crash the run.
          }
        }
        try {
          handler?.finalizePendingTools();
        } catch {
          // Telemetry is best-effort; span cleanup must not crash the run.
        }
        try {
          handler?.finalizeSessionSpan();
        } catch {
          // Telemetry is best-effort; span cleanup must not crash the run.
        }
      }

      return createResult(messages, startedAtMs, Date.now(), runError);
    },
  };
}
