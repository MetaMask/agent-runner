/* eslint-disable n/no-process-env, require-atomic-updates, @typescript-eslint/explicit-function-return-type, consistent-return, @typescript-eslint/prefer-promise-reject-errors, vitest/no-restricted-matchers, @typescript-eslint/no-unnecessary-type-assertion */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '../types.js';
import {
  createEventChannel,
  createDirectModelDeclaration,
  createPiAdapter,
  normalizeDirectContent,
  normalizeDirectEvent,
  normalizeDirectToolEvent,
  normalizeDirectUsage,
  settleIgnored,
  validatePiOptions,
} from './pi-adapter.js';

const calls = vi.hoisted(() => [] as string[]);
const piMocks = vi.hoisted(() => ({
  listeners: [] as ((event: unknown) => void)[],
  promptError: undefined as Error | string | undefined,
  promptMode: 'auto',
  promptResolve: undefined as (() => void) | undefined,
  resolvedModel: {} as object | undefined,
  sessionDisposeError: undefined as Error | undefined,
  setModelError: undefined as unknown,
  reloadError: undefined as unknown,
  createSessionError: undefined as unknown,
  abortError: undefined as unknown,
  emittedEvents: undefined as unknown[] | undefined,
  activeTools: ['read'] as string[],
  capturedCreate: undefined as Record<string, unknown> | undefined,
  capturedLoader: undefined as Record<string, unknown> | undefined,
  capturedRuntime: undefined as Record<string, unknown> | undefined,
  capturedSettings: undefined as Record<string, unknown> | undefined,
}));

const sandboxMocks = vi.hoisted(() => ({
  createDockerSandbox: vi.fn(),
  createDefaultDockerCommandRunner: vi.fn(),
  runDockerBridge: vi.fn(),
  normalizeDockerSandboxConfig: vi.fn(),
  prepareDockerSandboxRequest: vi.fn(),
}));

vi.mock('../sandbox/docker/bridge.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../sandbox/docker/bridge.js')>();
  return { ...original, runDockerBridge: sandboxMocks.runDockerBridge };
});
vi.mock('../sandbox/docker/command-runner.js', () => ({
  createDefaultDockerCommandRunner:
    sandboxMocks.createDefaultDockerCommandRunner,
}));
vi.mock('../sandbox/docker/lifecycle.js', () => ({
  createDockerSandbox: sandboxMocks.createDockerSandbox,
}));
vi.mock('../sandbox/docker/options.js', () => ({
  normalizeDockerSandboxConfig: sandboxMocks.normalizeDockerSandboxConfig,
  prepareDockerSandboxRequest: sandboxMocks.prepareDockerSandboxRequest,
}));

vi.mock('@earendil-works/pi-coding-agent', () => {
  const session = {
    sessionId: 'pi-session',
    model: { provider: 'litellm', id: 'model' },
    get isStreaming(): boolean {
      return piMocks.promptMode === 'deferred';
    },
    getActiveToolNames: () => piMocks.activeTools,
    async setModel(): Promise<void> {
      calls.push('setModel');
      if (piMocks.setModelError !== undefined) {
        return await Promise.reject(piMocks.setModelError);
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      calls.push('subscribe');
      piMocks.listeners.push(listener);
      return () => calls.push('unsubscribe');
    },
    async prompt(): Promise<void> {
      calls.push('prompt');
      if (piMocks.promptMode === 'settled-then-error') {
        for (const listener of piMocks.listeners) {
          listener({ type: 'agent_settled' });
        }
        return await Promise.reject(
          piMocks.promptError ?? new Error('provider failed'),
        );
      }
      if (piMocks.promptError !== undefined) {
        return await Promise.reject(piMocks.promptError);
      }
      if (piMocks.promptMode === 'deferred') {
        return await new Promise<void>((resolve) => {
          piMocks.promptResolve = resolve;
        });
      }
      if (piMocks.promptMode === 'no-settled') {
        return;
      }
      const events = piMocks.emittedEvents ?? [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'model',
            content: [{ type: 'text', text: 'answer' }],
            usage: { input: 1, output: 2, cost: { total: 0 } },
            stopReason: 'stop',
          },
        },
        { type: 'agent_settled' },
      ];
      for (const listener of piMocks.listeners) {
        for (const event of events) {
          listener(event);
        }
      }
    },
    async abort(): Promise<void> {
      calls.push('abort');
      piMocks.promptResolve?.();
      if (piMocks.abortError !== undefined) {
        return await Promise.reject(piMocks.abortError);
      }
    },
    dispose(): void {
      calls.push('dispose');
      if (piMocks.sessionDisposeError !== undefined) {
        throw piMocks.sessionDisposeError;
      }
    },
  };
  return {
    ModelRuntime: {
      async create(options: Record<string, unknown>): Promise<object> {
        calls.push('ModelRuntime.create');
        piMocks.capturedRuntime = options;
        return {};
      },
    },
    SettingsManager: {
      inMemory(options: Record<string, unknown>): object {
        calls.push('SettingsManager.inMemory');
        piMocks.capturedSettings = options;
        return {};
      },
    },
    SessionManager: {
      inMemory(): object {
        calls.push('SessionManager.inMemory');
        return {};
      },
    },
    DefaultResourceLoader: class {
      constructor(options: Record<string, unknown>) {
        calls.push('DefaultResourceLoader');
        piMocks.capturedLoader = options;
      }

      async reload(): Promise<void> {
        calls.push('resourceLoader.reload');
        if (piMocks.reloadError !== undefined) {
          return await Promise.reject(piMocks.reloadError);
        }
      }
    },
    async createAgentSession(options: Record<string, unknown>) {
      calls.push('createAgentSession');
      piMocks.capturedCreate = options;
      if (piMocks.createSessionError !== undefined) {
        return await Promise.reject(piMocks.createSessionError);
      }
      return { session };
    },
    resolveCliModel() {
      calls.push('resolveCliModel');
      return piMocks.resolvedModel === undefined
        ? { error: 'missing model' }
        : { model: piMocks.resolvedModel };
    },
    defineTool(definition: Record<string, unknown>) {
      calls.push('defineTool');
      return definition;
    },
  };
});

describe('createPiAdapter', () => {
  beforeEach(() => {
    calls.length = 0;
    piMocks.listeners.length = 0;
    piMocks.promptError = undefined;
    piMocks.promptMode = 'auto';
    piMocks.promptResolve = undefined;
    piMocks.resolvedModel = {};
    piMocks.sessionDisposeError = undefined;
    piMocks.setModelError = undefined;
    piMocks.reloadError = undefined;
    piMocks.createSessionError = undefined;
    piMocks.abortError = undefined;
    piMocks.emittedEvents = undefined;
    piMocks.activeTools = ['read'];
    piMocks.capturedCreate = undefined;
    piMocks.capturedLoader = undefined;
    piMocks.capturedRuntime = undefined;
    piMocks.capturedSettings = undefined;
    vi.clearAllMocks();
    const normalized = {
      image: 'image',
      workspace: false,
      mounts: [],
      env: {
        LITELLM_BASE_URL: 'https://sandbox.example',
        LITELLM_API_KEY: 'sandbox-key',
      },
      forwardEnv: [],
      unsafeDockerArgs: [],
      setupCommands: [],
      cleanup: 'always',
      bridge: { install: true, nodeCommand: 'node', npmCommand: 'npm' },
    };
    sandboxMocks.normalizeDockerSandboxConfig.mockReturnValue(normalized);
    sandboxMocks.prepareDockerSandboxRequest.mockReturnValue({
      prompt: 'sandbox prompt',
      options: { model: 'm', cwd: '/workspace', tools: [] },
    });
    sandboxMocks.createDefaultDockerCommandRunner.mockReturnValue({
      run: vi.fn(),
    });
    sandboxMocks.createDockerSandbox.mockResolvedValue({
      containerName: 'pi-container',
      close: vi.fn(async (): Promise<void> => undefined),
      unregisterCleanup: vi.fn(),
    });
    sandboxMocks.runDockerBridge.mockReturnValue(yieldValues([]));
    process.env.LITELLM_BASE_URL = 'https://litellm.example';
    process.env.LITELLM_API_KEY = 'secret';
  });

  afterEach(() => {
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
  });

  it('is synchronous and defers loading and execution until iteration', async () => {
    const adapter = createPiAdapter();
    expect(adapter.name).toBe('pi');
    expect(calls).toStrictEqual([]);
    const iterable = adapter.run({
      prompt: 'hello',
      options: { model: 'model', cwd: '/tmp/pi' },
    });
    expect(calls).toStrictEqual([]);
    const messages = [];
    for await (const message of iterable) {
      messages.push(message);
    }
    expect(messages.map((message) => message.type)).toStrictEqual([
      'init',
      'generation',
      'result',
    ]);
    expect(messages.at(-1)).toMatchObject({ success: true, costUsd: 0 });
  });

  it('encodes the locked isolated lifecycle and exact tool allowlist', async () => {
    const adapter = createPiAdapter();
    for await (const message of adapter.run({
      prompt: 'hello',
      options: { model: 'model', cwd: '/tmp/pi', tools: [] },
    })) {
      expect(message).toBeDefined();
    }
    expect(calls).toStrictEqual([
      'ModelRuntime.create',
      'SettingsManager.inMemory',
      'SessionManager.inMemory',
      'DefaultResourceLoader',
      'resourceLoader.reload',
      'createAgentSession',
      'resolveCliModel',
      'setModel',
      'subscribe',
      'prompt',
      'unsubscribe',
      'dispose',
    ]);
    expect(piMocks.capturedCreate).toMatchObject({
      cwd: '/tmp/pi',
      tools: [],
    });
    expect(piMocks.capturedCreate).not.toHaveProperty('model');
    expect(piMocks.capturedRuntime).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
      credentials: expect.any(Object),
    });
    expect(piMocks.capturedSettings).toMatchObject({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    expect(piMocks.capturedLoader).toMatchObject({
      cwd: '/tmp/pi',
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
    });
  });

  it.each([
    'allowedTools',
    'disallowedTools',
    'canUseTool',
    'permissionMode',
    'dangerouslySkipPermissions',
  ])('rejects Claude policy key %s', async (key) => {
    const adapter = createPiAdapter();
    const options: Record<string, unknown> = { model: 'model', [key]: true };
    await expect(async () => {
      for await (const message of adapter.run({
        prompt: 'hello',
        options,
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/does not support Claude tool policy/u);
  });

  it('rejects unknown tools, selectors, missing model, and missing direct credentials', async () => {
    const adapter = createPiAdapter();
    const collect = async (options: Record<string, unknown>): Promise<void> => {
      for await (const message of adapter.run({ prompt: 'x', options })) {
        expect(message).toBeDefined();
      }
    };
    await expect(collect({ model: 'm', tools: ['Read'] })).rejects.toThrow(
      /Unsupported Pi tool/u,
    );
    await expect(
      collect({ model: 'm', tools: ['bash(rm:*)'] }),
    ).rejects.toThrow(/Unsupported Pi tool/u);
    await expect(collect({})).rejects.toThrow(/options.model/u);
    delete process.env.LITELLM_BASE_URL;
    await expect(collect({ model: 'm' })).rejects.toThrow(/LITELLM_BASE_URL/u);
    process.env.LITELLM_BASE_URL = 'https://litellm.example';
    delete process.env.LITELLM_API_KEY;
    await expect(collect({ model: 'm' })).rejects.toThrow(/LITELLM_API_KEY/u);
  });

  it.each([
    ['excludeTools', ['bash']],
    ['allowDangerouslySkipPermissions', true],
    ['modle', 'm'],
  ])('rejects unsupported option %s before starting Pi', async (key, value) => {
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm', [key]: value },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/Unknown Pi option|does not support Claude/u);
    expect(calls).not.toContain('ModelRuntime.create');
  });

  it.each([
    ['contextWindow', 0],
    ['maxTokens', 1.5],
    ['reasoning', 'yes'],
    ['input', []],
    ['input', ['text', 'text']],
    ['cost', { input: -1 }],
    ['cost', { typo: 1 }],
  ])('rejects invalid runtime metadata %s', async (key, value) => {
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm', [key]: value },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/Pi/u);
  });

  it('accepts a complete exact Pi option record', () => {
    expect(
      validatePiOptions(
        {
          model: 'm',
          cwd: '/tmp',
          systemPrompt: 'system',
          tools: ['read'],
          contextWindow: 100,
          maxTokens: 10,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
        false,
      ),
    ).toMatchObject({ model: 'm', cwd: '/tmp', tools: ['read'] });
  });

  it('rejects non-plain options, system prompts, non-finite values, and costs', () => {
    expect(() => validatePiOptions([] as never, false)).toThrow(
      /plain object/u,
    );
    expect(() =>
      validatePiOptions({ model: 'm', systemPrompt: 1 } as never, false),
    ).toThrow(/systemPrompt/u);
    expect(() =>
      validatePiOptions({ model: 'm', contextWindow: Infinity }, false),
    ).toThrow(/positive integer/u);
    expect(() =>
      validatePiOptions({ model: 'm', cost: [] } as never, false),
    ).toThrow(/cost.*plain object/u);
  });

  it('converts non-Error prompt failures and disposes', async () => {
    piMocks.promptError = 'provider failed';
    const adapter = createPiAdapter();
    await expect(async () => {
      for await (const message of adapter.run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow('provider failed');
    expect(calls).toContain('unsubscribe');
    expect(calls).toContain('dispose');
  });

  it('yields init before a deferred prompt resolves', async () => {
    piMocks.promptMode = 'deferred';
    const iterator = createPiAdapter()
      .run({ prompt: 'x', options: { model: 'm' } })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'init' },
    });
    expect(piMocks.promptResolve).toBeTypeOf('function');
    await iterator.return?.();
    expect(calls.filter((call) => call === 'abort')).toHaveLength(1);
    expect(calls).toContain('unsubscribe');
    expect(calls).toContain('dispose');
  });

  it('errors when prompt resolves without agent_settled', async () => {
    piMocks.promptMode = 'no-settled';
    const iterator = createPiAdapter()
      .run({ prompt: 'x', options: { model: 'm' } })
      [Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow(
      /without emitting `agent_settled`/u,
    );
    expect(calls).toContain('unsubscribe');
    expect(calls).toContain('dispose');
  });

  it('disposes an unresolved model session', async () => {
    piMocks.resolvedModel = undefined;
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'missing' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/could not resolve model/u);
    expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
  });

  it('keeps the resolution failure when disposal also fails', async () => {
    piMocks.resolvedModel = undefined;
    piMocks.sessionDisposeError = new Error('dispose failed');
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'missing' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/could not resolve model/u);
    expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
  });

  it('keeps the setModel failure when disposal also fails', async () => {
    piMocks.setModelError = new Error('set model failed');
    piMocks.sessionDisposeError = new Error('dispose failed');
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow('set model failed');
    expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
  });

  it('surfaces dispose failure after natural completion', async () => {
    piMocks.sessionDisposeError = new Error('dispose failed');
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow('dispose failed');
  });

  it('does not mask provider failure with dispose failure', async () => {
    piMocks.promptError = new Error('provider failed');
    piMocks.sessionDisposeError = new Error('dispose failed');
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow('provider failed');
  });

  it('uses default direct tools and registers the complete provider declaration', async () => {
    for await (const message of createPiAdapter().run({
      prompt: 'x',
      options: {
        model: 'model-x',
        cwd: '/tmp/pi',
        contextWindow: 42_000,
        maxTokens: 1234,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        systemPrompt: 'system',
      },
    })) {
      expect(message).toBeDefined();
    }
    expect(piMocks.capturedCreate?.tools).toStrictEqual([
      'read',
      'bash',
      'edit',
      'write',
    ]);
    expect(piMocks.capturedLoader?.systemPrompt).toBe('system');
    const factories = piMocks.capturedLoader?.extensionFactories;
    const registerProvider = vi.fn();
    const registerFactory = requireFirstFunction(factories);
    registerFactory({ registerProvider });
    expect(registerProvider).toHaveBeenCalledWith(
      'litellm',
      expect.objectContaining({
        baseUrl: 'https://litellm.example/v1',
        apiKey: '$LITELLM_API_KEY',
        api: 'openai-completions',
        authHeader: true,
        models: [
          {
            id: 'model-x',
            name: 'model-x',
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            contextWindow: 42_000,
            maxTokens: 1234,
          },
        ],
      }),
    );
  });

  it.each([
    ['resource reload', 'reloadError'],
    ['session creation', 'createSessionError'],
  ])('propagates %s failure', async (_label, key) => {
    piMocks[key as 'reloadError' | 'createSessionError'] = 'setup failed';
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toBe('setup failed');
  });

  it('normalizes setModel failures and disposes', async () => {
    piMocks.setModelError = 'set model failed';
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow('set model failed');
    expect(calls).toContain('dispose');
  });

  it('normalizes direct system, tool, fallback model, malformed, and ignored events', async () => {
    piMocks.emittedEvents = [
      { type: 'message_end', message: { role: 'user' } },
      { type: 'message_end', message: null },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'text' },
            { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
            { type: 'unknown' },
          ],
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          errorMessage: 'detail',
        },
      },
      { type: 'tool_execution_start', toolName: 'read', toolCallId: 't1' },
      {
        type: 'tool_execution_update',
        toolName: 'read',
        toolCallId: 't1',
        partialResult: { progress: 1 },
      },
      {
        type: 'tool_execution_end',
        toolName: 'read',
        toolCallId: 't1',
        result: { ok: true },
        isError: true,
      },
      { type: 'auto_retry_end', finalError: 'retry exhausted' },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'unhandled' },
      1,
      { type: 'agent_settled' },
    ];
    const messages = [];
    for await (const message of createPiAdapter().run({
      prompt: 'x',
      options: { model: 'm' },
    })) {
      messages.push(message);
    }
    expect(messages.map((message) => message.type)).toStrictEqual([
      'init',
      'generation',
      'system',
      'tool_progress',
      'tool_result',
      'system',
      'system',
      'result',
    ]);
    expect(messages[1]).toMatchObject({
      model: 'litellm/model',
      toolCalls: [{ id: 't1', name: 'read', input: { path: 'a' } }],
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
    });
    expect(messages.at(-1)).toMatchObject({
      success: false,
      error: 'retry exhausted',
    });
  });

  it('marks an aborted direct generation as an unsuccessful result', async () => {
    piMocks.emittedEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'model',
          content: [{ type: 'text', text: 'partial' }],
          stopReason: 'aborted',
          errorMessage: 'cancelled',
        },
      },
      { type: 'agent_settled' },
    ];
    const messages: AgentMessage[] = [];
    for await (const message of createPiAdapter().run({
      prompt: 'x',
      options: { model: 'm' },
    })) {
      messages.push(message);
    }
    expect(messages.map((message) => message.type)).toStrictEqual([
      'init',
      'generation',
      'result',
    ]);
    expect(messages[1]).toMatchObject({ stopReason: 'aborted' });
    expect(messages.at(-1)).toMatchObject({
      success: false,
      result: 'partial',
      error: 'cancelled',
    });
  });

  it('waits for asynchronously delivered events', async () => {
    piMocks.promptMode = 'deferred';
    const iterator = createPiAdapter()
      .run({ prompt: 'x', options: { model: 'm' } })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'init' },
    });
    const pending = iterator.next();
    await Promise.resolve();
    for (const listener of piMocks.listeners) {
      listener({ type: 'agent_settled' });
    }
    piMocks.promptResolve?.();
    await expect(pending).resolves.toMatchObject({
      value: { type: 'result', success: true },
    });
    await iterator.return?.();
  });

  it('lets a prompt rejection win over a queued agent_settled', async () => {
    piMocks.promptMode = 'settled-then-error';
    piMocks.promptError = new Error('provider failed');
    const messages: AgentMessage[] = [];
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        messages.push(message);
      }
    }).rejects.toThrow('provider failed');
    expect(messages.map((message) => message.type)).toStrictEqual(['init']);
    expect(messages.some((message) => message.type === 'result')).toBe(false);
    expect(calls).toContain('unsubscribe');
    expect(calls).toContain('dispose');
  });

  it('withholds the terminal result until a deferred prompt fulfills', async () => {
    piMocks.promptMode = 'deferred';
    const iterator = createPiAdapter()
      .run({ prompt: 'x', options: { model: 'm' } })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'init' },
    });
    const pending = iterator.next();
    await Promise.resolve();
    for (const listener of piMocks.listeners) {
      listener({ type: 'agent_settled' });
    }
    const race = await Promise.race([
      pending.then(() => 'resolved'),
      Promise.resolve('pending'),
    ]);
    expect(race).toBe('pending');
    piMocks.promptResolve?.();
    await expect(pending).resolves.toMatchObject({
      value: { type: 'result', success: true },
    });
    await iterator.return?.();
  });

  it('keeps the first channel failure when close and fail race', async () => {
    const overflow = vi.fn();
    const channel = createEventChannel(overflow);
    const settlement = channel.iterable[Symbol.asyncIterator]().next();
    channel.fail(new Error('first'));
    channel.close();
    channel.fail(new Error('second'));
    await expect(settlement).rejects.toThrow('first');
  });

  it('ignores a fail after a clean close', async () => {
    const overflow = vi.fn();
    const channel = createEventChannel(overflow);
    channel.close();
    channel.fail(new Error('late failure'));
    await expect(
      channel.iterable[Symbol.asyncIterator]().next(),
    ).resolves.toStrictEqual({ value: undefined, done: true });
  });

  it('aborts when the bounded direct event queue overflows', async () => {
    piMocks.emittedEvents = [
      ...Array.from({ length: 10_001 }, () => ({ type: 'compaction_start' })),
      { type: 'agent_settled' },
    ];
    await expect(async () => {
      for await (const message of createPiAdapter().run({
        prompt: 'x',
        options: { model: 'm' },
      })) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/queue exceeded 10000/u);
    expect(calls).toContain('abort');
  });

  it('preserves channel failure and ignores pushes after closure', async () => {
    const overflow = vi.fn();
    const failed = createEventChannel(overflow);
    const failure = failed.iterable[Symbol.asyncIterator]().next();
    failed.fail('channel failed');
    failed.push({ kind: 'agent_settled' });
    await expect(failure).rejects.toThrow('channel failed');
    expect(overflow).not.toHaveBeenCalled();

    const closed = createEventChannel(overflow);
    closed.close();
    closed.push({ kind: 'agent_settled' });
    await expect(
      closed.iterable[Symbol.asyncIterator]().next(),
    ).resolves.toStrictEqual({ value: undefined, done: true });
  });

  it('observes fulfilled and rejected cleanup promises', async () => {
    const caught = vi.fn();
    const chained = { catch: caught };
    const then = vi.fn(
      (
        fulfilled: (value: unknown) => unknown,
        rejected: (cause: unknown) => unknown,
      ) => {
        expect(fulfilled('done')).toBeUndefined();
        expect(rejected(new Error('cleanup failed'))).toBeUndefined();
        return chained;
      },
    );
    settleIgnored({ then } as unknown as Promise<unknown>);
    expect(then).toHaveBeenCalledOnce();
    expect(caught).toHaveBeenCalledOnce();
  });

  it('covers direct provider defaults and optional normalization branches', () => {
    expect(
      createDirectModelDeclaration({
        model: 'm',
        cwd: '/tmp',
        tools: [],
      }),
    ).toMatchObject({
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    });
    expect(normalizeDirectContent(null)).toStrictEqual([]);
    expect(normalizeDirectContent({ type: 'unknown' })).toStrictEqual([]);
    expect(
      normalizeDirectContent({
        type: 'toolCall',
        id: 'id',
        name: 'read',
        arguments: { path: 'a' },
      }),
    ).toStrictEqual([
      {
        type: 'toolCall',
        id: 'id',
        name: 'read',
        arguments: { path: 'a' },
      },
    ]);
    expect(normalizeDirectUsage({})).toStrictEqual({});
    expect(
      normalizeDirectUsage({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: 5 },
      }),
    ).toStrictEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: { total: 5 },
    });
  });

  it('covers direct tool event fallbacks and optional content', () => {
    expect(
      normalizeDirectToolEvent(
        { type: 'tool_execution_start' },
        'tool_execution_start',
      ),
    ).toStrictEqual({
      kind: 'tool_execution_start',
      toolName: '',
      toolCallId: '',
    });
    expect(
      normalizeDirectToolEvent(
        { type: 'tool_execution_update', content: '' },
        'tool_execution_update',
      ),
    ).toStrictEqual({
      kind: 'tool_execution_update',
      toolName: '',
      toolCallId: '',
    });
    expect(
      normalizeDirectToolEvent(
        { type: 'tool_execution_end', result: 'done', isError: true },
        'tool_execution_end',
      ),
    ).toMatchObject({ content: 'done', isError: true });
  });

  it('covers direct retry error and assistant optional-field branches', () => {
    const session = {
      model: undefined,
    } as never;
    expect(
      normalizeDirectEvent(
        { type: 'auto_retry_end', errorMessage: 'retry failed' },
        session,
      ),
    ).toMatchObject({ error: 'retry failed' });
    expect(
      normalizeDirectEvent(
        { type: 'auto_retry_start', errorMessage: 'not terminal' },
        session,
      ),
    ).not.toHaveProperty('error');
    expect(
      normalizeDirectEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: null, usage: null },
        },
        session,
      ),
    ).toMatchObject({ model: '/' });
    expect(normalizeDirectEvent({ type: 'ignored' }, session)).toBeUndefined();
  });

  it('runs structured judgment with a strict terminating custom tool', async () => {
    piMocks.promptMode = 'deferred';
    const adapter = createPiAdapter();
    const iterable = adapter.runStructured?.({
      prompt: 'judge',
      systemPrompt: 'rubric',
      schema: { type: 'object', required: ['score'] },
      options: { model: 'judge-model', cwd: '/tmp/pi' },
    });
    expect(iterable).toBeDefined();
    const iterator = iterable?.[Symbol.asyncIterator]();
    const init = await iterator?.next();
    expect(init?.value).toMatchObject({ type: 'init' });
    expect(piMocks.capturedCreate).toMatchObject({
      noTools: 'builtin',
      tools: ['submit_judgment'],
    });
    expect(piMocks.capturedLoader?.systemPrompt).toBe('rubric');
    const customTools = piMocks.capturedCreate?.customTools;
    expect(Array.isArray(customTools)).toBe(true);
    const tool = Array.isArray(customTools)
      ? (customTools[0] as Record<string, unknown>)
      : undefined;
    expect(tool).toMatchObject({
      name: 'submit_judgment',
      parameters: { type: 'object', required: ['score'] },
      constrainedSampling: { type: 'json_schema', strict: 'require' },
    });
    const execute = tool?.execute;
    const executeTool = requireFunction(execute);
    await expect(executeTool('call', { score: 9 })).resolves.toStrictEqual({
      content: [{ type: 'text', text: '{"score":9}' }],
      details: { score: 9 },
      terminate: true,
    });
    for (const listener of piMocks.listeners) {
      listener({ type: 'agent_settled' });
    }
    piMocks.promptResolve?.();
    const terminal = await iterator?.next();
    expect(terminal?.value).toMatchObject({
      type: 'result',
      success: true,
      result: '{"score":9}',
    });
    await iterator?.return?.();
  });

  it('fails structured result when submit_judgment was not called', async () => {
    const results = [];
    for await (const message of createPiAdapter().runStructured?.({
      prompt: 'judge',
      systemPrompt: 'rubric',
      schema: { type: 'object' },
      options: { model: 'm' },
    }) ?? []) {
      results.push(message);
    }
    expect(results.at(-1)).toMatchObject({
      type: 'result',
      success: false,
      error: 'Pi did not submit a judgment.',
    });
  });

  it('rejects structured caller tool customization', async () => {
    await expect(async () => {
      for await (const message of createPiAdapter().runStructured?.({
        prompt: 'judge',
        systemPrompt: 'rubric',
        schema: {},
        options: { model: 'm', tools: [] },
      }) ?? []) {
        expect(message).toBeDefined();
      }
    }).rejects.toThrow(/do not accept caller tool customization/u);
  });

  describe('Docker sandbox', () => {
    /**
     * Builds a fake sandbox handle with lifecycle spies.
     *
     * @param cleanup - Normalized cleanup policy.
     * @returns Normalized config and fake lifecycle handle.
     */
    function sandboxHandle(cleanup = 'always'): {
      normalized: Record<string, unknown>;
      handle: {
        containerName: string;
        close: ReturnType<typeof vi.fn>;
        unregisterCleanup: ReturnType<typeof vi.fn>;
      };
    } {
      const normalized = {
        image: 'image',
        workspace: false,
        mounts: [],
        env: {
          LITELLM_BASE_URL: 'https://sandbox.example',
          LITELLM_API_KEY: 'sandbox-key',
        },
        forwardEnv: [],
        unsafeDockerArgs: [],
        setupCommands: [],
        cleanup,
        bridge: { install: true, nodeCommand: 'node', npmCommand: 'npm' },
      };
      const handle = {
        containerName: 'pi-container',
        close: vi.fn(async (): Promise<void> => undefined),
        unregisterCleanup: vi.fn(),
      };
      sandboxMocks.normalizeDockerSandboxConfig.mockReturnValue(normalized);
      sandboxMocks.createDockerSandbox.mockResolvedValue(handle);
      return { normalized, handle };
    }

    /**
     * Collects a sandbox run.
     *
     * @param cleanup - Cleanup policy to exercise.
     * @returns Sandbox state and translated messages.
     */
    async function runSandbox(cleanup = 'always'): Promise<{
      normalized: Record<string, unknown>;
      handle: {
        containerName: string;
        close: ReturnType<typeof vi.fn>;
        unregisterCleanup: ReturnType<typeof vi.fn>;
      };
      messages: AgentMessage[];
    }> {
      const state = sandboxHandle(cleanup);
      const messages = [];
      for await (const message of createPiAdapter().run({
        prompt: 'sandbox prompt',
        options: { model: 'm', cwd: '/host/work' },
        sandbox: {
          type: 'docker',
          cleanup: cleanup as 'always' | 'on-success' | 'never',
        },
      })) {
        messages.push(message);
      }
      return { ...state, messages };
    }

    it('uses Pi env defaults, prepared request, runtime descriptor, and translator', async () => {
      sandboxMocks.runDockerBridge.mockReturnValue(
        yieldValues([
          { kind: 'init', sessionId: 's', model: 'litellm/m', tools: [] },
          {
            kind: 'assistant_message_end',
            model: 'm',
            content: [{ type: 'text', text: 'sandbox answer' }],
            usage: { input: 1, output: 2, cost: { total: 0 } },
          },
          { kind: 'agent_settled' },
        ]),
      );
      const { normalized, handle, messages } = await runSandbox();
      expect(sandboxMocks.normalizeDockerSandboxConfig).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'docker' }),
        {
          hostCwd: '/host/work',
          defaultForwardEnv: [
            'LITELLM_BASE_URL',
            'LITELLM_API_KEY',
            'HTTP_PROXY',
            'HTTPS_PROXY',
            'NO_PROXY',
          ],
        },
      );
      expect(sandboxMocks.prepareDockerSandboxRequest).toHaveBeenCalledWith({
        prompt: 'sandbox prompt',
        options: expect.objectContaining({
          model: 'm',
          cwd: '/host/work',
        }),
        sandbox: normalized,
      });
      expect(
        sandboxMocks.prepareDockerSandboxRequest.mock.calls[0]?.[0].options,
      ).not.toHaveProperty('baseUrl');
      expect(sandboxMocks.runDockerBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: expect.objectContaining({
            id: 'pi',
            packageName: '@earendil-works/pi-coding-agent',
            remoteBridgeFile: 'pi-bridge.mjs',
          }),
          sandbox: handle,
          config: normalized,
          request: {
            prompt: 'sandbox prompt',
            options: { model: 'm', cwd: '/workspace', tools: [] },
          },
        }),
      );
      expect(messages.map((message) => message.type)).toStrictEqual([
        'init',
        'generation',
        'result',
      ]);
      expect(handle.close).toHaveBeenCalledOnce();
    });

    it('marks an aborted sandbox generation as an unsuccessful result', async () => {
      sandboxMocks.runDockerBridge.mockReturnValue(
        yieldValues([
          { kind: 'init', sessionId: 's', model: 'litellm/m', tools: [] },
          {
            kind: 'assistant_message_end',
            model: 'm',
            content: [{ type: 'text', text: 'partial' }],
            stopReason: 'aborted',
            errorMessage: 'cancelled',
          },
          { kind: 'agent_settled' },
        ]),
      );
      const { messages } = await runSandbox();
      expect(messages.map((message) => message.type)).toStrictEqual([
        'init',
        'generation',
        'result',
      ]);
      expect(messages[1]).toMatchObject({ stopReason: 'aborted' });
      expect(messages.at(-1)).toMatchObject({
        success: false,
        result: 'partial',
        error: 'cancelled',
      });
    });

    it('rejects invalid DTO and closes for cleanup always', async () => {
      sandboxMocks.runDockerBridge.mockReturnValue(
        yieldValues([{ nope: true }]),
      );
      const { handle } = sandboxHandle('always');
      await expect(async () => {
        for await (const message of createPiAdapter().run({
          prompt: 'x',
          options: { model: 'm', cwd: '/host/work' },
          sandbox: { type: 'docker' },
        })) {
          expect(message).toBeDefined();
        }
      }).rejects.toThrow(/invalid event DTO/u);
      expect(handle.close).toHaveBeenCalledOnce();
    });

    it.each([
      ['always', true, false],
      ['on-success', true, false],
      ['never', false, true],
    ] as const)(
      'applies %s cleanup after success',
      async (cleanup, closes, unregisters) => {
        const { handle } = await runSandbox(cleanup);
        expect(handle.close).toHaveBeenCalledTimes(closes ? 1 : 0);
        expect(handle.unregisterCleanup).toHaveBeenCalledTimes(
          unregisters ? 1 : 0,
        );
      },
    );

    it.each([
      ['always', true, false],
      ['on-success', false, true],
      ['never', false, true],
    ] as const)(
      'preserves bridge failure with %s cleanup',
      async (cleanup, closes, unregisters) => {
        sandboxMocks.runDockerBridge.mockReturnValue(
          rejectingIterable(new Error('bridge failed')),
        );
        const { handle } = sandboxHandle(cleanup);
        await expect(async () => {
          for await (const message of createPiAdapter().run({
            prompt: 'x',
            options: { model: 'm', cwd: '/host/work' },
            sandbox: { type: 'docker', cleanup },
          })) {
            expect(message).toBeDefined();
          }
        }).rejects.toThrow('bridge failed');
        expect(handle.close).toHaveBeenCalledTimes(closes ? 1 : 0);
        expect(handle.unregisterCleanup).toHaveBeenCalledTimes(
          unregisters ? 1 : 0,
        );
      },
    );

    it('surfaces close failure after successful bridge completion', async () => {
      const { handle } = sandboxHandle('always');
      handle.close.mockRejectedValueOnce('close failed');
      await expect(async () => {
        for await (const message of createPiAdapter().run({
          prompt: 'x',
          options: { model: 'm', cwd: '/host/work' },
          sandbox: { type: 'docker' },
        })) {
          expect(message).toBeDefined();
        }
      }).rejects.toThrow('close failed');
    });

    it('closes unconditionally on early iterator return', async () => {
      sandboxMocks.runDockerBridge.mockReturnValue(
        yieldValues([
          { kind: 'init', sessionId: 's', model: 'm', tools: [] },
          { kind: 'agent_settled' },
        ]),
      );
      const { handle } = sandboxHandle('never');
      const iterator = createPiAdapter()
        .run({
          prompt: 'x',
          options: { model: 'm', cwd: '/host/work' },
          sandbox: { type: 'docker', cleanup: 'never' },
        })
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'init' });
      await iterator.return?.();
      expect(handle.close).toHaveBeenCalledOnce();
    });
  });

  it('exposes only model metadata', () => {
    expect(createPiAdapter().getRunMetadata?.({ model: 'm' })).toStrictEqual({
      model: 'm',
    });
    expect(createPiAdapter().getRunMetadata?.({})).toStrictEqual({
      model: 'unknown',
    });
  });

  describe('getStructuredDefaults', () => {
    it('inherits model and metadata for a structured run', () => {
      expect(
        createPiAdapter().getStructuredDefaults?.({
          model: 'gpt-5.6-luna',
          cwd: '/repo',
          systemPrompt: 'be terse',
          contextWindow: 200_000,
          maxTokens: 4_096,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2 },
        }),
      ).toStrictEqual({
        model: 'gpt-5.6-luna',
        cwd: '/repo',
        systemPrompt: 'be terse',
        contextWindow: 200_000,
        maxTokens: 4_096,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1, output: 2 },
      });
    });

    it('drops the tools execution-policy field', () => {
      expect(
        createPiAdapter().getStructuredDefaults?.({
          model: 'gpt-5.6-luna',
          tools: ['read', 'bash', 'edit', 'write'],
        }),
      ).toStrictEqual({ model: 'gpt-5.6-luna' });
    });

    it('omits absent keys rather than emitting undefined values', () => {
      expect(
        createPiAdapter().getStructuredDefaults?.({ model: 'gpt-5.6-luna' }),
      ).toStrictEqual({ model: 'gpt-5.6-luna' });
    });

    it('returns an empty projection for empty or non-record defaults', () => {
      expect(createPiAdapter().getStructuredDefaults?.({})).toStrictEqual({});
      expect(
        createPiAdapter().getStructuredDefaults?.(
          undefined as unknown as Record<string, never>,
        ),
      ).toStrictEqual({});
    });
  });
});

/**
 * Creates an async iterable over supplied values.
 *
 * @param values - Values to emit in order.
 * @yields Supplied values.
 */
async function* yieldValues(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) {
    yield value;
  }
}

/**
 * Creates an async iterable whose first read rejects.
 *
 * @param error - Error returned by the iterator.
 * @returns Rejecting async iterable.
 */
function rejectingIterable(error: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw error;
        },
      };
    },
  };
}

/**
 * Requires a callable test value.
 *
 * @param value - Candidate callback.
 * @returns The callable value.
 */
function requireFunction(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError('Expected a function.');
  }
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
}

/**
 * Requires an array whose first element is callable.
 *
 * @param value - Candidate callback array.
 * @returns The first callback.
 */
function requireFirstFunction(value: unknown): (...args: unknown[]) => unknown {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an array.');
  }
  return requireFunction(value[0]);
}
