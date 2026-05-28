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

/**
 * Thrown when a sandbox configuration is invalid or references an
 * unsupported sandbox type.
 */
export class SandboxConfigurationError extends AgentRunnerError {
  /**
   * Creates a SandboxConfigurationError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxConfigurationError';
  }
}

/**
 * Thrown when the Docker sandbox runtime fails (e.g. container start,
 * exec, or cleanup failures).
 */
export class DockerSandboxError extends AgentRunnerError {
  /**
   * Creates a DockerSandboxError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerSandboxError';
  }
}

/**
 * Thrown when the host/sandbox bridge protocol is violated (e.g. an
 * unexpected frame is received or a frame fails to decode).
 */
export class DockerSandboxProtocolError extends DockerSandboxError {
  /**
   * Creates a DockerSandboxProtocolError.
   *
   * @param message - The error message.
   * @param options - Standard error options.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerSandboxProtocolError';
  }
}
