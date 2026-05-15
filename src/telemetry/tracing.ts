import { propagateAttributes, startObservation } from '@langfuse/tracing';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

/**
 * Handle for updating and closing a Langfuse observation span.
 *
 * Structural subset of the Langfuse `LangfuseBaseObservation` public API.
 * Langfuse observation objects returned by `startObservation()` satisfy this
 * interface, so no casts are needed at assignment sites.
 */
export type SpanHandle = {
  /** The trace ID from the OpenTelemetry span context. */
  traceId: string;
  /** The underlying OpenTelemetry span. */
  readonly otelSpan: Span;
  /**
   * Updates the span attributes.
   *
   * @param attrs - Attributes to apply to the span.
   * @returns The updated span handle.
   */
  update: (attrs: Record<string, unknown>) => SpanHandle;
  /**
   * Ends the span.
   *
   * @returns undefined.
   */
  end: () => void;
  /**
   * Starts a child observation span.
   *
   * @param name - The observation name.
   * @param attrs - Attributes to attach to the observation.
   * @param opts - Langfuse observation options.
   * @returns The child span handle.
   */
  startObservation: (
    name: string,
    attrs?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => SpanHandle;
};

/**
 * Attributes propagated to Langfuse traces via trace context.
 */
export type TraceAttributes = {
  /** Langfuse session identifier. */
  sessionId: string | undefined;
  /** User identifier for trace attribution. */
  userId: string;
  /** Arbitrary metadata attached to the trace. */
  metadata?: Record<string, string> | undefined;
  /** Tags for trace filtering and categorisation. */
  tags?: string[] | undefined;
  /** Application version for the trace. */
  version?: string | undefined;
};

let processor: { forceFlush(): Promise<void> } | undefined;

/**
 * Sets the Langfuse span processor used to enable tracing helpers.
 *
 * @param newProcessor - The Langfuse processor instance, or undefined to disable tracing.
 */
export function setLangfuseProcessor(newProcessor: typeof processor): void {
  processor = newProcessor;
}

/**
 * Checks whether tracing has been configured.
 *
 * @returns Whether a Langfuse processor is available.
 */
export function isTracingEnabled(): boolean {
  return Boolean(processor);
}

/**
 * Runs a callback with Langfuse trace propagation attributes.
 *
 * @param attrs - The trace attributes to propagate.
 * @param fn - The callback to run within the trace context.
 */
export function traceSpan(attrs: TraceAttributes, fn: () => void): void {
  if (!processor || !attrs.sessionId) {
    return;
  }

  try {
    const propagated: Record<string, unknown> = {
      sessionId: attrs.sessionId,
      userId: attrs.userId,
    };
    if (attrs.metadata !== undefined) {
      propagated.metadata = attrs.metadata;
    }
    if (attrs.tags !== undefined) {
      propagated.tags = attrs.tags;
    }
    if (attrs.version !== undefined) {
      propagated.version = attrs.version;
    }
    propagateAttributes(propagated, fn);
  } catch {
    // Fire-and-forget tracing should not affect agent execution.
  }
}

/**
 * Creates the root Langfuse observation for an agent session.
 *
 * @param traceName - The name for the root observation.
 * @param prompt - The prompt used to start the agent session.
 * @param metadata - Metadata to attach to the session observation.
 * @param redact - Whether to redact the prompt from tracing input.
 * @returns The root span and trace identifier, or undefined when tracing is disabled.
 */
export function createSessionSpan(
  traceName: string,
  prompt: string,
  metadata: Record<string, unknown>,
  redact: boolean,
):
  | {
      /**
       *
       */
      span: SpanHandle;
      /**
       *
       */
      traceId: string;
    }
  | undefined {
  if (!processor) {
    return undefined;
  }

  const obs = startObservation(
    traceName,
    { input: redact ? '[REDACTED]' : prompt, metadata },
    { asType: 'agent' },
  );

  return { span: obs, traceId: obs.traceId };
}

/**
 * Sets OpenTelemetry attributes on a Langfuse span's underlying OTel span.
 *
 * @param span - The span whose OTel attributes should be updated.
 * @param attrs - Attributes to set on the underlying OTel span.
 */
export function setOtelAttrs(
  span: SpanHandle,
  attrs: Record<string, string | number | boolean | undefined>,
): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      span.otelSpan.setAttribute(key, value);
    }
  }
}

/**
 * Records an error on a Langfuse span and its underlying OTel span.
 *
 * @param span - The span to record the error on.
 * @param error - The error to record.
 */
export function recordSpanError(span: SpanHandle, error: Error): void {
  span.otelSpan.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });
  span.otelSpan.recordException(error);
}

/**
 * Flushes pending Langfuse tracing spans.
 *
 * @returns A promise that resolves once tracing has been flushed.
 */
export async function flushTracing(): Promise<void> {
  await processor?.forceFlush();
}
