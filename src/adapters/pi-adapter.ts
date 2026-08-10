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
import { PI_DOCKER_SANDBOX_FORWARD_ENV } from '../sandbox/types.js';
import type {
  AgentMessage,
  ProviderAdapter,
  RunConfig,
  RunStructuredConfig,
} from '../types.js';
import { createPiCredentialStore } from './pi-credential-store.js';
import type { PiCredentialStore } from './pi-credential-store.js';
import { createPiEventTranslator } from './pi-message-translator.js';
import type { PiEventDto, PiQueryOptions, PiToolName } from './pi-types.js';

const PI_PROVIDER_ID = 'litellm';
const DEFAULT_PI_TOOLS: readonly PiToolName[] = [
  'read',
  'bash',
  'edit',
  'write',
];
const ALL_PI_TOOLS = new Set<PiToolName>([
  ...DEFAULT_PI_TOOLS,
  'grep',
  'find',
  'ls',
]);
const CLAUDE_POLICY_KEYS = [
  'allowedTools',
  'disallowedTools',
  'canUseTool',
  'permissionMode',
  'dangerouslySkipPermissions',
  'allowDangerouslySkipPermissions',
] as const;
const PI_OPTION_KEYS = new Set([
  'model',
  'cwd',
  'systemPrompt',
  'tools',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'cost',
]);
const PI_STRUCTURED_INHERITED_KEYS: readonly (keyof PiQueryOptions)[] = [
  'model',
  'cwd',
  'systemPrompt',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'cost',
];
const MAX_DIRECT_EVENT_QUEUE = 10_000;

/** Minimal structural contract used after the lazy Pi module import. */
/* eslint-disable jsdoc/require-jsdoc -- Mirrors the external SDK's structural boundary. */
type PiModule = {
  // External SDK constructor names intentionally retain their published casing.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  ModelRuntime: {
    create: (options?: {
      modelsPath?: string | null | undefined;
      allowModelNetwork?: boolean;
      credentials?: PiCredentialStore;
    }) => Promise<unknown>;
  };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  SettingsManager: {
    inMemory: (settings: Record<string, unknown>) => unknown;
  };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  SessionManager: { inMemory: (cwd: string) => unknown };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload: () => Promise<void>;
  };
  createAgentSession: (
    options: Record<string, unknown>,
  ) => Promise<{ session: PiSession }>;
  resolveCliModel: (options: Record<string, unknown>) => {
    model?: unknown;
    error?: string;
  };
  defineTool: (definition: Record<string, unknown>) => unknown;
};

/** Pi session methods needed by the harness lifecycle. */
type PiSession = {
  sessionId: string;
  model?: { provider?: string; id?: string };
  isStreaming: boolean;
  getActiveToolNames: () => string[];
  setModel: (model: unknown) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  prompt: (prompt: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
};
/* eslint-enable jsdoc/require-jsdoc */

let piModulePromise: Promise<PiModule> | undefined;

/**
 * Lazily imports and caches the ESM-only Pi SDK.
 *
 * @returns The imported Pi SDK module.
 */
async function loadPiModule(): Promise<PiModule> {
  piModulePromise ??= import('@earendil-works/pi-coding-agent').then(
    (module): PiModule => module as unknown as PiModule,
  );
  return piModulePromise;
}

/**
 * Creates the synchronous, lazily-loaded Pi provider adapter.
 *
 * @returns A Pi provider adapter.
 */
export function createPiAdapter(): ProviderAdapter<PiQueryOptions, string> {
  return {
    name: 'pi',
    capabilities: { sandboxes: ['docker'] },
    getRunMetadata: getPiRunMetadata,
    getStructuredDefaults: getPiStructuredDefaults,
    run: runPi,
    runStructured: runStructuredPi,
  };
}

/**
 * Selects the runner defaults safe to inherit for a structured Pi run.
 *
 * @param defaults - Runner-level Pi default options.
 * @returns Model and session metadata, excluding execution-policy fields.
 */
function getPiStructuredDefaults(
  defaults: Partial<PiQueryOptions>,
): Partial<PiQueryOptions> {
  if (!isPlainRecord(defaults)) {
    return {};
  }
  const inherited: Partial<PiQueryOptions> = {};
  for (const key of PI_STRUCTURED_INHERITED_KEYS) {
    if (defaults[key] !== undefined) {
      Object.assign(inherited, { [key]: defaults[key] });
    }
  }
  return inherited;
}

/**
 * Extracts Pi telemetry metadata without inventing turn limits.
 *
 * @param options - Pi options for the run.
 * @returns Provider-owned run metadata.
 */
function getPiRunMetadata(
  options: Partial<PiQueryOptions>,
): ProviderRunMetadataShape {
  return { model: options.model ?? 'unknown' };
}

/** Structured Pi tool execution result. */
type StructuredToolResult = {
  /** Human-readable tool output. */
  content: StructuredTextContent[];
  /** Captured structured parameters. */
  details: unknown;
  /** Terminates the agent turn. */
  terminate: true;
};

/** Provider-owned Pi telemetry metadata. */
type ProviderRunMetadataShape = {
  /** Requested model identifier. */
  model: string;
};

/** Text content returned by the terminating structured tool. */
type StructuredTextContent = {
  /** Content discriminant. */
  type: 'text';
  /** Serialized structured parameters. */
  text: string;
};

/**
 * Creates the terminating structured-judgment tool executor.
 *
 * @param capture - Stores validated tool parameters for the result event.
 * @returns A Pi custom-tool execute callback.
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
 * Runs Pi and translates its event DTO stream.
 *
 * @param config - Provider run configuration.
 * @yields Normalized agent messages.
 */
async function* runPi(
  config: RunConfig<PiQueryOptions, string>,
): AsyncGenerator<AgentMessage> {
  const options = validateOptions(config.options, false);
  const translator = createPiEventTranslator();
  const events =
    config.sandbox === undefined
      ? runDirectPi(config.prompt, options)
      : runSandboxPi(config.prompt, options, config.sandbox);
  for await (const event of events) {
    const translated = translator.translate(event);
    if (translated !== undefined) {
      yield translated;
    }
  }
}

/**
 * Runs Pi through the generic Docker bridge and always handles teardown.
 *
 * @param prompt - Prompt to execute.
 * @param options - Validated Pi options.
 * @param sandbox - Docker sandbox configuration.
 * @yields JSON-safe Pi event DTOs.
 */
async function* runSandboxPi(
  prompt: string,
  options: ValidatedPiOptions,
  sandbox: NonNullable<RunConfig<PiQueryOptions, string>['sandbox']>,
): AsyncGenerator<PiEventDto> {
  const normalized = normalizeDockerSandboxConfig(sandbox, {
    hostCwd: options.cwd,
    defaultForwardEnv: PI_DOCKER_SANDBOX_FORWARD_ENV,
  });
  const prepared = prepareDockerSandboxRequest({
    prompt,
    options,
    sandbox: normalized,
  });
  const commandRunner = createDefaultDockerCommandRunner();
  if (
    normalized.envFile === undefined &&
    (!normalized.env.LITELLM_BASE_URL || !normalized.env.LITELLM_API_KEY)
  ) {
    throw new Error(
      'Pi Docker sandbox requires LITELLM_BASE_URL and LITELLM_API_KEY via sandbox env, forwardEnv, or envFile.',
    );
  }
  const handle = await createDockerSandbox(normalized, { commandRunner });
  let completed = false;
  let bridgeError: unknown;
  let closeError: unknown;
  try {
    const events = runDockerBridge({
      runtime: PI_BRIDGE_RUNTIME,
      sandbox: handle,
      config: normalized,
      commandRunner,
      request: prepared,
    });
    for await (const event of events) {
      if (isPiEventDto(event)) {
        yield event;
      } else {
        throw new Error('Pi bridge emitted an invalid event DTO.');
      }
    }
    completed = true;
  } catch (cause) {
    bridgeError = cause;
  } finally {
    const consumerAborted = !completed && bridgeError === undefined;
    if (
      consumerAborted ||
      normalized.cleanup === 'always' ||
      (normalized.cleanup === 'on-success' && completed)
    ) {
      try {
        await handle.close();
      } catch (cause) {
        closeError = cause;
      }
    } else {
      handle.unregisterCleanup();
    }
  }
  if (bridgeError !== undefined) {
    throw normalizeError(bridgeError);
  }
  if (closeError !== undefined) {
    throw normalizeError(closeError);
  }
}

/**
 * Runs Pi with a strict terminating structured-output tool.
 *
 * @param config - Structured provider run configuration.
 * @yields Normalized agent messages.
 */
async function* runStructuredPi(
  config: RunStructuredConfig<PiQueryOptions>,
): AsyncGenerator<AgentMessage> {
  const options = validateOptions(config.options, true);
  const translator = createPiEventTranslator();
  for await (const event of runDirectPi(config.prompt, options, {
    schema: config.schema,
    systemPrompt: config.systemPrompt,
  })) {
    const translated = translator.translate(event);
    if (translated?.type === 'result' && translated.success) {
      const captured =
        event.kind === 'agent_settled' ? event.structuredResult : undefined;
      yield captured === undefined
        ? {
            ...translated,
            success: false,
            error: 'Pi did not submit a judgment.',
          }
        : { ...translated, result: JSON.stringify(captured) };
    } else if (translated !== undefined) {
      yield translated;
    }
  }
}

/** Fully validated internal options. */
/* eslint-disable jsdoc/require-jsdoc -- Internal refinements only. */
type ValidatedPiOptions = PiQueryOptions & {
  model: string;
  cwd: string;
  tools: readonly PiToolName[];
};
/* eslint-enable jsdoc/require-jsdoc */

/**
 * Rejects unsupported policy fields and resolves secure defaults.
 *
 * @param input - Caller-provided options.
 * @param structured - Whether this is a locked structured run.
 * @returns Validated and defaulted options.
 */
function validateOptions(
  input: Partial<PiQueryOptions>,
  structured: boolean,
): ValidatedPiOptions {
  if (!isPlainRecord(input)) {
    throw new Error('Pi options must be a plain object.');
  }
  const runtime: Record<string, unknown> = input;
  for (const key of Object.keys(runtime)) {
    if (!PI_OPTION_KEYS.has(key)) {
      if (
        CLAUDE_POLICY_KEYS.includes(key as (typeof CLAUDE_POLICY_KEYS)[number])
      ) {
        throw new Error(
          `Pi does not support Claude tool policy option \`${key}\`.`,
        );
      }
      throw new Error(`Unknown Pi option \`${key}\`.`);
    }
  }
  for (const key of CLAUDE_POLICY_KEYS) {
    if (key in runtime) {
      throw new Error(
        `Pi does not support Claude tool policy option \`${key}\`.`,
      );
    }
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    throw new Error('Pi requires a non-empty `options.model`.');
  }
  if (
    input.systemPrompt !== undefined &&
    typeof input.systemPrompt !== 'string'
  ) {
    throw new Error('Pi `options.systemPrompt` must be a string.');
  }
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const value = input[key];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    ) {
      throw new Error(`Pi \`options.${key}\` must be a positive integer.`);
    }
  }
  if (input.reasoning !== undefined && typeof input.reasoning !== 'boolean') {
    throw new Error('Pi `options.reasoning` must be a boolean.');
  }
  if (
    input.input !== undefined &&
    (!Array.isArray(input.input) ||
      input.input.length === 0 ||
      input.input.some((value) => value !== 'text' && value !== 'image') ||
      new Set(input.input).size !== input.input.length)
  ) {
    throw new Error(
      'Pi `options.input` must contain unique `text` or `image` modalities.',
    );
  }
  if (input.cost !== undefined) {
    if (!isPlainRecord(input.cost)) {
      throw new Error('Pi `options.cost` must be a plain object.');
    }
    const costKeys = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);
    for (const [key, value] of Object.entries(input.cost)) {
      if (
        !costKeys.has(key) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new Error(`Invalid Pi cost field \`${key}\`.`);
      }
    }
  }
  if (structured && 'tools' in runtime) {
    throw new Error(
      'Pi structured runs do not accept caller tool customization.',
    );
  }
  const tools = structured ? [] : [...(input.tools ?? DEFAULT_PI_TOOLS)];
  for (const tool of tools) {
    if (!ALL_PI_TOOLS.has(tool) || /[():*]/u.test(tool)) {
      throw new Error(`Unsupported Pi tool name: ${String(tool)}.`);
    }
  }
  // eslint-disable-next-line no-restricted-globals -- Authoritative host cwd.
  const cwd = input.cwd ?? process.cwd();
  if (!cwd.startsWith('/')) {
    throw new Error('Pi `options.cwd` must be an absolute path.');
  }
  return { ...input, model: input.model, cwd, tools };
}

/** Validates package-owned Pi options at the runtime boundary. */
export const validatePiOptions = validateOptions;

/** Optional structured mode configuration. */
/* eslint-disable jsdoc/require-jsdoc -- Internal structured state. */
type StructuredMode = {
  schema: Record<string, unknown>;
  systemPrompt: string;
};
/* eslint-enable jsdoc/require-jsdoc */

/**
 * Executes the exact isolated Pi lifecycle through a bounded event channel.
 *
 * @param prompt - Prompt to execute.
 * @param options - Validated Pi options.
 * @param structured - Optional structured configuration.
 * @yields JSON-safe Pi events as callbacks arrive.
 */
async function* runDirectPi(
  prompt: string,
  options: ValidatedPiOptions,
  structured?: StructuredMode,
): AsyncGenerator<PiEventDto> {
  // eslint-disable-next-line no-restricted-globals -- Credentials are env-only.
  assertLiteLlmEnv(process.env);
  const pi = await loadPiModule();
  const modelRuntime = await pi.ModelRuntime.create({
    modelsPath: null,
    credentials: createPiCredentialStore(),
    allowModelNetwork: false,
  });
  const settingsManager = pi.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
  });
  const sessionManager = pi.SessionManager.inMemory(options.cwd);
  const agentDir = `${options.cwd}/.metamask-agent-runner-pi`;
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    ...((structured?.systemPrompt ?? options.systemPrompt) === undefined
      ? {}
      : {
          systemPrompt: structured?.systemPrompt ?? options.systemPrompt ?? '',
        }),
    extensionFactories: [
      (api: {
        /** Registers the isolated provider. */
        registerProvider: (id: string, config: unknown) => void;
      }): void =>
        api.registerProvider(PI_PROVIDER_ID, {
          name: 'LiteLLM',
          // eslint-disable-next-line no-restricted-globals -- Validated above.
          baseUrl: `${process.env.LITELLM_BASE_URL?.replace(/\/+$/u, '')}/v1`,
          apiKey: '$LITELLM_API_KEY',
          api: 'openai-completions',
          authHeader: true,
          models: [buildModelDeclaration(options)],
        }),
    ],
  });
  await resourceLoader.reload();

  let structuredCapture: unknown;
  const customTools = structured
    ? [
        pi.defineTool({
          name: 'submit_judgment',
          label: 'Submit Judgment',
          description: 'Submit the final structured judgment and stop.',
          parameters: structured.schema,
          constrainedSampling: { type: 'json_schema', strict: 'require' },
          execute: createStructuredToolExecutor((params): void => {
            structuredCapture = params;
          }),
        }),
      ]
    : undefined;
  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
    ...(structured
      ? { noTools: 'builtin', tools: ['submit_judgment'], customTools }
      : { tools: [...options.tools] }),
  });
  try {
    const resolved = pi.resolveCliModel({
      cliProvider: PI_PROVIDER_ID,
      cliModel: options.model,
      modelRuntime,
    });
    if (resolved.model === undefined) {
      throw new Error(
        `Pi could not resolve model ${PI_PROVIDER_ID}/${options.model}: ${resolved.error ?? 'unknown error'}`,
      );
    }
    await session.setModel(resolved.model);
  } catch (cause) {
    try {
      session.dispose();
    } catch {
      // Setup cleanup must not mask the model-resolution or setModel failure.
    }
    throw normalizeError(cause);
  }

  let abortPromise: Promise<void> | undefined;
  /**
   * Aborts the session at most once.
   *
   * @returns The shared abort settlement promise.
   */
  const abortOnce = async (): Promise<void> => {
    abortPromise ??= session.abort();
    return await abortPromise;
  };
  const channel = createEventChannel(() => {
    settleIgnored(abortOnce());
  });
  let unsubscribe: (() => void) | undefined;
  let promptPromise: Promise<void> | undefined;
  let settled = false;
  let promptSettled = false;
  let completed = false;
  let runError: unknown;
  // Pi emits `agent_settled` from a `finally` block, so it arrives even when
  // the underlying prompt rejects. Buffer the terminal event and release it
  // only after `prompt()` fulfills so a prompt rejection always wins.
  let pendingSettled:
    | Extract<
        PiEventDto,
        {
          /** Terminal DTO discriminant. */
          kind: 'agent_settled';
        }
      >
    | undefined;
  try {
    unsubscribe = session.subscribe((event) => {
      const dto = toPiEventDto(event, session);
      if (dto === undefined) {
        return;
      }
      if (dto.kind === 'agent_settled') {
        if (!settled) {
          settled = true;
          pendingSettled =
            structuredCapture === undefined
              ? dto
              : { ...dto, structuredResult: structuredCapture };
        }
        return;
      }
      if (!settled) {
        channel.push(dto);
      }
    });
    channel.push({
      kind: 'init',
      sessionId: session.sessionId,
      model: `${session.model?.provider ?? PI_PROVIDER_ID}/${session.model?.id ?? options.model}`,
      tools: session.getActiveToolNames(),
    });
    promptPromise = Promise.resolve().then(async () => session.prompt(prompt));
    promptPromise
      .then(
        () => {
          promptSettled = true;
          if (pendingSettled === undefined) {
            channel.fail(
              new Error('Pi prompt resolved without emitting `agent_settled`.'),
            );
            return undefined;
          }
          channel.push(pendingSettled);
          channel.close();
          return undefined;
        },
        (cause: unknown) => {
          promptSettled = true;
          channel.fail(normalizeError(cause));
          return undefined;
        },
      )
      .catch((cause: unknown) => channel.fail(normalizeError(cause)));
    for await (const event of channel.iterable) {
      yield event;
    }
    await promptPromise;
    completed = true;
  } catch (cause) {
    runError = cause;
    throw normalizeError(cause);
  } finally {
    if (
      abortPromise !== undefined ||
      (!settled && (!promptSettled || session.isStreaming))
    ) {
      try {
        await abortOnce();
      } catch {
        // Abort cleanup must not mask a provider failure or consumer return.
      }
    }
    unsubscribe?.();
    if (promptPromise !== undefined) {
      try {
        await promptPromise;
      } catch {
        // The prompt rejection was already surfaced through the event channel.
      }
    }
    try {
      session.dispose();
    } catch (cause) {
      if (completed && runError === undefined) {
        // eslint-disable-next-line no-unsafe-finally -- No primary failure exists after natural completion.
        throw normalizeError(cause);
      }
    }
  }
}

/**
 * Builds the single safe provider model declaration.
 *
 * @param options - Validated Pi options.
 * @returns Provider model declaration.
 */
function buildModelDeclaration(
  options: ValidatedPiOptions,
): Record<string, unknown> {
  return {
    id: options.model,
    name: options.model,
    reasoning: options.reasoning ?? false,
    input: [...(options.input ?? ['text'])],
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

/** Builds the direct provider declaration for boundary tests. */
export const createDirectModelDeclaration = buildModelDeclaration;

/**
 * Converts SDK events to JSON-safe package DTOs.
 *
 * @param event - Raw Pi event.
 * @param session - Active Pi session.
 * @returns A normalized DTO, or undefined for ignored events.
 */
function toPiEventDto(
  event: unknown,
  session: PiSession,
): PiEventDto | undefined {
  if (!isRecord(event) || typeof event.type !== 'string') {
    return undefined;
  }
  if (event.type === 'agent_settled') {
    return { kind: 'agent_settled' };
  }
  if (event.type === 'message_end' && isRecord(event.message)) {
    const { message } = event;
    if (message.role !== 'assistant') {
      return undefined;
    }
    const content = Array.isArray(message.content)
      ? message.content.flatMap(normalizeContent)
      : [];
    const usage = isRecord(message.usage)
      ? normalizeUsage(message.usage)
      : undefined;
    return {
      kind: 'assistant_message_end',
      model:
        typeof message.model === 'string'
          ? message.model
          : `${session.model?.provider ?? ''}/${session.model?.id ?? ''}`,
      content,
      ...(usage === undefined ? {} : { usage }),
      ...(typeof message.stopReason === 'string'
        ? { stopReason: message.stopReason }
        : {}),
      ...(typeof message.errorMessage === 'string'
        ? { errorMessage: message.errorMessage }
        : {}),
    };
  }
  if (event.type === 'tool_execution_start') {
    return toolEvent(event, 'tool_execution_start');
  }
  if (event.type === 'tool_execution_update') {
    return toolEvent(event, 'tool_execution_update');
  }
  if (event.type === 'tool_execution_end') {
    return toolEvent(event, 'tool_execution_end');
  }
  if (
    event.type === 'auto_retry_start' ||
    event.type === 'auto_retry_end' ||
    event.type.startsWith('summarization_retry_') ||
    event.type.startsWith('compaction_')
  ) {
    const details = jsonSafeRecord(event);
    let error: string | undefined;
    if (typeof event.finalError === 'string') {
      error = event.finalError;
    } else if (
      typeof event.errorMessage === 'string' &&
      event.type.endsWith('_end')
    ) {
      error = event.errorMessage;
    }
    return {
      kind: 'system',
      subtype: event.type,
      details,
      ...(error === undefined ? {} : { error }),
    };
  }
  return undefined;
}

/** Normalizes one direct provider event for boundary tests. */
export const normalizeDirectEvent = toPiEventDto;

/**
 * Normalizes one assistant content block.
 *
 * @param value - Raw assistant content.
 * @returns Zero or one normalized content DTOs.
 */
function normalizeContent(
  value: unknown,
): (
  | import('./pi-types.js').PiTextContentDto
  | import('./pi-types.js').PiToolCallContentDto
)[] {
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

/** Normalizes direct provider content for boundary tests. */
export const normalizeDirectContent = normalizeContent;

/**
 * Normalizes usage without retaining provider objects.
 *
 * @param usage - Raw provider usage.
 * @returns JSON-safe usage DTO.
 */
function normalizeUsage(
  usage: Record<string, unknown>,
): import('./pi-types.js').PiUsageDto {
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

/** Normalizes direct provider usage for boundary tests. */
export const normalizeDirectUsage = normalizeUsage;

/**
 * Converts a tool lifecycle event into its DTO.
 *
 * @param event - Raw tool event.
 * @param kind - Normalized event kind.
 * @returns JSON-safe tool DTO.
 */
function toolEvent(
  event: Record<string, unknown>,
  kind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end',
): PiEventDto {
  const base = {
    toolName: typeof event.toolName === 'string' ? event.toolName : '',
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
  };
  if (kind === 'tool_execution_start') {
    return { kind, ...base };
  }
  const content = stringifyJsonSafe(
    event.result ?? event.partialResult ?? event.content,
  );
  if (kind === 'tool_execution_update') {
    return { kind, ...base, ...(content === '' ? {} : { content }) };
  }
  return {
    kind,
    ...base,
    content,
    isError: event.isError === true,
  };
}

/** Normalizes direct provider tool events for boundary tests. */
export const normalizeDirectToolEvent = toolEvent;

/** Bounded callback-to-async-generator channel. */
export type EventChannel = {
  /** Consumer iterable. */
  iterable: AsyncIterable<PiEventDto>;
  /** Adds one event. */
  push: (event: PiEventDto) => void;
  /** Closes successfully. */
  close: () => void;
  /** Closes with an error. */
  fail: (error: unknown) => void;
};

/**
 * Creates a bounded callback-to-async-generator channel.
 *
 * @param onOverflow - Callback that promptly aborts the producer.
 * @returns The channel surface.
 */
export function createEventChannel(onOverflow: () => void): EventChannel {
  const queue: PiEventDto[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: Error | undefined;
  /**
   *
   */
  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  /**
   *
   * @param cause - Channel failure.
   */
  const fail = (cause: unknown): void => {
    if (closed) {
      return;
    }
    failure = cause instanceof Error ? cause : new Error(String(cause));
    closed = true;
    notify();
  };
  return {
    /**
     *
     * @param event
     */
    /**
     * Pushes one callback event.
     *
     * @param event - Pi event DTO to enqueue.
     */
    push(event): void {
      if (closed) {
        return;
      }
      if (queue.length >= MAX_DIRECT_EVENT_QUEUE) {
        fail(
          new Error(
            `Pi event queue exceeded ${MAX_DIRECT_EVENT_QUEUE} events.`,
          ),
        );
        onOverflow();
        return;
      }
      queue.push(event);
      notify();
    },
    /**
     *
     */
    /** Closes the event stream successfully. */
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      notify();
    },
    fail,
    iterable: {
      /**
       *
       */
      /**
       * Iterates callback events in arrival order.
       *
       * @yields Queued Pi event DTOs.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<PiEventDto> {
        while (true) {
          while (queue.length > 0) {
            const event = queue.shift();
            if (event !== undefined) {
              yield event;
            }
          }
          if (failure !== undefined) {
            throw failure;
          }
          if (closed) {
            return;
          }
          // eslint-disable-next-line no-loop-func -- Resolver intentionally targets the mutable one-shot wake slot.
          await waitForEvent((resolve): void => {
            wake = resolve;
          });
        }
      },
    },
  };
}

/**
 * Waits for a channel producer notification.
 *
 * @param register - Registers the one-shot resolver.
 */
async function waitForEvent(
  register: (resolve: () => void) => void,
): Promise<void> {
  await new Promise<void>(register);
}

/**
 * Converts an arbitrary provider rejection into an Error.
 *
 * @param cause - Value rejected or thrown by Pi.
 * @returns The original Error or a normalized wrapper.
 */
function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Settles a cleanup promise without creating an unhandled rejection.
 *
 * @param promise - Cleanup promise to observe.
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
 * Tests whether a value is a non-array record.
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
 * Performs minimal discriminant validation for bridge DTOs.
 *
 * @param value - Bridge payload.
 * @returns Whether the payload has a DTO kind.
 */
function isPiEventDto(value: unknown): value is PiEventDto {
  return isRecord(value) && typeof value.kind === 'string';
}

/**
 * Validates required LiteLLM environment without exposing values.
 *
 * @param env - Environment source.
 */
function assertLiteLlmEnv(env: Record<string, string | undefined>): void {
  if (!env.LITELLM_BASE_URL) {
    throw new Error('Pi requires LITELLM_BASE_URL in the environment.');
  }
  if (!env.LITELLM_API_KEY) {
    throw new Error('Pi requires LITELLM_API_KEY in the environment.');
  }
}

/**
 * Creates a JSON-safe event details record.
 *
 * @param value - Event record.
 * @returns A JSON-safe clone.
 */
function jsonSafeRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Stringifies tool output safely.
 *
 * @param value - Tool output.
 * @returns Stable textual content.
 */
function stringifyJsonSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
