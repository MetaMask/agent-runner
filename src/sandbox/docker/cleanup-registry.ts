import { spawnSync } from 'node:child_process';

/**
 * Process-wide registry of containers that the lifecycle module has
 * started and is still tracking. Used as a last-resort safety net so an
 * abnormally terminated host process does not leak `docker` containers.
 *
 * The registry deliberately avoids attaching one signal handler per
 * sandbox: each `signal` event in Node accumulates handlers until the
 * process exits, so a long-lived host that spawns thousands of runs
 * would leak listeners. Instead we install at most one handler per
 * signal, regardless of how many containers register.
 */

/**
 * Signals on which the cleanup registry attempts to remove any active
 * containers before re-raising the signal so the host process exits
 * with the expected status.
 */
const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** Set of currently registered container names. */
const activeContainers = new Set<string>();

/** Tracks whether the shared exit handler has been installed. */
let exitHandlerInstalled = false;

/** Tracks whether the shared signal handlers have been installed. */
let signalHandlersInstalled = false;

/** Handler attached to `process.exit` to run synchronous cleanup. */
let exitHandler: (() => void) | undefined;

/**
 * Signal handlers we installed, kept so they can be removed when the
 * registry is reset between tests or when active containers drain.
 */
const installedSignalHandlers = new Map<
  NodeJS.Signals,
  (signal: NodeJS.Signals) => void
>();

/**
 * Snapshots whether other listeners existed for each signal at the
 * moment we installed our handler. Used to decide whether to re-raise
 * the signal or defer to the host application's handlers.
 */
const signalHadOtherListeners = new Map<NodeJS.Signals, boolean>();

/**
 * Synchronous best-effort remover used by the process exit and signal
 * handlers. Tests override this to capture invocations without
 * shelling out to a real `docker` binary.
 *
 * @param containerName - Name of the container to remove.
 */
let syncRemover: (containerName: string) => void = defaultSyncRemover;

/**
 * Default {@link syncRemover} implementation: invokes
 * `docker rm -f <name>` synchronously, swallowing all errors.
 *
 * @param containerName - Name of the container to remove.
 */
function defaultSyncRemover(containerName: string): void {
  try {
    spawnSync('docker', ['rm', '-f', containerName], {
      stdio: 'ignore',
    });
  } catch {
    // Intentionally ignored: best-effort safety net only.
  }
}

/**
 * Adds a container name to the active registry and installs the
 * shared process cleanup handlers on first use.
 *
 * Calling `registerActiveContainer` multiple times with the same name
 * is a no-op; the container is tracked exactly once.
 *
 * @param containerName - Name of the running container to track.
 */
export function registerActiveContainer(containerName: string): void {
  installExitHandlerOnce();
  installSignalHandlers();
  activeContainers.add(containerName);
}

/**
 * Removes a container name from the registry. Safe to call for
 * unknown names; the call is a no-op in that case.
 *
 * @param containerName - Name of the container to drop.
 */
export function unregisterActiveContainer(containerName: string): void {
  activeContainers.delete(containerName);
  if (activeContainers.size === 0) {
    removeSignalHandlers();
  }
}

/**
 * Returns a snapshot of the currently registered container names.
 * Intended for tests; not part of the runtime API.
 *
 * @returns A new array containing the current registry contents.
 */
export function getActiveContainersForTesting(): string[] {
  return [...activeContainers];
}

/**
 * Resets the registry to its initial state and removes any signal/exit
 * handlers we installed. Intended for tests so each case starts from a
 * clean slate; never called by production code.
 */
export function resetCleanupRegistryForTesting(): void {
  activeContainers.clear();

  if (exitHandler) {
    process.off('exit', exitHandler);
    exitHandler = undefined;
  }
  exitHandlerInstalled = false;

  for (const [signal, handler] of installedSignalHandlers) {
    process.off(signal, handler);
  }
  installedSignalHandlers.clear();
  signalHadOtherListeners.clear();
  signalHandlersInstalled = false;

  syncRemover = defaultSyncRemover;
}

/**
 * Overrides the synchronous container remover used by the shared
 * process handlers. Intended for tests; never call from production
 * code.
 *
 * @param remover - Replacement remover function.
 */
export function setSyncRemoverForTesting(
  remover: (containerName: string) => void,
): void {
  syncRemover = remover;
}

/**
 * Invokes the best-effort synchronous cleanup path used by the
 * registry's process handlers. Intended for tests so the cleanup path
 * can be exercised without sending a real signal to the host process.
 */
export function runSyncCleanupForTesting(): void {
  runSyncCleanup();
}

/**
 * Installs the shared `process.on('exit')` handler exactly once for
 * the lifetime of the process (or until the registry is reset for
 * tests). Subsequent calls return immediately.
 */
function installExitHandlerOnce(): void {
  if (exitHandlerInstalled) {
    return;
  }
  exitHandlerInstalled = true;

  /**
   * Process exit handler that drains the synchronous cleanup queue
   * before the Node.js runtime tears down.
   */
  exitHandler = (): void => {
    runSyncCleanup();
  };
  process.on('exit', exitHandler);
}

/**
 * Creates a signal handler that runs synchronous cleanup before deciding
 * whether to remove itself and re-raise the signal.
 *
 * @returns A signal handler suitable for `process.on(signal, handler)`.
 */
function createSignalHandler(): (received: NodeJS.Signals) => void {
  /**
   * @param received - The signal that triggered the handler.
   */
  const handler = (received: NodeJS.Signals): void => {
    const hadOthers = signalHadOtherListeners.get(received) ?? false;
    runSyncCleanup();
    if (hadOthers) {
      return;
    }
    process.off(received, handler);
    installedSignalHandlers.delete(received);
    if (installedSignalHandlers.size === 0) {
      signalHandlersInstalled = false;
      signalHadOtherListeners.clear();
    }
    process.kill(process.pid, received);
  };
  return handler;
}

/**
 * Installs the shared SIGINT and SIGTERM handlers when they are not
 * already present. Callers must pair this with `removeSignalHandlers()`
 * when the container registry becomes empty.
 */
function installSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;

  for (const signal of HANDLED_SIGNALS) {
    const hadOtherListeners = process.listenerCount(signal) > 0;
    signalHadOtherListeners.set(signal, hadOtherListeners);

    const handler = createSignalHandler();
    process.on(signal, handler);
    installedSignalHandlers.set(signal, handler);
  }
}

/**
 * Removes the shared SIGINT and SIGTERM handlers from the process.
 * Safe to call even when handlers are not currently installed.
 */
function removeSignalHandlers(): void {
  if (!signalHandlersInstalled) {
    return;
  }
  for (const [signal, handler] of installedSignalHandlers) {
    process.off(signal, handler);
  }
  installedSignalHandlers.clear();
  signalHadOtherListeners.clear();
  signalHandlersInstalled = false;
}

/**
 * Best-effort synchronous cleanup of any registered containers. Used
 * by the process exit/signal handlers above; callers should prefer
 * the async lifecycle's `close()` method which routes through the
 * injectable command runner.
 *
 * Failures are swallowed: at this point the process is going away and
 * the registry has no useful place to surface errors.
 */
function runSyncCleanup(): void {
  if (activeContainers.size === 0) {
    return;
  }
  const names = [...activeContainers];
  activeContainers.clear();
  for (const name of names) {
    syncRemover(name);
  }
}
