import type { SdkMessage } from './types.js';

/**
 * Opaque record used for dynamic field access on SDK messages.
 */
type MessageRecord = Record<string, unknown>;

/**
 * Reads a string field from an SDK message record.
 *
 * @param record - The message record.
 * @param field - The field name to read.
 * @returns The string value, or undefined when absent or non-string.
 */
function readString(
  record: MessageRecord,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a numeric field from an SDK message record.
 *
 * @param record - The message record.
 * @param field - The field name to read.
 * @returns The numeric value, or undefined when absent or non-number.
 */
function readNumber(
  record: MessageRecord,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Safely casts an unknown value to a record for field access.
 *
 * @param value - The value to cast.
 * @returns A record, or undefined when the value is not an object.
 */
function asRecord(value: unknown): MessageRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as MessageRecord)
    : undefined;
}

const MAX_INPUT_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 1000;

/**
 * Formats a system message based on its subtype.
 *
 * @param record - The system message record.
 * @returns Formatted string, or null for subtypes that should be skipped.
 */
function formatSystemMessage(record: MessageRecord): string | null {
  const subtype = readString(record, 'subtype');

  switch (subtype) {
    case 'init': {
      const model = readString(record, 'model') ?? 'unknown';
      const tools = Array.isArray(record.tools)
        ? (record.tools as unknown[])
        : [];
      return `[init] model=${model} tools=${String(tools.length)}`;
    }
    case 'status': {
      const status = readString(record, 'status');
      return status ? `[status] ${status}` : null;
    }
    case 'api_retry': {
      const attempt = readNumber(record, 'attempt') ?? 0;
      const max = readNumber(record, 'max_retries') ?? 0;
      const delay = readNumber(record, 'retry_delay_ms') ?? 0;
      return `[retry] attempt ${String(attempt)}/${String(max)} (${String(delay)}ms delay)`;
    }
    case 'task_started': {
      const description = readString(record, 'description') ?? '';
      return `[task:started] ${description}`;
    }
    case 'task_notification': {
      const status = readString(record, 'status') ?? 'unknown';
      const summary = readString(record, 'summary') ?? '';
      return `[task:${status}] ${summary}`;
    }
    case 'task_progress': {
      const description = readString(record, 'description') ?? '';
      const lastTool = readString(record, 'last_tool_name');
      return `[task:progress] ${description}${lastTool ? ` (${lastTool})` : ''}`;
    }
    case 'local_command_output': {
      const content = readString(record, 'content');
      return content
        ? `[output] ${truncate(content, MAX_OUTPUT_LENGTH)}`
        : null;
    }
    default:
      return null;
  }
}

/**
 * Truncates a string to the given length, appending an ellipsis when trimmed.
 *
 * @param value - The string to truncate.
 * @param maxLength - Maximum allowed length.
 * @returns The original or truncated string.
 */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
}

/**
 * Extracts a concise representation of a tool_use input object.
 *
 * Prioritises well-known fields (`command`, `file_path`, `query`) so the
 * most useful piece of information is always visible. Falls back to compact
 * JSON for unknown tool shapes.
 *
 * @param input - The raw tool input value.
 * @returns A human-readable string, or empty string when input is unusable.
 */
function formatToolInput(input: unknown): string {
  const rec = asRecord(input);
  if (!rec) {
    return '';
  }

  const command = readString(rec, 'command');
  if (command) {
    return truncate(command, MAX_INPUT_LENGTH);
  }

  const filePath =
    readString(rec, 'file_path') ?? readString(rec, 'filePath');
  if (filePath) {
    return filePath;
  }

  const query = readString(rec, 'query');
  if (query) {
    return truncate(query, MAX_INPUT_LENGTH);
  }

  try {
    return truncate(JSON.stringify(input), MAX_INPUT_LENGTH);
  } catch {
    return '';
  }
}

/**
 * Formats content blocks from an assistant message into readable lines.
 *
 * @param blocks - The raw content block array.
 * @returns Array of formatted strings, one per visible block.
 */
function formatContentBlocks(blocks: unknown[]): string[] {
  const parts: string[] = [];

  for (const block of blocks) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }

    const blockType = readString(rec, 'type');
    if (blockType === 'text') {
      const text = readString(rec, 'text');
      if (text) {
        parts.push(text);
      }
    } else if (blockType === 'tool_use') {
      const name = readString(rec, 'name') ?? 'unknown';
      const inputStr = formatToolInput(rec.input);
      parts.push(
        inputStr ? `[tool_use] ${name}: ${inputStr}` : `[tool_use] ${name}`,
      );
    }
    // Thinking and redacted_thinking blocks are internal reasoning — skip.
  }

  return parts;
}

/**
 * Formats an assistant message, extracting text and tool-use blocks.
 *
 * @param record - The assistant message record.
 * @returns Formatted string, or null when the message has no visible content.
 */
function formatAssistantMessage(record: MessageRecord): string | null {
  const error = readString(record, 'error');
  if (error) {
    return `[error] ${error}`;
  }

  const inner = asRecord(record.message);
  if (!inner) {
    return null;
  }

  const content = Array.isArray(inner.content)
    ? (inner.content as unknown[])
    : [];
  const parts = formatContentBlocks(content);

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extracts text from a tool_result content field.
 *
 * Tool result content can be a plain string or an array of content blocks.
 * This normalises both forms into a single string.
 *
 * @param content - The raw content value from a tool_result block.
 * @returns The extracted text, or empty string when content is unusable.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const item of content as unknown[]) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const text = readString(rec, 'text');
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * Checks whether a content array contains at least one tool_result block.
 *
 * @param content - The raw content array from a user message.
 * @returns Whether any block has type 'tool_result'.
 */
function hasToolResultBlocks(content: unknown[]): boolean {
  return content.some((block) => {
    const rec = asRecord(block);
    return rec !== undefined && readString(rec, 'type') === 'tool_result';
  });
}

/**
 * Formats a synthetic user message containing tool results.
 *
 * Detects synthetic messages by checking either the `isSynthetic` flag
 * or the presence of `tool_result` content blocks. The flag is optional
 * in the SDK and may not always be set; content inspection is the
 * reliable fallback.
 *
 * Real user input (no tool results, not marked synthetic) is skipped
 * since callers already know what they sent.
 *
 * @param record - The user message record.
 * @returns Formatted tool output, or null for non-synthetic messages.
 */
function formatUserMessage(record: MessageRecord): string | null {
  const inner = asRecord(record.message);
  if (!inner) {
    return null;
  }

  const content = Array.isArray(inner.content)
    ? (inner.content as unknown[])
    : [];

  if (record.isSynthetic !== true && !hasToolResultBlocks(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }

    if (readString(rec, 'type') !== 'tool_result') {
      continue;
    }

    const isError = rec.is_error === true;
    const prefix = isError ? '[tool_error]' : '[tool_output]';
    const text = extractToolResultText(rec.content);
    if (text) {
      parts.push(`${prefix} ${truncate(text, MAX_OUTPUT_LENGTH)}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Formats a tool progress heartbeat.
 *
 * @param record - The tool progress message record.
 * @returns Formatted progress string.
 */
function formatToolProgress(record: MessageRecord): string | null {
  const name = readString(record, 'tool_name') ?? 'unknown';
  const elapsed = readNumber(record, 'elapsed_time_seconds') ?? 0;
  return `[tool_progress] ${name} (${String(elapsed)}s)`;
}

/**
 * Formats a tool use summary.
 *
 * @param record - The tool use summary message record.
 * @returns Formatted summary string, or null when summary is absent.
 */
function formatToolUseSummary(record: MessageRecord): string | null {
  const summary = readString(record, 'summary');
  return summary ? `[tool_summary] ${summary}` : null;
}

/**
 * Formats a result message (success or error).
 *
 * @param record - The result message record.
 * @returns Formatted result string.
 */
function formatResult(record: MessageRecord): string | null {
  const subtype = readString(record, 'subtype');
  const turns = readNumber(record, 'num_turns') ?? 0;
  const cost = readNumber(record, 'total_cost_usd');
  const costStr =
    cost === undefined ? '' : ` ($${cost.toFixed(4)})`;

  if (subtype === 'success') {
    const result = readString(record, 'result') ?? '';
    return `[result] done in ${String(turns)} turns${costStr}\n${result}`;
  }

  const errors = Array.isArray(record.errors)
    ? (record.errors as string[])
    : [];
  const errorStr =
    errors.length > 0
      ? errors.join(', ')
      : subtype ?? 'unknown error';
  return `[result:error] ${errorStr} (${String(turns)} turns${costStr})`;
}

/**
 * Formats a rate limit event.
 *
 * @param record - The rate limit event record.
 * @returns Formatted rate limit string, or null when info is absent.
 */
function formatRateLimit(record: MessageRecord): string | null {
  const info = asRecord(record.rate_limit_info);
  if (!info) {
    return null;
  }

  const status = readString(info, 'status');
  return status ? `[rate_limit] ${status}` : null;
}

/**
 * Formats an SDK message for human-readable console output.
 *
 * Returns `null` for messages that should not be displayed (internal
 * bookkeeping, non-synthetic user input, etc.). Callers typically write
 * non-null results to `process.stdout`:
 *
 * ```ts
 * import { createAgentRunner, formatMessage } from '@metamask/agent-runner';
 *
 * const runner = createAgentRunner();
 * const result = await runner.runAgent({
 *   prompt: 'Summarize the architecture.',
 *   onMessage: (msg) => {
 *     const line = formatMessage(msg);
 *     if (line !== null) {
 *       process.stdout.write(line + '\n');
 *     }
 *   },
 * });
 * ```
 *
 * @param message - The SDK message to format.
 * @returns A formatted string, or `null` to skip the message.
 */
export function formatMessage(message: SdkMessage): string | null {
  const record = message as unknown as MessageRecord;
  const type = readString(record, 'type');

  switch (type) {
    case 'system':
      return formatSystemMessage(record);
    case 'assistant':
      return formatAssistantMessage(record);
    case 'user':
      return formatUserMessage(record);
    case 'tool_progress':
      return formatToolProgress(record);
    case 'tool_use_summary':
      return formatToolUseSummary(record);
    case 'result':
      return formatResult(record);
    case 'rate_limit_event':
      return formatRateLimit(record);
    default:
      return null;
  }
}
