/* eslint-disable jsdoc/require-jsdoc -- Structural mirror of Pi's credential boundary. */
export type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | {
      type: 'oauth';
      refresh: string;
      access: string;
      expires: number;
      [key: string]: unknown;
    };

export type PiCredentialStore = {
  read: (providerId: string) => Promise<PiCredential | undefined>;
  list: () => Promise<
    readonly { providerId: string; type: PiCredential['type'] }[]
  >;
  modify: (
    providerId: string,
    update: (
      current: PiCredential | undefined,
    ) => Promise<PiCredential | undefined>,
  ) => Promise<PiCredential | undefined>;
  delete: (providerId: string) => Promise<void>;
};
/* eslint-enable jsdoc/require-jsdoc */

/**
 * Creates a filesystem-free credential store with serialized writes.
 *
 * @returns An isolated credential store.
 */
export function createPiCredentialStore(): PiCredentialStore {
  /* eslint-disable jsdoc/require-jsdoc -- Local closures implement the documented store contract. */
  const values = new Map<string, PiCredential>();
  const chains = new Map<string, Promise<void>>();
  const serialize = async <Result>(
    providerId: string,
    task: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(ignoreQueueFailure).then(task);
    const recovery = operation.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    chains.set(providerId, recovery);
    try {
      return await operation;
    } finally {
      if (chains.get(providerId) === recovery) {
        chains.delete(providerId);
      }
    }
  };
  return {
    read: async (providerId) => values.get(providerId),
    list: async () =>
      [...values].map(([providerId, value]) => ({
        providerId,
        type: value.type,
      })),
    modify: async (providerId, update) =>
      serialize(providerId, async () => {
        const value = await update(values.get(providerId));
        if (value !== undefined) {
          values.set(providerId, value);
        }
        return value ?? values.get(providerId);
      }),
    delete: async (providerId) =>
      serialize(providerId, async () => {
        values.delete(providerId);
      }),
  };
  /* eslint-enable jsdoc/require-jsdoc */
}

/**
 * Converts a prior queue rejection into successful settlement.
 *
 * @returns Undefined.
 */
export function ignoreQueueFailure(): undefined {
  return undefined;
}
