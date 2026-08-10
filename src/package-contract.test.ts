import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import-x/no-useless-path-segments
import { createHarnessAdapter } from './index.js';
import { PI_BRIDGE_SDK_VERSION } from './sandbox/docker/bridge.js';

describe('package contract', () => {
  it('keeps Pi pin, engine, and descriptor version in lockstep', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      engines: { node: string };
    };
    expect(pkg.dependencies['@earendil-works/pi-coding-agent']).toBe('0.83.0');
    expect(PI_BRIDGE_SDK_VERSION).toBe('0.83.0');
    expect(pkg.engines.node).toBe('^22.19.0 || >=24');
  });

  it('selects both public built-in harnesses', () => {
    expect(createHarnessAdapter('claude').name).toBe('claude');
    expect(createHarnessAdapter('pi').name).toBe('pi');
  });
});
