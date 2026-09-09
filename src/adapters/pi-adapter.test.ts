/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles infer their contracts from the runtime. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentRunner } from '../runner.js';
import { createPiAdapter } from './pi-adapter.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  unregisterCleanup: vi.fn(),
  create: vi.fn(),
  bridge: vi.fn(),
  direct: vi.fn(),
  command: vi.fn(),
}));
vi.mock('../pi-runtime.js', async (original) => ({
  ...(await original<object>()),
  runPiSession: mocks.direct,
}));
vi.mock('../sandbox/docker/command-runner.js', () => ({
  createDefaultDockerCommandRunner: () => ({ run: mocks.command }),
}));
vi.mock('../sandbox/docker/lifecycle.js', () => ({
  createDockerSandbox: mocks.create,
}));
vi.mock('../sandbox/docker/bridge.js', () => ({
  PI_BRIDGE_RUNTIME: { id: 'pi' },
  runDockerBridge: mocks.bridge,
}));

function setup(
  messages: unknown[] = [{ type: 'result', success: true }],
): import('../types.js').AgentRunner<
  import('./pi-types.js').PiQueryOptions,
  string
> {
  mocks.create.mockResolvedValue({
    containerName: 'pi-test',
    close: mocks.close,
    unregisterCleanup: mocks.unregisterCleanup,
  });
  mocks.bridge.mockImplementation(async function* () {
    yield* messages;
  });
  return createAgentRunner({
    adapter: createPiAdapter(),
    defaultOptions: { model: 'test' },
    sandbox: { type: 'docker', workspace: false, workdir: '/task' },
  });
}
describe('pi adapter', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe('pi adapter sandbox routing', () => {
    it('requires exactly one terminal result', async () => {
      expect(
        (await setup([]).runAgent({ prompt: 'hi' })).error?.message,
      ).toContain('without a result');
      expect(
        (
          await setup([
            { type: 'result', success: true },
            { type: 'result', success: true },
          ]).runAgent({ prompt: 'hi' })
        ).error?.message,
      ).toContain('after the result');
    });
    it('exposes provider metadata without Claude defaults', () => {
      const adapter = createPiAdapter();
      expect(adapter.defaultOptions).toStrictEqual({});
      expect(adapter.getRunMetadata?.({})).toStrictEqual({
        model: 'unknown',
        maxTurns: 0,
      });
      expect(
        adapter.getRunMetadata?.({ model: 'x', maxTurns: 3 }),
      ).toStrictEqual({ model: 'x', maxTurns: 3 });
    });
    it.each([
      null,
      {},
      { type: 'init' },
      { type: 'generation' },
      { type: 'tool_result' },
      { type: 'tool_progress' },
      { type: 'result' },
      { type: 'result', success: true, result: 3 },
      { type: 'result', success: true, error: 3 },
      { type: 'result', success: true, costUsd: -1 },
      {
        type: 'generation',
        model: 'x',
        text: '',
        toolCalls: [null],
        usage: {},
      },
      { type: 'generation', model: 'x', text: '', toolCalls: [{}], usage: {} },
      {
        type: 'generation',
        model: 'x',
        text: '',
        toolCalls: [{ id: 'x' }],
        usage: {},
      },
      {
        type: 'generation',
        model: 'x',
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0 },
      },
      {
        type: 'generation',
        model: 'x',
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ])('rejects malformed normalized payload %j', async (message) => {
      expect(
        (await setup([message]).runAgent({ prompt: 'hi' })).error?.message,
      ).toBe('Invalid pi bridge message.');
    });
    it('accepts each emitted message variant and maps the workspace cwd', async () => {
      const messages = [
        {
          type: 'generation',
          model: 'x',
          text: 'text',
          toolCalls: [{ id: 'id', name: 'bash', input: {} }],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'stop',
        },
        {
          type: 'tool_result',
          toolUseId: 'id',
          content: 'output',
          isError: false,
        },
        { type: 'tool_progress', toolName: 'bash', elapsedSeconds: 1 },
        {
          type: 'result',
          success: true,
          costUsd: 0,
          error: '',
          result: 'done',
        },
      ];
      const result = await setup(messages).runAgent({
        prompt: 'hi',
        sandbox: { type: 'docker', workspace: { hostPath: process.cwd() } },
      });
      expect(result.messages).toStrictEqual(messages);
      const runner = createAgentRunner({
        adapter: createPiAdapter(),
        defaultOptions: { model: 'x' },
        sandbox: { type: 'docker' },
      });
      await runner.runAgent({ prompt: 'hi' });
      expect(mocks.bridge.mock.calls.at(-1)?.[0].request.options.cwd).toBe(
        '/workspace',
      );
    });
    it('does not mask provider failures with cleanup failures', async () => {
      const runner = setup();
      mocks.close.mockRejectedValue(new Error('cleanup'));
      const completed = await runner.runAgent({ prompt: 'hi' });
      expect(completed.error?.message).toBe('cleanup');
      mocks.bridge.mockImplementation(() => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('provider');
          },
        }),
      }));
      expect((await runner.runAgent({ prompt: 'hi' })).error?.message).toBe(
        'provider',
      );
    });
    it('normalizes non-error failures and obeys successful cleanup policies', async () => {
      const runner = setup();
      mocks.create.mockRejectedValue('failure');
      expect((await runner.runAgent({ prompt: 'hi' })).error?.message).toBe(
        'failure',
      );
      await setup().runAgent({
        prompt: 'hi',
        sandbox: { type: 'docker', cleanup: 'on-success' },
      });
      expect(mocks.close).toHaveBeenCalledOnce();
      await setup().runAgent({
        prompt: 'hi',
        sandbox: { type: 'docker', cleanup: 'never' },
      });
      expect(mocks.unregisterCleanup).toHaveBeenCalledOnce();
    });
    it('forwards setup cancellation while leaving removal executable', async () => {
      const runner = setup();
      const controller = new AbortController();
      const inner = new AbortController();
      mocks.create.mockImplementation(async (_config, { commandRunner }) => {
        await commandRunner.run('docker', ['exec']);
        await commandRunner.run('docker', ['exec'], { signal: inner.signal });
        controller.abort();
        await commandRunner.run('docker', ['rm', '-f']);
        return {
          close: mocks.close,
          unregisterCleanup: mocks.unregisterCleanup,
        };
      });
      await runner.runAgent({ prompt: 'hi', signal: controller.signal });
      expect(mocks.command.mock.calls[0]?.[2].signal).toBe(controller.signal);
      expect(mocks.command.mock.calls[1]?.[2].signal.aborted).toBe(true);
      expect(mocks.command.mock.calls[2]?.[2].signal).toBeUndefined();
    });
    it('runs in Docker with pi env defaults and container cwd, never on the host', async () => {
      vi.stubEnv('LITELLM_API_KEY', 'key');
      vi.stubEnv('ANTHROPIC_API_KEY', 'other');
      const result = await setup().runAgent({ prompt: 'hi' });
      expect(result.error).toBeUndefined();
      expect(mocks.direct).not.toHaveBeenCalled();
      expect(mocks.bridge.mock.calls[0]?.[0]).toMatchObject({
        request: { prompt: 'hi', options: { model: 'test', cwd: '/task' } },
        config: { env: { LITELLM_API_KEY: 'key' } },
      });
      expect(mocks.bridge.mock.calls[0]?.[0].config.env).not.toHaveProperty(
        'ANTHROPIC_API_KEY',
      );
      expect(mocks.close).toHaveBeenCalledOnce();
    });
    it('runs the judge in Docker with inherited model and a five-turn limit', async () => {
      const runner = setup([
        {
          type: 'result',
          success: true,
          result: JSON.stringify({ score: 8, reasoning: 'good' }),
        },
      ]);
      const verdict = await runner.judge(
        {
          messages: [],
          durationMs: 0,
          isPartial: false,
          metadata: { startedAt: '', endedAt: '', messageCount: 0 },
        },
        { rubric: 'Judge.', scoreFields: [{ name: 'score', min: 0, max: 10 }] },
      );
      expect(verdict.scores.score).toBe(8);
      expect(mocks.bridge.mock.calls[0]?.[0].request.options).toMatchObject({
        model: 'test',
        maxTurns: 5,
        structured: { systemPrompt: 'Judge.' },
      });
      expect(
        mocks.bridge.mock.calls[0]?.[0].request.options,
      ).not.toHaveProperty('tools');
    });
    it.each(['never', 'on-success'] as const)(
      'removes the container on callback failure regardless of %s cleanup',
      async (cleanup) => {
        const result = await setup([{ type: 'init', sessionId: 'x' }]).runAgent(
          {
            prompt: 'hi',
            sandbox: { type: 'docker', cleanup },
            onMessage: () => {
              throw new Error('stop');
            },
          },
        );
        expect(result.isPartial).toBe(true);
        expect(mocks.close).toHaveBeenCalledOnce();
      },
    );
    it('keeps unsuccessful completed runs for on-success cleanup', async () => {
      await setup([
        { type: 'result', success: false, error: 'maxTurns' },
      ]).runAgent({
        prompt: 'hi',
        sandbox: { type: 'docker', cleanup: 'on-success' },
      });
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.unregisterCleanup).toHaveBeenCalledOnce();
    });
    it('rejects malformed messages and scrubs sandbox credentials in errors', async () => {
      const result = await setup([{ type: 'bogus' }]).runAgent({
        prompt: 'hi',
      });
      expect(result.error?.message).toContain('Invalid pi bridge');
      expect(mocks.close).toHaveBeenCalledOnce();
      const runner = setup();
      // eslint-disable-next-line require-yield -- Models a provider that throws before emitting a message.
      mocks.bridge.mockImplementation(async function* () {
        throw new Error('sandbox-key leaked');
      });
      const failed = await runner.runAgent({
        prompt: 'hi',
        sandbox: { type: 'docker', env: { LITELLM_API_KEY: 'sandbox-key' } },
      });
      expect(failed.error?.message).toBe('[REDACTED] leaked');
    });
    it('rejects unsupported options before creating a container', async () => {
      const result = await setup().runAgent({
        prompt: 'hi',
        options: { permissionMode: 'bypassPermissions' } as any,
      });
      expect(result.error?.message).toContain('Unsupported Pi option');
      expect(mocks.create).not.toHaveBeenCalled();
    });
    it('passes caller cancellation to the bridge and always removes an aborted container', async () => {
      const runner = setup();
      const controller = new AbortController();
      // eslint-disable-next-line require-yield -- Models a provider that throws before emitting a message.
      mocks.bridge.mockImplementation(async function* () {
        controller.abort();
        throw new Error('aborted');
      });
      const result = await runner.runAgent({
        prompt: 'hi',
        signal: controller.signal,
        sandbox: { type: 'docker', cleanup: 'never' },
      });
      expect(result.isPartial).toBe(true);
      expect(mocks.bridge.mock.calls[0]?.[0].signal).toBe(controller.signal);
      expect(mocks.close).toHaveBeenCalledOnce();
    });
  });
});
