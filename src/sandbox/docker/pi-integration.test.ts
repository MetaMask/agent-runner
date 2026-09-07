import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

// The host must be reachable from Docker as host.docker.internal. On Linux,
// provide that hostname in the daemon's network or run the daemon locally with
// an appropriate host-gateway mapping. Build dist before enabling these tests.
describe.skipIf(process.env.RUN_DOCKER_TESTS !== '1')(
  'pi real Docker integration',
  () => {
    let server: Server | undefined;
    afterEach(async () => {
      server?.closeAllConnections();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
    });

    it('runs and judges through the standalone bridge with no external model service', async () => {
      // Load the built package only when the opt-in test runs.
      const { createAgentRunner, createPiAdapter } = (await import(
        new URL('../../../dist/index.mjs', import.meta.url).href
      )) as typeof import('../../index.js');
      let judge = false;
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          const delta = judge
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'submit_judgment',
                      arguments: JSON.stringify({
                        score: 8,
                        reasoning: 'good',
                      }),
                    },
                  },
                ],
              }
            : { content: 'Docker works' };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: judge ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, '0.0.0.0', resolve),
      );
      const address = server.address();
      const { port } = address as import('node:net').AddressInfo;
      const runner = createAgentRunner({
        adapter: createPiAdapter(),
        defaultOptions: { model: 'test', tools: [] },
        sandbox: {
          type: 'docker',
          image: 'node:22-bookworm',
          workspace: false,
          workdir: '/tmp',
          forwardEnv: false,
          env: {
            LITELLM_BASE_URL: `http://host.docker.internal:${port}`,
            LITELLM_API_KEY: 'sk-local',
          },
        },
      });
      const result = await runner.runAgent({ prompt: 'hi' });
      expect(result.error).toBeUndefined();
      expect(result.resultMessage).toMatchObject({
        success: true,
        result: 'Docker works',
        turns: 1,
      });
      judge = true;
      const verdict = await runner.judge(result, {
        rubric: 'Judge.',
        scoreFields: [{ name: 'score', min: 0, max: 10 }],
      });
      expect(verdict.scores.score).toBe(8);
    }, 120000);
  },
);
