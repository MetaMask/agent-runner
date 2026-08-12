import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { SandboxConfigurationError } from '../../errors.js';
import {
  DEFAULT_DOCKER_SANDBOX_FORWARD_ENV,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH,
} from '../types.js';
import type { DockerSandboxConfig } from '../types.js';
import {
  DEFAULT_DOCKER_SANDBOX_BRIDGE_INSTALL,
  DEFAULT_DOCKER_SANDBOX_BRIDGE_NODE_COMMAND,
  DEFAULT_DOCKER_SANDBOX_BRIDGE_NPM_COMMAND,
  DEFAULT_DOCKER_SANDBOX_CLEANUP,
  normalizeDockerSandboxConfig,
  prepareDockerSandboxRequest,
} from './options.js';
import type { NormalizedDockerSandboxConfig } from './options.js';

const HOST_CWD = '/host/cwd';

const baseContext = {
  hostCwd: HOST_CWD,
  env: {} as Record<string, string | undefined>,
};

/**
 * Convenience builder for a normalized sandbox config used by the
 * `prepareDockerSandboxRequest` tests.
 *
 * @param overrides - Partial fields applied on top of sensible defaults.
 * @returns A normalized Docker sandbox config.
 */
function makeNormalized(
  overrides: Partial<NormalizedDockerSandboxConfig> = {},
): NormalizedDockerSandboxConfig {
  const base: NormalizedDockerSandboxConfig = {
    image: DEFAULT_DOCKER_SANDBOX_IMAGE,
    workspace: {
      hostPath: '/host/work',
      containerPath: '/workspace',
      readOnly: false,
    },
    mounts: [],
    env: {},
    forwardEnv: [...DEFAULT_DOCKER_SANDBOX_FORWARD_ENV],
    unsafeDockerArgs: [],
    setupCommands: [],
    cleanup: DEFAULT_DOCKER_SANDBOX_CLEANUP,
    bridge: {
      install: DEFAULT_DOCKER_SANDBOX_BRIDGE_INSTALL,
      nodeCommand: DEFAULT_DOCKER_SANDBOX_BRIDGE_NODE_COMMAND,
      npmCommand: DEFAULT_DOCKER_SANDBOX_BRIDGE_NPM_COMMAND,
    },
  };
  return { ...base, ...overrides };
}

describe('normalizeDockerSandboxConfig', () => {
  describe('defaults', () => {
    it('fills image, workspace, cleanup, and bridge defaults', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker' },
        baseContext,
      );

      expect(normalized.image).toBe(DEFAULT_DOCKER_SANDBOX_IMAGE);
      expect(normalized.workspace).toStrictEqual({
        hostPath: HOST_CWD,
        containerPath: DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH,
        readOnly: false,
      });
      expect(normalized.cleanup).toBe(DEFAULT_DOCKER_SANDBOX_CLEANUP);
      expect(normalized.bridge).toStrictEqual({
        install: DEFAULT_DOCKER_SANDBOX_BRIDGE_INSTALL,
        nodeCommand: DEFAULT_DOCKER_SANDBOX_BRIDGE_NODE_COMMAND,
        npmCommand: DEFAULT_DOCKER_SANDBOX_BRIDGE_NPM_COMMAND,
      });
      expect(normalized.mounts).toStrictEqual([]);
      expect(normalized.setupCommands).toStrictEqual([]);
      expect(normalized.unsafeDockerArgs).toStrictEqual([]);
    });

    it('resolves relative workspace host paths against hostCwd', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker', workspace: { hostPath: 'sub/work' } },
        baseContext,
      );

      expect(normalized.workspace).toMatchObject({
        hostPath: '/host/cwd/sub/work',
        containerPath: '/workspace',
      });
    });

    it('preserves explicit workspace container path and read-only flag', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          workspace: {
            hostPath: '/host/work',
            containerPath: '/code',
            readOnly: true,
          },
        },
        baseContext,
      );

      expect(normalized.workspace).toStrictEqual({
        hostPath: '/host/work',
        containerPath: '/code',
        readOnly: true,
      });
    });

    it('preserves shmSize, memory, envFile, network, user, workdir, and unsafeDockerArgs', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          shmSize: '512m',
          memory: '4g',
          envFile: '/host/cwd/.env',
          network: 'host',
          user: 'current',
          workdir: '/code',
          unsafeDockerArgs: ['--cap-add=NET_ADMIN'],
          setupCommands: ['echo hi'],
        },
        baseContext,
      );

      expect(normalized.shmSize).toBe('512m');
      expect(normalized.memory).toBe('4g');
      expect(normalized.envFile).toBe('/host/cwd/.env');
      expect(normalized.network).toBe('host');
      expect(normalized.user).toBe('current');
      expect(normalized.workdir).toBe('/code');
      expect(normalized.unsafeDockerArgs).toStrictEqual([
        '--cap-add=NET_ADMIN',
      ]);
      expect(normalized.setupCommands).toStrictEqual(['echo hi']);
    });

    it('preserves bridge.sdkVersion when explicitly provided', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker', bridge: { sdkVersion: '1.2.3' } },
        baseContext,
      );

      expect(normalized.bridge.sdkVersion).toBe('1.2.3');
    });
  });

  describe('env forwarding', () => {
    it('uses adapter defaults without leaking keys between harnesses', () => {
      const env = {
        ANTHROPIC_API_KEY: 'claude',
        LITELLM_API_KEY: 'pi',
        LITELLM_BASE_URL: 'https://litellm',
      };
      const claude = normalizeDockerSandboxConfig(
        { type: 'docker' },
        {
          hostCwd: HOST_CWD,
          env,
          defaultForwardEnv: ['ANTHROPIC_API_KEY'],
        },
      );
      const pi = normalizeDockerSandboxConfig(
        { type: 'docker' },
        {
          hostCwd: HOST_CWD,
          env,
          defaultForwardEnv: ['LITELLM_API_KEY', 'LITELLM_BASE_URL'],
        },
      );
      expect(claude.env).toStrictEqual({ ANTHROPIC_API_KEY: 'claude' });
      expect(pi.env).toStrictEqual({
        LITELLM_API_KEY: 'pi',
        LITELLM_BASE_URL: 'https://litellm',
      });
    });
    it('forwards default env vars from the env source', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker' },
        {
          hostCwd: HOST_CWD,
          env: {
            ANTHROPIC_API_KEY: 'secret',
            HTTPS_PROXY: 'http://proxy:8080',
            UNRELATED: 'ignored',
          },
        },
      );

      expect(normalized.env).toStrictEqual({
        ANTHROPIC_API_KEY: 'secret',
        HTTPS_PROXY: 'http://proxy:8080',
      });
    });

    it('disables forwarding when forwardEnv is false', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker', forwardEnv: false },
        {
          hostCwd: HOST_CWD,
          env: { ANTHROPIC_API_KEY: 'secret' },
        },
      );

      expect(normalized.env).toStrictEqual({});
      expect(normalized.forwardEnv).toBe(false);
    });

    it('lets explicit env override forwarded values', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          env: { ANTHROPIC_API_KEY: 'override', EXTRA: 'value' },
        },
        {
          hostCwd: HOST_CWD,
          env: { ANTHROPIC_API_KEY: 'host' },
        },
      );

      expect(normalized.env).toStrictEqual({
        ANTHROPIC_API_KEY: 'override',
        EXTRA: 'value',
      });
    });

    it('lets explicit undefined remove a forwarded var', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          env: { ANTHROPIC_API_KEY: undefined },
        },
        {
          hostCwd: HOST_CWD,
          env: { ANTHROPIC_API_KEY: 'secret', HTTP_PROXY: 'p' },
        },
      );

      expect(normalized.env).toStrictEqual({ HTTP_PROXY: 'p' });
    });

    it('respects a narrower explicit forwardEnv list', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker', forwardEnv: ['ONLY'] },
        {
          hostCwd: HOST_CWD,
          env: { ONLY: 'yes', ANTHROPIC_API_KEY: 'no' },
        },
      );

      expect(normalized.env).toStrictEqual({ ONLY: 'yes' });
      expect(normalized.forwardEnv).toStrictEqual(['ONLY']);
    });
  });

  describe('workspace false', () => {
    it('preserves workspace=false and skips workspace mount', () => {
      const normalized = normalizeDockerSandboxConfig(
        { type: 'docker', workspace: false, workdir: '/srv' },
        baseContext,
      );

      expect(normalized.workspace).toBe(false);
      expect(normalized.workdir).toBe('/srv');
    });
  });

  describe('mounts validation', () => {
    it('resolves relative mount host paths against hostCwd', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          mounts: [{ hostPath: 'extra', containerPath: '/extra' }],
        },
        baseContext,
      );

      expect(normalized.mounts).toStrictEqual([
        {
          hostPath: '/host/cwd/extra',
          containerPath: '/extra',
          readOnly: false,
        },
      ]);
    });

    it('rejects duplicate mount container paths', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            mounts: [
              { hostPath: '/a', containerPath: '/dup' },
              { hostPath: '/b', containerPath: '/dup' },
            ],
          },
          baseContext,
        ),
      ).toThrow(SandboxConfigurationError);
    });

    it('rejects a mount that collides with the workspace container path', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            workspace: { containerPath: '/workspace' },
            mounts: [{ hostPath: '/a', containerPath: '/workspace' }],
          },
          baseContext,
        ),
      ).toThrow(/Duplicate Docker sandbox container path/u);
    });

    it('rejects a mount nested inside the workspace container path', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            workspace: { containerPath: '/workspace' },
            mounts: [{ hostPath: '/a', containerPath: '/workspace/sub' }],
          },
          baseContext,
        ),
      ).toThrow(/Overlapping Docker sandbox container paths/u);
    });

    it('rejects a mount that would be an ancestor of the workspace container path', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            workspace: { containerPath: '/workspace/sub' },
            mounts: [{ hostPath: '/a', containerPath: '/workspace' }],
          },
          baseContext,
        ),
      ).toThrow(/Overlapping Docker sandbox container paths/u);
    });

    it('rejects non-absolute container paths', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            mounts: [{ hostPath: '/a', containerPath: 'relative' }],
          },
          baseContext,
        ),
      ).toThrow(/must be an absolute POSIX path/u);
    });

    it('rejects empty string mount host paths', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            mounts: [{ hostPath: '', containerPath: '/data' }],
          },
          baseContext,
        ),
      ).toThrow(/mounts\[0\]\.hostPath must be a non-empty string/u);
    });

    it('rejects container paths with parent directory references', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            mounts: [{ hostPath: '/a', containerPath: '/data/../etc' }],
          },
          baseContext,
        ),
      ).toThrow(/must not contain parent directory references/u);
    });

    it('normalizes container paths with trailing slashes', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          mounts: [{ hostPath: '/a', containerPath: '/data/' }],
        },
        baseContext,
      );

      expect(normalized.mounts).toStrictEqual([
        {
          hostPath: '/a',
          containerPath: '/data',
          readOnly: false,
        },
      ]);
    });

    it('rejects overlapping mount container paths (ancestor)', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            workspace: false,
            mounts: [
              { hostPath: '/a', containerPath: '/data' },
              { hostPath: '/b', containerPath: '/data/inner' },
            ],
          },
          baseContext,
        ),
      ).toThrow(/Overlapping Docker sandbox container paths/u);
    });

    it('rejects overlapping mount container paths (descendant)', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          {
            type: 'docker',
            workspace: false,
            mounts: [
              { hostPath: '/a', containerPath: '/data/inner' },
              { hostPath: '/b', containerPath: '/data' },
            ],
          },
          baseContext,
        ),
      ).toThrow(/Overlapping Docker sandbox container paths/u);
    });

    it('allows non-overlapping mount container paths', () => {
      const normalized = normalizeDockerSandboxConfig(
        {
          type: 'docker',
          workspace: false,
          mounts: [
            { hostPath: '/a', containerPath: '/data' },
            { hostPath: '/b', containerPath: '/config' },
          ],
        },
        baseContext,
      );

      expect(normalized.mounts).toStrictEqual([
        {
          hostPath: '/a',
          containerPath: '/data',
          readOnly: false,
        },
        {
          hostPath: '/b',
          containerPath: '/config',
          readOnly: false,
        },
      ]);
    });
  });

  describe('type validation', () => {
    it('rejects unknown sandbox types', () => {
      const bogus = { type: 'firecracker' } as unknown as DockerSandboxConfig;
      expect(() => normalizeDockerSandboxConfig(bogus, baseContext)).toThrow(
        SandboxConfigurationError,
      );
    });

    it('rejects a non-absolute hostCwd', () => {
      expect(() =>
        normalizeDockerSandboxConfig(
          { type: 'docker' },
          { hostCwd: 'relative', env: {} },
        ),
      ).toThrow(/host cwd must be absolute/u);
    });
  });

  describe('immutability', () => {
    it('does not mutate the input config or env arrays', () => {
      const config: DockerSandboxConfig = {
        type: 'docker',
        env: { FOO: 'bar' },
        forwardEnv: ['ONLY'],
        mounts: [{ hostPath: '/a', containerPath: '/a' }],
        unsafeDockerArgs: ['--cap-add=NET_ADMIN'],
        setupCommands: ['echo hi'],
        bridge: { install: false },
      };
      const snapshot = structuredClone(config);

      const normalized = normalizeDockerSandboxConfig(config, baseContext);

      normalized.mounts.push({
        hostPath: '/x',
        containerPath: '/x',
        readOnly: false,
      });
      normalized.unsafeDockerArgs.push('--privileged');
      normalized.setupCommands.push('rm -rf');
      normalized.env.FOO = 'mutated';

      expect(config).toStrictEqual(snapshot);
    });
  });

  describe('dangerous docker arg warnings', () => {
    it('warns for --privileged=true (equals form)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', unsafeDockerArgs: ['--privileged=true'] },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--privileged'),
      );
      warnSpy.mockRestore();
    });

    it('warns for --cap-add=SYS_ADMIN (equals form)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', unsafeDockerArgs: ['--cap-add=SYS_ADMIN'] },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--cap-add'),
      );
      warnSpy.mockRestore();
    });

    it('warns for --cap-add SYS_ADMIN (split form)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', unsafeDockerArgs: ['--cap-add', 'SYS_ADMIN'] },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--cap-add'),
      );
      warnSpy.mockRestore();
    });

    it('warns for --pid host (split form)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', unsafeDockerArgs: ['--pid', 'host'] },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--pid'));
      warnSpy.mockRestore();
    });

    it('does not warn when a dangerous split flag has a safe value', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', unsafeDockerArgs: ['--pid', 'container:abc'] },
        baseContext,
      );

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('warns for network: "host" (typed field)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', network: 'host' },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('network: "host"'),
      );
      warnSpy.mockRestore();
    });

    it('warns for user: "root" (typed field)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', user: 'root' },
        baseContext,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('user: "root"'),
      );
      warnSpy.mockRestore();
    });

    it('warns for user: "0" (typed field)', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig({ type: 'docker', user: '0' }, baseContext);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('user: "root"'),
      );
      warnSpy.mockRestore();
    });

    it('does not warn for safe typed config values', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      normalizeDockerSandboxConfig(
        { type: 'docker', network: 'bridge', user: 'current' },
        baseContext,
      );

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

describe('prepareDockerSandboxRequest', () => {
  describe('prompt validation', () => {
    it('accepts a string prompt', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hello',
        options: {},
        sandbox: makeNormalized(),
      });

      expect(prepared.prompt).toBe('hello');
      expect(prepared.options).toStrictEqual({});
    });

    it('rejects async iterable prompts', () => {
      const asyncIterable = (async function* () {
        yield { type: 'user' as const };
      })();

      expect(() =>
        prepareDockerSandboxRequest({
          prompt: asyncIterable,
          options: {},
          sandbox: makeNormalized(),
        }),
      ).toThrow(/prompt must be a string/u);
    });

    it('rejects non-string prompts', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 42,
          options: {},
          sandbox: makeNormalized(),
        }),
      ).toThrow(SandboxConfigurationError);
    });
  });

  describe('cwd mapping', () => {
    it('rewrites cwd inside workspace to container path', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { cwd: '/host/work/sub/dir' },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.cwd).toBe('/workspace/sub/dir');
    });

    it('maps cwd equal to the workspace root to the container root', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { cwd: '/host/work' },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.cwd).toBe('/workspace');
    });

    it('rejects cwd outside the workspace', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { cwd: '/other/place' },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/outside the workspace host path/u);
    });

    it('rejects relative cwd values', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { cwd: 'relative/path' },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/options\.cwd must be an absolute host path/u);
    });

    it('rejects cwd when workspace mount is disabled', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { cwd: '/somewhere' },
          sandbox: makeNormalized({ workspace: false, workdir: '/srv' }),
        }),
      ).toThrow(/workspace mount is disabled/u);
    });

    it('rejects cwd outside all mounts when workspace is disabled but mounts exist', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { cwd: '/host/other' },
          sandbox: makeNormalized({
            workspace: false,
            mounts: [
              {
                hostPath: '/host/extra',
                containerPath: '/extra',
                readOnly: false,
              },
            ],
          }),
        }),
      ).toThrow(/not inside any mounted host path/u);
    });

    it('leaves options.cwd unset when caller omits it', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {},
        sandbox: makeNormalized({ workspace: false, workdir: '/srv' }),
      });

      expect(prepared.options).toStrictEqual({});
    });

    it('maps cwd inside an additional mount', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { cwd: '/host/extra/sub' },
        sandbox: makeNormalized({
          mounts: [
            {
              hostPath: '/host/extra',
              containerPath: '/extra',
              readOnly: false,
            },
          ],
        }),
      });

      expect(prepared.options.cwd).toBe('/extra/sub');
    });

    it('prefers the most specific mount when workspace and mount overlap', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { cwd: '/host/work/nested/sub' },
        sandbox: makeNormalized({
          workspace: {
            hostPath: '/host/work',
            containerPath: '/workspace',
            readOnly: false,
          },
          mounts: [
            {
              hostPath: '/host/work/nested',
              containerPath: '/nested',
              readOnly: false,
            },
          ],
        }),
      });

      expect(prepared.options.cwd).toBe('/nested/sub');
    });

    it('rejects cwd not under any mount when additional mounts are present', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { cwd: '/unmounted' },
          sandbox: makeNormalized({
            mounts: [
              {
                hostPath: '/host/extra',
                containerPath: '/extra',
                readOnly: false,
              },
            ],
          }),
        }),
      ).toThrow(/outside the workspace host path/u);
    });
  });

  describe('additionalDirectories mapping', () => {
    it('maps each entry inside the workspace', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          additionalDirectories: ['/host/work/a', '/host/work/b/c'],
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.additionalDirectories).toStrictEqual([
        '/workspace/a',
        '/workspace/b/c',
      ]);
    });

    it('rejects entries outside the workspace', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: {
            additionalDirectories: ['/host/work/a', '/elsewhere'],
          },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/additionalDirectories\[1\]/u);
    });

    it('rejects non-string entries', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: {
            additionalDirectories: ['/host/work/a', 42],
          },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/options\.additionalDirectories\[1\] must be a string/u);
    });

    it('maps entries inside an additional mount', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          additionalDirectories: ['/host/extra/a'],
        },
        sandbox: makeNormalized({
          mounts: [
            {
              hostPath: '/host/extra',
              containerPath: '/extra',
              readOnly: false,
            },
          ],
        }),
      });

      expect(prepared.options.additionalDirectories).toStrictEqual([
        '/extra/a',
      ]);
    });
  });

  describe('settings mapping', () => {
    it('maps a string settings path inside the workspace', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { settings: '/host/work/.claude/settings.json' },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.settings).toBe(
        '/workspace/.claude/settings.json',
      );
    });

    it('rejects a string settings path outside the workspace', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { settings: '/etc/claude/settings.json' },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/options\.settings/u);
    });

    it('maps a string settings path inside an additional mount', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { settings: '/host/extra/settings.json' },
        sandbox: makeNormalized({
          mounts: [
            {
              hostPath: '/host/extra',
              containerPath: '/extra',
              readOnly: false,
            },
          ],
        }),
      });

      expect(prepared.options.settings).toBe('/extra/settings.json');
    });

    it('passes a plain settings object through JSON sanitization', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          settings: { model: 'claude-sonnet', permissions: { allow: ['*'] } },
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.settings).toStrictEqual({
        model: 'claude-sonnet',
        permissions: { allow: ['*'] },
      });
    });
  });

  describe('plugins mapping', () => {
    it('maps local plugin paths inside the workspace', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          plugins: [{ type: 'local', path: '/host/work/plugins/a' }],
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.plugins).toStrictEqual([
        { type: 'local', path: '/workspace/plugins/a' },
      ]);
    });

    it('rejects local plugin paths outside the workspace', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: {
            plugins: [{ type: 'local', path: '/elsewhere' }],
          },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/options\.plugins\[0\]\.path/u);
    });

    it('maps local plugin paths inside an additional mount', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          plugins: [{ type: 'local', path: '/host/extra/plugin' }],
        },
        sandbox: makeNormalized({
          mounts: [
            {
              hostPath: '/host/extra',
              containerPath: '/extra',
              readOnly: false,
            },
          ],
        }),
      });

      expect(prepared.options.plugins).toStrictEqual([
        { type: 'local', path: '/extra/plugin' },
      ]);
    });

    it('passes non-local plugin configs through when JSON-safe', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          plugins: [{ type: 'remote', name: 'foo', config: { x: 1 } }],
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.plugins).toStrictEqual([
        { type: 'remote', name: 'foo', config: { x: 1 } },
      ]);
    });

    it('passes primitive plugin entries through when JSON-safe', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          plugins: ['builtin-plugin'],
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options.plugins).toStrictEqual(['builtin-plugin']);
    });
  });

  describe('JSON serialization validation', () => {
    it('rejects functions anywhere in options', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { extraArgs: { handler: (() => undefined) as never } },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/contains a function/u);
    });

    it('rejects symbols', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { tag: Symbol('x') as unknown as string },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/contains a symbol/u);
    });

    it('rejects bigint values', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { count: 1n as unknown as number },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/contains a bigint/u);
    });

    it('rejects class instances', () => {
      /**
       *
       */
      class Custom {
        public field = 1;
      }
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { agents: new Custom() as unknown as Record<string, never> },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/non-plain object/u);
    });

    it('rejects Node.js streams', () => {
      const stream = Readable.from(['x']);
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { input: stream as unknown as string },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/stream-like/u);
    });

    it('rejects circular references', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { agents: circular },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/circular reference/u);
    });

    it('rejects undefined entries inside arrays', () => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: {
            allowedTools: ['Read', undefined as unknown as string, 'Edit'],
          },
          sandbox: makeNormalized(),
        }),
      ).toThrow(/may not contain undefined entries/u);
    });

    it('strips undefined fields from objects', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: {
          model: 'claude-sonnet',
          extraArgs: { keep: 'yes', drop: undefined },
        },
        sandbox: makeNormalized(),
      });

      expect(prepared.options).toStrictEqual({
        model: 'claude-sonnet',
        extraArgs: { keep: 'yes' },
      });
    });
  });

  describe('unsupported SDK options', () => {
    const cases: {
      key: string;
      value: unknown;
    }[] = [
      {
        key: 'canUseTool',
        value: () => undefined,
      },
      { key: 'hooks', value: { PreToolUse: [] } },
      {
        key: 'onElicitation',
        value: () => undefined,
      },
      {
        key: 'stderr',
        value: () => undefined,
      },
      {
        key: 'sessionStore',
        value: {
          load: () => undefined,
        },
      },
      { key: 'abortController', value: new AbortController() },
      { key: 'signal', value: new AbortController().signal },
      {
        key: 'spawnClaudeCodeProcess',
        value: () => undefined,
      },
    ];

    it.each(cases)('rejects $key', ({ key, value }) => {
      expect(() =>
        prepareDockerSandboxRequest({
          prompt: 'hi',
          options: { [key]: value },
          sandbox: makeNormalized(),
        }),
      ).toThrow(
        new RegExp(`does not support Claude SDK option \`${key}\``, 'u'),
      );
    });

    it('allows explicit undefined values for unsupported keys', () => {
      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { canUseTool: undefined, model: 'claude-sonnet' },
        sandbox: makeNormalized(),
      });

      expect(prepared.options).toStrictEqual({ model: 'claude-sonnet' });
    });
  });

  describe('immutability', () => {
    it('does not mutate the caller options', () => {
      const options = {
        cwd: '/host/work/sub',
        additionalDirectories: ['/host/work/a'],
        allowedTools: ['Read', 'Edit'],
        plugins: [{ type: 'local', path: '/host/work/p' }],
      };
      const snapshot = structuredClone(options);

      const prepared = prepareDockerSandboxRequest({
        prompt: 'hi',
        options,
        sandbox: makeNormalized(),
      });

      // Mutating the prepared payload must not bleed into the input.
      (prepared.options.allowedTools as string[]).push('Bash');

      expect(options).toStrictEqual(snapshot);
    });

    it('does not mutate the supplied sandbox config', () => {
      const sandbox = makeNormalized();
      const snapshot = structuredClone(sandbox);

      prepareDockerSandboxRequest({
        prompt: 'hi',
        options: { cwd: '/host/work/sub' },
        sandbox,
      });

      expect(sandbox).toStrictEqual(snapshot);
    });
  });
});
