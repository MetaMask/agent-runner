import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from '@langfuse/tracing';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { resolveTelemetryConfig } from './env.js';
import { TelemetryConfigurationError } from './errors.js';
import type {
  AgentRunTelemetryAttributes,
  TelemetryConfig,
  TelemetryLifecycle,
} from './types.js';

/**
 *
 */
export type ObservationContext = {
  /**
   *
   */
  recordError: (error: Error) => void;
};

/**
 *
 */
export type TelemetryController = TelemetryLifecycle & {
  /**
   *
   */
  runWithObservation: <Result>(
    attributes: AgentRunTelemetryAttributes | undefined,
    callback: (observation: ObservationContext) => Promise<Result>,
  ) => Promise<Result>;
};

const noopObservation: ObservationContext = {
  /**
   * No-op error recorder.
   *
   * @returns undefined.
   */
  recordError: () => undefined,
};

/**
 * Creates a no-op telemetry controller when telemetry is disabled.
 *
 * @returns A telemetry controller that performs no operations.
 */
function noopTelemetryController(): TelemetryController {
  return {
    enabled: false,
    /**
     * No-op flush.
     *
     * @returns A resolved promise.
     */
    flush: async () => undefined,
    /**
     * No-op shutdown.
     *
     * @returns A resolved promise.
     */
    shutdown: async () => undefined,
    /**
     * Passes through to the callback without observation.
     *
     * @param _attributes - Telemetry attributes (ignored).
     * @param callback - The callback to invoke.
     * @returns The callback result.
     */
    runWithObservation: async (_attributes, callback) =>
      callback(noopObservation),
  };
}

/**
 *
 */
type SharedTelemetryInfra = {
  /**
   *
   */
  sdk: NodeSDK;
  /**
   *
   */
  spanProcessor: LangfuseSpanProcessor;
  /**
   *
   */
  refCount: number;
  /**
   *
   */
  isShutdown: boolean;
};

let sharedInfra: SharedTelemetryInfra | undefined;
let sharedConfigKey: string | undefined;

/**
 * Derives a unique key for identifying a telemetry configuration.
 *
 * @param publicKey - The Langfuse public key.
 * @param baseUrl - The Langfuse base URL.
 * @param serviceName - The service name.
 * @returns A string key combining the configuration values.
 */
function deriveConfigKey(
  publicKey: string,
  baseUrl: string,
  serviceName: string,
): string {
  return `${publicKey}|${baseUrl}|${serviceName}`;
}

/**
 * Acquires or reuses shared telemetry infrastructure.
 *
 * @param config - The telemetry configuration.
 * @returns The shared telemetry infrastructure.
 */
function acquireTelemetryInfra(
  config: TelemetryConfig | undefined,
): SharedTelemetryInfra {
  const resolved = resolveTelemetryConfig(config);
  const key = deriveConfigKey(
    resolved.publicKey,
    resolved.baseUrl,
    resolved.serviceName,
  );

  if (sharedInfra && !sharedInfra.isShutdown) {
    if (sharedConfigKey !== key) {
      throw new TelemetryConfigurationError(
        'Telemetry infrastructure already exists with a different configuration. ' +
          'Shutdown existing runners before creating one with a different Langfuse project.',
      );
    }
    sharedInfra.refCount += 1;
    return sharedInfra;
  }

  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: resolved.publicKey,
    secretKey: resolved.secretKey,
    baseUrl: resolved.baseUrl,
  });
  // NodeSDK.start() mutates global OTel state (TracerProvider, ContextManager,
  // Propagator, etc.). This follows the canonical Langfuse integration pattern
  // for Claude Agent SDK and is appropriate for single-process eval scripts.
  //
  // If this package is later embedded inside a host app with its own OTel setup,
  // replace NodeSDK with NodeTracerProvider + setLangfuseTracerProvider() from
  // @langfuse/tracing to avoid overwriting the host's global providers.
  // See: https://langfuse.com/faq/all/existing-otel-setup
  const sdk = new NodeSDK({
    serviceName: resolved.serviceName,
    spanProcessors: [spanProcessor],
    resource: resourceFromAttributes({
      ...resolved.resourceAttributes,
      'service.name': resolved.serviceName,
    }),
  });

  sdk.start();

  sharedConfigKey = key;
  sharedInfra = { sdk, spanProcessor, refCount: 1, isShutdown: false };
  return sharedInfra;
}

/**
 * Creates a telemetry controller for tracing agent runs.
 *
 * @param config - The telemetry configuration.
 * @returns A telemetry controller, either active or no-op depending on the config.
 */
export function createTelemetryController(
  config: TelemetryConfig | undefined,
): TelemetryController {
  if (config?.mode !== 'enabled') {
    return noopTelemetryController();
  }

  const infra = acquireTelemetryInfra(config);
  let isShutdown = false;

  return {
    enabled: true,
    /**
     *
     */
    flush: async (): Promise<void> => {
      if (isShutdown) {
        return;
      }
      await infra.spanProcessor.forceFlush();
    },
    /**
     *
     */
    shutdown: async (): Promise<void> => {
      if (isShutdown) {
        return;
      }
      isShutdown = true;
      infra.refCount -= 1;
      if (infra.refCount <= 0) {
        infra.isShutdown = true;
        sharedInfra = undefined;
        await infra.sdk.shutdown();
      }
    },
    /**
     * Runs a callback within a Langfuse observation span.
     *
     * @param attributes - Telemetry attributes for the trace.
     * @param callback - The callback to invoke within the observation.
     * @returns The callback result.
     */
    runWithObservation: async <Result>(
      attributes: AgentRunTelemetryAttributes | undefined,
      callback: (observation: ObservationContext) => Promise<Result>,
    ): Promise<Result> => {
      if (!attributes) {
        return callback(noopObservation);
      }

      return startActiveObservation(
        attributes.traceName ?? 'agent-run',
        async () =>
          propagateAttributes(
            {
              ...(attributes.userId !== undefined && {
                userId: attributes.userId,
              }),
              ...(attributes.sessionId !== undefined && {
                sessionId: attributes.sessionId,
              }),
              ...(attributes.metadata !== undefined && {
                metadata: attributes.metadata,
              }),
              ...(attributes.tags !== undefined && { tags: attributes.tags }),
              ...(attributes.version !== undefined && {
                version: attributes.version,
              }),
            },
            async () =>
              callback({
                /**
                 * Records an error on the active observation and span.
                 *
                 * @param error - The error to record.
                 */
                recordError: (error: Error) => {
                  updateActiveObservation({
                    level: 'ERROR',
                    statusMessage: error.message,
                  });
                  const activeSpan = trace.getActiveSpan();
                  if (activeSpan) {
                    activeSpan.setStatus({
                      code: SpanStatusCode.ERROR,
                      message: error.message,
                    });
                    activeSpan.recordException(error);
                  }
                },
              }),
          ),
      );
    },
  };
}
