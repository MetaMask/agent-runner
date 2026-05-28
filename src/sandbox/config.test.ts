import { describe, expect, it } from 'vitest';

import { SandboxConfigurationError } from '../errors.js';
import { resolveSandboxConfig } from './config.js';
import type { DockerSandboxConfig, SandboxConfig } from './types.js';

describe('resolveSandboxConfig', () => {
  describe('disable / pass-through', () => {
    it('returns undefined when neither side is provided', () => {
      expect(resolveSandboxConfig()).toBeUndefined();
      expect(resolveSandboxConfig(undefined, undefined)).toBeUndefined();
    });

    it('returns undefined when run config disables the sandbox', () => {
      const defaultSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'example:latest',
      };

      expect(resolveSandboxConfig(defaultSandbox, false)).toBeUndefined();
    });

    it('returns undefined when the default disables and no run override is given', () => {
      expect(resolveSandboxConfig(false)).toBeUndefined();
    });

    it('returns a clone of the run config when the default disables sandboxing', () => {
      const runSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'override:latest',
      };

      const resolved = resolveSandboxConfig(false, runSandbox);

      expect(resolved).toStrictEqual(runSandbox);
      expect(resolved).not.toBe(runSandbox);
    });

    it('returns a clone of the default when no run config is given', () => {
      const defaultSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'default:latest',
        workdir: '/workspace',
        mounts: [{ hostPath: '/a', containerPath: '/a' }],
        forwardEnv: ['ANTHROPIC_API_KEY'],
        env: { FOO: 'bar' },
        network: 'bridge',
        user: 'current',
        shmSize: '512m',
        unsafeDockerArgs: ['--cap-add=SYS_PTRACE'],
        setupCommands: ['default.sh'],
        cleanup: 'on-success',
        bridge: { install: true },
        workspace: { hostPath: '/host' },
      };

      const resolved = resolveSandboxConfig(defaultSandbox);

      expect(resolved).toStrictEqual(defaultSandbox);
      expect(resolved).not.toBe(defaultSandbox);
      expect(resolved?.mounts).not.toBe(defaultSandbox.mounts);
      expect(resolved?.env).not.toBe(defaultSandbox.env);
      expect(resolved?.bridge).not.toBe(defaultSandbox.bridge);
      expect(resolved?.workspace).not.toBe(defaultSandbox.workspace);
      expect(resolved?.unsafeDockerArgs).not.toBe(
        defaultSandbox.unsafeDockerArgs,
      );
      expect(resolved?.setupCommands).not.toBe(defaultSandbox.setupCommands);
    });

    it('returns a clone of the run config when no default is given', () => {
      const runSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'only-run:latest',
        unsafeDockerArgs: ['--cap-add=NET_ADMIN'],
      };

      const resolved = resolveSandboxConfig(undefined, runSandbox);

      expect(resolved).toStrictEqual(runSandbox);
      expect(resolved).not.toBe(runSandbox);
      expect(resolved?.unsafeDockerArgs).not.toBe(runSandbox.unsafeDockerArgs);
    });
  });

  describe('scalar merging', () => {
    it('lets run-level scalars override defaults while preserving missing keys', () => {
      const defaultSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'default:latest',
        workdir: '/workspace',
        network: 'bridge',
        user: 'current',
        shmSize: '512m',
        memory: '2g',
        envFile: '/host/default.env',
        cleanup: 'always',
      };
      const runSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'override:latest',
        cleanup: 'never',
      };

      const resolved = resolveSandboxConfig(defaultSandbox, runSandbox);

      expect(resolved).toMatchObject({
        type: 'docker',
        image: 'override:latest',
        workdir: '/workspace',
        network: 'bridge',
        user: 'current',
        shmSize: '512m',
        memory: '2g',
        envFile: '/host/default.env',
        cleanup: 'never',
      });
    });

    it('preserves runner-level memory and envFile when no run config is given', () => {
      const resolved = resolveSandboxConfig({
        type: 'docker',
        memory: '4g',
        envFile: '/host/runner.env',
      });

      expect(resolved).toMatchObject({
        type: 'docker',
        memory: '4g',
        envFile: '/host/runner.env',
      });
    });

    it('lets per-run memory and envFile override runner-level values', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', memory: '2g', envFile: '/host/runner.env' },
        { type: 'docker', memory: '8g', envFile: '/host/run.env' },
      );

      expect(resolved).toMatchObject({
        type: 'docker',
        memory: '8g',
        envFile: '/host/run.env',
      });
    });
  });

  describe('env merging', () => {
    it('merges env per-key with override winning', () => {
      const resolved = resolveSandboxConfig(
        {
          type: 'docker',
          env: { FOO: 'base', SHARED: 'base' },
        },
        {
          type: 'docker',
          env: { SHARED: 'override', BAR: 'override' },
        },
      );

      expect(resolved?.env).toStrictEqual({
        FOO: 'base',
        SHARED: 'override',
        BAR: 'override',
      });
    });

    it('deletes a default env key when the run sets it to undefined', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', env: { FOO: 'base', BAR: 'base' } },
        { type: 'docker', env: { FOO: undefined } },
      );

      expect(resolved?.env).toStrictEqual({ BAR: 'base' });
      expect(resolved?.env && 'FOO' in resolved.env).toBe(false);
    });
  });

  describe('array fields', () => {
    it('replaces mounts when the run config provides them', () => {
      const resolved = resolveSandboxConfig(
        {
          type: 'docker',
          mounts: [{ hostPath: '/a', containerPath: '/a' }],
        },
        {
          type: 'docker',
          mounts: [{ hostPath: '/b', containerPath: '/b', readOnly: true }],
        },
      );

      expect(resolved?.mounts).toStrictEqual([
        { hostPath: '/b', containerPath: '/b', readOnly: true },
      ]);
    });

    it('preserves default mounts when the run config omits them', () => {
      const defaultMounts = [{ hostPath: '/a', containerPath: '/a' }];

      const resolved = resolveSandboxConfig(
        { type: 'docker', mounts: defaultMounts },
        { type: 'docker', image: 'something:latest' },
      );

      expect(resolved?.mounts).toStrictEqual(defaultMounts);
      expect(resolved?.mounts).not.toBe(defaultMounts);
    });

    it('replaces setupCommands and unsafeDockerArgs on the run side', () => {
      const resolved = resolveSandboxConfig(
        {
          type: 'docker',
          setupCommands: ['default-setup.sh'],
          unsafeDockerArgs: ['--cap-add=SYS_PTRACE'],
        },
        {
          type: 'docker',
          setupCommands: ['run-setup.sh'],
          unsafeDockerArgs: ['--cap-add=NET_ADMIN'],
        },
      );

      expect(resolved?.setupCommands).toStrictEqual(['run-setup.sh']);
      expect(resolved?.unsafeDockerArgs).toStrictEqual(['--cap-add=NET_ADMIN']);
    });

    it('supports forwardEnv replacement, false disable, and default fallback', () => {
      const replaced = resolveSandboxConfig(
        { type: 'docker', forwardEnv: ['A', 'B'] },
        { type: 'docker', forwardEnv: ['C'] },
      );
      expect(replaced?.forwardEnv).toStrictEqual(['C']);

      const disabled = resolveSandboxConfig(
        { type: 'docker', forwardEnv: ['A'] },
        { type: 'docker', forwardEnv: false },
      );
      expect(disabled?.forwardEnv).toBe(false);

      const inherited = resolveSandboxConfig(
        { type: 'docker', forwardEnv: ['A'] },
        { type: 'docker' },
      );
      expect(inherited?.forwardEnv).toStrictEqual(['A']);

      const fromFalseDefault = resolveSandboxConfig(
        { type: 'docker', forwardEnv: false },
        { type: 'docker' },
      );
      expect(fromFalseDefault?.forwardEnv).toBe(false);
    });
  });

  describe('workspace merging', () => {
    it('shallow-merges workspace objects', () => {
      const resolved = resolveSandboxConfig(
        {
          type: 'docker',
          workspace: { hostPath: '/host', containerPath: '/workspace' },
        },
        {
          type: 'docker',
          workspace: { containerPath: '/code', readOnly: true },
        },
      );

      expect(resolved?.workspace).toStrictEqual({
        hostPath: '/host',
        containerPath: '/code',
        readOnly: true,
      });
    });

    it('disables workspace when the run sets it to false', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', workspace: { hostPath: '/host' } },
        { type: 'docker', workspace: false },
      );

      expect(resolved?.workspace).toBe(false);
    });

    it('preserves the default workspace when the run omits it', () => {
      const defaultWorkspace = { hostPath: '/host' };
      const resolved = resolveSandboxConfig(
        { type: 'docker', workspace: defaultWorkspace },
        { type: 'docker', image: 'override:latest' },
      );

      expect(resolved?.workspace).toStrictEqual(defaultWorkspace);
      expect(resolved?.workspace).not.toBe(defaultWorkspace);
    });

    it('clones the run workspace when the default disables it', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', workspace: false },
        { type: 'docker', workspace: { hostPath: '/host' } },
      );

      expect(resolved?.workspace).toStrictEqual({ hostPath: '/host' });
    });

    it('keeps workspace disabled when the default sets false and the run omits it', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', image: 'd', workspace: false },
        { type: 'docker', image: 'r' },
      );

      expect(resolved?.workspace).toBe(false);
    });

    it('uses the run workspace when the default omits it', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', image: 'd' },
        { type: 'docker', workspace: { hostPath: '/from-run' } },
      );

      expect(resolved?.workspace).toStrictEqual({ hostPath: '/from-run' });
    });
  });

  describe('bridge merging', () => {
    it('shallow-merges bridge config with override winning', () => {
      const resolved = resolveSandboxConfig(
        {
          type: 'docker',
          bridge: {
            install: true,
            nodeCommand: 'node',
            sdkVersion: '0.1.0',
          },
        },
        {
          type: 'docker',
          bridge: { nodeCommand: '/usr/local/bin/node', npmCommand: 'pnpm' },
        },
      );

      expect(resolved?.bridge).toStrictEqual({
        install: true,
        nodeCommand: '/usr/local/bin/node',
        npmCommand: 'pnpm',
        sdkVersion: '0.1.0',
      });
    });

    it('keeps base bridge when the run omits it', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', bridge: { install: true } },
        { type: 'docker', image: 'r' },
      );

      expect(resolved?.bridge).toStrictEqual({ install: true });
    });

    it('uses run bridge when the default omits it', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', image: 'd' },
        { type: 'docker', bridge: { nodeCommand: 'node' } },
      );

      expect(resolved?.bridge).toStrictEqual({ nodeCommand: 'node' });
    });
  });

  describe('env without override', () => {
    it('keeps base env when the run omits env', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', env: { FOO: 'base' } },
        { type: 'docker', image: 'r' },
      );

      expect(resolved?.env).toStrictEqual({ FOO: 'base' });
    });

    it('uses run env when the base omits env', () => {
      const resolved = resolveSandboxConfig(
        { type: 'docker', image: 'd' },
        { type: 'docker', env: { BAR: 'run' } },
      );

      expect(resolved?.env).toStrictEqual({ BAR: 'run' });
    });
  });

  describe('immutability', () => {
    it('does not mutate either input', () => {
      const defaultSandbox: DockerSandboxConfig = {
        type: 'docker',
        image: 'default:latest',
        mounts: [{ hostPath: '/a', containerPath: '/a' }],
        env: { FOO: 'base' },
        bridge: { install: true },
        workspace: { hostPath: '/host' },
        setupCommands: ['default.sh'],
        unsafeDockerArgs: ['--cap-add=SYS_PTRACE'],
        forwardEnv: ['ANTHROPIC_API_KEY'],
      };
      const runSandbox: DockerSandboxConfig = {
        type: 'docker',
        env: { BAR: 'run' },
        bridge: { nodeCommand: 'node' },
      };
      const defaultSnapshot = structuredClone(defaultSandbox);
      const runSnapshot = structuredClone(runSandbox);

      const resolved = resolveSandboxConfig(defaultSandbox, runSandbox);
      // Test data above guarantees these merged fields are present.
      const mergedMounts = resolved?.mounts as Exclude<
        DockerSandboxConfig['mounts'],
        undefined
      >;
      const mergedEnv = resolved?.env as Exclude<
        DockerSandboxConfig['env'],
        undefined
      >;
      const mergedBridge = resolved?.bridge as Exclude<
        DockerSandboxConfig['bridge'],
        undefined
      >;
      const mergedWorkspace = resolved?.workspace as Exclude<
        DockerSandboxConfig['workspace'],
        undefined | false
      >;

      // Mutating the resolved value must not bleed into the inputs.
      mergedMounts.push({ hostPath: '/z', containerPath: '/z' });
      mergedEnv.NEW = 'value';
      mergedBridge.npmCommand = 'pnpm';
      mergedWorkspace.readOnly = true;

      expect(defaultSandbox).toStrictEqual(defaultSnapshot);
      expect(runSandbox).toStrictEqual(runSnapshot);
    });
  });

  describe('type validation', () => {
    it('throws SandboxConfigurationError for an unknown default type', () => {
      const bogus = { type: 'firecracker' } as unknown as SandboxConfig;

      expect(() => resolveSandboxConfig(bogus)).toThrow(
        SandboxConfigurationError,
      );
    });

    it('throws SandboxConfigurationError for an unknown run type', () => {
      const bogus = { type: 'firecracker' } as unknown as SandboxConfig;

      expect(() => resolveSandboxConfig(undefined, bogus)).toThrow(
        SandboxConfigurationError,
      );
    });
  });
});
