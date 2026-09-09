/** Built-in tools allowed in an isolated pi run. */
export type PiToolName =
  | 'read'
  | 'bash'
  | 'edit'
  | 'write'
  | 'grep'
  | 'find'
  | 'ls';

/** USD per million tokens. Missing prices remain unknown, not free. */
export type PiModelCost = {
  /** Input token price. */
  input?: number;
  /** Output token price. */
  output?: number;
  /** Cached input price. */
  cacheRead?: number;
  /** Cache creation price. */
  cacheWrite?: number;
};

/** Serializable options for isolated LiteLLM pi runs. */
export type PiQueryOptions = {
  /** LiteLLM model alias. Required, including for judging. */
  model: string;
  /** Absolute working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Replacement system prompt. */
  systemPrompt?: string;
  /** Exact allowlist. Defaults to read, bash, edit, write; [] disables tools. */
  tools?: readonly PiToolName[];
  /** Maximum model turns, including tool execution. Unlimited when omitted. */
  maxTurns?: number;
  /** Model context window. Defaults to 128000. */
  contextWindow?: number;
  /** Maximum output tokens per generation. Defaults to 8192. */
  maxTokens?: number;
  /** Whether the model supports reasoning. Defaults to false. */
  reasoning?: boolean;
  /** Model input capabilities. Prompts in this adapter are text-only. */
  input?: readonly ('text' | 'image')[];
  /** Explicit pricing used to calculate reported cost. */
  cost?: PiModelCost;
};
