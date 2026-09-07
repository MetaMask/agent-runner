import {
  createCredentialScrubber,
  scrubCredentials,
} from '../credential-redactor.js';
import {
  runPiSession,
  validatePiOptions,
  PI_FORWARD_ENV,
} from '../pi-runtime.js';
import type { PiStructuredOutput } from '../pi-runtime.js';
import {
  runDockerBridge,
  PI_BRIDGE_RUNTIME,
} from '../sandbox/docker/bridge.js';
import { createDefaultDockerCommandRunner } from '../sandbox/docker/command-runner.js';
import { createDockerSandbox } from '../sandbox/docker/lifecycle.js';
import {
  normalizeDockerSandboxConfig,
  prepareDockerSandboxRequest,
} from '../sandbox/docker/options.js';
import type { AgentMessage, ProviderAdapter, RunConfig } from '../types.js';
import type { PiQueryOptions } from './pi-types.js';

/**
 * Creates an isolated LiteLLM pi adapter. The SDK is loaded only for direct runs.
 *
 * @returns The pi provider adapter.
 */
export function createPiAdapter(): ProviderAdapter<PiQueryOptions, string> {
  return {
    name: 'pi',
    defaultOptions: {},
    capabilities: { sandboxes: ['docker'] },
    /**
     * Describes the run for telemetry.
     *
     * @param options - Pi run options.
     * @returns Model and turn limit.
     */
    getRunMetadata: (options) => ({
      model: options.model ?? 'unknown',
      maxTurns: options.maxTurns ?? 0,
    }),
    /**
     * Keeps model settings without inheriting task execution policy.
     *
     * @param options0 - Runner defaults.
     * @param options0.tools - Task tools, excluded from judging.
     * @param options0.maxTurns - Task limit, excluded from judging.
     * @returns Safe judge defaults.
     */
    getStructuredDefaults: ({
      tools: _tools,
      maxTurns: _maxTurns,
      ...options
    }) => options,
    run: runPi,
    /**
     * Runs a bounded judge with its own tool contract.
     *
     * @param config - Structured run request.
     * @returns Normalized judge messages.
     */
    runStructured: (config) =>
      runPi(
        { ...config, options: { maxTurns: 5, ...config.options } },
        { schema: config.schema, systemPrompt: config.systemPrompt },
      ),
  };
}

/**
 * Runs pi directly or with the shared Docker lifecycle.
 *
 * @param config - Runner request.
 * @param structured - Optional judge contract.
 * @yields Normalized messages.
 */
async function* runPi(
  config: RunConfig<PiQueryOptions, string>,
  structured?: PiStructuredOutput,
): AsyncGenerator<AgentMessage> {
  const scrub = createCredentialScrubber({
    ...process.env,
    ...config.sandbox?.env,
  });
  try {
    config.signal?.throwIfAborted();
    const options = validatePiOptions(config.options, structured !== undefined);
    if (config.sandbox === undefined) {
      // The runtime validates again at the container entry point too. Keep the
      // caller's options so structured runs can reject an explicitly set tools.
      yield* runPiSession(
        config.prompt,
        config.options,
        structured,
        config.signal,
      );
      return;
    }
    const normalized = normalizeDockerSandboxConfig(
      {
        ...config.sandbox,
        forwardEnv: config.sandbox.forwardEnv ?? PI_FORWARD_ENV,
      },
      { hostCwd: options.cwd ?? process.cwd() },
    );
    const prepared = prepareDockerSandboxRequest({
      prompt: config.prompt,
      options: { ...options },
      sandbox: normalized,
    });
    // Respect an explicit workdir; otherwise use the mapped workspace cwd.
    if (normalized.workdir !== undefined) {
      prepared.options.cwd = normalized.workdir;
    } else if (
      prepared.options.cwd === undefined &&
      normalized.workspace !== false
    ) {
      prepared.options.cwd = normalized.workspace.containerPath;
    }
    if (structured !== undefined) {
      delete prepared.options.tools;
      prepared.options.structured = structured;
    }
    const baseRunner = createDefaultDockerCommandRunner();
    const commandRunner: typeof baseRunner = {
      // Cancellation applies to setup/install too. Container removal must still
      // run after cancellation, so it never receives the aborted signal.
      /**
       * Applies cancellation without preventing cleanup.
       *
       * @param command - Executable.
       * @param args - Command arguments.
       * @param commandOptions - Process options.
       * @returns Process outcome.
       */
      run: async (command, args, commandOptions) =>
        baseRunner.run(command, args, {
          ...commandOptions,
          ...(config.signal === undefined || args[0] === 'rm'
            ? {}
            : {
                signal:
                  commandOptions?.signal === undefined
                    ? config.signal
                    : // Pi execution requires Node >=22.19; Claude never uses this path.
                      // eslint-disable-next-line n/no-unsupported-features/node-builtins
                      AbortSignal.any([config.signal, commandOptions.signal]),
              }),
        }),
    };
    const handle = await createDockerSandbox(normalized, { commandRunner });
    let completed = false;
    let failed = false;
    let succeeded = false;
    let resultSeen = false;
    try {
      config.signal?.throwIfAborted();
      for await (const raw of runDockerBridge({
        runtime: PI_BRIDGE_RUNTIME,
        sandbox: handle,
        config: normalized,
        commandRunner,
        request: prepared,
        ...(config.signal === undefined ? {} : { signal: config.signal }),
      })) {
        if (resultSeen) {
          throw new Error('Pi bridge emitted messages after the result.');
        }
        const message = validatePiBridgeMessage(raw);
        if (message.type === 'result') {
          resultSeen = true;
          succeeded = message.success;
        }
        yield scrubCredentials(message, scrub);
      }
      if (!resultSeen) {
        throw new Error('Pi bridge completed without a result.');
      }
      completed = true;
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      if (
        (!completed && !failed) ||
        config.signal?.aborted ||
        normalized.cleanup === 'always' ||
        (normalized.cleanup === 'on-success' && succeeded && completed)
      ) {
        try {
          await handle.close();
        } catch (cause) {
          if (completed && !failed) {
            // eslint-disable-next-line no-unsafe-finally -- No primary error or abandoned iterator to mask.
            throw cause;
          }
        }
      } else {
        handle.unregisterCleanup();
      }
    }
  } catch (cause) {
    throw scrubCredentials(
      cause instanceof Error ? cause : new Error(String(cause)),
      scrub,
    );
  }
}

/**
 * Validates normalized messages arriving from the container.
 *
 * @param raw - Parsed bridge payload.
 * @returns A supported normalized message.
 */
function validatePiBridgeMessage(raw: unknown): AgentMessage {
  if (raw === null || typeof raw !== 'object' || !('type' in raw)) {
    throw new Error('Invalid pi bridge message.');
  }
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'init':
      if (typeof message.sessionId === 'string') {
        return message as AgentMessage;
      }
      break;
    case 'generation':
      if (
        typeof message.model === 'string' &&
        typeof message.text === 'string' &&
        Array.isArray(message.toolCalls) &&
        message.toolCalls.every(
          (call: unknown) =>
            call !== null &&
            typeof call === 'object' &&
            'id' in call &&
            typeof call.id === 'string' &&
            'name' in call &&
            typeof call.name === 'string',
        ) &&
        message.usage !== null &&
        typeof message.usage === 'object' &&
        'inputTokens' in message.usage &&
        typeof message.usage.inputTokens === 'number' &&
        'outputTokens' in message.usage &&
        typeof message.usage.outputTokens === 'number' &&
        (message.stopReason === null || typeof message.stopReason === 'string')
      ) {
        return message as AgentMessage;
      }
      break;
    case 'tool_result':
      if (
        typeof message.toolUseId === 'string' &&
        typeof message.content === 'string' &&
        typeof message.isError === 'boolean'
      ) {
        return message as AgentMessage;
      }
      break;
    case 'tool_progress':
      if (
        typeof message.toolName === 'string' &&
        typeof message.elapsedSeconds === 'number'
      ) {
        return message as AgentMessage;
      }
      break;
    case 'result':
      if (
        typeof message.success === 'boolean' &&
        (message.result === undefined || typeof message.result === 'string') &&
        (message.error === undefined || typeof message.error === 'string') &&
        (message.costUsd === undefined ||
          (typeof message.costUsd === 'number' &&
            Number.isFinite(message.costUsd) &&
            message.costUsd >= 0))
      ) {
        return message as AgentMessage;
      }
      break;
    default:
      break;
  }
  throw new Error('Invalid pi bridge message.');
}
