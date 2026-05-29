import { DockerSandboxError } from '../../errors.js';

/**
 * Maximum number of characters included in a stderr excerpt inside
 * error messages. Longer output is truncated with an ellipsis.
 */
export const STDERR_EXCERPT_LIMIT = 2000;

/**
 * Type guard recognising plain (object-literal) records.
 *
 * @param value - Value to test.
 * @returns Whether `value` is a non-null object whose prototype is
 * `Object.prototype` or `null`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Formats a bounded stderr excerpt suitable for inclusion in error
 * messages. Returns an empty string when stderr is empty.
 *
 * @param stderr - Captured stderr text.
 * @returns The formatted excerpt (with leading newline) or `''`.
 */
export function formatStderrExcerpt(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.length <= STDERR_EXCERPT_LIMIT) {
    return `\nstderr: ${trimmed}`;
  }
  return `\nstderr (truncated): ${trimmed.slice(0, STDERR_EXCERPT_LIMIT)}…`;
}

/**
 * Wraps an arbitrary thrown value in a {@link DockerSandboxError} with
 * the supplied message prefix, preserving the underlying cause.
 *
 * When `cause` is already a {@link DockerSandboxError}, the wrapped
 * error chains the messages so the full context is visible.
 *
 * @param prefix - Human-readable description of what failed.
 * @param cause - Original error (or arbitrary thrown value).
 * @returns The wrapped error.
 */
export function wrapDockerSandboxError(
  prefix: string,
  cause: unknown,
): DockerSandboxError {
  if (cause instanceof DockerSandboxError) {
    return new DockerSandboxError(`${prefix}: ${cause.message}`, { cause });
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new DockerSandboxError(
    `${prefix}: ${reason}`,
    cause instanceof Error ? { cause } : undefined,
  );
}
