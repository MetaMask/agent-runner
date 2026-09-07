import type {
  AgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import path from 'node:path';

import type { PiQueryOptions, PiToolName } from './adapters/pi-types.js';
import {
  createCredentialScrubber,
  scrubCredentials,
} from './credential-redactor.js';
import type { AgentMessage, AgentResultMessage } from './types.js';

/** Supported pi SDK version, also installed in Docker. */
export const PI_SDK_VERSION = '0.83.0';
/** Environment forwarded to pi containers unless explicitly overridden. */
export const PI_FORWARD_ENV = [
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];
const TOOLS: readonly PiToolName[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
];
const OPTION_KEYS = new Set([
  'model',
  'cwd',
  'systemPrompt',
  'tools',
  'maxTurns',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'cost',
]);

/** Internal structured-output contract. Never supplied through pi query options. */
export type PiStructuredOutput = {
  /** Judge response schema. */
  schema: Record<string, unknown>;
  /** Judge rubric. */
  systemPrompt: string;
};

/**
 * Checks the pi-specific Node floor without affecting Claude consumers.
 *
 * @param version - Node version.
 */
export function assertPiNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version
    .replace(/^v/u, '')
    .split('.')
    .map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      'Pi requires Node.js >=22.19.0. Claude-only runs still support Node 20.',
    );
  }
}

/**
 * Validates the complete pi option allowlist before starting any SDK or container.
 *
 * @param value - Caller options.
 * @param structured - Whether the judge owns tool selection.
 * @returns Validated options with defaults.
 */
export function validatePiOptions(
  value: Partial<PiQueryOptions>,
  structured = false,
): PiQueryOptions {
  if (!isRecord(value)) {
    throw new Error('Pi options must be a plain object.');
  }
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) {
      throw new Error(
        `Unsupported Pi option \`${key}\`; Claude permission policies cannot be applied to pi.`,
      );
    }
  }
  if (typeof value.model !== 'string' || !value.model.trim()) {
    throw new Error('Pi requires a non-empty options.model.');
  }
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd))
  ) {
    throw new Error('Pi options.cwd must be an absolute path.');
  }
  if (
    value.systemPrompt !== undefined &&
    typeof value.systemPrompt !== 'string'
  ) {
    throw new Error('Pi options.systemPrompt must be a string.');
  }
  for (const key of ['maxTurns', 'contextWindow', 'maxTokens'] as const) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] <= 0)
    ) {
      throw new Error(`Pi options.${key} must be a positive integer.`);
    }
  }
  if (value.reasoning !== undefined && typeof value.reasoning !== 'boolean') {
    throw new Error('Pi options.reasoning must be a boolean.');
  }
  if (
    value.input !== undefined &&
    (!Array.isArray(value.input) ||
      !value.input.length ||
      value.input.some((entry) => entry !== 'text' && entry !== 'image'))
  ) {
    throw new Error('Pi options.input must contain text or image.');
  }
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) {
      throw new Error('Pi options.cost must be a plain object.');
    }
    for (const [key, price] of Object.entries(value.cost)) {
      if (
        !['input', 'output', 'cacheRead', 'cacheWrite'].includes(key) ||
        typeof price !== 'number' ||
        !Number.isFinite(price) ||
        price < 0
      ) {
        throw new Error(
          'Pi pricing must contain only finite nonnegative token prices.',
        );
      }
    }
  }
  if (structured && 'tools' in value) {
    throw new Error('Pi judging does not accept caller tool customization.');
  }
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.some((tool) => !TOOLS.includes(tool)))
  ) {
    throw new Error('Pi tools must be an exact built-in tool allowlist.');
  }
  return {
    ...value,
    model: value.model,
    tools: structured ? [] : [...(value.tools ?? TOOLS.slice(0, 4))],
  };
}

/**
 * Checks a plain JSON-like record.
 *
 * @param value - Candidate record.
 * @returns Whether the value has a plain object prototype.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds one isolated session using the supported SDK.
 *
 * @param options - Validated pi options.
 * @param structured - Optional structured-output contract.
 * @param capture - Receives the structured response.
 * @returns A fresh, in-memory session.
 */
async function createSession(
  options: PiQueryOptions,
  structured: PiStructuredOutput | undefined,
  capture: (value: unknown) => void,
): Promise<AgentSession> {
  assertPiNodeVersion();
  if (!process.env.LITELLM_BASE_URL || !process.env.LITELLM_API_KEY) {
    throw new Error(
      'Pi requires LITELLM_BASE_URL and LITELLM_API_KEY in the environment.',
    );
  }
  const url = new URL(process.env.LITELLM_BASE_URL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'LITELLM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '')}/v1`;
  let pi: typeof import('@earendil-works/pi-coding-agent');
  try {
    pi = await import('@earendil-works/pi-coding-agent');
  } catch (cause) {
    throw new Error(
      `Could not load pi. Install @earendil-works/pi-coding-agent@${PI_SDK_VERSION} and use Node >=22.19.0.`,
      { cause },
    );
  }
  if (pi.VERSION !== PI_SDK_VERSION) {
    throw new Error(`Pi requires SDK ${PI_SDK_VERSION}; found ${pi.VERSION}.`);
  }
  // Credentials come only from the environment. No persistence or login flow
  // exists in this adapter, so reject writes instead of implementing a store.
  const modelRuntime = await pi.ModelRuntime.create({
    modelsPath: null,
    credentials: {
      /**
       * Returns no stored credentials.
       *
       * @returns No persisted credential.
       */
      read: async () => undefined,
      /**
       * Lists no stored credentials.
       *
       * @returns An empty credential list.
       */
      list: async () => [],
      /** Rejects credential writes. */
      modify: async () => {
        throw new Error('Pi credential persistence is disabled.');
      },
      /** Rejects credential deletion. */
      delete: async () => {
        throw new Error('Pi credential persistence is disabled.');
      },
    },
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider('litellm', {
    name: 'LiteLLM',
    baseUrl: url.href.replace(/\/$/u, ''),
    apiKey: '$LITELLM_API_KEY',
    api: 'openai-completions',
    authHeader: true,
    models: [
      {
        id: options.model,
        name: options.model,
        reasoning: options.reasoning ?? false,
        input: [...(options.input ?? ['text'])],
        contextWindow: options.contextWindow ?? 128000,
        maxTokens: options.maxTokens ?? 8192,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          ...options.cost,
        },
      },
    ],
  });
  const model = modelRuntime.getModel('litellm', options.model);
  if (model === undefined) {
    throw new Error('Pi could not resolve the configured LiteLLM model.');
  }
  const cwd = options.cwd ?? process.cwd();
  const settingsManager = pi.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: path.join(cwd, '.agent-runner-pi'),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    ...((structured?.systemPrompt ?? options.systemPrompt) === undefined
      ? {}
      : {
          systemPrompt: (structured?.systemPrompt ??
            options.systemPrompt) as string,
        }),
  });
  await loader.reload();
  const customTools =
    structured === undefined
      ? []
      : [
          pi.defineTool({
            name: 'submit_judgment',
            label: 'Submit judgment',
            description: 'Submit the final judgment using this tool and stop.',
            parameters: structured.schema,
            constrainedSampling: { type: 'json_schema', strict: 'require' },
            /**
             * Captures the schema-validated judgment and terminates the tool batch.
             *
             * @param _id - Tool call identifier.
             * @param params - Validated judgment fields.
             * @returns A terminating tool result.
             */
            execute: async (_id, params) => {
              capture(params);
              return {
                content: [
                  { type: 'text' as const, text: 'Judgment submitted.' },
                ],
                details: {},
                terminate: true,
              };
            },
          }),
        ];
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir: path.join(cwd, '.agent-runner-pi'),
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager: pi.SessionManager.inMemory(cwd),
    tools:
      structured === undefined
        ? [...(options.tools ?? [])]
        : ['submit_judgment'],
    customTools,
  });
  return session;
}

/**
 * Extracts text without trusting tool-specific result details.
 *
 * @param result - Tool result from the SDK.
 * @returns Text content of the result.
 */
function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .filter(
      (
        block: unknown,
      ): block is {
        /** Text block discriminant. */
        type: 'text';
        /** Tool output text. */
        text: string;
      } =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

/** Session factory seam used to test lifecycle without network requests. */
export type PiSessionFactory = typeof createSession;

/**
 * Runs the same pi lifecycle on the host and in Docker.
 *
 * @param prompt - Text prompt.
 * @param input - Package-owned pi options.
 * @param structured - Optional locked judgment contract.
 * @param signal - Caller cancellation.
 * @param factory - Test session factory.
 * @yields Normalized messages, with credentials scrubbed before leaving the runtime.
 */
export async function* runPiSession(
  prompt: string,
  input: Partial<PiQueryOptions>,
  structured?: PiStructuredOutput,
  signal?: AbortSignal,
  factory: PiSessionFactory = createSession,
): AsyncGenerator<AgentMessage> {
  const scrub = createCredentialScrubber();
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let task: Promise<void> | undefined;
  let completed = false;
  let structuredResult: unknown;
  let limitReached = false;
  let turns = 0;
  let lastText: string | undefined;
  let failure: string | undefined;
  let cost = 0;
  let costKnown = true;
  const started = Date.now();
  const toolStarts = new Map<string, number>();
  const queue: AgentMessage[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let taskError: Error | undefined;
  /** Wakes the waiting message consumer. */
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  /** Stops the active model request and tools. */
  const cancel = (): void => {
    session?.agent.abort();
    notify();
  };
  try {
    signal?.throwIfAborted();
    if (typeof prompt !== 'string') {
      throw new Error('Pi requires a string prompt.');
    }
    const options = validatePiOptions(input, structured !== undefined);
    costKnown = options.cost !== undefined;
    session = await factory(
      options,
      scrubCredentials(structured, scrub),
      (value) => {
        structuredResult = value;
      },
    );
    signal?.addEventListener('abort', cancel, { once: true });
    signal?.throwIfAborted();
    const activeSession = session;
    /**
     * Buffers a scrubbed message, aborting on overflow.
     *
     * @param message - Normalized runtime message.
     */
    const push = (message: AgentMessage): void => {
      if (queue.length >= 10000) {
        taskError ??= new Error('Pi event queue exceeded 10000 messages.');
        cancel();
      } else {
        queue.push(scrubCredentials(message, scrub));
      }
      notify();
    };
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const { message } = event;
        // Pi can emit a synthetic aborted response after the last tool batch.
        // It is not another model generation.
        if (limitReached) {
          return;
        }
        turns += 1;
        lastText = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (
          ['error', 'aborted', 'length', 'pending'].includes(message.stopReason)
        ) {
          failure =
            message.errorMessage ??
            `Pi generation stopped with ${message.stopReason}.`;
        }
        const { usage } = message;
        for (const key of [
          'input',
          'output',
          'cacheRead',
          'cacheWrite',
        ] as const) {
          const tokens = usage[key];
          const price = options.cost?.[key];
          if (
            !Number.isFinite(tokens) ||
            tokens < 0 ||
            (tokens > 0 && price === undefined)
          ) {
            costKnown = false;
          } else {
            cost += (tokens * (price ?? 0)) / 1e6;
          }
        }
        push({
          type: 'generation',
          model: message.model,
          text: lastText,
          toolCalls: message.content
            .filter((block) => block.type === 'toolCall')
            .map((block) => ({
              id: block.id,
              name: block.name,
              input: block.arguments,
            })),
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheCreationTokens: usage.cacheWrite,
          },
          stopReason: message.stopReason,
          raw: event,
        });
      } else if (event.type === 'tool_execution_start') {
        toolStarts.set(event.toolCallId, Date.now());
      } else if (event.type === 'tool_execution_update') {
        const start = toolStarts.get(event.toolCallId);
        if (start !== undefined) {
          push({
            type: 'tool_progress',
            toolName: event.toolName,
            elapsedSeconds: (Date.now() - start) / 1000,
            raw: event,
          });
        }
      } else if (event.type === 'tool_execution_end') {
        toolStarts.delete(event.toolCallId);
        push({
          type: 'tool_result',
          toolUseId: event.toolCallId,
          content: toolResultText(event.result),
          isError: event.isError,
          raw: event,
        });
      } else if (
        event.type === 'turn_end' &&
        options.maxTurns !== undefined &&
        turns >= options.maxTurns &&
        event.message.role === 'assistant' &&
        event.message.content.some((block) => block.type === 'toolCall') &&
        structuredResult === undefined
      ) {
        limitReached = true;
        activeSession.agent.abort();
      }
    });
    yield scrubCredentials(
      {
        type: 'init' as const,
        sessionId: session.sessionId,
        model: `litellm/${options.model}`,
        tools: session.getActiveToolNames(),
      },
      scrub,
    );
    signal?.throwIfAborted();
    task = session
      .prompt(structured === undefined ? prompt : scrub(prompt), {
        expandPromptTemplates: false,
      })
      .then(
        () => {
          settled = true;
          notify();
          return undefined;
        },
        (cause: unknown) => {
          taskError ??=
            cause instanceof Error ? cause : new Error(String(cause));
          settled = true;
          notify();
          return undefined;
        },
      );
    // eslint-disable-next-line no-unmodified-loop-condition -- The prompt promise settles asynchronously.
    while (!settled || queue.length) {
      signal?.throwIfAborted();
      if (queue.length) {
        yield queue.shift() as AgentMessage;
      } else {
        // eslint-disable-next-line no-loop-func -- A one-shot wake slot, not a captured loop index.
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    if (taskError !== undefined) {
      throw taskError;
    }
    signal?.throwIfAborted();
    if (limitReached) {
      failure = `Pi reached maxTurns (${String(options.maxTurns)}).`;
    }
    if (turns === 0) {
      failure ??= 'Pi produced no assistant response.';
    }
    if (structured !== undefined && structuredResult === undefined) {
      failure ??= 'Pi did not submit a judgment.';
    }
    const result: AgentResultMessage = {
      type: 'result',
      success: failure === undefined,
      turns,
      durationMs: Date.now() - started,
      ...(lastText === undefined ? {} : { result: lastText }),
      ...(structuredResult === undefined
        ? {}
        : { result: JSON.stringify(structuredResult) }),
      ...(costKnown && Number.isFinite(cost) ? { costUsd: cost } : {}),
      ...(failure === undefined ? {} : { error: failure }),
    };
    completed = true;
    yield scrubCredentials(result, scrub);
  } catch (cause) {
    throw scrubCredentials(
      cause instanceof Error ? cause : new Error(String(cause)),
      scrub,
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (session !== undefined) {
      if (!completed) {
        session.agent.abort();
      }
      try {
        await task;
      } finally {
        try {
          unsubscribe?.();
        } finally {
          try {
            session.dispose();
          } catch (cause) {
            if (completed) {
              // eslint-disable-next-line no-unsafe-finally -- Only surface cleanup failure after natural completion.
              throw scrubCredentials(
                cause instanceof Error ? cause : new Error(String(cause)),
                scrub,
              );
            }
          }
        }
      }
    }
  }
}
