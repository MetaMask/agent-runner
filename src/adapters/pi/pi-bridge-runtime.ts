import type { DockerBridgeRuntimeDescriptor } from '../../sandbox/docker/bridge.js';
import { PI_SDK_VERSION } from './pi-runtime.js';

/**
 * Runtime descriptor for the standalone Pi bridge.
 */
export const PI_BRIDGE_RUNTIME: DockerBridgeRuntimeDescriptor = {
  id: 'pi',
  packageName: '@earendil-works/pi-coding-agent',
  remoteBridgeFile: 'sandbox/container/pi-bridge.mjs',
  hostRoot: 'dist',
  files: [
    'adapters/pi/pi-runtime.mjs',
    'credential-redactor.mjs',
    'message-parser.mjs',
  ],
  /**
   * Returns the architecture-locked Pi version.
   *
   * @returns The locked Pi SDK version.
   */
  resolveVersion: () => PI_SDK_VERSION,
  minNodeVersion: '22.19.0',
  exactVersion: PI_SDK_VERSION,
};
