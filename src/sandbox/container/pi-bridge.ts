import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSessionEvent,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable jsdoc/require-jsdoc -- Self-contained structural mirror of Pi's credential boundary. */
type BridgeCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | {
      type: 'oauth';
      refresh: string;
      access: string;
      expires: number;
      [key: string]: unknown;
    };
type BridgeCredentialStore = {
  read: (providerId: string) => Promise<BridgeCredential | undefined>;
  list: () => Promise<
    readonly { providerId: string; type: BridgeCredential['type'] }[]
  >;
  modify: (
    providerId: string,
    update: (
      current: BridgeCredential | undefined,
    ) => Promise<BridgeCredential | undefined>,
  ) => Promise<BridgeCredential | undefined>;
  delete: (providerId: string) => Promise<void>;
};
/* eslint-enable jsdoc/require-jsdoc */

/** Protocol version shared with the host bridge. */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_QUEUE_SIZE = 10_000;
export const MAX_BRIDGE_LINE_LENGTH = 10 * 1024 * 1024;
const PROVIDER_ID = 'litellm';
const BRIDGE_OPTION_KEYS = new Set([
  'model',
  'cwd',
  'systemPrompt',
  'tools',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'cost',
  'structured',
]);
const BRIDGE_TOOLS = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
]);

/**
 * Creates the bridge-local filesystem-free credential store.
 *
 * @returns An isolated credential store.
 */
export function createBridgeCredentialStore(): BridgeCredentialStore {
  /* eslint-disable jsdoc/require-jsdoc -- Local closures implement the documented store contract. */
  const values = new Map<string, BridgeCredential>();
  const chains = new Map<string, Promise<void>>();
  const serialize = async <Result>(
    providerId: string,
    task: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(ignoreBridgeQueueFailure).then(task);
    const recovery = operation.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    chains.set(providerId, recovery);
    try {
      return await operation;
    } finally {
      if (chains.get(providerId) === recovery) {
        chains.delete(providerId);
      }
    }
  };
  return {
    read: async (providerId) => values.get(providerId),
    list: async () =>
      [...values].map(([providerId, value]) => ({
        providerId,
        type: value.type,
      })),
    modify: async (providerId, update) =>
      serialize(providerId, async () => {
        const current = values.get(providerId);
        const value = await update(current);
        if (value !== undefined) {
          values.set(providerId, value);
        }
        return value ?? current;
      }),
    delete: async (providerId) =>
      serialize(providerId, async () => {
        values.delete(providerId);
      }),
  };
  /* eslint-enable jsdoc/require-jsdoc */
}

/**
 * Converts a prior bridge queue rejection into successful settlement.
 *
 * @returns Undefined.
 */
export function ignoreBridgeQueueFailure(): undefined {
  return undefined;
}

/** Dependency surface used by unit tests and the standalone entry point. */
export type PiBridgeDeps = {
  /** Stream containing the single protocol request. */
  stdin: NodeJS.ReadableStream;
  /** Stream receiving protocol response frames. */
  stdout: NodeJS.WritableStream;
  /** Stream receiving human-readable diagnostics. */
  stderr: NodeJS.WritableStream;
  /** Environment used for credential validation and provider interpolation. */
  env: Record<string, string | undefined>;
  /** Optional isolated-session factory used by unit tests. */
  createSession?: typeof createIsolatedSession;
  /** Optional SDK boundary forwarded to the default isolated-session factory. */
  sdk?: PiBridgeSdk;
};

/** Isolated Pi SDK calls used by the standalone session factory. */
export type PiBridgeSdk = {
  /** Creates the model runtime. */
  createModelRuntime: (options: {
    /** Disables models.json loading. */
    modelsPath: null;
    /** Filesystem-free credential store. */
    credentials: BridgeCredentialStore;
    /** Disables remote model catalog access. */
    allowModelNetwork: false;
  }) => ReturnType<typeof ModelRuntime.create>;
  /** Creates isolated settings. */
  createSettings: typeof SettingsManager.inMemory;
  /** Creates an in-memory session manager. */
  createSessionManager: typeof SessionManager.inMemory;
  /** Constructs the isolated resource loader. */
  createResourceLoader: (
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ) => InstanceType<typeof DefaultResourceLoader>;
  /** Defines a custom Pi tool. */
  defineTool: typeof defineTool;
  /** Creates the Pi agent session. */
  createAgentSession: (
    options: Parameters<typeof createAgentSession>[0],
  ) => Promise<PiBridgeCreateSessionResult>;
  /** Resolves the registered model. */
  resolveCliModel: (
    options: Parameters<typeof resolveCliModel>[0],
  ) => PiBridgeResolveResult;
};

/** Result from creating an injected Pi session. */
type PiBridgeCreateSessionResult = {
  /** Created bridge session. */
  session: PiBridgeSession;
};

/** Result from resolving the configured Pi model. */
type PiBridgeResolveResult = {
  /** Resolved model, when found. */
  model: unknown | undefined;
  /** Resolution error, when not found. */
  error: string | undefined;
};

/** Real SDK boundary used by standalone execution. */
export const defaultSdk: PiBridgeSdk = {
  /**
   * Creates the real isolated model runtime.
   *
   * @param options - Runtime isolation options.
   * @returns The Pi model runtime.
   */
  createModelRuntime: async (options) => {
    const runtimeFactory = ModelRuntime as unknown as {
      /** Creates the isolated model runtime. */
      create: PiBridgeSdk['createModelRuntime'];
    };
    return await runtimeFactory.create(options);
  },
  createSettings: SettingsManager.inMemory.bind(SettingsManager),
  createSessionManager: SessionManager.inMemory.bind(SessionManager),
  /**
   * Creates the real default resource loader.
   *
   * @param options - Resource loader options.
   * @returns The configured resource loader.
   */
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  defineTool,
  /**
   * Creates the real Pi session and narrows it to the bridge contract.
   *
   * @param options - Agent session options.
   * @returns The created bridge session.
   */
  createAgentSession: async (options) => {
    const { session } = await createAgentSession(options);
    return { session: session as unknown as PiBridgeSession };
  },
  /**
   * Resolves the real registered provider model.
   *
   * @param options - Model resolver options.
   * @returns The resolved model or error.
   */
  resolveCliModel: (options) => {
    const result = resolveCliModel(options);
    return { model: result.model, error: result.error };
  },
};

/** Validated package-owned Pi options received from the host. */
export type BridgePiOptions = {
  /** LiteLLM model identifier. */
  model: string;
  /** Absolute in-container working directory. */
  cwd: string;
  /** Optional replacement system prompt. */
  systemPrompt?: string;
  /** Exact built-in tool allowlist. */
  tools: string[];
  /** Declared model context window. */
  contextWindow?: number;
  /** Declared maximum output tokens. */
  maxTokens?: number;
  /** Whether the model supports reasoning output. */
  reasoning?: boolean;
  /** Declared input modalities. */
  input?: ('text' | 'image')[];
  /** Model pricing declaration. */
  cost?: {
    /** Input token price. */
    input?: number;
    /** Output token price. */
    output?: number;
    /** Cache-read price. */
    cacheRead?: number;
    /** Cache-write price. */
    cacheWrite?: number;
  };
  /** Locked structured-judge configuration. */
  structured?: {
    /** JSON schema enforced by the terminating tool. */
    schema: Record<string, unknown>;
    /** Judge system prompt. */
    systemPrompt: string;
  };
};

/** Structural Pi session boundary used by the standalone bridge. */
export type PiBridgeSession = {
  /** Ephemeral session identifier. */
  sessionId: string;
  /** Active resolved model. */
  model:
    | {
        /** Provider identifier. */
        provider?: string;
        /** Model identifier. */
        id?: string;
      }
    | undefined;
  /** Whether Pi still has active work. */
  isStreaming: boolean;
  /** Returns enabled tool names. */
  getActiveToolNames: () => string[];
  /** Subscribes to Pi lifecycle events. */
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  /** Sends the one-shot prompt. */
  prompt: (prompt: string) => Promise<void>;
  /** Selects the resolved model. */
  setModel: (model: unknown) => Promise<void>;
  /** Aborts active work. */
  abort: () => Promise<void>;
  /** Releases session listeners and resources. */
  dispose: () => void;
};

/** Result returned by the isolated-session factory. */
export type PiBridgeSessionResult = {
  /** Created session. */
  session: PiBridgeSession;
  /** Returns captured structured tool parameters, when present. */
  getStructuredResult: () => unknown;
};

/** Provider model declaration registered with Pi. */
type ProviderModelDeclaration = {
  /** Model identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether reasoning output is supported. */
  reasoning: boolean;
  /** Supported input modalities. */
  input: ('text' | 'image')[];
  /** Declared model pricing. */
  cost: {
    /** Input token price. */
    input: number;
    /** Output token price. */
    output: number;
    /** Cache-read price. */
    cacheRead: number;
    /** Cache-write price. */
    cacheWrite: number;
  };
  /** Context window size. */
  contextWindow: number;
  /** Maximum output token count. */
  maxTokens: number;
};

/** Structured tool execution result. */
type StructuredToolResult = {
  /** Human-readable tool output. */
  content: StructuredTextContent[];
  /** Captured structured parameters. */
  details: unknown;
  /** Terminates the agent turn. */
  terminate: true;
};

/** Text content returned by the terminating structured tool. */
type StructuredTextContent = {
  /** Content discriminant. */
  type: 'text';
  /** Serialized structured parameters. */
  text: string;
};

/**
 * Creates the terminating structured tool executor.
 *
 * @param capture - Stores the submitted structured parameters.
 * @returns A Pi custom-tool execution callback.
 */
function createStructuredToolExecutor(
  capture: (params: unknown) => void,
): (_id: string, params: unknown) => Promise<StructuredToolResult> {
  return async (
    _id: string,
    params: unknown,
  ): Promise<StructuredToolResult> => {
    capture(params);
    return {
      content: [{ type: 'text', text: JSON.stringify(params) }],
      details: params,
      terminate: true,
    };
  };
}

/**
 * Runs one v1 request and emits ordered message/error/done JSONL frames.
 *
 * @param deps - Injected streams, environment, and optional session factory.
 * @returns Process exit code: zero on success, one on failure.
 */
export async function runPiBridge(deps: PiBridgeDeps): Promise<number> {
  try {
    const request = await readRequest(deps.stdin);
    const options = validateOptions(request.options, deps.env);
    const factory = deps.createSession;
    const { session, getStructuredResult } =
      factory === undefined
        ? await createIsolatedSession(options, deps.env, deps.sdk ?? defaultSdk)
        : await factory(options, deps.env);
    let settled = false;
    let pendingSettledFrame: Record<string, unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    let writerOpen = true;
    let writeTail: Promise<void> = Promise.resolve();
    let pendingWrites = 0;
    let writeFailure: Error | undefined;
    let primaryFailure: Error | undefined;
    let abortPromise: Promise<void> | undefined;
    let completed = false;
    let runError: Error | undefined;
    /**
     * Aborts the session at most once.
     *
     * @returns Shared abort settlement.
     */
    const abortOnce = async (): Promise<void> => {
      abortPromise ??= Promise.resolve().then(async () => session.abort());
      return await abortPromise;
    };
    /**
     * Records the first writer failure and promptly stops the producer.
     *
     * @param cause - Writer, frame-size, or queue failure.
     */
    const failWriter = (cause: unknown): void => {
      if (writeFailure !== undefined) {
        return;
      }
      writeFailure = normalizeFailure(cause);
      primaryFailure ??= writeFailure;
      writerOpen = false;
      settleIgnored(abortOnce());
    };
    /**
     * @param event - Protocol frame to append to the serialized write tail.
     */
    const enqueue = (event: Record<string, unknown>): void => {
      if (!writerOpen) {
        return;
      }
      const serialized = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(serialized) > MAX_BRIDGE_LINE_LENGTH) {
        failWriter(new Error('Pi bridge frame exceeded maximum line length.'));
        return;
      }
      if (pendingWrites >= MAX_BRIDGE_QUEUE_SIZE) {
        failWriter(
          new Error('Pi bridge pending write queue exceeded 10000 events.'),
        );
        return;
      }
      pendingWrites += 1;
      const operation = writeTail
        .then(async (): Promise<undefined> => {
          if (writeFailure === undefined) {
            await writeSerializedEvent(deps.stdout, serialized);
          }
          return undefined;
        })
        .finally((): void => {
          pendingWrites -= 1;
        });
      // Observe the write immediately so a broken stdout never becomes an
      // unhandled rejection, while keeping the public tail fulfilled so the
      // final drain is deterministic.
      writeTail = operation.then(
        (): undefined => undefined,
        (cause: unknown): undefined => {
          failWriter(cause);
          return undefined;
        },
      );
    };
    /**
     * Removes the callback source before sealing the writer.
     */
    const stopListening = (): void => {
      const stop = unsubscribe;
      unsubscribe = undefined;
      try {
        stop?.();
      } catch {
        // Subscription cleanup is best-effort.
      }
    };
    try {
      unsubscribe = session.subscribe((event) => {
        const dto = toDto(event, session, getStructuredResult);
        if (event.type === 'agent_settled') {
          settled = true;
          if (dto !== undefined && pendingSettledFrame === undefined) {
            pendingSettledFrame = {
              version: BRIDGE_PROTOCOL_VERSION,
              type: 'message',
              message: dto,
            };
          }
          return;
        }
        if (!settled && dto !== undefined) {
          enqueue({
            version: BRIDGE_PROTOCOL_VERSION,
            type: 'message',
            message: dto,
          });
        }
      });
      enqueue({
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'message',
        message: {
          kind: 'init',
          sessionId: session.sessionId,
          model: `${session.model?.provider ?? PROVIDER_ID}/${session.model?.id ?? options.model}`,
          tools: session.getActiveToolNames(),
        },
      });
      let promptFailure: Error | undefined;
      try {
        await session.prompt(request.prompt);
      } catch (cause) {
        promptFailure = normalizeFailure(cause);
        primaryFailure ??= promptFailure;
      }
      // Pi emits run events before prompt settlement; remove the only callback
      // producer before publishing the buffered terminal frame so no late
      // callback can extend the write tail after the final drain.
      stopListening();
      if (
        promptFailure === undefined &&
        primaryFailure === undefined &&
        pendingSettledFrame !== undefined
      ) {
        enqueue(pendingSettledFrame);
      }
      writerOpen = false;
      await writeTail;
      if (primaryFailure !== undefined) {
        throw primaryFailure;
      }
      if (pendingSettledFrame === undefined) {
        throw new Error('Pi prompt completed without agent_settled.');
      }
      await writeEvent(deps.stdout, {
        version: BRIDGE_PROTOCOL_VERSION,
        type: 'done',
      });
      completed = true;
      return 0;
    } catch (cause) {
      runError = normalizeFailure(cause);
      throw runError;
    } finally {
      if (abortPromise !== undefined || (!settled && session.isStreaming)) {
        try {
          await abortOnce();
        } catch {
          // Abort cleanup must not mask the writer or provider failure.
        }
      }
      stopListening();
      try {
        session.dispose();
      } catch (cause) {
        if (completed && runError === undefined) {
          // eslint-disable-next-line no-unsafe-finally -- No primary failure exists after natural completion.
          throw normalizeFailure(cause);
        }
      }
    }
  } catch (cause) {
    try {
      await writeEvent(deps.stdout, makeErrorEvent(cause));
    } catch {
      // Stdout may be the original failure; retain the primary diagnostic.
    }
    try {
      deps.stderr.write(`[pi-bridge] failed: ${describeError(cause)}\n`);
    } catch {
      // Diagnostic output is best-effort.
    }
    return 1;
  }
}

/**
 * Constructs the exact isolated Pi session used in Docker.
 *
 * @param options - Validated bridge options.
 * @param env - Environment used to configure LiteLLM.
 * @param sdk - Injected Pi SDK boundary.
 * @returns The isolated session and structured result accessor.
 */
export async function createIsolatedSession(
  options: BridgePiOptions,
  env: Record<string, string | undefined>,
  sdk: PiBridgeSdk = defaultSdk,
): Promise<{
  /**
   *
   */
  session: PiBridgeSession;
  /**
   *
   */
  getStructuredResult: () => unknown;
}> {
  const modelRuntime = await sdk.createModelRuntime({
    modelsPath: null,
    credentials: createBridgeCredentialStore(),
    allowModelNetwork: false,
  });
  const settingsManager = sdk.createSettings({
    retry: { enabled: false },
    compaction: { enabled: false },
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
  });
  const sessionManager = sdk.createSessionManager(options.cwd);
  const agentDir = `${options.cwd}/.metamask-agent-runner-pi`;
  const resourceLoader = sdk.createResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    ...((options.structured?.systemPrompt ?? options.systemPrompt) === undefined
      ? {}
      : {
          systemPrompt:
            options.structured?.systemPrompt ?? options.systemPrompt ?? '',
        }),
    extensionFactories: [
      (api): void =>
        api.registerProvider(PROVIDER_ID, {
          name: 'LiteLLM',
          baseUrl: `${env.LITELLM_BASE_URL?.replace(/\/+$/u, '')}/v1`,
          apiKey: '$LITELLM_API_KEY',
          api: 'openai-completions',
          authHeader: true,
          models: [modelDeclaration(options)],
        }),
    ],
  });
  await resourceLoader.reload();
  let structuredResult: unknown;
  const customTools: ToolDefinition[] = [];
  if (options.structured !== undefined) {
    customTools.push(
      sdk.defineTool({
        name: 'submit_judgment',
        label: 'Submit Judgment',
        description: 'Submit the final structured judgment and stop.',
        parameters: options.structured.schema,
        constrainedSampling: { type: 'json_schema', strict: 'require' },
        execute: createStructuredToolExecutor((params): void => {
          structuredResult = params;
        }),
      }),
    );
  }
  const { session } = await sdk.createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
    ...(options.structured === undefined
      ? { tools: options.tools }
      : {
          noTools: 'builtin',
          tools: ['submit_judgment'],
          customTools,
        }),
  });
  try {
    const resolved = sdk.resolveCliModel({
      cliProvider: PROVIDER_ID,
      cliModel: options.model,
      modelRuntime,
    });
    if (resolved.model === undefined) {
      throw new Error(
        `Could not resolve ${PROVIDER_ID}/${options.model}: ${resolved.error ?? 'unknown error'}`,
      );
    }
    await session.setModel(resolved.model);
  } catch (cause) {
    try {
      session.dispose();
    } catch {
      // Setup cleanup must not mask the model-resolution or setModel failure.
    }
    throw normalizeFailure(cause);
  }
  return {
    session,
    /** @returns Captured structured tool parameters. */
    getStructuredResult: (): unknown => structuredResult,
  };
}

/**
 * Builds the one registered LiteLLM model.
 *
 * @param options - Validated bridge options.
 * @returns Provider model declaration.
 */
function modelDeclaration(options: BridgePiOptions): ProviderModelDeclaration {
  return {
    id: options.model,
    name: options.model,
    reasoning: options.reasoning ?? false,
    input: options.input ?? ['text'],
    cost: {
      input: options.cost?.input ?? 0,
      output: options.cost?.output ?? 0,
      cacheRead: options.cost?.cacheRead ?? 0,
      cacheWrite: options.cost?.cacheWrite ?? 0,
    },
    contextWindow: options.contextWindow ?? 128_000,
    maxTokens: options.maxTokens ?? 8_192,
  };
}

/** Builds the package-owned provider declaration for boundary tests. */
export const createModelDeclaration = modelDeclaration;

/**
 * Converts finalized Pi events into JSON-safe DTOs.
 *
 * @param event - Pi lifecycle event.
 * @param session - Active bridge session.
 * @param getStructuredResult - Structured result accessor.
 * @returns A normalized DTO, or undefined for ignored events.
 */
function toDto(
  event: AgentSessionEvent,
  session: PiBridgeSession,
  getStructuredResult: () => unknown,
): Record<string, unknown> | undefined {
  if (event.type === 'agent_settled') {
    const structuredResult = getStructuredResult();
    return {
      kind: 'agent_settled',
      ...(structuredResult === undefined ? {} : { structuredResult }),
    };
  }
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const { message } = event;
    return {
      kind: 'assistant_message_end',
      model: message.model ?? `${session.model?.provider}/${session.model?.id}`,
      content: Array.isArray(message.content)
        ? message.content.flatMap(normalizeContent)
        : [],
      usage: isRecord(message.usage)
        ? normalizeUsage(message.usage)
        : undefined,
      ...(message.stopReason === undefined
        ? {}
        : { stopReason: message.stopReason }),
      ...(message.errorMessage === undefined
        ? {}
        : { errorMessage: message.errorMessage }),
    };
  }
  if (
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  ) {
    return normalizeToolEvent(event);
  }
  if (
    event.type === 'auto_retry_start' ||
    event.type === 'auto_retry_end' ||
    event.type.startsWith('summarization_retry_') ||
    event.type.startsWith('compaction_')
  ) {
    return {
      kind: 'system',
      subtype: event.type,
      details: JSON.parse(JSON.stringify(event)) as unknown,
      ...('finalError' in event && typeof event.finalError === 'string'
        ? { error: event.finalError }
        : {}),
    };
  }
  return undefined;
}

/**
 * Normalizes one assistant content block.
 *
 * @param value - Raw assistant content.
 * @returns Zero or one normalized content blocks.
 */
function normalizeContent(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return [{ type: 'text', text: value.text }];
  }
  if (
    (value.type === 'toolCall' || value.type === 'tool_use') &&
    typeof value.id === 'string' &&
    typeof value.name === 'string'
  ) {
    return [
      {
        type: 'toolCall',
        id: value.id,
        name: value.name,
        arguments: value.arguments ?? value.input ?? {},
      },
    ];
  }
  return [];
}

/** Normalizes one provider content block for boundary tests. */
export const normalizeBridgeContent = normalizeContent;

/**
 * Normalizes finalized assistant usage.
 *
 * @param usage - Raw provider usage.
 * @returns JSON-safe usage DTO.
 */
function normalizeUsage(
  usage: Record<string, unknown>,
): Record<string, unknown> {
  const cost =
    isRecord(usage.cost) && typeof usage.cost.total === 'number'
      ? { total: usage.cost.total }
      : undefined;
  return {
    ...(typeof usage.input === 'number' ? { input: usage.input } : {}),
    ...(typeof usage.output === 'number' ? { output: usage.output } : {}),
    ...(typeof usage.cacheRead === 'number'
      ? { cacheRead: usage.cacheRead }
      : {}),
    ...(typeof usage.cacheWrite === 'number'
      ? { cacheWrite: usage.cacheWrite }
      : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** Normalizes provider usage for boundary tests. */
export const normalizeBridgeUsage = normalizeUsage;

/**
 * Normalizes a Pi tool lifecycle event.
 *
 * @param event - Raw tool lifecycle event.
 * @returns JSON-safe tool DTO.
 */
function normalizeToolEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const kind = String(event.type);
  const base = {
    kind,
    toolName: typeof event.toolName === 'string' ? event.toolName : '',
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
  };
  if (kind === 'tool_execution_start') {
    return base;
  }
  const content = stringifyJsonSafe(
    event.result ?? event.partialResult ?? event.content,
  );
  if (kind === 'tool_execution_update') {
    return { ...base, ...(content.length === 0 ? {} : { content }) };
  }
  return { ...base, content, isError: event.isError === true };
}

/** Normalizes one provider tool event for boundary tests. */
export const normalizeBridgeToolEvent = normalizeToolEvent;

/**
 * Reads and validates the protocol-v1 request.
 *
 * @param stdin - Request input stream.
 * @returns Validated prompt and options record.
 */
async function readRequest(stdin: NodeJS.ReadableStream): Promise<{
  /**
   *
   */
  prompt: string;
  /**
   *
   */
  options: Record<string, unknown>;
}> {
  let raw = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    raw += String(chunk);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.type !== 'run') {
    throw new Error('Pi bridge expected a protocol-v1 run request.');
  }
  if (typeof parsed.prompt !== 'string' || !isRecord(parsed.options)) {
    throw new Error(
      'Pi bridge request requires string prompt and object options.',
    );
  }
  return { prompt: parsed.prompt, options: parsed.options };
}

/**
 * Validates credentials and package-owned options.
 *
 * @param input - Parsed options record.
 * @param env - Bridge environment.
 * @returns Validated Pi options.
 */
function validateOptions(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
): BridgePiOptions {
  if (!isPlainRecord(input)) {
    throw new Error('Pi bridge options must be a plain object.');
  }
  for (const key of Object.keys(input)) {
    if (!BRIDGE_OPTION_KEYS.has(key)) {
      throw new Error(`Pi bridge received unknown option \`${key}\`.`);
    }
  }
  if (!env.LITELLM_BASE_URL || !env.LITELLM_API_KEY) {
    throw new Error('Pi bridge requires LITELLM_BASE_URL and LITELLM_API_KEY.');
  }
  if (
    typeof input.model !== 'string' ||
    input.model.trim().length === 0 ||
    typeof input.cwd !== 'string' ||
    !input.cwd.startsWith('/') ||
    !Array.isArray(input.tools) ||
    !input.tools.every(
      (tool) => typeof tool === 'string' && BRIDGE_TOOLS.has(tool),
    )
  ) {
    throw new Error('Pi bridge received invalid model, cwd, or tools options.');
  }
  if (
    input.systemPrompt !== undefined &&
    typeof input.systemPrompt !== 'string'
  ) {
    throw new Error('Pi bridge systemPrompt must be a string.');
  }
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const value = input[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0)
    ) {
      throw new Error(`Pi bridge ${key} must be a positive integer.`);
    }
  }
  if (input.reasoning !== undefined && typeof input.reasoning !== 'boolean') {
    throw new Error('Pi bridge reasoning must be a boolean.');
  }
  if (
    input.input !== undefined &&
    (!Array.isArray(input.input) ||
      input.input.length === 0 ||
      input.input.some((value) => value !== 'text' && value !== 'image') ||
      new Set(input.input).size !== input.input.length)
  ) {
    throw new Error('Pi bridge input modalities are invalid.');
  }
  if (input.cost !== undefined) {
    if (!isPlainRecord(input.cost)) {
      throw new Error('Pi bridge cost must be a plain object.');
    }
    const keys = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);
    for (const [key, value] of Object.entries(input.cost)) {
      if (
        !keys.has(key) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new Error(`Pi bridge cost field \`${key}\` is invalid.`);
      }
    }
  }
  if (
    input.structured !== undefined &&
    (!isPlainRecord(input.structured) ||
      !isPlainRecord(input.structured.schema) ||
      typeof input.structured.systemPrompt !== 'string' ||
      Object.keys(input.structured).some(
        (key) => key !== 'schema' && key !== 'systemPrompt',
      ))
  ) {
    throw new Error('Pi bridge structured options are invalid.');
  }
  return input as BridgePiOptions;
}

/** Validates package-owned Pi bridge options at the protocol boundary. */
export const validateBridgeOptions = validateOptions;

/**
 * Writes one JSONL frame while respecting stdout backpressure.
 *
 * @param stdout - Protocol output stream.
 * @param event - JSON-safe event frame.
 */
async function writeEvent(
  stdout: NodeJS.WritableStream,
  event: Record<string, unknown>,
): Promise<void> {
  const canContinue = stdout.write(`${JSON.stringify(event)}\n`);
  if (!canContinue) {
    await new Promise<void>((resolve) => stdout.once('drain', resolve));
  }
}

/**
 * Writes a pre-serialized frame while respecting backpressure.
 *
 * @param stdout - Protocol output stream.
 * @param serialized - Complete newline-terminated frame.
 */
async function writeSerializedEvent(
  stdout: NodeJS.WritableStream,
  serialized: string,
): Promise<void> {
  const canContinue = stdout.write(serialized);
  if (!canContinue) {
    await new Promise<void>((resolve) => stdout.once('drain', resolve));
  }
}

/**
 * Creates a normalized protocol error frame.
 *
 * @param cause - Failure to normalize.
 * @returns Protocol error frame.
 */
function makeErrorEvent(cause: unknown): Record<string, unknown> {
  const error =
    cause instanceof Error
      ? {
          name: cause.name || 'Error',
          message: cause.message,
          stack: cause.stack,
        }
      : { name: 'Error', message: String(cause) };
  return { version: BRIDGE_PROTOCOL_VERSION, type: 'error', error };
}

/** Normalizes one bridge failure for boundary tests. */
export const makeBridgeErrorEvent = makeErrorEvent;

/**
 * Formats arbitrary failures for stderr.
 *
 * @param cause - Failure to describe.
 * @returns Human-readable description.
 */
function describeError(cause: unknown): string {
  return cause instanceof Error
    ? (cause.stack ?? `${cause.name}: ${cause.message}`)
    : String(cause);
}

/** Describes one bridge failure for boundary tests. */
export const describeBridgeError = describeError;

/**
 * Converts an arbitrary bridge rejection into an Error.
 *
 * @param cause - Value rejected or thrown inside the bridge.
 * @returns The original Error or a normalized wrapper.
 */
function normalizeFailure(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Observes a best-effort promise so its rejection never goes unhandled.
 *
 * @param promise - Promise whose settlement is intentionally ignored.
 */
export function settleIgnored(promise: Promise<unknown>): void {
  promise
    .then(
      (): undefined => undefined,
      (): undefined => undefined,
    )
    .catch((): undefined => undefined);
}

/**
 * Tests whether a value is a non-array object record.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tests whether a value is a plain record.
 *
 * @param value - Candidate value.
 * @returns Whether the value has a plain object prototype.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Detects standalone bridge execution.
 *
 * @returns Whether this module is the process entry point.
 */
export function isMain(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

/* istanbul ignore next -- exercised only by the copied standalone entry point */
if (isMain()) {
  settleMain(
    runPiBridge({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    }).then(
      (code) => {
        process.exitCode = code;
        setTimeout(() => process.exit(code), 1000).unref();
        return undefined;
      },
      (cause: unknown) => {
        process.stderr.write(`[pi-bridge] fatal: ${describeError(cause)}\n`);
        process.exitCode = 1;
        return undefined;
      },
    ),
  );
}

/**
 * Serializes tool output into stable text.
 *
 * @param value - Tool output.
 * @returns Stable textual content.
 */
export function stringifyJsonSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Observes the standalone main promise to prevent unhandled rejections.
 *
 * @param promise - Main bridge promise.
 */
export function settleMain(promise: Promise<unknown>): void {
  promise.catch((cause: unknown) => {
    process.stderr.write(`[pi-bridge] fatal: ${describeError(cause)}\n`);
  });
}

/** Exercises the real session factory boundary without starting a prompt. */
export const createDefaultAgentSession = defaultSdk.createAgentSession;
