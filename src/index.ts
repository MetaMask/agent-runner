import { createClaudeAdapter } from './adapters/claude-adapter.js';
import { createPiAdapter } from './adapters/pi-adapter.js';
import type { PiQueryOptions } from './adapters/pi-types.js';
import type {
  ClaudeQueryInput,
  ClaudeQueryOptions,
  ProviderAdapter,
} from './types.js';

export { formatMessage } from './formatter.js';
export { createClaudeAdapter } from './adapters/claude-adapter.js';
export { createPiAdapter } from './adapters/pi-adapter.js';
export { createAgentRunner } from './runner.js';
export {
  AgentRunnerError,
  DockerSandboxError,
  DockerSandboxProtocolError,
  JudgeError,
  MessageHandlerError,
  SandboxConfigurationError,
  TelemetryConfigurationError,
} from './errors.js';
export {
  CLAUDE_DOCKER_SANDBOX_FORWARD_ENV,
  DEFAULT_DOCKER_SANDBOX_FORWARD_ENV,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH,
  PI_DOCKER_SANDBOX_FORWARD_ENV,
} from './sandbox/types.js';
export type {
  PiModelCost,
  PiModelInput,
  PiQueryOptions,
  PiToolName,
} from './adapters/pi-types.js';
export type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunTelemetryAttributes,
  AgentRunner,
  AgentRunnerConfig,
  ClaudeQueryOptions,
  DockerSandboxBridgeConfig,
  DockerSandboxCleanupPolicy,
  DockerSandboxConfig,
  DockerSandboxMount,
  DockerSandboxWorkspace,
  JudgeConfig,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  JudgeScoreField,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderRunMetadata,
  RunConfig,
  RunStructuredConfig,
  RunnerMessageHandler,
  SandboxConfig,
  ScoreEntry,
  TelemetryConfig,
  TelemetryLifecycle,
  TelemetryRedactor,
  TokenUsage,
  ToolCall,
} from './types.js';

/**
 * Selects the built-in Claude harness.
 *
 * @param harness - Literal Claude selector.
 * @returns The Claude adapter.
 */
export function createHarnessAdapter(
  harness: 'claude',
): ProviderAdapter<ClaudeQueryOptions, ClaudeQueryInput['prompt']>;
/**
 * Selects the built-in Pi harness.
 *
 * @param harness - Literal Pi selector.
 * @returns The Pi adapter.
 */
export function createHarnessAdapter(
  harness: 'pi',
): ProviderAdapter<PiQueryOptions, string>;
/**
 * Returns the adapter selected by its literal harness name.
 *
 * @param harness - Built-in harness selector.
 * @returns The selected built-in adapter.
 */
export function createHarnessAdapter(
  harness: 'claude' | 'pi',
):
  | ProviderAdapter<ClaudeQueryOptions, ClaudeQueryInput['prompt']>
  | ProviderAdapter<PiQueryOptions, string> {
  return harness === 'pi' ? createPiAdapter() : createClaudeAdapter();
}
