import * as ClaudeAgentSDKModule from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';

import type { ClaudeSdkModule, MutableClaudeSdkModule } from './types.js';

let instrumentedModule: ClaudeSdkModule | undefined;

/**
 * Loads the Claude SDK module, optionally with telemetry instrumentation.
 *
 * @param isTelemetryEnabled - Whether telemetry instrumentation is needed.
 * @returns The Claude SDK module, instrumented if telemetry is enabled.
 */
export function loadClaudeSdk(isTelemetryEnabled: boolean): ClaudeSdkModule {
  if (!isTelemetryEnabled) {
    return ClaudeAgentSDKModule;
  }

  instrumentedModule ??= instrumentSdk();

  return instrumentedModule;
}

/**
 * Creates a mutable copy of the Claude SDK and instruments it for telemetry.
 *
 * @returns An instrumented mutable copy of the Claude SDK module.
 */
function instrumentSdk(): ClaudeSdkModule {
  const mutableCopy = {} as MutableClaudeSdkModule;
  const source: Record<string, unknown> = ClaudeAgentSDKModule;

  for (const key of Object.getOwnPropertyNames(ClaudeAgentSDKModule)) {
    Object.defineProperty(mutableCopy, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.manuallyInstrument(mutableCopy);
  return mutableCopy;
}
