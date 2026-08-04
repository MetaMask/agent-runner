import { redactSensitive } from '../message-parser.js';
import type { AgentMessage, TelemetryRedactor, ToolCall } from '../types.js';
import {
  createSessionSpan,
  recordSpanError,
  setOtelAttrs,
  traceSpan,
} from './tracing.js';
import type { SpanHandle } from './tracing.js';

/**
 * Configuration used by the tracing message handler.
 */
export type MessageHandlerConfig = {
  /**
   * The prompt used to start the agent run.
   */
  prompt: string;
  /**
   * The default model name for generated observations.
   */
  model: string;
  /**
   * The configured maximum number of turns.
   */
  maxTurns: number;
  /**
   * Whether sensitive prompt and payload values should be redacted.
   */
  redact: boolean;
  /**
   * Optional value-level redactor applied to span I/O string leaves when
   * blanket redaction is not already in effect for that value.
   */
  redactor?: TelemetryRedactor | undefined;
  /**
   * The user identifier to attach to trace propagation.
   */
  userId: string;
  /**
   * The initial Langfuse session identifier, if known before init.
   */
  initialSessionId: string | undefined;
  /**
   * Name for the root Langfuse trace observation.
   */
  traceName?: string | undefined;
  /**
   * Arbitrary metadata attached to the trace.
   */
  traceMetadata?: Record<string, string> | undefined;
  /**
   * Tags for filtering and categorisation in Langfuse.
   */
  traceTags?: string[] | undefined;
  /**
   * Application version for the trace.
   */
  traceVersion?: string | undefined;
};

/**
 * Mutable tracing state accumulated while messages flow through the runner.
 */
export type MessageHandlerState = {
  /**
   * Total input tokens reported by generation messages.
   */
  totalInputTokens: number;
  /**
   * Total output tokens reported by generation messages.
   */
  totalOutputTokens: number;
  /**
   * Number of generation turns observed.
   */
  turns: number;
  /**
   * Final agent result text, if provided.
   */
  finalResult: string | undefined;
  /**
   * Langfuse session identifier used for trace propagation.
   */
  langfuseSessionId: string | undefined;
  /**
   * Root agent session span.
   */
  sessionSpan: SpanHandle | undefined;
  /**
   * The latest input used for generation span context.
   */
  lastTurnInput: string;
  /**
   * Langfuse trace identifier for the session span.
   */
  traceId: string | undefined;
  /**
   * Error that terminated the run, recorded for telemetry.
   */
  runError: Error | undefined;
  /**
   * Tool spans that have been started but have not received a result.
   */
  pendingTools: Map<
    string,
    {
      /** Tool name. */
      name: string;
      /** Tool input arguments. */
      input: unknown;
      /** Langfuse observation span for the tool invocation. */
      span: SpanHandle;
    }
  >;
};

/**
 * Message handler interface for tracing agent messages.
 */
export type MessageHandler = {
  /**
   * Handles one parsed agent message.
   *
   * @param message - The message to process.
   * @returns undefined.
   */
  handleMessage: (message: AgentMessage) => void;
  /**
   * Closes any pending tool spans that did not receive a result message.
   *
   * @returns undefined.
   */
  finalizePendingTools: () => void;
  /**
   * Records a run error for telemetry reporting.
   *
   * @param error - The error to record.
   */
  recordError: (error: Error) => void;
  /**
   * Updates and closes the root session span.
   *
   * @returns undefined.
   */
  finalizeSessionSpan: () => void;
  /**
   * Returns the current mutable handler state.
   *
   * @returns The current message handler state.
   */
  getState: () => MessageHandlerState;
};

/**
 * Creates a tracing-aware message handler for agent runner messages.
 *
 * @param config - Configuration for the message handler.
 * @returns A message handler with lifecycle finalizers.
 */
export function createMessageHandler(
  config: MessageHandlerConfig,
): MessageHandler {
  /**
   * Applies the configured value-level redactor to a string, if any.
   *
   * @param value - The string leaf to scrub.
   * @returns The scrubbed string, or the original when no redactor is set
   * or the value is undefined.
   */
  function scrubText<Value extends string | undefined>(value: Value): Value {
    if (config.redactor && typeof value === 'string') {
      return config.redactor(value) as Value;
    }
    return value;
  }

  /**
   * Recursively applies the value-level redactor to string leaves of a
   * structured value, preserving the surrounding object and array shape.
   *
   * @param value - The value to scrub.
   * @returns The value with string leaves scrubbed.
   */
  function scrubValueLeaves(value: unknown): unknown {
    if (!config.redactor) {
      return value;
    }

    if (typeof value === 'string') {
      return config.redactor(value);
    }

    if (Array.isArray(value)) {
      return value.map(scrubValueLeaves);
    }

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          scrubValueLeaves(entry),
        ]),
      );
    }

    return value;
  }

  const state: MessageHandlerState = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turns: 0,
    finalResult: undefined,
    langfuseSessionId: config.initialSessionId,
    sessionSpan: undefined,
    lastTurnInput: config.redact ? '[REDACTED]' : scrubText(config.prompt),
    traceId: undefined,
    runError: undefined,
    pendingTools: new Map(),
  };

  /**
   * Handles an init message by creating the root session span.
   *
   * @param message - The agent message to process.
   */
  function handleInit(message: AgentMessage): void {
    if (message.type !== 'init') {
      return;
    }

    state.langfuseSessionId = message.sessionId;
    traceSpan(
      {
        sessionId: state.langfuseSessionId,
        userId: config.userId,
        metadata: config.traceMetadata,
        tags: config.traceTags,
        version: config.traceVersion,
      },
      () => {
        const session = createSessionSpan(
          config.traceName ?? 'agent-runner',
          config.redact ? config.prompt : scrubText(config.prompt),
          {
            model: message.model ?? config.model,
            maxTurns: config.maxTurns,
            tools: message.tools ?? [],
          },
          config.redact,
        );

        state.sessionSpan = session?.span;
        state.traceId = session?.traceId;
      },
    );
  }

  /**
   * Handles a generation message by recording token usage and creating spans.
   *
   * @param message - The agent message to process.
   */
  function handleGeneration(message: AgentMessage): void {
    if (message.type !== 'generation') {
      return;
    }

    state.turns += 1;
    state.totalInputTokens += message.usage.inputTokens;
    state.totalOutputTokens += message.usage.outputTokens;

    traceSpan(
      {
        sessionId: state.langfuseSessionId,
        userId: config.userId,
        metadata: config.traceMetadata,
        tags: config.traceTags,
        version: config.traceVersion,
      },
      () => {
        const parent = state.sessionSpan;
        if (!parent) {
          return;
        }

        const output = config.redact
          ? '[REDACTED]'
          : scrubText(message.text || JSON.stringify(message.toolCalls));
        const span = parent.startObservation(
          message.model || config.model,
          {
            input: state.lastTurnInput,
            output,
            metadata: { stopReason: message.stopReason },
          },
          { asType: 'generation' },
        );

        setOtelAttrs(span, {
          'langfuse.observation.model.name': message.model || config.model,
          'gen_ai.usage.input_tokens': message.usage.inputTokens,
          'gen_ai.usage.output_tokens': message.usage.outputTokens,
          'gen_ai.usage.cache_read_input_tokens': message.usage.cacheReadTokens,
          'gen_ai.usage.cache_creation_input_tokens':
            message.usage.cacheCreationTokens,
        });
        span.end();

        for (const toolCall of message.toolCalls) {
          createPendingToolSpan(toolCall);
        }
      },
    );
  }

  /**
   * Handles a tool result message by closing the matching pending tool span.
   *
   * @param message - The agent message to process.
   */
  function handleToolResult(message: AgentMessage): void {
    if (message.type !== 'tool_result') {
      return;
    }

    const pendingTool = state.pendingTools.get(message.toolUseId);
    if (!pendingTool) {
      return;
    }

    pendingTool.span.update({
      output: config.redact ? '[REDACTED]' : scrubText(message.content),
      metadata: { isError: message.isError },
    });
    pendingTool.span.end();
    state.pendingTools.delete(message.toolUseId);
    state.lastTurnInput = config.redact
      ? '[REDACTED]'
      : scrubText(message.content);
  }

  /**
   * Handles a result message by storing the final result or error text.
   *
   * @param message - The agent message to process.
   */
  function handleResult(message: AgentMessage): void {
    if (message.type === 'result') {
      state.finalResult = message.result ?? message.error;
    }
  }

  /**
   * Creates a pending tool span for a tool call from a generation message.
   *
   * @param toolCall - The tool call to create a span for.
   */
  function createPendingToolSpan(toolCall: ToolCall): void {
    const input = config.redact
      ? redactSensitive(toolCall.input)
      : scrubValueLeaves(toolCall.input);
    const span = state.sessionSpan?.startObservation(
      formatToolLabel(toolCall.name, input),
      { input },
      { asType: 'tool' },
    );

    if (span) {
      state.pendingTools.set(toolCall.id, {
        name: toolCall.name,
        input,
        span,
      });
    }
  }

  /**
   * Closes all pending tool spans that did not receive a result message.
   */
  function finalizePendingTools(): void {
    for (const pendingTool of state.pendingTools.values()) {
      pendingTool.span.update({ output: '[no result received]' });
      pendingTool.span.end();
    }
    state.pendingTools.clear();
  }

  /**
   * Updates and closes the root session span with final summary data.
   */
  function finalizeSessionSpan(): void {
    if (!state.sessionSpan) {
      return;
    }

    const hasError = state.runError !== undefined;
    const finalStatus =
      state.finalResult === undefined ? 'unknown' : 'completed';
    const status = hasError ? 'error' : finalStatus;

    const finalOutput = state.runError?.message ?? state.finalResult;
    state.sessionSpan.update({
      output: config.redact ? '[REDACTED]' : scrubText(finalOutput),
      level: hasError ? 'ERROR' : undefined,
      statusMessage: hasError ? state.runError?.message : undefined,
      metadata: {
        status,
        totalInputTokens: state.totalInputTokens,
        totalOutputTokens: state.totalOutputTokens,
        turns: state.turns,
      },
    });

    if (state.runError) {
      recordSpanError(state.sessionSpan, state.runError);
    }

    state.sessionSpan.end();
    state.sessionSpan = undefined;
  }

  return {
    /**
     * Dispatches a message to all sub-handlers.
     *
     * @param message - The agent message to handle.
     */
    handleMessage: (message: AgentMessage): void => {
      handleInit(message);
      handleGeneration(message);
      handleToolResult(message);
      handleResult(message);
    },
    /**
     * Stores a run error for telemetry finalization.
     *
     * @param error - The run error.
     */
    recordError: (error: Error): void => {
      state.runError = error;
    },
    finalizePendingTools,
    finalizeSessionSpan,
    /**
     * Returns the current mutable handler state.
     *
     * @returns The handler state snapshot.
     */
    getState: () => state,
  };
}

/**
 * Builds a human-readable label for a tool call span.
 *
 * @param toolName - The tool name to format.
 * @param input - The tool input used for label context.
 * @returns The formatted tool label string.
 */
function formatToolLabel(toolName: string, input: unknown): string {
  if (toolName === 'Bash' && hasStringProperty(input, 'command')) {
    return `Bash: ${shorten(input.command)}`;
  }

  if (toolName === 'Read' && hasStringProperty(input, 'file_path')) {
    return `Read: ${basename(input.file_path)}`;
  }

  if (toolName === 'Edit' && hasStringProperty(input, 'file_path')) {
    return `Edit: ${basename(input.file_path)}`;
  }

  return `tool:${toolName}`;
}

/**
 * Type guard that checks whether a value has a string property with the given key.
 *
 * @param input - The value to check.
 * @param key - The property key to look for.
 * @returns Whether the input has the specified string property.
 */
function hasStringProperty<Key extends string>(
  input: unknown,
  key: Key,
): input is Record<Key, string> {
  return (
    typeof input === 'object' &&
    input !== null &&
    key in input &&
    typeof (input as Record<Key, unknown>)[key] === 'string'
  );
}

/**
 * Extracts the file name from a file path.
 *
 * @param filePath - The full file path.
 * @returns The base file name.
 */
function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/**
 * Shortens a string to 80 characters with a trailing ellipsis.
 *
 * @param value - The string to shorten.
 * @returns The original or shortened string.
 */
function shorten(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
