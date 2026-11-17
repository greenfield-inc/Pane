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

/** Lets the same-network check, which runs beside the requests, finish. */
const checked = () => new Promise(resolve => setTimeout(resolve, 0));

describe('same-network addresses', () => {
  it('sends requests through the relay while the same network is checked, then to the address that answered', async () => {
    const lan = 'https://l192-168-1-20.aaaa.runpane.net:42138';
    const net = network([lan, 'https://aaaa.runpane.net']);
    const fetch = sameNetworkFetch(computer('aaaa', [`${lan}/`]), net.fetch);

    await fetch('https://aaaa.runpane.net/api/projects');
    await checked();
    await fetch('https://aaaa.runpane.net/api/sessions');

    expect(net.dialed).toEqual([`${lan}/health`, 'https://aaaa.runpane.net/api/projects', `${lan}/api/sessions`]);
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
    await checked();

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
    await checked();
    await fetch('https://eeee.runpane.net/f');
    expect(net.dialed.at(-1)).toBe(`${lan}/f`);
  });

  it('moves to the relay when a same-network request gets no answer for 3 s', async () => {
    vi.useFakeTimers();
    const lan = 'https://l192-168-1-40.ffff.runpane.net:42138';
    const net = network([lan, 'https://ffff.runpane.net']);
    // A Wi-Fi the phone left: the address still takes the connection but never answers.
    let silent = false;
    const fetch = sameNetworkFetch(computer('ffff', [`${lan}/`]), async url => {
      if (silent && url.startsWith(lan)) return new Promise(() => {});
      return net.fetch(url);
    });
    await fetch('https://ffff.runpane.net/a');
    await vi.advanceTimersByTimeAsync(0);
    await fetch('https://ffff.runpane.net/b');
    expect(net.dialed.at(-1)).toBe(`${lan}/b`);

    silent = true;
    void fetch('https://ffff.runpane.net/c');
    await vi.advanceTimersByTimeAsync(3_000);
    await fetch('https://ffff.runpane.net/d');

    expect(net.dialed.at(-1)).toBe('https://ffff.runpane.net/d');
    vi.useRealTimers();
  });
});
