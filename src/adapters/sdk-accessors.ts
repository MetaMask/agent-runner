/**
 * Safely casts an unknown value to a Record if it is a non-null object.
 *
 * @param input - The value to cast.
 * @returns The value as a Record, or undefined when not applicable.
 */
export function getRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }

  return input as Record<string, unknown>;
}

/**
 * Safely reads a string value, defaulting to an empty string.
 *
 * @param input - The value to read.
 * @returns The string value, or an empty string when non-string.
 */
export function getString(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

/**
 * Safely reads an optional string value.
 *
 * @param input - The value to read.
 * @returns The string value, or undefined when non-string.
 */
export function getOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

/**
 * Safely reads a numeric value, defaulting to zero.
 *
 * @param input - The value to read.
 * @returns The numeric value, or zero when non-number.
 */
export function getNumber(input: unknown): number {
  return typeof input === 'number' ? input : 0;
}

/**
 * Safely reads an optional numeric value.
 *
 * @param input - The value to read.
 * @returns The numeric value, or undefined when non-number.
 */
export function getOptionalNumber(input: unknown): number | undefined {
  return typeof input === 'number' ? input : undefined;
}

/**
 * Safely reads an array of strings from an unknown value.
 *
 * @param input - The value to read.
 * @returns The filtered string array, or undefined when input is not an array.
 */
export function getStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  return input.filter((value): value is string => typeof value === 'string');
}

/**
 * Returns a single-key object when the value is defined, or an empty object otherwise.
 *
 * Designed for use with object spread to conditionally include optional fields.
 *
 * @param key - The property key.
 * @param value - The value to include when defined.
 * @returns An object with the key-value pair, or an empty object.
 */
export function spreadOptional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [K in Key]: Value } | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as { [K in Key]: Value };
}
