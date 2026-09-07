import { describe, expect, it } from 'vitest';

import {
  createCredentialScrubber,
  scrubCredentials,
} from './credential-redactor.js';
import { DockerSandboxError } from './errors.js';

describe('credential redaction', () => {
  it('redacts credential values of at least eight characters and keeps shorter values', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'sk-secret-value',
      TOKENIZERS_PARALLELISM: 'false',
      PASSWORD_MIN_LENGTH: '8',
      TOKEN: 'short',
      OTHER: 'visible',
      EMPTY_KEY: '',
    });
    expect(scrub('sk-secret-value false 8 short visible')).toBe(
      '[REDACTED] false 8 short visible',
    );
    expect(createCredentialScrubber({})('unchanged')).toBe('unchanged');
  });
  it('copies errors, stacks, nested causes, and cycles without losing error identity', () => {
    const cause = new Error('sk-test-key cause');
    const error = new DockerSandboxError('sk-test-key failure', { cause });
    cause.cause = error;
    const scrubbed = scrubCredentials(
      error,
      createCredentialScrubber({ API_KEY: 'sk-test-key' }),
    );
    expect(scrubbed).toBeInstanceOf(DockerSandboxError);
    expect(scrubbed).not.toBe(error);
    expect(scrubbed.message).toBe('[REDACTED] failure');
    expect(scrubbed.stack).not.toContain('sk-test-key');
    expect((scrubbed.cause as Error).message).toBe('[REDACTED] cause');
    expect((scrubbed.cause as Error).cause).toBe(scrubbed);
    expect(error.message).toBe('sk-test-key failure');
  });
  it('preserves stackless errors and repeated references', () => {
    const error = new Error('failure');
    delete error.stack;
    const scrubbed = scrubCredentials([error, error], (text) => text);
    expect(scrubbed[0]).toBe(scrubbed[1]);
    expect(scrubbed[0]?.message).toBe('failure');
  });
  it('supports DOMException abort reasons and structured payloads', () => {
    const scrub = createCredentialScrubber({ API_KEY: 'secret-key' });
    const error = scrubCredentials(
      new DOMException('secret-key', 'AbortError'),
      scrub,
    );
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('[REDACTED]');
    expect(
      scrubCredentials({ raw: ['secret-key', null, 1] }, scrub),
    ).toStrictEqual({
      raw: ['[REDACTED]', null, 1],
    });
  });
  it('keeps DOMExceptions as real DOMExceptions so prototype getters still work', () => {
    const scrubbed = scrubCredentials(
      new DOMException('secret-key abort', 'AbortError'),
      createCredentialScrubber({ API_KEY: 'secret-key' }),
    );
    expect(scrubbed).toBeInstanceOf(DOMException);
    expect(scrubbed.message).toBe('[REDACTED] abort');
    // OTel's `recordException` reads `exception.code`; a prototype-swapped
    // copy throws `TypeError` here instead.
    expect(() => scrubbed.code).not.toThrow();
  });
});
