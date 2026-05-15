import type { ClaudeQueryOptions, RunnerMessageHandler } from '../types.js';

/**
 * Defines a single scoring dimension for LLM judge evaluation.
 */
export type JudgeScoreField = {
  /** Dimension name used as the key in scores and Langfuse score name. */
  name: string;
  /** Minimum allowed value; scores are clamped to this bound. */
  min: number;
  /** Maximum allowed value; scores are clamped to this bound. */
  max: number;
};

/**
 * Configuration for running an LLM-as-a-judge evaluation.
 */
export type JudgeConfig = {
  /** System prompt / evaluation rubric for the judge. */
  rubric: string;
  /** Score dimensions the judge should return. Used for validation and clamping. */
  scoreFields: JudgeScoreField[];
  /**
   * Query options forwarded to the SDK call.
   *
   * Defaults applied when not set: `model` (`claude-sonnet-4-20250514`),
   * `tools` (`[]`), `maxTurns` (`5`), `settingSources` (`[]`).
   */
  queryOptions?: Partial<ClaudeQueryOptions>;
};

/**
 * Context provided to the judge alongside the agent run result.
 */
export type JudgeContext = {
  /** The original task prompt given to the agent. */
  taskPrompt?: string;
  /** The terminal status or outcome of the agent run. */
  status?: string;
};

/**
 * Result of an LLM-as-a-judge evaluation.
 */
export type JudgeResult = {
  /** Scores keyed by dimension name. */
  scores: Record<string, number>;
  /** The judge's reasoning explanation. */
  reasoning: string;
  /** Raw text response from the judge model. */
  raw: string;
};

/**
 * Options for the runner `judge()` method.
 */
export type JudgeOptions = {
  /**
   * When `true`, automatically posts judge scores to the telemetry backend
   * after evaluation. Requires telemetry to be enabled and a trace ID on
   * the run result. Defaults to `false`.
   */
  postScores?: boolean;
  /**
   * Callback invoked for each raw SDK message streamed during the judge
   * agent run. Mirrors the `onMessage` callback on `AgentRunOptions`.
   * If the callback throws, the judge run terminates early with a
   * `JudgeError`.
   */
  onMessage?: RunnerMessageHandler;
};

/**
 * A single score entry to post to the telemetry backend.
 */
export type ScoreEntry = {
  /** Name of the score dimension. */
  name: string;
  /** Numeric score value. */
  value: number;
  /** Optional comment or reasoning. */
  comment?: string;
};
