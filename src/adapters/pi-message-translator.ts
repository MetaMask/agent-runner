import type {
  AgentGenerationMessage,
  AgentMessage,
  TokenUsage,
} from '../types.js';
import type { PiEventDto, PiToolCallContentDto } from './pi-types.js';

/** Stateful translator for the JSON-safe Pi event boundary. */
export type PiEventTranslator = {
  /** Translates one Pi DTO into zero or one normalized messages. */
  translate: (event: PiEventDto) => AgentMessage | undefined;
};

/**
 * Creates a per-run Pi event translator with cost and terminal state.
 *
 * @returns A stateful translator for one Pi run.
 */
export function createPiEventTranslator(): PiEventTranslator {
  let totalCost = 0;
  let costSeen = false;
  let settled = false;
  let lastText: string | undefined;
  let failure: string | undefined;
  let incomplete: string | undefined;

  return {
    /**
     * Translates one DTO using the accumulated run state.
     *
     * @param event - Pi event DTO.
     * @returns A normalized message, or undefined after settlement.
     */
    translate(event): AgentMessage | undefined {
      if (settled) {
        return undefined;
      }

      switch (event.kind) {
        case 'init':
          return {
            type: 'init',
            sessionId: event.sessionId,
            model: event.model,
            tools: event.tools,
            raw: event,
          };
        case 'assistant_message_end': {
          const generation = translateAssistant(event);
          if (generation.text.length > 0) {
            lastText = generation.text;
          }
          const cost = event.usage?.cost?.total;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
            totalCost += cost;
            costSeen = true;
          }
          switch (event.stopReason) {
            case 'error':
              failure =
                event.errorMessage ?? 'Pi assistant generation failed.';
              incomplete = undefined;
              break;
            case 'aborted':
              failure =
                event.errorMessage ?? 'Pi assistant generation was aborted.';
              incomplete = undefined;
              break;
            case 'length':
              incomplete =
                event.errorMessage ??
                'Pi assistant generation stopped after reaching the maximum output token limit.';
              break;
            case 'pending':
              incomplete =
                event.errorMessage ??
                'Pi assistant generation did not complete.';
              break;
            case 'stop':
            case 'toolUse':
              incomplete = undefined;
              break;
            default:
              break;
          }
          return generation;
        }
        case 'tool_execution_start':
          return {
            type: 'system',
            subtype: 'tool_execution_start',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            raw: event,
          };
        case 'tool_execution_update':
          return {
            type: 'tool_progress',
            toolName: event.toolName,
            elapsedSeconds: 0,
            raw: event,
          };
        case 'tool_execution_end':
          return {
            type: 'tool_result',
            toolUseId: event.toolCallId,
            content: event.content,
            isError: event.isError,
            raw: event,
          };
        case 'system':
          if (event.error !== undefined) {
            failure = event.error;
          }
          return {
            ...event.details,
            type: 'system',
            subtype: event.subtype,
            raw: event,
          };
        case 'agent_settled': {
          settled = true;
          const error = failure ?? incomplete;
          return {
            type: 'result',
            success: error === undefined,
            ...(lastText === undefined ? {} : { result: lastText }),
            ...(costSeen ? { costUsd: totalCost } : {}),
            ...(error === undefined ? {} : { error }),
            raw: event,
          };
        }
        default:
          return undefined;
      }
    },
  };
}

/**
 * Translates a finalized Pi assistant event.
 *
 * @param event - Finalized assistant DTO.
 * @returns The normalized generation message.
 */
function translateAssistant(
  event: Extract<
    PiEventDto,
    {
      /**
       *
       */
      kind: 'assistant_message_end';
    }
  >,
): AgentGenerationMessage {
  const toolCalls = event.content.filter(isToolCall).map(
    (
      content,
    ): {
      /** Tool call identifier. */
      id: string;
      /** Tool name. */
      name: string;
      /** Tool arguments. */
      input: unknown;
    } => ({
      id: content.id,
      name: content.name,
      input: content.arguments,
    }),
  );
  const text = event.content
    .filter(
      (
        content,
      ): content is Extract<
        typeof content,
        {
          /**
           *
           */
          type: 'text';
        }
      > => content.type === 'text',
    )
    .map((content): string => content.text)
    .join('');

  return {
    type: 'generation',
    model: event.model,
    text,
    toolCalls,
    usage: translateUsage(event.usage),
    stopReason: event.stopReason ?? null,
    raw: event,
  };
}

/**
 * Checks whether Pi content represents a tool call.
 *
 * @param content - Assistant content DTO.
 * @returns Whether the DTO is a tool call.
 */
function isToolCall(
  content: Extract<
    PiEventDto,
    {
      /**
       *
       */
      kind: 'assistant_message_end';
    }
  >['content'][number],
): content is PiToolCallContentDto {
  return content.type === 'toolCall';
}

/**
 * Converts optional Pi usage into the normalized token shape.
 *
 * @param usage - Optional Pi usage DTO.
 * @returns Normalized token usage.
 */
function translateUsage(
  usage: Extract<
    PiEventDto,
    {
      /**
       *
       */
      kind: 'assistant_message_end';
    }
  >['usage'],
): TokenUsage {
  return {
    inputTokens: finiteNonnegative(usage?.input),
    outputTokens: finiteNonnegative(usage?.output),
    ...(usage?.cacheRead === undefined
      ? {}
      : { cacheReadTokens: finiteNonnegative(usage.cacheRead) }),
    ...(usage?.cacheWrite === undefined
      ? {}
      : { cacheCreationTokens: finiteNonnegative(usage.cacheWrite) }),
  };
}

/**
 * Returns a finite nonnegative number or zero.
 *
 * @param value - Numeric candidate.
 * @returns A valid usage number.
 */
function finiteNonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
