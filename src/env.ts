import { TelemetryConfigurationError } from './errors.js';
import type { TelemetryConfig } from './types.js';

/**
 * Fully resolved Langfuse telemetry configuration with all required fields.
 */
export type ResolvedTelemetryConfig = {
  /** Langfuse public key for authentication. */
  publicKey: string;
  /** Langfuse secret key for authentication. */
  secretKey: string;
  /** Langfuse API base URL. */
  baseUrl: string;
  /** OpenTelemetry service name for resource tagging. */
  serviceName: string;
  /** Additional OpenTelemetry resource attributes. */
  resourceAttributes: Record<string, string | number | boolean>;
};

/**
 * Checks whether telemetry is enabled in the given configuration.
 *
 * @param config - The telemetry configuration to check.
 * @returns Whether the telemetry mode is set to 'enabled'.
 */
export function isTelemetryEnabled(
  config: TelemetryConfig | undefined,
): boolean {
  return config?.mode === 'enabled';
}

/**
 * Resolves and validates Langfuse telemetry configuration from explicit config
 * and environment variables.
 *
 * @param config - The telemetry configuration provided by the caller.
 * @param env - The process environment for fallback variable lookup.
 * @returns The fully resolved telemetry configuration.
 */
export function resolveTelemetryConfig(
  config: TelemetryConfig | undefined,
  // eslint-disable-next-line no-restricted-globals
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTelemetryConfig {
  const publicKey =
    (config?.publicKey ?? env.LANGFUSE_PUBLIC_KEY)?.trim() ?? undefined;
  const secretKey =
    (config?.secretKey ?? env.LANGFUSE_SECRET_KEY)?.trim() ?? undefined;
  const baseUrl =
    (config?.baseUrl ?? env.LANGFUSE_BASE_URL)?.trim() ?? undefined;

  const missing = [
    ['LANGFUSE_PUBLIC_KEY', publicKey],
    ['LANGFUSE_SECRET_KEY', secretKey],
    ['LANGFUSE_BASE_URL', baseUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new TelemetryConfigurationError(
      `Telemetry is enabled but required Langfuse configuration is missing: ${missing.join(', ')}`,
    );
  }

  if (!publicKey || !secretKey || !baseUrl) {
    throw new TelemetryConfigurationError(
      'Telemetry configuration could not be resolved.',
    );
  }

  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    throw new TelemetryConfigurationError(
      `LANGFUSE_BASE_URL is not a valid URL: ${baseUrl}`,
    );
  }

  return {
    publicKey,
    secretKey,
    baseUrl,
    serviceName: config?.serviceName ?? 'metamask-agent-runner',
    resourceAttributes: config?.resourceAttributes ?? {},
  };
}
