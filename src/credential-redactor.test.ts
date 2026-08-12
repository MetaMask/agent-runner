import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_REDACTION_PLACEHOLDER,
  composeRedactors,
  createCredentialScrubber,
} from './credential-redactor.js';

describe('createCredentialScrubber', () => {
  it('returns a no-op when no credentials are present', () => {
    const scrub = createCredentialScrubber({});
    const text = 'nothing secret here LITELLM_API_KEY';
    expect(scrub(text)).toBe(text);
  });

  it('scrubs the exact value of a forwarded LiteLLM key', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'sk-litellm-abcdef123456',
    });
    expect(scrub('the key is sk-litellm-abcdef123456 ok')).toBe(
      `the key is ${CREDENTIAL_REDACTION_PLACEHOLDER} ok`,
    );
  });

  it('scrubs Anthropic credentials from both providers', () => {
    const scrub = createCredentialScrubber({
      ANTHROPIC_API_KEY: 'sk-ant-1234567890',
      ANTHROPIC_AUTH_TOKEN: 'auth-token-0987654321',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdefgh',
    });
    const scrubbed = scrub(
      'sk-ant-1234567890 / auth-token-0987654321 / oauth-token-abcdefgh',
    );
    expect(scrubbed).toBe(
      `${CREDENTIAL_REDACTION_PLACEHOLDER} / ${CREDENTIAL_REDACTION_PLACEHOLDER} / ${CREDENTIAL_REDACTION_PLACEHOLDER}`,
    );
  });

  it('replaces every occurrence of a secret', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'super-secret-value',
    });
    expect(scrub('super-secret-value super-secret-value')).toBe(
      `${CREDENTIAL_REDACTION_PLACEHOLDER} ${CREDENTIAL_REDACTION_PLACEHOLDER}`,
    );
  });

  it('ignores short values to avoid mangling unrelated text', () => {
    const scrub = createCredentialScrubber({ LITELLM_API_KEY: 'abc' });
    expect(scrub('abc def abc')).toBe('abc def abc');
  });

  it('does not scrub base URLs, only keys', () => {
    const scrub = createCredentialScrubber({
      LITELLM_BASE_URL: 'https://litellm.internal.example',
      LITELLM_API_KEY: 'sk-litellm-abcdef123456',
    });
    const text =
      'connecting to https://litellm.internal.example with sk-litellm-abcdef123456';
    expect(scrub(text)).toBe(
      `connecting to https://litellm.internal.example with ${CREDENTIAL_REDACTION_PLACEHOLDER}`,
    );
  });

  it('treats secret values as regex literals', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'a.b*c(secret)+value',
    });
    expect(scrub('token a.b*c(secret)+value end')).toBe(
      `token ${CREDENTIAL_REDACTION_PLACEHOLDER} end`,
    );
    expect(scrub('token axbxcsecretvalue end')).toBe(
      'token axbxcsecretvalue end',
    );
  });

  it('replaces longer overlapping secrets before their substrings', () => {
    const scrub = createCredentialScrubber({
      ANTHROPIC_API_KEY: 'prefix-secret',
      LITELLM_API_KEY: 'prefix-secret-extended',
    });
    expect(scrub('value prefix-secret-extended done')).toBe(
      `value ${CREDENTIAL_REDACTION_PLACEHOLDER} done`,
    );
  });
});

describe('composeRedactors', () => {
  it('returns the scrubber unchanged when no user redactor is given', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'sk-secret-12345678',
    });
    const composed = composeRedactors(scrub);
    expect(composed('sk-secret-12345678')).toBe(
      CREDENTIAL_REDACTION_PLACEHOLDER,
    );
  });

  it('runs the credential scrubber before the user redactor', () => {
    const scrub = createCredentialScrubber({
      LITELLM_API_KEY: 'sk-secret-12345678',
    });
    const composed = composeRedactors(scrub, (text) =>
      text.replaceAll('SRP-WORDS', '[REDACTED_SRP]'),
    );
    expect(composed('key sk-secret-12345678 and SRP-WORDS')).toBe(
      `key ${CREDENTIAL_REDACTION_PLACEHOLDER} and [REDACTED_SRP]`,
    );
  });
});
