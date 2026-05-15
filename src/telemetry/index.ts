export { createTelemetryController } from './controller.js';
export type { TelemetryController } from './controller.js';
export { createMessageHandler } from './message-handler.js';
export type {
  MessageHandler,
  MessageHandlerConfig,
  MessageHandlerState,
} from './message-handler.js';
export {
  createSessionSpan,
  flushTracing,
  isTracingEnabled,
  recordSpanError,
  setLangfuseProcessor,
  setOtelAttrs,
  traceSpan,
} from './tracing.js';
export type { SpanHandle, TraceAttributes } from './tracing.js';
export { isTelemetryEnabled, resolveTelemetryConfig } from './env.js';
export type { ResolvedTelemetryConfig } from './env.js';
