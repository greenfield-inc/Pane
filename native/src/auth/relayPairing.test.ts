import { beforeEach, expect, it, vi } from 'vitest';

import type { RelayConnectionProfile } from '@shared/remoteClient';

const calls = vi.hoisted((): string[] => []);
vi.mock('@/daemon/createClient', () => ({
  CLIENT_LABEL: 'Pane', DEVICE_LABEL: 'Phone', getRuntimeId: () => Promise.resolve('runtime'), streamingFetch: fetch,
  createDaemonClient: (profile: { label: string }) => ({
    invoke: async (channel: string) => {
      calls.push(`${profile.label} ${channel}`);
      return { token: 'minted' };
    },
  }),
}));

const { linkWithSavedComputers } = await import('./relayPairing');

function computer(label: string, access?: 'read'): RelayConnectionProfile {
  return { id: `relay:${label}`, label, baseUrl: `https://${label}.runpane.net`, token: 't', transport: 'http+sse', relay: { computerId: label, fingerprint: 'fp', domain: 'runpane.net', local: [] }, access };
}

beforeEach(() => { calls.length = 0; });

it('links nothing after pairing Read only: neither side is asked to mint or save a link', async () => {
  await linkWithSavedComputers(computer('tyler', 'read'), [], [computer('mine')]);
  expect(calls).toEqual([]);
});

it('links a newly paired computer with the full-access ones only', async () => {
  await linkWithSavedComputers(computer('studio'), [], [computer('mine'), computer('tyler', 'read')]);
  expect([...calls].sort()).toEqual(['mine relay:client:mint-link', 'mine relay:client:save-link', 'studio relay:client:mint-link', 'studio relay:client:save-link']);
});
