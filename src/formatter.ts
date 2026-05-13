import type { AgentMessage } from './types.js';

const MAX_INPUT_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 1000;

/**
 * Safely returns a string value.
 *
 * @param value - The value to read.
 * @returns The string value, or undefined when non-string.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Safely returns a numeric value.
 *
 * @param value - The value to read.
 * @returns The numeric value, or undefined when non-number.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Truncates a string to the given length, appending an ellipsis when trimmed.
 *
 * @param value - The string to truncate.
 * @param maxLength - Maximum allowed length.
 * @returns The original or truncated string.
 */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Extracts a concise representation of a tool input object.
 *
 * Prioritises well-known fields (`command`, `file_path`, `query`) so the
 * most useful piece of information is always visible. Falls back to compact
 * JSON for unknown tool shapes.
 *
 * @param input - The raw tool input value.
 * @returns A human-readable string, or empty string when input is unusable.
 */
function formatToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return '';
  }

  const record = input as Record<string, unknown>;
  const command = asString(record.command);
  if (command) {
    return truncate(command, MAX_INPUT_LENGTH);
  }

  const filePath = asString(record.file_path) ?? asString(record.filePath);
  if (filePath) {
    return filePath;
  }

  const query = asString(record.query);
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
 * Formats an agent message for human-readable console output.
 *
 * Returns `null` for messages that should not be displayed (internal
 * bookkeeping, empty content, etc.). Callers typically write non-null results
 * to `process.stdout`:
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
 * @param message - The agent message to format.
 * @returns A formatted string, or `null` to skip the message.
 */
export function formatMessage(message: AgentMessage): string | null {
  switch (message.type) {
    case 'init':
      return `[init] model=${message.model ?? 'unknown'} tools=${String(
        message.tools?.length ?? 0,
      )}`;

    case 'generation': {
      const parts: string[] = [];

      for (const toolCall of message.toolCalls) {
        const inputStr = formatToolInput(toolCall.input);
        parts.push(
          inputStr
            ? `[tool_use] ${toolCall.name}: ${inputStr}`
            : `[tool_use] ${toolCall.name}`,
        );
      }

      if (message.text) {
        parts.push(message.text);
      }

      return parts.length > 0 ? parts.join('\n') : null;
    }

    case 'tool_result': {
      if (!message.content) {
        return null;
      }

      const prefix = message.isError ? '[tool_error]' : '[tool_output]';
      return `${prefix} ${truncate(message.content, MAX_OUTPUT_LENGTH)}`;
    }

    case 'result': {
      const turns = message.turns ?? 0;
      const costStr =
        message.costUsd === undefined
          ? ''
          : ` ($${message.costUsd.toFixed(4)})`;

      if (message.success) {
        return `[result] done in ${String(turns)} turns${costStr}\n${
          message.result ?? ''
        }`;
      }

      return `[result:error] ${
        message.error ?? 'unknown error'
      } (${String(turns)} turns${costStr})`;
    }

    case 'system':
      switch (message.subtype) {
        case 'status': {
          const status = asString(message.status);
          return status ? `[status] ${status}` : null;
        }
        case 'api_retry': {
          const attempt = asNumber(message.attempt) ?? 0;
          const max = asNumber(message.max_retries) ?? 0;
          const delay = asNumber(message.retry_delay_ms) ?? 0;
          return `[retry] attempt ${String(attempt)}/${String(max)} (${String(
            delay,
          )}ms delay)`;
        }
        case 'task_started': {
          const description = asString(message.description) ?? '';
          return `[task:started] ${description}`;
        }
        case 'task_notification': {
          const status = asString(message.status) ?? 'unknown';
          const summary = asString(message.summary) ?? '';
          return `[task:${status}] ${summary}`;
        }
        case 'task_progress': {
          const description = asString(message.description) ?? '';
          const lastTool =
            asString(message.lastTool) ?? asString(message.last_tool_name);
          return `[task:progress] ${description}${lastTool ? ` (${lastTool})` : ''}`;
        }
        case 'local_command_output': {
          const content = asString(message.content);
          return content
            ? `[output] ${truncate(content, MAX_OUTPUT_LENGTH)}`
            : null;
        }
        default:
          return null;
      }

    case 'tool_progress':
      return `[tool_progress] ${message.toolName} (${String(
        message.elapsedSeconds,
      )}s)`;

    case 'tool_use_summary':
      return message.summary ? `[tool_summary] ${message.summary}` : null;

    case 'rate_limit':
      return message.status ? `[rate_limit] ${message.status}` : null;

    default:
      return null;
  }
}
