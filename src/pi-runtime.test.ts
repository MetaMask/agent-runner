import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPiAdapter } from './adapters/pi-adapter.js';
import {
  assertPiNodeVersion,
  runPiSession,
  validatePiOptions,
} from './pi-runtime.js';
import { createAgentRunner } from './runner.js';
import type { AgentMessage } from './types.js';

type Reply = {
  text?: string;
  tool?: string;
  args?: object;
  stop?: string;
  status?: number;
};
let server: Server;
let requests: Record<string, any>[];
let reply: Reply;
let hanging = false;

// The SDK itself requires Node >=22.19; Claude compatibility is tested on Node 20.
describe.skipIf(Number(process.versions.node.split('.')[0]) < 22)(
  'pi integration',
  () => {
    beforeEach(async () => {
      requests = [];
      reply = { text: 'hello' };
      hanging = false;
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Local fixture handler; failures are test failures.
      server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
        }
        requests.push(JSON.parse(body));
        if (hanging) {
          return;
        }
        if (reply.status) {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'bad sk-test', type: 'invalid_request_error' },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = reply.tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: 'function',
                  function: {
                    name: reply.tool,
                    arguments: JSON.stringify(reply.args ?? {}),
                  },
                },
              ],
            }
          : { content: reply.text ?? '' };
        res.end(
          `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reply.stop ?? (reply.tool ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing server address');
      }
      vi.stubEnv('LITELLM_BASE_URL', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('LITELLM_API_KEY', 'sk-test');
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
    });

    describe('pi runtime with the real SDK and local LiteLLM protocol', () => {
      it('normalizes finalized text and usage without inventing prices', async () => {
        const runner = createAgentRunner({
          adapter: createPiAdapter(),
          defaultOptions: { model: 'test', tools: [] },
        });
        const result = await runner.runAgent({ prompt: 'hi' });
        expect(result.error).toBeUndefined();
        expect(result.resultMessage).toMatchObject({
          success: true,
          result: 'hello',
          turns: 1,
        });
        expect(result.totalCostUsd).toBeUndefined();
        expect(result.messages[1]).toMatchObject({
          type: 'generation',
          usage: { inputTokens: 3, outputTokens: 2 },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.tools).toBeUndefined();
      });

      it.each([
        { input: 2, output: 4 },
        { input: 0, output: 0 },
      ])('reports explicitly configured prices %j', async (cost) => {
        const result = await createAgentRunner({
          adapter: createPiAdapter(),
        }).runAgent({
          prompt: 'hi',
          options: { model: 'test', tools: [], cost },
        });
        expect(result.totalCostUsd).toBe(
          (3 * cost.input + 2 * cost.output) / 1e6,
        );
      });

      it('does not report a partial price as a complete total', async () => {
        const result = await createAgentRunner({
          adapter: createPiAdapter(),
        }).runAgent({
          prompt: 'hi',
          options: { model: 'test', tools: [], cost: { input: 1 } },
        });
        expect(result.totalCostUsd).toBeUndefined();
      });

      it('stops tool loops at maxTurns, without another HTTP request', async () => {
        reply = { tool: 'bash', args: { command: 'printf done' } };
        const result = await createAgentRunner({
          adapter: createPiAdapter(),
        }).runAgent({
          prompt: 'hi',
          options: { model: 'test', tools: ['bash'], maxTurns: 1 },
        });
        expect(result.error).toBeUndefined();
        expect(result.resultMessage).toMatchObject({
          success: false,
          turns: 1,
          error: 'Pi reached maxTurns (1).',
        });
        expect(result.messages).toContainEqual(
          expect.objectContaining({ type: 'tool_result', content: 'done' }),
        );
        expect(requests).toHaveLength(1);
      });

      it('judges with only submit_judgment and inherits the model', async () => {
        reply = {
          tool: 'submit_judgment',
          args: { correctness: 7, reasoning: 'Looks right.' },
        };
        const runner = createAgentRunner({
          adapter: createPiAdapter(),
          defaultOptions: { model: 'test', tools: ['bash'] },
        });
        const verdict = await runner.judge(
          {
            messages: [],
            durationMs: 0,
            isPartial: false,
            metadata: { startedAt: '', endedAt: '', messageCount: 0 },
          },
          {
            rubric: 'Judge correctness.',
            scoreFields: [{ name: 'correctness', min: 0, max: 10 }],
          },
          { taskPrompt: 'sk-test', status: 'sk-test' },
        );
        expect(verdict.scores.correctness).toBe(7);
        expect(requests).toHaveLength(1);
        expect(
          requests[0]?.tools.map((tool: any) => tool.function.name),
        ).toStrictEqual(['submit_judgment']);
        expect(JSON.stringify(requests[0])).not.toContain('sk-test');
      });

      it('cleans up when a judge message callback fails', async () => {
        const runner = createAgentRunner({
          adapter: createPiAdapter(),
          defaultOptions: { model: 'test' },
        });
        await expect(
          runner.judge(
            {
              messages: [],
              durationMs: 0,
              isPartial: false,
              metadata: { startedAt: '', endedAt: '', messageCount: 0 },
            },
            {
              rubric: 'Judge.',
              scoreFields: [{ name: 'score', min: 0, max: 10 }],
            },
            undefined,
            {
              onMessage: () => {
                throw new Error('callback');
              },
            },
          ),
        ).rejects.toThrow('callback failed');
        expect(requests).toHaveLength(0);
      });

      it('rejects a judge that never submits the structured result', async () => {
        const runner = createAgentRunner({
          adapter: createPiAdapter(),
          defaultOptions: { model: 'test' },
        });
        await expect(
          runner.judge(
            {
              messages: [],
              durationMs: 0,
              isPartial: false,
              metadata: { startedAt: '', endedAt: '', messageCount: 0 },
            },
            {
              rubric: 'Judge.',
              scoreFields: [{ name: 'score', min: 0, max: 10 }],
            },
          ),
        ).rejects.toThrow('did not submit');
      });

      it('cancels a stalled provider request and returns a partial result', async () => {
        hanging = true;
        const controller = new AbortController();
        const resultPromise = createAgentRunner({
          adapter: createPiAdapter(),
        }).runAgent({
          prompt: 'hi',
          options: { model: 'test' },
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        controller.abort(new Error('cancel sk-test'));
        const result = await resultPromise;
        expect(result.isPartial).toBe(true);
        expect(result.error?.message).toBe('cancel [REDACTED]');
        expect(result.resultMessage).toBeUndefined();
      });

      it('does not start a prompt if the init callback fails', async () => {
        const result = await createAgentRunner({
          adapter: createPiAdapter(),
        }).runAgent({
          prompt: 'hi',
          options: { model: 'test' },
          onMessage: () => {
            throw new Error('callback failed');
          },
        });
        expect(result.isPartial).toBe(true);
        expect(requests).toHaveLength(0);
      });

      it('returns an unsuccessful result for truncation and scrubs provider errors', async () => {
        reply = { stop: 'length', text: 'partial sk-test' };
        const runner = createAgentRunner({
          adapter: createPiAdapter(),
          defaultOptions: { model: 'test', tools: [] },
        });
        const truncated = await runner.runAgent({ prompt: 'hi' });
        expect(truncated.resultMessage).toMatchObject({
          success: false,
          result: 'partial [REDACTED]',
        });
        reply = { status: 400 };
        const failed = await runner.runAgent({ prompt: 'hi' });
        expect(failed.resultMessage).toMatchObject({ success: false });
        expect(JSON.stringify(failed)).not.toContain('sk-test');
      });

      it('accepts a base URL that already ends in /v1', async () => {
        // eslint-disable-next-line n/no-process-env -- Local fixture endpoint.
        vi.stubEnv('LITELLM_BASE_URL', `${process.env.LITELLM_BASE_URL}/v1/`);
        const messages: AgentMessage[] = [];
        for await (const message of runPiSession('hi', {
          model: 'test',
          tools: [],
        })) {
          messages.push(message);
        }
        expect(messages.at(-1)).toMatchObject({ success: true });
      });
    });

    describe('pi validation', () => {
      it.each(['20.19.0', '22.18.0', '0.0.0'])(
        'rejects unsupported Node %s',
        (version) => {
          expect(() => assertPiNodeVersion(version)).toThrow('Node.js');
        },
      );
      it.each(['22.19.0', '24.0.0'])('accepts Node %s', (version) => {
        expect(() => assertPiNodeVersion(version)).not.toThrow(/Pi/u);
      });
      it.each([
        null,
        {},
        { model: '' },
        { model: 'x', permissionMode: 'bypassPermissions' },
        { model: 'x', maxTurns: 0 },
        { model: 'x', maxTokens: Infinity },
        { model: 'x', tools: ['bash(rm:*)'] },
        { model: 'x', tools: 'bash' },
        { model: 'x', cwd: 'relative' },
        { model: 'x', cost: { input: -1 } },
        { model: 'x', cost: [] },
        { model: 'x', input: ['invalid'] },
        Object.assign(new Date(), { model: 'x' }),
        { model: 'x', cost: { unknown: 1 } },
        { model: 'x', reasoning: 'yes' },
        { model: 'x', input: [] },
        { model: 'x', systemPrompt: 2 },
      ])('fails closed on invalid options %j', (options) => {
        expect(() => validatePiOptions(options as any)).toThrow(/Pi/u);
      });
      it('rejects judge tool customization', () => {
        expect(() =>
          validatePiOptions({ model: 'x', tools: [] }, true),
        ).toThrow('tool customization');
      });
      it('rejects missing credentials and pre-aborted runs without HTTP requests', async () => {
        vi.stubEnv('LITELLM_API_KEY', '');
        const runner = createAgentRunner({ adapter: createPiAdapter() });
        const missing = await runner.runAgent({
          prompt: 'hi',
          options: { model: 'x' },
        });
        expect(missing.error?.message).toContain('LITELLM_API_KEY');
        const aborted = await runner.runAgent({
          prompt: 'hi',
          options: { model: 'x' },
          signal: AbortSignal.abort(),
        });
        expect(aborted.error?.name).toBe('AbortError');
        expect(requests).toHaveLength(0);
      });
    });
  },
);
