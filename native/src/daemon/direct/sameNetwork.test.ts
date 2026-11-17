import { describe, expect, it, vi } from 'vitest';

import type { RelayConnectionProfile } from '@shared/remoteClient';

import { sameNetworkFetch } from './sameNetwork';

function computer(id: string, local: string[]): RelayConnectionProfile {
  return {
    id: `relay:${id}`, label: 'Studio Mac', baseUrl: `https://${id}.runpane.net`, token: 't', transport: 'http+sse',
    relay: { computerId: id, fingerprint: 'fp', domain: 'runpane.net', local },
  };
}

/** A network where only `reachable` origins answer. Records each URL dialed. */
function network(reachable: string[]) {
  const dialed: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    dialed.push(url);
    if (!reachable.some(origin => url.startsWith(`${origin}/`))) throw new TypeError('Network request failed');
    return Response.json({ ok: true });
  });
  return { fetch, dialed, reachable };
}

describe('same-network addresses', () => {
  it('sends requests to the same-network address when it answers', async () => {
    const lan = 'https://l192-168-1-20.aaaa.runpane.net:42138';
    const net = network([lan, 'https://aaaa.runpane.net']);
    const fetch = sameNetworkFetch(computer('aaaa', [`${lan}/`]), net.fetch);

    await fetch('https://aaaa.runpane.net/api/projects');

    expect(net.dialed).toEqual([`${lan}/health`, `${lan}/api/projects`]);
  });

  it('uses the relay when no same-network address answers', async () => {
    const net = network(['https://bbbb.runpane.net']);
    const fetch = sameNetworkFetch(computer('bbbb', ['https://l10-0-0-5.bbbb.runpane.net:42138/']), net.fetch);

    await fetch('https://bbbb.runpane.net/api/projects');

    expect(net.dialed.at(-1)).toBe('https://bbbb.runpane.net/api/projects');
  });

  it('never sends a request to an address outside the computer’s own names', async () => {
    const net = network(['https://cccc.runpane.net', 'https://evil.example', 'https://l10-0-0-5.dddd.runpane.net:42138']);
    const fetch = sameNetworkFetch(computer('cccc', ['https://evil.example/', 'https://l10-0-0-5.dddd.runpane.net:42138/', 'http://l10-0-0-5.cccc.runpane.net/']), net.fetch);

    await fetch('https://cccc.runpane.net/api/projects');

    expect(net.dialed).toEqual(['https://cccc.runpane.net/api/projects']);
  });

  it('falls back to the relay when the same network drops, and moves back a minute later', async () => {
    let clock = 0;
    const lan = 'https://l192-168-1-30.eeee.runpane.net:42138';
    const net = network([lan, 'https://eeee.runpane.net']);
    const fetch = sameNetworkFetch(computer('eeee', [`${lan}/`]), net.fetch, () => clock);
    await fetch('https://eeee.runpane.net/a');

    net.reachable.splice(net.reachable.indexOf(lan), 1);
    await expect(fetch('https://eeee.runpane.net/b')).rejects.toThrow();
    await fetch('https://eeee.runpane.net/c');
    expect(net.dialed.at(-1)).toBe('https://eeee.runpane.net/c');

    net.reachable.push(lan);
    clock = 30_000;
    await fetch('https://eeee.runpane.net/d');
    expect(net.dialed.at(-1)).toBe('https://eeee.runpane.net/d');
    clock = 60_000;
    await fetch('https://eeee.runpane.net/e');
    expect(net.dialed.at(-1)).toBe(`${lan}/e`);
  });
});
