import { describe, expect, it } from 'vitest';

import {
  extractTextContent,
  extractToolUseBlocks,
  redactSensitive,
} from './message-parser.js';

describe('redactSensitive', () => {
  it('passes primitive values through unchanged', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(false)).toBe(false);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it('redacts sensitive keys and preserves non-matching keys', () => {
    expect(
      redactSensitive({
        password: 'pw',
        passphrase: 'pp',
        secret: 'sec',
        srp: 'srp',
        seed: 'seed',
        mnemonic: 'words',
        privatekey: 'key',
        private_key: 'snake',
        entropy: 'ent',
        credential: 'cred',
        authorization: 'auth',
        token: 'tok',
        apikey: 'ak',
        api_key: 'ak2',
        keyring: 'kr',
        publicKey: 'public',
      }),
    ).toStrictEqual({
      password: '[REDACTED]',
      passphrase: '[REDACTED]',
      secret: '[REDACTED]',
      srp: '[REDACTED]',
      seed: '[REDACTED]',
      mnemonic: '[REDACTED]',
      privatekey: '[REDACTED]',
      private_key: '[REDACTED]',
      entropy: '[REDACTED]',
      credential: '[REDACTED]',
      authorization: '[REDACTED]',
      token: '[REDACTED]',
      apikey: '[REDACTED]',
      api_key: '[REDACTED]',
      keyring: '[REDACTED]',
      publicKey: 'public',
    });
  });

  it('recursively redacts nested objects and arrays case-insensitively', () => {
    expect(
      redactSensitive({
        nested: { myPassword: 'pw', ok: 'value' },
        list: [{ API_SECRET: 'sec' }, { safe: true }],
        auth: { accessToken: 'tok', refreshToken: 'rt', name: 'user' },
        infura: { infraApiKey: 'key', endpoint: 'https://...' },
      }),
    ).toStrictEqual({
      nested: { myPassword: '[REDACTED]', ok: 'value' },
      list: [{ API_SECRET: '[REDACTED]' }, { safe: true }],
      auth: {
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
        name: 'user',
      },
      infura: { infraApiKey: '[REDACTED]', endpoint: 'https://...' },
    });
  });
});

describe('extractTextContent', () => {
  it('returns string content as-is', () => {
    expect(extractTextContent({ content: 'plain text' })).toBe('plain text');
  });

  it('joins text blocks and ignores mixed non-text content', () => {
    expect(
      extractTextContent({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
          { type: 'text', text: 'world' },
          { type: 'text', text: 1 },
        ],
      }),
    ).toBe('hello world');
  });

  it('returns empty string for empty, missing, or unsupported content', () => {
    expect(extractTextContent({ content: [] })).toBe('');
    expect(extractTextContent({})).toBe('');
    expect(
      extractTextContent({ content: { type: 'text', text: 'ignored' } }),
    ).toBe('');
  });
});

describe('extractToolUseBlocks', () => {
  it('extracts valid tool_use blocks and filters everything else', () => {
    expect(
      extractToolUseBlocks({
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'pwd' },
          },
          { type: 'tool_use', id: 'tool-2', input: {} },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      }),
    ).toStrictEqual([
      { id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('returns an empty array for empty or non-array content', () => {
    expect(extractToolUseBlocks({ content: [] })).toStrictEqual([]);
    expect(extractToolUseBlocks({})).toStrictEqual([]);
    expect(extractToolUseBlocks({ content: 'not blocks' })).toStrictEqual([]);
  });
});
