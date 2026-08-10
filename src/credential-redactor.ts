/**
 * Provider-agnostic, always-on credential value redactor.
 *
 * Unlike {@link redactSensitive} (which redacts object *values* by matching
 * their *key names*), this module scrubs the exact secret *values* of known
 * provider credentials wherever they appear in free text — tool output,
 * generation text, judge transcripts, and bridge error messages.
 *
 * This closes the passive-leak vector where a model-controlled tool prints a
 * forwarded credential (e.g. `echo "$LITELLM_API_KEY"`) and the raw value then
 * flows into a telemetry span or a second (judge) model call. It runs
 * regardless of the telemetry `redact` flag because the judge transcript is an
 * egress channel independent of telemetry, and because full-fidelity traces
 * (`redact: false`) are the common case the value-level redactor was built for.
 *
 * The scrubber only ever removes exact substring matches of concrete secret
 * values read from the environment; it never alters surrounding structure, so
 * it is safe to apply broadly.
 */

/** Replacement token substituted in place of a recognized credential value. */
export const CREDENTIAL_REDACTION_PLACEHOLDER = '[REDACTED_CREDENTIAL]';

/**
 * Environment variable names whose values are treated as secret credentials
 * and scrubbed from all free-text sinks. Covers both provider adapters.
 *
 * `*_BASE_URL` entries are intentionally excluded: they are endpoints (not
 * secrets), are useful for debugging, and scrubbing them would corrupt error
 * messages. Only reusable keys/tokens are listed.
 */
export const CREDENTIAL_ENV_VARS: readonly string[] = [
  // Pi / LiteLLM
  'LITELLM_API_KEY',
  // Claude / Anthropic
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * Minimum length for an environment value to be treated as a scrubbable
 * secret. Guards against scrubbing accidental short values (e.g. a key set to
 * `"x"` in a test) that would mangle unrelated text.
 */
const MIN_SECRET_LENGTH = 8;

/** A function that scrubs recognized credential values from a string. */
export type CredentialScrubber = (text: string) => string;

/**
 * No-op scrubber used when no credentials are present in the environment.
 *
 * @param text - The input string.
 * @returns The input string unchanged.
 */
const identityScrubber: CredentialScrubber = (text) => text;

/**
 * Collects the concrete secret values to scrub from an environment source.
 *
 * @param env - Environment source to read credential values from.
 * @returns Unique, sufficiently-long secret values, longest-first so that
 *   overlapping secrets are replaced before any of their substrings.
 */
function collectSecretValues(
  env: Record<string, string | undefined>,
): string[] {
  const values = new Set<string>();
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      values.add(value);
    }
  }
  return [...values].sort((first, second) => second.length - first.length);
}

/**
 * Escapes a string for safe use as a literal inside a regular expression.
 *
 * @param value - Raw secret value.
 * @returns The regex-escaped value.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Builds an always-on credential scrubber from an environment source.
 *
 * The scrubber is created once (typically per run) so it captures a stable
 * snapshot of the credential values. When no qualifying credentials are
 * present it returns a no-op, so callers pay no cost on unprotected runs.
 *
 * @param env - Environment source. Defaults to `process.env`.
 * @returns A function that replaces recognized credential values with
 *   {@link CREDENTIAL_REDACTION_PLACEHOLDER}.
 */
export function createCredentialScrubber(
  // eslint-disable-next-line no-restricted-globals -- Credentials are read from the ambient environment by design.
  env: Record<string, string | undefined> = process.env,
): CredentialScrubber {
  const secrets = collectSecretValues(env);
  if (secrets.length === 0) {
    return identityScrubber;
  }
  const pattern = new RegExp(secrets.map(escapeRegExp).join('|'), 'gu');
  return (text: string): string => {
    if (text.length === 0) {
      return text;
    }
    return text.replace(pattern, CREDENTIAL_REDACTION_PLACEHOLDER);
  };
}

/**
 * Composes a credential scrubber with an optional user-supplied redactor.
 *
 * The credential scrubber always runs; the user redactor (when provided) runs
 * afterward on the already-scrubbed text. The result is a single function that
 * is safe to apply to any string leaf.
 *
 * @param scrubber - Always-on credential scrubber.
 * @param userRedactor - Optional caller-provided value redactor.
 * @returns A combined redactor.
 */
export function composeRedactors(
  scrubber: CredentialScrubber,
  userRedactor?: CredentialScrubber,
): CredentialScrubber {
  if (!userRedactor) {
    return scrubber;
  }
  return (text: string): string => userRedactor(scrubber(text));
}
