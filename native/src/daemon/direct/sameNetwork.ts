import { isRelayProfile, type RelayConnectionProfile, type RemoteFetch } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

/** How long a same-network address has to answer before the relay is used instead. */
const PROBE_TIMEOUT_MS = 1_500;
/** While on the relay, how often the same-network addresses are tried again. */
const RECHECK_MS = 60_000;

interface SameNetwork {
  /** The same-network address in use, or null while on the relay. */
  base: string | null;
  checkedAt: number;
  probe: Promise<string | null> | null;
}

/** Per computer id, shared by every client of that computer (each screen builds its own). */
const state = new Map<string, SameNetwork>();

/**
 * The computer's same-network addresses a request may go to: `https://l<a>-<b>-<c>-<d>.<id>.<domain>[:port]`
 * only. That name is covered by the computer's own certificate, so TLS checks the computer's key as
 * it does on the relay, and the token never goes to an address outside the computer's names.
 */
function sameNetworkBases(profile: RelayConnectionProfile): string[] {
  const { computerId, domain, local } = profile.relay;
  const host = new RegExp(`^l\\d{1,3}-\\d{1,3}-\\d{1,3}-\\d{1,3}\\.${escape(computerId)}\\.${escape(domain)}$`, 'u');
  return (local ?? []).flatMap(address => {
    try {
      const url = new URL(address);
      return url.protocol === 'https:' && host.test(url.hostname) && url.pathname === '/' && !url.search && !url.username
        ? [url.origin]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Wraps `fetch` so a relay computer's requests go to its same-network address (`relay.local`)
 * when one answers within a short timeout, and through the relay otherwise. A failed request on
 * the same network sends the next ones through the relay; the same network is tried again after
 * a minute.
 */
export function sameNetworkFetch(profile: RemotePaneConnectionProfile, fetch: RemoteFetch, now: () => number = Date.now): RemoteFetch {
  if (!isRelayProfile(profile)) return fetch;
  const bases = sameNetworkBases(profile);
  if (bases.length === 0) return fetch;
  const relayBase = profile.baseUrl.replace(/\/+$/u, '');
  const { computerId } = profile.relay;
  return async (url, init) => {
    if (!url.startsWith(`${relayBase}/`)) return fetch(url, init);
    const entry = state.get(computerId) ?? { base: null, checkedAt: Number.NEGATIVE_INFINITY, probe: null };
    state.set(computerId, entry);
    if (!entry.base && !entry.probe && now() - entry.checkedAt >= RECHECK_MS) {
      entry.probe = firstAnswering(fetch, bases).then(base => {
        entry.base = base;
        entry.checkedAt = now();
        entry.probe = null;
        return base;
      });
    }
    const base = entry.base ?? (entry.probe ? await entry.probe : null);
    if (!base) return fetch(url, init);
    return fetch(`${base}${url.slice(relayBase.length)}`, init).catch((error: unknown) => {
      if (!init?.signal?.aborted && entry.base === base) {
        entry.base = null;
        entry.checkedAt = now();
      }
      throw error;
    });
  };
}

/** The first address whose /health answers within the timeout, tried all at once. */
async function firstAnswering(fetch: RemoteFetch, bases: string[]): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await Promise.any(bases.map(async base => {
      const response = await fetch(`${base}/health`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`${base} answered ${response.status}`);
      return base;
    }));
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
