/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles infer their contracts from the runtime. */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPiSession } from './pi-runtime.js';

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  createSession: vi.fn(),
  loader: vi.fn(),
  model: vi.fn(),
  version: '0.83.0',
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Match the SDK export.
  get VERSION() {
    return mocks.version;
  },
  ModelRuntime: { create: mocks.createRuntime },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  DefaultResourceLoader: class {
    constructor(options: object) {
      mocks.loader(options);
    }

    async reload() {
      return undefined;
    }
  },
  createAgentSession: mocks.createSession,
}));

async function consume(
  options: Parameters<typeof runPiSession>[1] = { model: 'x' },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Drain the stream.
  for await (const _message of runPiSession('hi', options)) {
    /* Drain runtime. */
  }
}
function setup(): void {
  vi.stubEnv('LITELLM_BASE_URL', 'http://localhost:4000');
  vi.stubEnv('LITELLM_API_KEY', 'sk-test');
  mocks.model.mockReturnValue({ id: 'x' });
  mocks.createRuntime.mockResolvedValue({
    registerProvider: vi.fn(),
    getModel: mocks.model,
  });
  let listener: (event: AgentSessionEvent) => void = () => undefined;
  mocks.createSession.mockResolvedValue({
    session: {
      sessionId: 'x',
      agent: { abort: vi.fn() },
      getActiveToolNames: () => [],
      dispose: vi.fn(),
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return () => undefined;
      },
      prompt: async () => {
        listener({
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'x',
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            stopReason: 'stop',
          },
        } as unknown as AgentSessionEvent);
      },
    },
  });
}

describe.skipIf(Number(process.versions.node.split('.')[0]) < 22)(
  'pi SDK setup contract',
  () => {
    afterEach(() => {
      vi.resetAllMocks();
      vi.unstubAllEnvs();
      mocks.version = '0.83.0';
    });
    it('disables discovery and persisted credentials, while passing declared model settings', async () => {
      setup();
      await consume({
        model: 'x',
        cwd: '/tmp',
        systemPrompt: 'custom',
        contextWindow: 1000,
        maxTokens: 100,
        reasoning: true,
        input: ['image'],
        cost: { input: 0, output: 0 },
      });
      const config = mocks.createRuntime.mock.calls[0]?.[0];
      expect(config).toMatchObject({
        modelsPath: null,
        allowModelNetwork: false,
      });
      expect(await config.credentials.read('litellm')).toBeUndefined();
      expect(await config.credentials.list()).toStrictEqual([]);
      await expect(config.credentials.modify()).rejects.toThrow(
        'persistence is disabled',
      );
      await expect(config.credentials.delete()).rejects.toThrow(
        'persistence is disabled',
      );
      expect(mocks.loader).toHaveBeenCalledWith(
        expect.objectContaining({
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          systemPrompt: 'custom',
        }),
      );
      expect(mocks.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/tmp',
          tools: ['read', 'bash', 'edit', 'write'],
        }),
      );
    });
    it('rejects a mismatched SDK version', async () => {
      setup();
      mocks.version = '0.84.0';
      await expect(consume()).rejects.toThrow('requires SDK 0.83.0');
    });
    it('rejects an unresolved model before creating a session', async () => {
      setup();
      mocks.model.mockReturnValue(undefined);
      await expect(consume()).rejects.toThrow('could not resolve');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });
    it.each([
      'ftp://localhost',
      'http://user:pass@localhost',
      'http://localhost?key=x',
      'http://localhost#fragment',
    ])('rejects unsafe endpoint %s', async (url) => {
      setup();
      vi.stubEnv('LITELLM_BASE_URL', url);
      await expect(consume()).rejects.toThrow('HTTP(S) URL');
    });
  },
);
