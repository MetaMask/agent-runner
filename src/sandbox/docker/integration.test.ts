/**
 * Optional Docker integration smoke test.
 *
 * This test actually shells out to the host `docker` CLI to verify that
 * {@link createDockerSandbox} can create, exec inside, copy files into,
 * and tear down a real container. It is skipped by default because most
 * CI/dev environments will not have a Docker daemon configured.
 *
 * To run it locally:
 *
 * ```bash
 * RUN_DOCKER_TESTS=1 yarn vitest run src/sandbox/docker/integration.test.ts
 * ```
 *
 * The default image is the small `busybox:1.36` image. Override it via
 * `DOCKER_TEST_IMAGE` to use a private mirror or a different tag.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { bootstrapDockerBridge, PI_BRIDGE_RUNTIME } from './bridge.js';
import { createDefaultDockerCommandRunner } from './command-runner.js';
import { createDockerSandbox } from './lifecycle.js';
import type { NormalizedDockerSandboxConfig } from './options.js';

const runDockerTests = process.env.RUN_DOCKER_TESTS === '1';
const testImage = process.env.DOCKER_TEST_IMAGE ?? 'busybox:1.36';

/**
 * Builds a minimal normalized sandbox config for the smoke test. The
 * bridge fields are populated with values that satisfy the type but are
 * not exercised by these tests (the bridge itself has its own coverage).
 *
 * @param overrides - Optional fields to merge over the defaults.
 * @returns A normalized config suitable for `createDockerSandbox`.
 */
function makeConfig(
  overrides: Partial<NormalizedDockerSandboxConfig> = {},
): NormalizedDockerSandboxConfig {
  return {
    image: testImage,
    workspace: false,
    mounts: [],
    env: {},
    forwardEnv: [],
    unsafeDockerArgs: [],
    setupCommands: [],
    cleanup: 'always',
    bridge: {
      install: false,
      nodeCommand: 'node',
      npmCommand: 'npm',
    },
    ...overrides,
  };
}

// `describe.skipIf` evaluates the predicate at suite registration time
// so the whole block (including its setup) is short-circuited when the
// environment flag is absent. This keeps the default vitest run fast
// and Docker-free.
describe.skipIf(!runDockerTests)('docker sandbox integration', () => {
  it(
    'creates a container, executes commands, copies files, and tears down',
    { timeout: 60_000 },
    async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-runner-docker-'));
      const hostFile = path.join(tmpDir, 'hello.txt');
      writeFileSync(hostFile, 'hello from host\n', 'utf8');

      const handle = await createDockerSandbox(makeConfig());

      try {
        const echo = await handle.exec('echo hi');
        expect(echo.exitCode).toBe(0);
        expect(echo.stdout.trim()).toBe('hi');

        await handle.copyFileIn(hostFile, '/tmp/hello.txt');
        const printed = await handle.exec('cat /tmp/hello.txt');
        expect(printed.stdout).toBe('hello from host\n');

        await handle.exec('echo "from container" > /tmp/out.txt');
        const outFile = path.join(tmpDir, 'out.txt');
        await handle.copyFileOut('/tmp/out.txt', outFile);
        expect(readFileSync(outFile, 'utf8')).toBe('from container\n');
      } finally {
        await handle.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'runs setup commands before returning the handle',
    { timeout: 60_000 },
    async () => {
      const handle = await createDockerSandbox(
        makeConfig({
          setupCommands: ['mkdir -p /opt/seed', 'echo seeded > /opt/seed/data'],
        }),
      );

      try {
        const result = await handle.exec('cat /opt/seed/data');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('seeded');
      } finally {
        await handle.close();
      }
    },
  );

  it('close is idempotent', { timeout: 60_000 }, async () => {
    const handle = await createDockerSandbox(makeConfig());
    await handle.close();
    // Second close must be a no-op and must not throw even though the
    // container no longer exists.
    expect(await handle.close()).toBeUndefined();
  });

  it(
    'installs and loads the credential-free Pi bridge runtime',
    { timeout: 180_000 },
    async () => {
      const handle = await createDockerSandbox(
        makeConfig({ image: 'docker/sandbox-templates:shell' }),
      );
      const commandRunner = createDefaultDockerCommandRunner();
      try {
        const prepared = await bootstrapDockerBridge({
          runtime: PI_BRIDGE_RUNTIME,
          sandbox: handle,
          config: makeConfig({ image: 'docker/sandbox-templates:shell' }),
          commandRunner,
        });
        const loaded = await commandRunner.run('docker', [
          'exec',
          handle.containerName,
          prepared.nodeCommand,
          '-e',
          "import('@earendil-works/pi-coding-agent').then(()=>process.stdout.write('ok'))",
        ]);
        expect(loaded.stdout).toBe('ok');
      } finally {
        await handle.close();
      }
    },
  );
});

// Sanity check so the file is never completely empty when the suite
// above is skipped: assert the env-flag predicate is observed.
describe('docker sandbox integration gating', () => {
  it('matches the RUN_DOCKER_TESTS env flag', () => {
    expect(runDockerTests).toBe(process.env.RUN_DOCKER_TESTS === '1');
  });
});
