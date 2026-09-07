import { describe, expect, it } from 'vitest';

import {
  createCredentialScrubber,
  scrubCredentials,
} from './credential-redactor.js';
import { DockerSandboxError } from './errors.js';

describe('credential redaction', () => {
  it('redacts every nonempty credential, including short and regex-like values', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'a+b',
      TOKEN: 'xy',
      OTHER: 'visible',
      EMPTY_KEY: '',
    });
    expect(scrub('a+b xy visible')).toBe('[REDACTED] [REDACTED] visible');
    expect(createCredentialScrubber({})('unchanged')).toBe('unchanged');
  });
  it('copies errors, stacks, nested causes, and cycles without losing error identity', () => {
    const cause = new Error('sk-test cause');
    const error = new DockerSandboxError('sk-test failure', { cause });
    cause.cause = error;
    const scrubbed = scrubCredentials(
      error,
      createCredentialScrubber({ API_KEY: 'sk-test' }),
    );
    expect(scrubbed).toBeInstanceOf(DockerSandboxError);
    expect(scrubbed).not.toBe(error);
    expect(scrubbed.message).toBe('[REDACTED] failure');
    expect(scrubbed.stack).not.toContain('sk-test');
    expect((scrubbed.cause as Error).message).toBe('[REDACTED] cause');
    expect((scrubbed.cause as Error).cause).toBe(scrubbed);
    expect(error.message).toBe('sk-test failure');
  });
  it('preserves stackless errors and repeated references', () => {
    const error = new Error('failure');
    delete error.stack;
    const scrubbed = scrubCredentials([error, error], (text) => text);
    expect(scrubbed[0]).toBe(scrubbed[1]);
    expect(scrubbed[0]?.message).toBe('failure');
  });
  it('supports DOMException abort reasons and structured payloads', () => {
    const scrub = createCredentialScrubber({ API_KEY: 'key' });
    const error = scrubCredentials(
      new DOMException('key', 'AbortError'),
      scrub,
    );
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('[REDACTED]');
    expect(scrubCredentials({ raw: ['key', null, 1] }, scrub)).toStrictEqual({
      raw: ['[REDACTED]', null, 1],
    });
  });
});
