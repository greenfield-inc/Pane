import { describe, expect, it } from 'vitest';
import {
  mergeSharedCredentials,
  syncSharedCredentials,
  type SharedCredentialHost,
  type SharedCredentials,
} from '../../../shared/types/sharedCredentials';

function host(initial: SharedCredentials) {
  let credentials = initial;
  let applies = 0;
  const endpoint: SharedCredentialHost = {
    read: async () => credentials,
    apply: async (incoming) => {
      applies += 1;
      credentials = mergeSharedCredentials(credentials, incoming).credentials;
    },
  };
  return { endpoint, current: () => credentials, applies: () => applies };
}

const offline: SharedCredentialHost = {
  read: async () => { throw new Error('connect ECONNREFUSED'); },
  apply: async () => { throw new Error('connect ECONNREFUSED'); },
};

describe('syncSharedCredentials', () => {
  it('gives every reachable host the newest copy of each key and skips hosts it cannot reach', async () => {
    const mac = host({
      deepgramApiKey: { value: 'dg-new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
    });
    const windows = host({
      deepgramApiKey: { value: 'dg-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' },
      falApiKey: { value: 'fal-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' },
      openRouterApiKey: { value: 'or-win', updatedAt: '2026-02-01T00:00:00.000Z', source: 'Windows' },
    });

    const result = await syncSharedCredentials([mac.endpoint, offline, windows.endpoint]);

    const expected = {
      deepgramApiKey: { value: 'dg-new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      openRouterApiKey: { value: 'or-win', updatedAt: '2026-02-01T00:00:00.000Z', source: 'Windows' },
    };
    expect(mac.current()).toEqual(expected);
    expect(windows.current()).toEqual(expected);
    expect(result).toEqual({ reached: 2, updated: 2 });
  });

  it('writes nothing when every host already agrees', async () => {
    const same = { anthropicApiKey: { value: 'sk-ant-1', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Mac' } };
    const mac = host(same);
    const windows = host(same);

    await syncSharedCredentials([mac.endpoint, windows.endpoint]);

    expect(mac.applies() + windows.applies()).toBe(0);
  });
});
