import { describe, expect, it } from 'vitest';

import {
  createPiCredentialStore,
  ignoreQueueFailure,
} from './pi-credential-store.js';

describe('createPiCredentialStore', () => {
  it('settles rejected queue predecessors for later operations', () => {
    expect(ignoreQueueFailure()).toBeUndefined();
  });
  it('stores, lists, modifies, and deletes credentials only in memory', async () => {
    const store = createPiCredentialStore();
    expect(await store.read('litellm')).toBeUndefined();
    const written = await store.modify('litellm', async () => ({
      type: 'api_key',
      key: 'secret',
    }));
    expect(written).toMatchObject({ key: 'secret' });
    expect(await store.list()).toStrictEqual([
      { providerId: 'litellm', type: 'api_key' },
    ]);
    expect(await store.read('litellm')).toMatchObject({ type: 'api_key' });
    await store.delete('litellm');
    expect(await store.list()).toStrictEqual([]);
  });

  it('serializes concurrent modifications per provider', async () => {
    const store = createPiCredentialStore();
    const order: string[] = [];
    await Promise.all([
      store.modify('p', async () => {
        order.push('first-start');
        await Promise.resolve();
        order.push('first-end');
        return { type: 'api_key', key: 'one' };
      }),
      store.modify('p', async (current) => {
        order.push(current?.type ?? 'missing');
        return { type: 'api_key', key: 'two' };
      }),
    ]);
    expect(order).toStrictEqual(['first-start', 'first-end', 'api_key']);
  });

  it('leaves an existing credential unchanged when modify returns undefined', async () => {
    const store = createPiCredentialStore();
    await store.modify('p', async () => ({ type: 'api_key', key: 'one' }));
    const retained = await store.modify('p', async () => undefined);
    expect(retained).toMatchObject({ key: 'one' });
    expect(await store.read('p')).toMatchObject({ key: 'one' });
  });

  it('returns undefined when an absent credential is left unchanged', async () => {
    const store = createPiCredentialStore();
    expect(await store.modify('p', async () => undefined)).toBeUndefined();
  });

  it('recovers the provider queue after an updater rejects', async () => {
    const store = createPiCredentialStore();
    await expect(
      store.modify('p', async () => {
        throw new Error('update failed');
      }),
    ).rejects.toThrow('update failed');
    const written = await store.modify('p', async () => ({
      type: 'api_key',
      key: 'recovered',
    }));
    expect(written).toMatchObject({ key: 'recovered' });
    await store.delete('p');
    expect(await store.read('p')).toBeUndefined();
  });

  it('recovers a queued operation that was already waiting on a rejection', async () => {
    const store = createPiCredentialStore();
    let rejectFirst: ((cause: Error) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = store.modify('p', async () => {
      markStarted?.();
      throw await new Promise<Error>((resolve) => {
        rejectFirst = resolve;
      });
    });
    const second = store.modify('p', async () => ({
      type: 'api_key',
      key: 'second',
    }));
    await started;
    rejectFirst?.(new Error('first failed'));
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toMatchObject({ key: 'second' });
  });

  it('allows different providers to proceed independently', async () => {
    const store = createPiCredentialStore();
    let releaseFirst: (() => void) | undefined;
    const blocked = store.modify('first', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { type: 'api_key', key: 'first' };
    });
    expect(
      await store.modify('second', async () => ({
        type: 'api_key',
        key: 'second',
      })),
    ).toMatchObject({ key: 'second' });
    releaseFirst?.();
    await blocked;
  });
});
