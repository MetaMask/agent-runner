import { query } from '@anthropic-ai/claude-agent-sdk';

import { extractTextContent, extractToolUseBlocks } from '../message-parser.js';
import type {
  AgentGenerationMessage,
  AgentMessage,
  ProviderAdapter,
  RunConfig,
  TokenUsage,
} from '../types.js';

/**
 * Wire-format shape for a tool result block from the Claude SDK.
 */
type RawToolResultBlock = {
  /** Block type discriminant. */
  type: 'tool_result';
  /** Identifier linking the result to its originating tool call. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  tool_use_id: string;
  /** Content returned by the tool execution. */
  content: unknown;
  /** Whether the tool execution produced an error. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  is_error?: boolean;
};

/**
 * Creates a provider adapter backed by the Claude Agent SDK.
 *
 * @returns The Claude provider adapter.
 */
export function createClaudeAdapter(): ProviderAdapter {
  return {
    name: 'claude',
    /**
     * Runs the Claude query and yields translated agent messages.
     *
     * The Claude SDK may emit multiple `assistant` messages for a single
     * model turn during streaming, each carrying the same token usage but
     * different content blocks (empty → text → tool_use). This method
     * buffers emissions that share the same inner `BetaMessage.id` and
     * yields a single merged generation per turn.
     *
     * @param config - The run configuration for the Claude query.
     * @yields Translated agent messages from the SDK response stream.
     */
    async *run(config: RunConfig): AsyncGenerator<AgentMessage> {
      let pending:
        | {
            /** Merged generation being accumulated for the current turn. */
            generation: AgentGenerationMessage;
            /** Inner BetaMessage ID used as the dedup key. */
            messageId: string;
          }
        | undefined;

      for await (const rawMessage of query({
        prompt: config.prompt,
        options: config.options,
      })) {
        const raw = rawMessage as Record<string, unknown>;

        if (raw.type === 'assistant') {
          const inner = getRecord(raw.message);
          if (!inner) {
            continue;
          }

          const messageId = getOptionalString(inner.id);

          // Same model turn — merge content into the pending generation.
          if (messageId && messageId === pending?.messageId) {
            mergeAssistantEmission(pending.generation, inner, raw);
            continue;
          }

          // Different turn — flush the previous pending generation.
          if (pending) {
            yield pending.generation;
            pending = undefined;
          }

          const translated = translateAssistantMessage(inner, raw);
          if (messageId) {
            pending = { generation: translated, messageId };
          } else {
            yield translated;
          }
        } else {
          // Non-assistant message — flush any pending generation first.
          if (pending) {
            yield pending.generation;
            pending = undefined;
          }

          for (const message of translateMessage(raw)) {
            yield message;
          }
        }
      }

      // Flush the final pending generation at stream end.
      if (pending) {
        yield pending.generation;
      }
    },
  };
}

/**
 * Merges content from a later assistant emission into an existing generation
 * for the same model turn.
 *
 * @param target - The generation message to merge into (mutated in place).
 * @param inner - The inner BetaMessage record from the raw SDK message.
 * @param rawMessage - The raw SDK assistant message, kept for the `raw` field.
 */
function mergeAssistantEmission(
  target: AgentGenerationMessage,
  inner: Record<string, unknown>,
  rawMessage: Record<string, unknown>,
): void {
  const text = extractTextContent(inner);
  if (text) {
    target.text = target.text ? `${target.text}${text}` : text;
  }

  const toolCalls = extractToolUseBlocks(inner);
  if (toolCalls.length > 0) {
    target.toolCalls = [...target.toolCalls, ...toolCalls];
  }

  const stopReason = getOptionalString(inner.stop_reason) ?? null;
  if (stopReason) {
    target.stopReason = stopReason;
  }

  target.raw = rawMessage;
}

/**
 * Translates a raw SDK message into one or more typed agent messages.
 *
 * Most message types produce exactly one output, but user messages with
 * parallel tool results expand into one {@link AgentMessage} per result.
 *
 * @param message - The raw SDK message to translate.
 * @returns The translated agent messages, empty for unrecognised types.
 */
function translateMessage(message: Record<string, unknown>): AgentMessage[] {
  switch (message.type) {
    case 'system':
      return [translateSystemMessage(message)];
    case 'user':
      return translateUserMessages(message);
    case 'tool_progress':
      return [translateToolProgressMessage(message)];
    case 'tool_use_summary':
      return [translateToolUseSummaryMessage(message)];
    case 'result':
      return [translateResultMessage(message)];
    case 'rate_limit_event':
      return [translateRateLimitMessage(message)];
    default:
      return [];
  }
}

/**
 * Translates a system-type SDK message into an agent message.
 *
 * @param message - The raw system message from the SDK.
 * @returns The translated system or init agent message.
 */
function translateSystemMessage(
  message: Record<string, unknown>,
): AgentMessage {
  const subtype = typeof message.subtype === 'string' ? message.subtype : '';

  if (subtype === 'init') {
    return {
      type: 'init',
      sessionId: getString(message.session_id),
      ...spreadOptional('model', getOptionalString(message.model)),
      ...spreadOptional('tools', getStringArray(message.tools)),
      raw: message,
    };
  }

  return {
    ...message,
    type: 'system',
    subtype,
    raw: message,
  };
}

/**
 * Translates the inner BetaMessage of an assistant SDK message into a generation.
 *
 * @param inner - The inner BetaMessage record.
 * @param rawMessage - The full raw SDK assistant message, kept for the `raw` field.
 * @returns The translated generation message.
 */
function translateAssistantMessage(
  inner: Record<string, unknown>,
  rawMessage: Record<string, unknown>,
): AgentGenerationMessage {
  return {
    type: 'generation',
    model: getString(inner.model),
    text: extractTextContent(inner),
    toolCalls: extractToolUseBlocks(inner),
    usage: translateUsage(inner.usage),
    stopReason: getOptionalString(inner.stop_reason) ?? null,
    raw: rawMessage,
  };
}

/**
 * Translates a user-type SDK message into tool result agent messages.
 *
 * A single SDK user message may contain multiple tool result blocks when
 * Claude executes tools in parallel, so this returns one
 * {@link AgentMessage} per result block.
 *
 * @param message - The raw user message from the SDK.
 * @returns The translated tool result messages, empty when none are found.
 */
function translateUserMessages(
  message: Record<string, unknown>,
): AgentMessage[] {
  const inner = getRecord(message.message);
  const toolResults = getToolResultBlocks(inner?.content);

  return toolResults.map((toolResult) => ({
    type: 'tool_result' as const,
    toolUseId: toolResult.tool_use_id,
    content: extractToolResultContent(toolResult.content),
    isError: toolResult.is_error ?? false,
    raw: message,
  }));
}

/**
 * Translates a tool progress SDK message into an agent message.
 *
 * @param message - The raw tool progress message from the SDK.
 * @returns The translated tool progress agent message.
 */
function translateToolProgressMessage(
  message: Record<string, unknown>,
): AgentMessage {
  return {
    type: 'tool_progress',
    toolName: getString(message.tool_name),
    elapsedSeconds: getNumber(message.elapsed_seconds),
    raw: message,
  };
}

/**
 * Translates a tool use summary SDK message into an agent message.
 *
 * @param message - The raw tool use summary message from the SDK.
 * @returns The translated tool use summary agent message.
 */
function translateToolUseSummaryMessage(
  message: Record<string, unknown>,
): AgentMessage {
  return {
    type: 'tool_use_summary',
    summary: getString(message.summary),
    raw: message,
  };
}

/**
 * Translates a result SDK message into an agent message.
 *
 * @param message - The raw result message from the SDK.
 * @returns The translated result agent message.
 */
function translateResultMessage(
  message: Record<string, unknown>,
): AgentMessage {
  return {
    type: 'result',
    success: message.subtype === 'success',
    ...spreadOptional('result', getOptionalString(message.result)),
    ...spreadOptional('costUsd', getOptionalNumber(message.total_cost_usd)),
    ...spreadOptional('turns', getOptionalNumber(message.num_turns)),
    ...spreadOptional('durationMs', getOptionalNumber(message.duration_ms)),
    ...spreadOptional('error', getOptionalString(message.error)),
    raw: message,
  };
}

/**
 * Translates a rate limit event SDK message into an agent message.
 *
 * @param message - The raw rate limit event message from the SDK.
 * @returns The translated rate limit agent message.
 */
function translateRateLimitMessage(
  message: Record<string, unknown>,
): AgentMessage {
  const rateLimitInfo = getRecord(message.rate_limit_info);

  return {
    type: 'rate_limit',
    status: getString(rateLimitInfo?.status),
    raw: message,
  };
}

/**
 * Translates raw token usage data into a typed usage object.
 *
 * @param input - The raw usage data from the SDK response.
 * @returns The translated token usage object.
 */
function translateUsage(input: unknown): TokenUsage {
  const usage = getRecord(input);

  return {
    inputTokens: getNumber(usage?.input_tokens),
    outputTokens: getNumber(usage?.output_tokens),
    ...spreadOptional(
      'cacheReadTokens',
      getOptionalNumber(usage?.cache_read_input_tokens),
    ),
    ...spreadOptional(
      'cacheCreationTokens',
      getOptionalNumber(usage?.cache_creation_input_tokens),
    ),
  };
}

/**
 * Extracts all tool result blocks from a content array.
 *
 * @param input - The raw content value to search for tool result blocks.
 * @returns The tool result blocks found.
 */
function getToolResultBlocks(input: unknown): RawToolResultBlock[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter(isToolResultBlock);
}

/**
 * Type guard that checks whether a value is a tool result block.
 *
 * @param input - The value to check.
 * @returns Whether the input is a valid tool result block.
 */
function isToolResultBlock(input: unknown): input is RawToolResultBlock {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'tool_result' &&
    'tool_use_id' in input &&
    typeof input.tool_use_id === 'string' &&
    'content' in input &&
    (!('is_error' in input) || typeof input.is_error === 'boolean')
  );
}

/**
 * Extracts text content from a tool result block's content field.
 *
 * @param content - The tool result content to extract text from.
 * @returns The extracted text content.
 */
function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
}

/**
 * Type guard that checks whether a value is a text content block.
 *
 * @param input - The value to check.
 * @returns Whether the input is a valid text block.
 */
function isTextBlock(input: unknown): input is {
  /** Block type discriminant. */
  type: 'text';
  /** Text content of the block. */
  text: string;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'text' &&
    'text' in input &&
    typeof input.text === 'string'
  );
}

/**
 * Safely casts an unknown value to a Record if it is a non-null object.
 *
 * @param input - The value to cast.
 * @returns The value as a Record, or undefined when not applicable.
 */
function getRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }

  return input as Record<string, unknown>;
}

/**
 * Safely reads a string value, defaulting to an empty string.
 *
 * @param input - The value to read.
 * @returns The string value, or an empty string when non-string.
 */
function getString(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

/**
 * Safely reads an optional string value.
 *
 * @param input - The value to read.
 * @returns The string value, or undefined when non-string.
 */
function getOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

/**
 * Safely reads a numeric value, defaulting to zero.
 *
 * @param input - The value to read.
 * @returns The numeric value, or zero when non-number.
 */
function getNumber(input: unknown): number {
  return typeof input === 'number' ? input : 0;
}

/**
 * Safely reads an optional numeric value.
 *
 * @param input - The value to read.
 * @returns The numeric value, or undefined when non-number.
 */
function getOptionalNumber(input: unknown): number | undefined {
  return typeof input === 'number' ? input : undefined;
}

/**
 * Safely reads an array of strings from an unknown value.
 *
 * @param input - The value to read.
 * @returns The filtered string array, or undefined when input is not an array.
 */
function getStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  return input.filter((value): value is string => typeof value === 'string');
}

/**
 * Returns a single-key object when the value is defined, or an empty object otherwise.
 *
 * Designed for use with object spread to conditionally include optional fields.
 *
 * @param key - The property key.
 * @param value - The value to include when defined.
 * @returns An object with the key-value pair, or an empty object.
 */
function spreadOptional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [K in Key]: Value } | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as { [K in Key]: Value };
}
