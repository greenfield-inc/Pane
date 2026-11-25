import { describe, expect, it, vi } from 'vitest';

import type { RelayConnectionProfile, RelayPairingLink } from '@shared/remoteClient';
import { relayLinkJoin } from '@shared/remoteClient/relayLinkPreview';
import { readOnlyToken } from '@shared/types/accessLevel';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

const LINK: RelayPairingLink = { secret: 's3cret', computerId: 'buildbox', name: 'Build Box', domain: 'runpane.net' };

function relayComputer(id: string, label: string): RelayConnectionProfile {
  return { id: `relay:${id}`, label, baseUrl: `https://${id}.runpane.net`, token: 't', transport: 'http+sse', relay: { computerId: id, fingerprint: 'fp', domain: 'runpane.net', local: [] } };
}
const TAILSCALE: RemotePaneConnectionProfile = { id: 'ts', label: 'Home', baseUrl: 'https://home.tail.ts.net', token: 't', transport: 'http+sse' };

function host(answer: { status: number; body: unknown }) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    expect(url).toBe('https://buildbox.runpane.net/pair/preview');
    expect(JSON.parse(init?.body ?? '{}')).toEqual({ secret: 's3cret' });
    return Response.json(answer.body, { status: answer.status });
  });
}

describe('joining two groups of computers', () => {
  it('pairs a device that reaches no relay computer without asking', async () => {
    const fetch = host({ status: 200, body: { ok: true, group: [{ id: 'buildbox', name: 'Build Box' }], expiresAt: '2026-11-15T10:00:00Z' } });
    expect(await relayLinkJoin(fetch, LINK, [TAILSCALE])).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks even when the maker says its group holds one of this device’s computers, since the maker writes that answer', async () => {
    const fetch = host({ status: 200, body: { ok: true, group: [{ id: 'buildbox', name: 'Build Box' }, { id: 'studio', name: 'Studio Mac' }], expiresAt: '2026-11-15T10:00:00Z' } });
    expect(await relayLinkJoin(fetch, LINK, [relayComputer('studio', 'Studio Mac')]))
      .toEqual({ maker: 'Build Box', makerGroup: ['Build Box', 'Studio Mac'], here: ['Studio Mac'] });
  });

  it('pairs without asking when this device reaches the link’s computer already', async () => {
    const fetch = host({ status: 200, body: { ok: true, group: [{ id: 'buildbox', name: 'Build Box' }], expiresAt: '2026-11-15T10:00:00Z' } });
    expect(await relayLinkJoin(fetch, LINK, [relayComputer('buildbox', 'Build Box')])).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks before a full-access link links a computer this device only watches with its others', async () => {
    const fetch = host({ status: 200, body: { ok: true, group: [{ id: 'buildbox', name: 'Build Box' }], expiresAt: '2026-11-15T10:00:00Z' } });
    expect(await relayLinkJoin(fetch, LINK, [{ ...relayComputer('buildbox', 'Build Box'), token: readOnlyToken('a') }, relayComputer('studio', 'Studio Mac')]))
      .toEqual({ maker: 'Build Box', makerGroup: ['Build Box'], here: ['Studio Mac'] });
  });

  it('names both sides when the link would join a second group', async () => {
    const fetch = host({ status: 200, body: { ok: true, group: [{ id: 'buildbox', name: 'Build Box' }, { id: 'labpc', name: 'Lab PC' }], expiresAt: '2026-11-15T10:00:00Z' } });
    expect(await relayLinkJoin(fetch, LINK, [relayComputer('studio', 'Studio Mac'), relayComputer('laptop', 'Travel Laptop'), TAILSCALE]))
      .toEqual({ maker: 'Build Box', makerGroup: ['Build Box', 'Lab PC'], here: ['Studio Mac', 'Travel Laptop'] });
  });

  it('still asks, naming the link’s computer, when the computer can’t show its group', async () => {
    const fetch = host({ status: 404, body: { ok: false } });
    expect(await relayLinkJoin(fetch, LINK, [relayComputer('studio', 'Studio Mac')]))
      .toEqual({ maker: 'Build Box', makerGroup: ['Build Box'], here: ['Studio Mac'] });
  });
});
