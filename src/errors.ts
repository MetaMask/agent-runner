/**
 * Base error class for agent runner failures.
 */
export class AgentRunnerError extends Error {
  /**
   * Creates an AgentRunnerError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentRunnerError';
  }
}

/**
 * Thrown when telemetry configuration is invalid or incomplete.
 */
export class TelemetryConfigurationError extends AgentRunnerError {
  /**
   * Creates a TelemetryConfigurationError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TelemetryConfigurationError';
  }
}

/**
 * Wraps errors thrown by the onMessage callback during an agent run.
 */
export class MessageHandlerError extends AgentRunnerError {
  /**
   * Creates a MessageHandlerError.
   *
   * @param cause - The original error thrown by the message handler.
   */
  public constructor(cause: Error) {
    super('onMessage handler threw an error', { cause });
    this.name = 'MessageHandlerError';
  }
}

/**
 * Thrown when an LLM-as-a-judge evaluation fails.
 */
export class JudgeError extends AgentRunnerError {
  /**
   * Creates a JudgeError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JudgeError';
  }
}
