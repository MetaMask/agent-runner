import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveContainersForTesting,
  registerActiveContainer,
  resetCleanupRegistryForTesting,
  runSyncCleanupForTesting,
  setSyncRemoverForTesting,
  unregisterActiveContainer,
} from './cleanup-registry.js';

describe('cleanup-registry', () => {
  beforeEach(() => {
    resetCleanupRegistryForTesting();
  });

  afterEach(() => {
    resetCleanupRegistryForTesting();
  });

  it('registers and unregisters containers', () => {
    registerActiveContainer('a');
    registerActiveContainer('b');

    expect(getActiveContainersForTesting().sort()).toStrictEqual(['a', 'b']);

    unregisterActiveContainer('a');

    expect(getActiveContainersForTesting()).toStrictEqual(['b']);
  });

  it('treats double registration as idempotent', () => {
    registerActiveContainer('dup');
    registerActiveContainer('dup');

    expect(getActiveContainersForTesting()).toStrictEqual(['dup']);
  });

  it('treats unregistering an unknown container as a no-op', () => {
    expect(() => unregisterActiveContainer('not-tracked')).not.toThrow();
  });

  it('installs each shared process handler at most once across many registrations', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    for (let index = 0; index < 50; index += 1) {
      registerActiveContainer(`container-${index}`);
    }

    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
  });

  it('invokes the synchronous remover for each registered container during cleanup', () => {
    const removed: string[] = [];
    setSyncRemoverForTesting((name) => {
      removed.push(name);
    });

    registerActiveContainer('one');
    registerActiveContainer('two');

    runSyncCleanupForTesting();

    expect(removed.sort()).toStrictEqual(['one', 'two']);
    expect(getActiveContainersForTesting()).toStrictEqual([]);
  });

  it('uses the default synchronous remover (spawnSync docker rm -f) without throwing when not overridden', () => {
    // Register a name that is guaranteed to not exist; the default
    // remover wraps spawnSync in a try/catch so it must not throw even
    // when the docker binary is missing or the container is unknown.
    registerActiveContainer(
      `agent-runner-test-nonexistent-${process.pid}-${Date.now()}`,
    );

    expect(() => runSyncCleanupForTesting()).not.toThrow();
    expect(getActiveContainersForTesting()).toStrictEqual([]);
  });

  it('is a no-op when no containers are registered', () => {
    const calls: string[] = [];
    setSyncRemoverForTesting((name) => {
      calls.push(name);
    });

    runSyncCleanupForTesting();

    expect(calls).toStrictEqual([]);
  });

  it('runs the exit handler synchronously when the process emits exit', () => {
    const removed: string[] = [];
    setSyncRemoverForTesting((name) => {
      removed.push(name);
    });

    registerActiveContainer('exiting');
    process.emit('exit', 0);

    expect(removed).toStrictEqual(['exiting']);
  });

  it('runs the registered signal handler: cleanup, self-removal, and re-raise', () => {
    const removed: string[] = [];
    setSyncRemoverForTesting((name) => {
      removed.push(name);
    });

    const originalKill = process.kill.bind(process);
    const killSpy = vi.fn();
    // Replace process.kill so the re-raise inside the signal handler
    // does not actually terminate the test process.
    Object.defineProperty(process, 'kill', {
      value: killSpy,
      configurable: true,
    });

    try {
      registerActiveContainer('sig-clean');
      const sigintListeners = process.listeners('SIGINT');
      const handler = sigintListeners[sigintListeners.length - 1] as (
        signal: NodeJS.Signals,
      ) => void;
      expect(typeof handler).toBe('function');

      handler('SIGINT');

      expect(removed).toStrictEqual(['sig-clean']);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
      // The handler should have removed itself from the SIGINT listener
      // list, leaving the listener count back to its baseline.
      expect(process.listeners('SIGINT')).not.toContain(handler);
    } finally {
      Object.defineProperty(process, 'kill', {
        value: originalKill,
        configurable: true,
      });
    }
  });

  it('clears signal lifecycle state after the last installed signal handler removes itself', () => {
    const originalKill = process.kill.bind(process);
    const killSpy = vi.fn();
    Object.defineProperty(process, 'kill', {
      value: killSpy,
      configurable: true,
    });

    try {
      registerActiveContainer('sig-clean');
      const sigintListeners = process.listeners('SIGINT');
      const sigtermListeners = process.listeners('SIGTERM');
      const sigintHandler = sigintListeners[sigintListeners.length - 1] as (
        signal: NodeJS.Signals,
      ) => void;
      const sigtermHandler = sigtermListeners[sigtermListeners.length - 1] as (
        signal: NodeJS.Signals,
      ) => void;

      sigintHandler('SIGINT');
      sigtermHandler('SIGTERM');

      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');

      const before = {
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };

      registerActiveContainer('after-signal');

      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    } finally {
      Object.defineProperty(process, 'kill', {
        value: originalKill,
        configurable: true,
      });
    }
  });

  it('removes signal handlers when the registry becomes empty', () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    registerActiveContainer('temp');
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    unregisterActiveContainer('temp');

    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  });

  it('re-installs signal handlers after the registry becomes empty and a new container is registered', () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    registerActiveContainer('a');
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);

    unregisterActiveContainer('a');
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);

    registerActiveContainer('b');
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
  });

  it('does not re-raise the signal when pre-existing listeners exist', () => {
    const removed: string[] = [];
    setSyncRemoverForTesting((name) => {
      removed.push(name);
    });

    const preExistingListener = vi.fn();
    process.on('SIGINT', preExistingListener);

    const originalKill = process.kill.bind(process);
    const killSpy = vi.fn();
    Object.defineProperty(process, 'kill', {
      value: killSpy,
      configurable: true,
    });

    try {
      registerActiveContainer('no-reraise');
      const sigintListeners = process.listeners('SIGINT');
      const handler = sigintListeners[sigintListeners.length - 1] as (
        signal: NodeJS.Signals,
      ) => void;
      expect(typeof handler).toBe('function');

      handler('SIGINT');

      expect(removed).toStrictEqual(['no-reraise']);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'kill', {
        value: originalKill,
        configurable: true,
      });
      process.off('SIGINT', preExistingListener);
    }
  });

  it('removes installed handlers when reset for tests', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    registerActiveContainer('x');
    expect(process.listenerCount('exit')).toBe(before.exit + 1);

    resetCleanupRegistryForTesting();

    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(getActiveContainersForTesting()).toStrictEqual([]);
  });

  it('installs signal handlers only after first registerActiveContainer', () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    registerActiveContainer('first');

    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
  });

  it('removes signal handlers when registry becomes empty via unregisterActiveContainer', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    registerActiveContainer('x');
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    unregisterActiveContainer('x');

    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  });

  it('does not re-raise the signal when other listeners existed at install time', () => {
    const removed: string[] = [];
    setSyncRemoverForTesting((name) => {
      removed.push(name);
    });

    const originalKill = process.kill.bind(process);
    const killSpy = vi.fn();
    Object.defineProperty(process, 'kill', {
      value: killSpy,
      configurable: true,
    });

    // eslint-disable-next-line no-empty-function
    const dummyListener = (): void => {};
    process.on('SIGINT', dummyListener);

    try {
      registerActiveContainer('sig-clean');
      const sigintListeners = process.listeners('SIGINT');
      const handler = sigintListeners[sigintListeners.length - 1] as (
        signal: NodeJS.Signals,
      ) => void;
      expect(typeof handler).toBe('function');

      handler('SIGINT');

      expect(removed).toStrictEqual(['sig-clean']);
      expect(killSpy).not.toHaveBeenCalled();
      expect(process.listeners('SIGINT')).toContain(handler);
    } finally {
      Object.defineProperty(process, 'kill', {
        value: originalKill,
        configurable: true,
      });
      process.off('SIGINT', dummyListener);
    }
  });
});
