import { expectTypeOf } from 'vitest';

import { createClaudeAdapter } from './adapters/claude-adapter.js';
import { createPiAdapter } from './adapters/pi-adapter.js';
import type { PiQueryOptions } from './adapters/pi-types.js';
// eslint-disable-next-line import-x/no-useless-path-segments
import { createHarnessAdapter } from './index.js';
import { createAgentRunner } from './runner.js';
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  AgentRunnerConfig,
  ClaudeQueryInput,
  ClaudeQueryOptions,
  JudgeConfig,
  ProviderAdapter,
} from './types.js';

const claudeRunner = createAgentRunner({ defaultOptions: { maxTurns: 1 } });
expectTypeOf(claudeRunner.runAgent)
  .parameter(0)
  .toEqualTypeOf<AgentRunOptions<ClaudeQueryOptions>>();

const claudeRunPromise = claudeRunner.runAgent({
  prompt: 'use a later Claude option',
  options: { model: 'claude-sonnet' },
});
expectTypeOf(claudeRunPromise).toEqualTypeOf<Promise<AgentRunResult>>();

const annotatedClaudeConfig: AgentRunnerConfig = {
  defaultOptions: { maxTurns: 2 },
};
const annotatedClaudeRunner = createAgentRunner(annotatedClaudeConfig);
expectTypeOf(annotatedClaudeRunner).toEqualTypeOf<AgentRunner>();

const annotatedClaudeAdapterConfig: AgentRunnerConfig = {
  adapter: createClaudeAdapter(),
  defaultOptions: { maxTurns: 2 },
};
const annotatedClaudeAdapterRunner = createAgentRunner(
  annotatedClaudeAdapterConfig,
);
expectTypeOf(annotatedClaudeAdapterRunner).toEqualTypeOf<AgentRunner>();

/** Provider-specific options used to verify custom adapter inference. */
type CustomOptions = {
  /** Sampling temperature supported by the custom provider. */
  temperature?: number;
};

const customAdapter: ProviderAdapter<CustomOptions, string> = {
  name: 'custom',
  /**
   * Creates the custom adapter test stream.
   *
   * @yields The normalized result message.
   */
  async *run(): AsyncGenerator<AgentMessage> {
    yield { type: 'result', success: true };
  },
};

const customRunner = createAgentRunner({
  adapter: customAdapter,
  defaultOptions: { temperature: 0.2 },
});

expectTypeOf(customRunner.runAgent)
  .parameter(0)
  .toEqualTypeOf<AgentRunOptions<CustomOptions, string>>();
/** Claude-only options that must not match the custom runner. */
type ClaudeOnlyRunOptions = {
  /** Prompt accepted by the default Claude runner. */
  prompt: string;
  /** Claude-specific query options. */
  options?: ClaudeMaxTurnsOption;
};
/** Claude option intentionally unsupported by the custom provider. */
type ClaudeMaxTurnsOption = {
  /** Maximum Claude agent turns. */
  maxTurns?: number;
};
expectTypeOf(customRunner.runAgent)
  .parameter(0)
  .not.toMatchTypeOf<ClaudeOnlyRunOptions>();
expectTypeOf<CustomOptions>().not.toMatchTypeOf<ClaudeMaxTurnsOption>();

/** Factory configuration inferred for explicit custom provider generics. */
type CustomFactoryConfig = Parameters<
  typeof createAgentRunner<CustomOptions, string>
>[0];
/** Expected factory configuration requiring the custom adapter. */
type ExpectedCustomFactoryConfig = AgentRunnerConfig<CustomOptions, string> & {
  /** Adapter required when explicit custom generics are supplied. */
  adapter: ProviderAdapter<CustomOptions, string>;
};
expectTypeOf<CustomFactoryConfig>().toEqualTypeOf<ExpectedCustomFactoryConfig>();

const customRunPromise = customRunner.runAgent({
  prompt: 'custom prompt',
  options: { temperature: 0.7 },
});
expectTypeOf(customRunPromise).toEqualTypeOf<Promise<AgentRunResult>>();

/** Options deliberately overlapping Claude's model field. */
type OverlappingCustomOptions = {
  /** Provider model identifier. */
  model?: string;
};
const overlappingAdapter: ProviderAdapter<
  OverlappingCustomOptions,
  ClaudeQueryInput['prompt']
> = {
  name: 'overlapping-custom',
  /**
   * Creates the overlapping adapter test stream.
   *
   * @yields The normalized result message.
   */
  async *run(): AsyncGenerator<AgentMessage> {
    yield { type: 'result', success: true };
  },
};
const overlappingRunner = createAgentRunner({ adapter: overlappingAdapter });
expectTypeOf(overlappingRunner.runAgent)
  .parameter(0)
  .toEqualTypeOf<
    AgentRunOptions<OverlappingCustomOptions, ClaudeQueryInput['prompt']>
  >();
expectTypeOf(overlappingRunner.runAgent)
  .parameter(0)
  .not.toMatchTypeOf<ClaudeOnlyRunOptions>();
expectTypeOf<Parameters<typeof overlappingRunner.judge>[1]>().toEqualTypeOf<
  JudgeConfig<OverlappingCustomOptions>
>();
expectTypeOf<
  NonNullable<JudgeConfig<OverlappingCustomOptions>['queryOptions']>
>().toEqualTypeOf<Partial<OverlappingCustomOptions>>();

const piAdapter = createPiAdapter();
expectTypeOf(piAdapter).toEqualTypeOf<
  ProviderAdapter<PiQueryOptions, string>
>();
const piRunner = createAgentRunner({ adapter: piAdapter });
expectTypeOf(piRunner.runAgent)
  .parameter(0)
  .toEqualTypeOf<AgentRunOptions<PiQueryOptions, string>>();

/** Claude-only field intentionally absent from Pi's package-owned options. */
type ClaudePolicyOption = {
  /** Claude permission mode unsupported by Pi. */
  permissionMode?: 'bypassPermissions';
};
expectTypeOf<PiQueryOptions>().not.toMatchTypeOf<ClaudePolicyOption>();

const selectedPi = createHarnessAdapter('pi');
expectTypeOf(selectedPi).toEqualTypeOf<
  ProviderAdapter<PiQueryOptions, string>
>();
const selectedClaude = createHarnessAdapter('claude');
expectTypeOf(selectedClaude).toEqualTypeOf<
  ProviderAdapter<ClaudeQueryOptions, ClaudeQueryInput['prompt']>
>();
