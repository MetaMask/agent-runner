/** Built-in tool names supported by the Pi harness. */
export type PiToolName =
  | 'read'
  | 'bash'
  | 'edit'
  | 'write'
  | 'grep'
  | 'find'
  | 'ls';

/** Model input modalities accepted by the Pi provider declaration. */
export type PiModelInput = 'text' | 'image';

/** Zero-or-positive model pricing metadata, in USD per million tokens. */
export type PiModelCost = {
  /** Input-token price. */
  input?: number;
  /** Output-token price. */
  output?: number;
  /** Cache-read price. */
  cacheRead?: number;
  /** Cache-write price. */
  cacheWrite?: number;
};

/** Options accepted by the built-in Pi provider adapter. */
export type PiQueryOptions = {
  /** LiteLLM model identifier registered under the internal `litellm` provider. */
  model: string;
  /** Absolute working directory used by the isolated in-memory session. */
  cwd?: string;
  /** Optional replacement system prompt. */
  systemPrompt?: string;
  /** Exact built-in tool allowlist. An empty list disables every built-in tool. */
  tools?: readonly PiToolName[];
  /** Declared model context window. Defaults to 128,000 tokens. */
  contextWindow?: number;
  /** Declared maximum output tokens. Defaults to 8,192 tokens. */
  maxTokens?: number;
  /** Whether the model supports reasoning output. Defaults to false. */
  reasoning?: boolean;
  /** Model input modalities. Defaults to text only. */
  input?: readonly PiModelInput[];
  /** Optional model pricing metadata used only for Pi usage accounting. */
  cost?: PiModelCost;
};

/** JSON-safe text content emitted by Pi. */
export type PiTextContentDto = {
  /** Content discriminant. */
  type: 'text';
  /** Finalized text. */
  text: string;
};

/** JSON-safe Pi tool call content. */
export type PiToolCallContentDto = {
  /** Content discriminant. */
  type: 'toolCall';
  /** Tool call identifier. */
  id: string;
  /** Tool name. */
  name: string;
  /** JSON-safe tool arguments. */
  arguments: unknown;
};

/** JSON-safe token usage emitted for a finalized assistant message. */
export type PiUsageDto = {
  /** Input tokens. */
  input?: number;
  /** Output tokens. */
  output?: number;
  /** Cache-read tokens. */
  cacheRead?: number;
  /** Cache-write tokens. */
  cacheWrite?: number;
  /** Optional finalized cost. */
  cost?: {
    /** Total generation cost. */
    total?: number;
  };
};

/** JSON-safe event DTO shared by direct and Docker Pi execution. */
export type PiEventDto =
  | {
      /** DTO discriminant. */
      kind: 'init';
      /** Ephemeral session identifier. */
      sessionId: string;
      /** Resolved provider/model identifier. */
      model: string;
      /** Enabled tools. */
      tools: string[];
    }
  | {
      /** DTO discriminant. */
      kind: 'assistant_message_end';
      /** Model that finalized the generation. */
      model: string;
      /** Normalized finalized content. */
      content: (PiTextContentDto | PiToolCallContentDto)[];
      /** Optional token and cost usage. */
      usage?: PiUsageDto;
      /** Provider stop reason. */
      stopReason?: string;
      /** Provider error detail. */
      errorMessage?: string;
    }
  | {
      /** DTO discriminant. */
      kind: 'tool_execution_start';
      /** Tool name. */
      toolName: string;
      /** Tool call identifier. */
      toolCallId: string;
    }
  | {
      /** DTO discriminant. */
      kind: 'tool_execution_update';
      /** Tool name. */
      toolName: string;
      /** Tool call identifier. */
      toolCallId: string;
      /** Optional progress content. */
      content?: string;
    }
  | {
      /** DTO discriminant. */
      kind: 'tool_execution_end';
      /** Tool name. */
      toolName: string;
      /** Tool call identifier. */
      toolCallId: string;
      /** Normalized tool result text. */
      content: string;
      /** Whether tool execution failed. */
      isError: boolean;
    }
  | {
      /** DTO discriminant. */
      kind: 'system';
      /** Pi system-event subtype. */
      subtype: string;
      /** JSON-safe event details. */
      details: Record<string, unknown>;
      /** Terminal retry or compaction failure. */
      error?: string;
    }
  | {
      /** DTO discriminant. */
      kind: 'agent_settled';
      /** Captured structured judge parameters. */
      structuredResult?: unknown;
    };
