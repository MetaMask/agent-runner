import { LangfuseSpanProcessor } from '@langfuse/otel';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { resolveTelemetryConfig } from './env.js';
import { TelemetryConfigurationError } from './errors.js';
import { setLangfuseProcessor } from './tracing.js';
import type { TelemetryConfig, TelemetryLifecycle } from './types.js';

/**
 * Extended telemetry lifecycle with redaction support.
 */
export type TelemetryController = TelemetryLifecycle & {
  /**
   * Whether redaction is enabled.
   */
  redact: boolean;
};

/**
 * Creates a no-op telemetry controller when telemetry is disabled.
 *
 * @param config - Optional telemetry configuration.
 * @returns A telemetry controller that performs no operations.
 */
function noopTelemetryController(
  config?: TelemetryConfig,
): TelemetryController {
  return {
    enabled: false,
    redact: config?.redact ?? false,
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
  };
}

/**
 * Shared OTel/Langfuse infrastructure reused across runners with matching config.
 */
type SharedTelemetryInfra = {
  /** The OpenTelemetry Node SDK instance. */
  sdk: NodeSDK;
  /** The Langfuse span processor attached to the SDK. */
  spanProcessor: LangfuseSpanProcessor;
  /** Number of active runners sharing this infrastructure. */
  refCount: number;
  /** Whether the infrastructure has been shut down. */
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
    return noopTelemetryController(config);
  }

  const infra = acquireTelemetryInfra(config);
  setLangfuseProcessor(infra.spanProcessor);
  let isShutdown = false;

  return {
    enabled: true,
    redact: config.redact ?? false,
    /**
     * Force-flushes pending spans to the Langfuse backend.
     */
    flush: async (): Promise<void> => {
      if (isShutdown) {
        return;
      }
      await infra.spanProcessor.forceFlush();
    },
    /**
     * Decrements the shared infra ref count and shuts down when zero.
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
        sharedConfigKey = undefined;
        setLangfuseProcessor(undefined);
        await infra.sdk.shutdown();
      }
    },
  };
}
