import { query } from '@anthropic-ai/claude-agent-sdk';

import { runDockerClaudeBridge } from '../sandbox/docker/bridge.js';
import { createDefaultDockerCommandRunner } from '../sandbox/docker/command-runner.js';
import { createDockerSandbox } from '../sandbox/docker/lifecycle.js';
import {
  normalizeDockerSandboxConfig,
  prepareDockerSandboxRequest,
} from '../sandbox/docker/options.js';
import type {
  AgentMessage,
  DockerSandboxConfig,
  ProviderAdapter,
  RunConfig,
  SandboxConfig,
} from '../types.js';
import { translateClaudeSdkMessages } from './claude-message-translator.js';

/**
 * Creates a provider adapter backed by the Claude Agent SDK.
 *
 * The adapter supports two execution paths:
 *
 * - **Direct**: when {@link RunConfig.sandbox} is absent the SDK is
 *   invoked in-process and its messages are translated as usual.
 * - **Docker sandbox**: when {@link RunConfig.sandbox} declares a
 *   `docker` runtime, the adapter normalizes the config, prepares the
 *   JSON-safe bridge request, starts a Docker sandbox container, and
 *   streams the in-container SDK messages back through
 *   {@link translateClaudeSdkMessages}. The container is removed
 *   according to the configured cleanup policy.
 *
 * @returns The Claude provider adapter.
 */
export function createClaudeAdapter(): ProviderAdapter {
  return {
    name: 'claude',
    capabilities: { sandboxes: ['docker'] },
    /**
     * Runs the Claude query and yields translated agent messages.
     *
     * Delegates raw-to-normalized message translation (including
     * merge-by-inner-message-id semantics for streamed assistant emissions)
     * to {@link translateClaudeSdkMessages}.
     *
     * @param config - The run configuration for the Claude query.
     * @yields Translated agent messages from the SDK response stream.
     */
    async *run(config: RunConfig): AsyncGenerator<AgentMessage> {
      if (config.sandbox === undefined) {
        const rawMessages = query({
          prompt: config.prompt,
          options: config.options,
        });

        yield* translateClaudeSdkMessages(rawMessages);
        return;
      }

      yield* runWithSandbox(config, config.sandbox);
    },
  };
}

/**
 * Runs the Claude SDK against a sandbox, yielding translated agent
 * messages.
 *
 * The generator delegates SDK execution to the in-container bridge and
 * always tears down the sandbox container according to the configured
 * cleanup policy:
 *
 * - `always`: the container is always removed.
 * - `on-success`: the container is kept when the bridge throws, so the
 *   caller can inspect it.
 * - `never`: the container is never removed by the adapter.
 *
 * @param config - The run configuration for the Claude query.
 * @param sandbox - The resolved sandbox configuration.
 * @yields Translated agent messages from the SDK response stream.
 */
async function* runWithSandbox(
  config: RunConfig,
  sandbox: SandboxConfig,
): AsyncGenerator<AgentMessage> {
  const dockerSandbox: DockerSandboxConfig = sandbox;
  const hostCwd =
    typeof config.options.cwd === 'string' ? config.options.cwd : process.cwd();

  const normalized = normalizeDockerSandboxConfig(dockerSandbox, { hostCwd });
  const prepared = prepareDockerSandboxRequest({
    prompt: config.prompt,
    options: config.options,
    sandbox: normalized,
  });

  const commandRunner = createDefaultDockerCommandRunner();
  const handle = await createDockerSandbox(normalized, { commandRunner });

  // Cleanup runs inside a `finally` block so that *any* exit path —
  // bridge throwing, runner `onMessage` rejection causing the
  // consumer to `break`, or an explicit `iterator.return()` —
  // applies the configured cleanup policy. Cleaning up after a plain
  // try/catch would skip teardown whenever the generator was
  // returned early.
  //
  // Failure handling rules:
  // - A bridge failure (caught here) is re-thrown after `finally`.
  // - A close failure is only surfaced when the bridge ran to natural
  //   completion. On early termination or after a bridge error we
  //   swallow close failures to avoid masking the primary outcome
  //   (and because there is no clean way to throw from a generator
  //   that is already being torn down).
  let bridgeError: unknown;
  let bridgeFailed = false;
  let bridgeCompleted = false;
  let closeError: unknown;
  let closeFailed = false;
  try {
    const bridgeMessages = runDockerClaudeBridge({
      sandbox: handle,
      config: normalized,
      commandRunner,
      request: { prompt: prepared.prompt, options: prepared.options },
    });

    yield* translateClaudeSdkMessages(bridgeMessages);
    bridgeCompleted = true;
  } catch (cause) {
    bridgeError = cause;
    bridgeFailed = true;
  } finally {
    const consumerAborted = !bridgeCompleted && !bridgeFailed;
    if (
      consumerAborted ||
      shouldCloseContainer(normalized.cleanup, bridgeCompleted)
    ) {
      try {
        await handle.close();
      } catch (caughtClose) {
        closeError = caughtClose;
        closeFailed = true;
      }
    } else {
      handle.unregisterCleanup();
    }
  }

  if (bridgeFailed) {
    throw bridgeError;
  }
  if (closeFailed) {
    throw closeError;
  }
}

/**
 * Decides whether the sandbox container should be removed at the end
 * of a run based on the cleanup policy and whether the bridge run
 * completed naturally.
 *
 * This function ONLY governs the non-abort cases. When the consumer
 * aborts iteration early (`break`, `iterator.return()`, or an
 * exception thrown inside the consumer's `for await` body), the
 * caller closes the container unconditionally regardless of the
 * cleanup policy, because the in-container process may still be
 * running.
 *
 * @param cleanup - Cleanup policy from the normalized sandbox config.
 * @param succeeded - Whether the bridge completed naturally without
 *   throwing and without being abandoned mid-stream.
 * @returns Whether to call `handle.close()`.
 */
function shouldCloseContainer(
  cleanup: 'always' | 'on-success' | 'never',
  succeeded: boolean,
): boolean {
  switch (cleanup) {
    case 'always':
      return true;
    case 'on-success':
      return succeeded;
    case 'never':
      return false;
    default:
      return true;
  }
}
