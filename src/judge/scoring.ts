import { LangfuseClient } from '@langfuse/client';

import { resolveTelemetryConfig } from '../telemetry/env.js';
import type { TelemetryConfig } from '../types.js';
import type { ScoreEntry } from './types.js';

/**
 * Posts scores to Langfuse via the official SDK client.
 *
 * No-op when telemetry is disabled, the trace ID is missing, or the
 * scores array is empty. Failures are silently swallowed to match the
 * best-effort telemetry contract of the runner.
 *
 * @param traceId - The Langfuse trace identifier to attach scores to.
 * @param scores - Score entries to post.
 * @param telemetryConfig - The telemetry configuration with Langfuse credentials.
 */
export async function postScores(
  traceId: string | undefined,
  scores: ScoreEntry[],
  telemetryConfig: TelemetryConfig | undefined,
): Promise<void> {
  if (telemetryConfig?.mode !== 'enabled' || !traceId || scores.length === 0) {
    return;
  }

  const resolved = resolveTelemetryConfig(telemetryConfig);

  const langfuse = new LangfuseClient({
    publicKey: resolved.publicKey,
    secretKey: resolved.secretKey,
    baseUrl: resolved.baseUrl,
  });

  try {
    for (const score of scores) {
      langfuse.score.create({
        traceId,
        name: score.name,
        value: score.value,
        ...(score.comment === undefined ? {} : { comment: score.comment }),
      });
    }

    await langfuse.flush();
  } catch {
    // Best-effort scoring; failures must not crash the caller.
  } finally {
    await langfuse.shutdown().catch(() => undefined);
  }
}
