import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Pi bridge standalone source contract', () => {
  it('imports only the Pi package and Node builtins', async () => {
    const source = await readFile(
      new URL('./pi-bridge.ts', import.meta.url),
      'utf8',
    );
    const specifiers = [
      ...source.matchAll(/from\s+['"](?<specifier>[^'"]+)['"]/gu),
    ].flatMap((match) =>
      match.groups?.specifier === undefined ? [] : [match.groups.specifier],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.every(
        (specifier) =>
          specifier === '@earendil-works/pi-coding-agent' ||
          specifier.startsWith('node:'),
      ),
    ).toBe(true);
  });
});
