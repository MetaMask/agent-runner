import { describe, expect, it } from 'vitest';

import {
  AgentRunnerError,
  DockerSandboxError,
  DockerSandboxProtocolError,
  SandboxConfigurationError,
} from '../errors.js';
import {
  DEFAULT_DOCKER_SANDBOX_FORWARD_ENV,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH,
} from './types.js';

describe('sandbox default constants', () => {
  it('exposes the default Docker sandbox image', () => {
    expect(DEFAULT_DOCKER_SANDBOX_IMAGE).toBe('docker/sandbox-templates:shell');
  });

  it('exposes the default workspace mount path', () => {
    expect(DEFAULT_DOCKER_SANDBOX_WORKSPACE_PATH).toBe('/workspace');
  });

  it('forwards common Claude/auth/proxy environment variables by default', () => {
    expect(DEFAULT_DOCKER_SANDBOX_FORWARD_ENV).toStrictEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
    ]);
  });
});

describe('sandbox error classes', () => {
  it('exposes SandboxConfigurationError extending AgentRunnerError', () => {
    const cause = new Error('bad type');
    const error = new SandboxConfigurationError('boom', { cause });

    expect(error).toBeInstanceOf(AgentRunnerError);
    expect(error).toBeInstanceOf(SandboxConfigurationError);
    expect(error.name).toBe('SandboxConfigurationError');
    expect(error.message).toBe('boom');
    expect(error.cause).toBe(cause);
  });

  it('exposes DockerSandboxError extending AgentRunnerError', () => {
    const error = new DockerSandboxError('container exploded');

    expect(error).toBeInstanceOf(AgentRunnerError);
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect(error.name).toBe('DockerSandboxError');
    expect(error.message).toBe('container exploded');
  });

  it('exposes DockerSandboxProtocolError extending DockerSandboxError', () => {
    const cause = new Error('decode failed');
    const error = new DockerSandboxProtocolError('bad frame', { cause });

    expect(error).toBeInstanceOf(AgentRunnerError);
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect(error).toBeInstanceOf(DockerSandboxProtocolError);
    expect(error.name).toBe('DockerSandboxProtocolError');
    expect(error.cause).toBe(cause);
  });
});
