import { isRelayProfile, type RelayConnectionProfile, type RemoteFetch } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

/** How long a same-network address has to answer before the relay is used instead. */
const PROBE_TIMEOUT_MS = 1_500;
/** While on the relay, how often the same-network addresses are tried again. */
const RECHECK_MS = 60_000;
/** A same-network request with no answer by then has its address checked: the phone may have left that network. */
const SAME_NETWORK_STALL_MS = 3_000;

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
 * once one has answered a short check, and through the relay otherwise. The check runs beside
 * the requests and never holds one up. A same-network request that fails sends the next ones
 * through the relay. One with no answer for 3 s does too when the address's own check then fails
 * (a slow command still answers its check); the same network is tried again after a minute.
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
    const base = entry.base;
    if (!base) return fetch(url, init);
    const leave = () => {
      if (entry.base !== base) return;
      entry.base = null;
      entry.checkedAt = now();
    };
    // Off that Wi-Fi, a request can hang rather than fail. The host answers a command only when it
    // finishes, so a slow one also looks stalled: leave only if the address stops answering too.
    const stalled = setTimeout(() => {
      void firstAnswering(fetch, [base]).then(answering => {
        if (!answering) leave();
      });
    }, SAME_NETWORK_STALL_MS);
    return fetch(`${base}${url.slice(relayBase.length)}`, init).then(response => {
      clearTimeout(stalled);
      return response;
    }, (error: unknown) => {
      clearTimeout(stalled);
      if (!init?.signal?.aborted) leave();
      throw error;
    });
  };
}

/** The first address whose /health answers within the timeout, tried all at once. */
async function firstAnswering(fetch: RemoteFetch, bases: string[]): Promise<string | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // A request to an address that went away can ignore its abort; the check ends on time regardless.
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('No same-network address answered in time')), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([expired, Promise.any(bases.map(async base => {
      const response = await fetch(`${base}/health`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`${base} answered ${response.status}`);
      return base;
    }))]);
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
