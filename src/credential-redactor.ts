/**
 * Collects configured credential values without imposing a minimum length.
 *
 * @param env - Credential-bearing environment.
 * @returns A value-level string scrubber.
 */
export function createCredentialScrubber(
  env: Record<string, string | undefined> = process.env,
): (text: string) => string {
  const values = [
    ...new Set(
      Object.entries(env)
        .filter(
          ([key, value]) =>
            /key|token|secret|password|authorization/iu.test(key) &&
            Boolean(value),
        )
        .map(([, value]) => value as string),
    ),
  ].sort((a, b) => b.length - a.length);
  if (values.length === 0) {
    return (text) => text;
  }
  const pattern = new RegExp(
    values
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|'),
    'gu',
  );
  return (text) => text.replace(pattern, '[REDACTED]');
}

/**
 * Copies errors and JSON-like values while scrubbing every string, including causes.
 *
 * @param value - Value leaving an execution boundary.
 * @param scrub - Credential or caller-provided scrubber.
 * @param seen - Already copied objects, including cyclic error causes.
 * @returns A scrubbed copy with the original error name preserved.
 */
export function scrubCredentials<Value>(
  value: Value,
  scrub: (text: string) => string,
  seen = new WeakMap<object, unknown>(),
): Value {
  if (typeof value === 'string') {
    return scrub(value) as Value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value) as Value;
  }
  if (value instanceof Error) {
    const result = new Error(scrub(value.message));
    Object.setPrototypeOf(result, Object.getPrototypeOf(value));
    seen.set(value, result);
    Object.defineProperty(result, 'name', {
      value: scrub(value.name),
      configurable: true,
      writable: true,
    });
    if (value.stack !== undefined) {
      result.stack = scrub(value.stack);
    }
    if (value.cause !== undefined) {
      result.cause = scrubCredentials(value.cause, scrub, seen);
    }
    return result as Value;
  }
  const result: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: scrubCredentials(entry, scrub, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result as Value;
}
