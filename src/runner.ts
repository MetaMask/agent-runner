import { isTelemetryEnabled } from './env.js';
import { AgentRunnerError, MessageHandlerError } from './errors.js';
import { loadClaudeSdk } from './sdk-loader.js';
import { createTelemetryController } from './telemetry.js';
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  AgentRunnerConfig,
  ClaudeQueryOptions,
  ClaudeSdkQueryModule,
  SdkMessage,
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
 * Extracts a string field from an SDK message.
 *
 * @param message - The SDK message to read from.
 * @param field - The field name to extract.
 * @returns The string value if present, or undefined.
 */
function extractStringField(
  message: SdkMessage,
  field: string,
): string | undefined {
  if (typeof message !== 'object' || message === null || !(field in message)) {
    return undefined;
  }

  const value = message[field as keyof SdkMessage];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extracts a numeric field from an SDK message.
 *
 * @param message - The SDK message to read from.
 * @param field - The field name to extract.
 * @returns The numeric value if present, or undefined.
 */
function extractNumberField(
  message: SdkMessage,
  field: string,
): number | undefined {
  if (typeof message !== 'object' || message === null || !(field in message)) {
    return undefined;
  }

  const value = message[field as keyof SdkMessage];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Checks whether an SDK message is a result message.
 *
 * @param message - The SDK message to check.
 * @returns Whether the message type is 'result'.
 */
function isResultMessage(message: SdkMessage): boolean {
  return extractStringField(message, 'type') === 'result';
}

/**
 * Assembles an agent run result from collected messages and timing data.
 *
 * @param messages - The collected SDK messages.
 * @param startedAtMs - Run start timestamp in milliseconds.
 * @param endedAtMs - Run end timestamp in milliseconds.
 * @param error - Optional error if the run failed or was interrupted.
 * @returns The structured agent run result.
 */
function createResult(
  messages: SdkMessage[],
  startedAtMs: number,
  endedAtMs: number,
  error?: Error,
): AgentRunResult {
  const resultMessage = [...messages].reverse().find(isResultMessage);

  return {
    messages,
    resultMessage,
    sessionId: resultMessage
      ? extractStringField(resultMessage, 'session_id')
      : undefined,
    totalCostUsd: resultMessage
      ? extractNumberField(resultMessage, 'total_cost_usd')
      : undefined,
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
  const sdkModule: ClaudeSdkQueryModule =
    config.sdkModule ?? loadClaudeSdk(isTelemetryEnabled(config.telemetry));

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
    runAgent: async (runOptions: AgentRunOptions) =>
      telemetry.runWithObservation(
        runOptions.telemetry,
        async (observation) => {
          const options = {
            ...defaultQueryOptions(),
            ...config.defaultOptions,
            ...runOptions.options,
          };
          const messages: SdkMessage[] = [];
          const startedAtMs = Date.now();

          try {
            for await (const message of sdkModule.query({
              prompt: runOptions.prompt,
              options,
            })) {
              messages.push(message);

              if (runOptions.onMessage) {
                try {
                  await runOptions.onMessage(message);
                } catch (handlerError) {
                  const cause =
                    handlerError instanceof Error
                      ? handlerError
                      : new Error(String(handlerError));

                  const handlerFailure = new MessageHandlerError(cause);
                  observation.recordError(handlerFailure);
                  return createResult(
                    messages,
                    startedAtMs,
                    Date.now(),
                    handlerFailure,
                  );
                }
              }
            }
          } catch (error) {
            const runError =
              error instanceof Error
                ? error
                : new AgentRunnerError(String(error));

            observation.recordError(runError);
            return createResult(messages, startedAtMs, Date.now(), runError);
          }

          return createResult(messages, startedAtMs, Date.now());
        },
      ),
  };
}
