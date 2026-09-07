import { createClaudeAdapter } from './adapters/claude-adapter.js';
import {
  AgentRunnerError,
  MessageHandlerError,
  SandboxConfigurationError,
} from './errors.js';
import { executeJudge } from './judge/executor.js';
import { postScores as postScoresToLangfuse } from './judge/scoring.js';
import type {
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  ScoreEntry,
} from './judge/types.js';
import { resolveSandboxConfig } from './sandbox/config.js';
import { createTelemetryController } from './telemetry/controller.js';
import { createMessageHandler } from './telemetry/message-handler.js';
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  AgentRunnerConfig,
  ClaudeQueryInput,
  ClaudeQueryOptions,
  ProviderAdapter,
  ProviderRunMetadata,
  RunConfig,
} from './types.js';

/**
 * Assembles an agent run result from collected messages and timing data.
 *
 * @param messages - The collected agent messages.
 * @param startedAtMs - Run start timestamp in milliseconds.
 * @param endedAtMs - Run end timestamp in milliseconds.
 * @param error - Optional error if the run failed or was interrupted.
 * @param traceId - Optional Langfuse trace identifier from the telemetry handler.
 * @returns The structured agent run result.
 */
function createResult(
  messages: AgentMessage[],
  startedAtMs: number,
  endedAtMs: number,
  error?: Error,
  traceId?: string,
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
    traceId,
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
 * Converts a provider prompt into best-effort telemetry text.
 *
 * @param prompt - Provider-specific prompt value.
 * @returns A safe prompt representation for telemetry.
 */
function getTelemetryPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') {
    return prompt;
  }

  try {
    const serialized = JSON.stringify(prompt);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to a guarded string conversion.
  }

  try {
    return String(prompt);
  } catch {
    return '[unserializable prompt]';
  }
}

/**
 * Reads adapter-owned telemetry metadata without affecting agent execution.
 *
 * @param adapter - Active provider adapter.
 * @param options - Merged provider-specific run options.
 * @returns Provider metadata with neutral harness fallbacks.
 */
function getTelemetryRunMetadata<TOptions extends object, TPrompt>(
  adapter: ProviderAdapter<TOptions, TPrompt>,
  options: Partial<TOptions>,
): Required<ProviderRunMetadata> {
  try {
    const metadata = adapter.getRunMetadata?.(options);
    return {
      model: metadata?.model ?? 'unknown',
      maxTurns: metadata?.maxTurns ?? 0,
    };
  } catch {
    return { model: 'unknown', maxTurns: 0 };
  }
}

/**
 * Creates an agent runner with optional telemetry support.
 *
 * @param config - Runner configuration including telemetry and default options.
 * @returns The agent runner instance.
 */
export function createAgentRunner<TOptions extends object, TPrompt>(
  config: AgentRunnerConfig<TOptions, TPrompt> & {
    /** Custom provider adapter defining the runner's option and prompt types. */
    adapter: ProviderAdapter<TOptions, TPrompt>;
  },
): AgentRunner<TOptions, TPrompt>;
/**
 * Creates the default Claude agent runner.
 *
 * @param config - Claude runner configuration with an optional Claude adapter.
 * @returns A runner typed to Claude query options and prompts.
 */
export function createAgentRunner(
  config?: AgentRunnerConfig<ClaudeQueryOptions, ClaudeQueryInput['prompt']>,
): AgentRunner<ClaudeQueryOptions, ClaudeQueryInput['prompt']>;
/**
 * Implements the public Claude and custom-provider overloads.
 *
 * @param config - Runner configuration.
 * @returns The configured agent runner.
 */
export function createAgentRunner<
  TOptions extends object = ClaudeQueryOptions,
  TPrompt = ClaudeQueryInput['prompt'],
>(
  config: AgentRunnerConfig<TOptions, TPrompt> = {},
): AgentRunner<TOptions, TPrompt> {
  const telemetry = createTelemetryController(config.telemetry);
  // Public overloads only permit an omitted adapter for the Claude option and
  // prompt types. This cast unifies that default with the generic implementation.
  const adapter = (config.adapter ?? createClaudeAdapter()) as ProviderAdapter<
    TOptions,
    TPrompt
  >;

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
    runAgent: async (
      runOptions: AgentRunOptions<TOptions, TPrompt>,
    ): Promise<AgentRunResult> => {
      const options = {
        ...adapter.defaultOptions,
        ...config.defaultOptions,
        ...runOptions.options,
      };
      const messages: AgentMessage[] = [];
      const startedAtMs = Date.now();
      let handler;
      if (telemetry.enabled) {
        const promptText = getTelemetryPrompt(runOptions.prompt);
        const runMetadata = getTelemetryRunMetadata(adapter, options);
        handler = createMessageHandler({
          prompt: promptText,
          model: runMetadata.model,
          maxTurns: runMetadata.maxTurns,
          redact: telemetry.redact,
          redactor: telemetry.redactor,
          userId: runOptions.telemetry?.userId ?? 'unknown',
          initialSessionId: runOptions.telemetry?.sessionId,
          traceName: runOptions.telemetry?.traceName,
          traceMetadata: runOptions.telemetry?.metadata,
          traceTags: runOptions.telemetry?.tags,
          traceVersion: runOptions.telemetry?.version,
        });
      }

      let runError: Error | undefined;

      try {
        const sandbox = resolveSandboxConfig(
          config.sandbox,
          runOptions.sandbox,
        );

        if (sandbox !== undefined) {
          const supported = adapter.capabilities?.sandboxes ?? [];
          if (!supported.includes(sandbox.type)) {
            throw new SandboxConfigurationError(
              `Provider adapter \`${adapter.name}\` does not support sandbox type \`${sandbox.type}\`.`,
            );
          }
        }

        const runConfig: RunConfig<TOptions, TPrompt> =
          sandbox === undefined
            ? { prompt: runOptions.prompt, options }
            : { prompt: runOptions.prompt, options, sandbox };
        if (runOptions.signal !== undefined) {
          runConfig.signal = runOptions.signal;
        }
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

      const handlerTraceId = handler?.getState().traceId;
      return createResult(
        messages,
        startedAtMs,
        Date.now(),
        runError,
        handlerTraceId,
      );
    },
    /**
     * Runs an LLM-as-a-judge evaluation, optionally posting scores to telemetry.
     *
     * @param runResult - The completed agent run to evaluate.
     * @param judgeConfig - Judge configuration including rubric and score schema.
     * @param context - Optional task context forwarded to the judge prompt.
     * @param options - Judge options including score posting and message callback.
     * @returns The judge evaluation result with scores and reasoning.
     */
    judge: async (
      runResult: AgentRunResult,
      judgeConfig: JudgeConfig<TOptions>,
      context?: JudgeContext,
      options?: JudgeOptions,
    ): Promise<JudgeResult> => {
      const structuredDefaults = adapter.getStructuredDefaults
        ? adapter.getStructuredDefaults(config.defaultOptions ?? {})
        : {};
      const result = await executeJudge(
        runResult,
        judgeConfig,
        context,
        options?.onMessage,
        adapter.runStructured === undefined
          ? undefined
          : {
              run: adapter.runStructured,
              defaults: structuredDefaults,
              sandbox: resolveSandboxConfig(config.sandbox, options?.sandbox),
              signal: options?.signal,
            },
      );

      if (options?.postScores && telemetry.enabled && runResult.traceId) {
        const scoreEntries: ScoreEntry[] = Object.entries(result.scores).map(
          ([name, value]) => ({
            name: `judge_${name}`,
            value,
            comment: result.reasoning,
          }),
        );

        await postScoresToLangfuse(
          runResult.traceId,
          scoreEntries,
          config.telemetry,
        );
      }

      return result;
    },
    /**
     * Posts scores to the telemetry backend for a completed agent run.
     *
     * @param runResult - The agent run result whose trace receives the scores.
     * @param scores - Score entries to post.
     */
    postScores: async (
      runResult: AgentRunResult,
      scores: ScoreEntry[],
    ): Promise<void> => {
      await postScoresToLangfuse(runResult.traceId, scores, config.telemetry);
    },
  };
}
