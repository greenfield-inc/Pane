import { AppState } from 'react-native';

import { isRelayProfile, type RemoteFetch } from '@shared/remoteClient';
import { RELAY_CLIENT_COMMANDS, type RelayDirectEndpoint } from '@shared/types/relay';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { secureStore } from '@/auth/secureStore';
import { invokeChannel } from '@/daemon/invoke';

import * as paneDirect from '../../../modules/pane-direct';
import { FIRST_PICK, pathFailed, pickPath, type PathPick } from './pathPicker';

const directSchema = boundary.object({
  nodeId: boundary.nonEmptyString,
  addrs: boundary.array(boundary.string),
  relayUrls: boundary.array(boundary.string),
});
const computerDirectSchema = boundary.object({ direct: boundary.optional(directSchema) });

/** Probe quickly while a connection settles, then at a steady pace. */
const QUICK_PROBES = 5;
const QUICK_PROBE_MS = 1_000;
const PROBE_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;

interface Route {
  /** `https://<id>.<domain>`, the address requests are written for. */
  relayBase: string;
  pick: PathPick;
  /** The loopback port while the direct connection is up. */
  directPort: number | null;
}

/** Routes by computer id, for every client of that computer (each screen builds its own). */
const routes = new Map<string, Route>();

/**
 * Wraps `fetch` so a relay computer's requests go to its direct connection while that path is
 * picked. The URL changes to the loopback port; TLS to the computer's name and key happens behind it.
 */
export function routedFetch(profile: RemotePaneConnectionProfile, fetch: RemoteFetch): RemoteFetch {
  if (!isRelayProfile(profile)) return fetch;
  const { computerId } = profile.relay;
  return (url, init) => {
    const route = routes.get(computerId);
    if (route?.pick.path !== 'direct' || route.directPort === null || !url.startsWith(route.relayBase)) return fetch(url, init);
    const direct = `http://127.0.0.1:${route.directPort}${url.slice(route.relayBase.length)}`;
    return fetch(direct, init).catch((error: unknown) => {
      // A request that failed on the direct path sends the next ones through the relay; the
      // client's own retry rules decide whether this one is sent again.
      if (!init?.signal?.aborted) route.pick = pathFailed(route.pick, 'direct');
      throw error;
    });
  };
}

/**
 * While the app is connected to a relay computer, keeps its direct connection open and picks
 * between it and the relay. Returns a stop function.
 */
export function startDirectRoute(
  profile: RemotePaneConnectionProfile,
  client: { invoke(channel: string, args?: unknown[]): Promise<unknown> },
  fetch: RemoteFetch,
): () => void {
  if (!paneDirect.directAvailable || !isRelayProfile(profile)) return () => undefined;
  const { computerId } = profile.relay;
  const route: Route = { relayBase: profile.baseUrl, pick: FIRST_PICK, directPort: null };
  routes.set(computerId, route);
  let stopped = false;
  let connection: { id: number; remove(): void } | null = null;
  let current: RelayDirectEndpoint | null = null;
  let probes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const closeConnection = () => {
    if (!connection) return;
    connection.remove();
    paneDirect.close(connection.id);
    connection = null;
    route.directPort = null;
    route.pick = pathFailed(route.pick, 'direct');
  };

  const open = async (direct: RelayDirectEndpoint) => {
    if (stopped || sameDirect(direct, current)) return;
    current = direct;
    closeConnection();
    let started;
    try {
      started = await paneDirect.connect({
        nodeId: direct.nodeId,
        relayUrls: direct.relayUrls,
        directAddrs: direct.addrs,
        serverName: new URL(profile.baseUrl).hostname,
        fingerprint: profile.relay.fingerprint,
      });
    } catch {
      // The relay keeps working; the next fresh address tries again.
      if (current === direct) current = null;
      return;
    }
    const { id, port } = started;
    if (stopped || current !== direct) {
      paneDirect.close(id);
      return;
    }
    const subscription = paneDirect.addEventListener(id, event => {
      if (event.t === 'path') route.directPort = port;
      else if (event.t === 'error') {
        route.directPort = null;
        route.pick = pathFailed(route.pick, 'direct');
      }
    });
    connection = { id, remove: () => subscription.remove() };
    probes = 0;
    schedule(0);
  };

  const probe = async () => {
    const [relayMs, directMs] = await Promise.all([
      timeRequest(fetch, `${route.relayBase}/health`),
      route.directPort === null ? null : timeRequest(fetch, `http://127.0.0.1:${route.directPort}/health`),
    ]);
    if (stopped) return;
    route.pick = pickPath(route.pick, { relayMs, directMs });
    probes += 1;
    schedule(probes < QUICK_PROBES ? QUICK_PROBE_MS : PROBE_MS);
  };

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    timer = stopped || !connection ? null : setTimeout(() => void probe(), ms);
  }

  // Coming back to the app, the network may have changed: settle again.
  const appState = AppState.addEventListener('change', status => {
    if (status !== 'active') return;
    probes = 0;
    schedule(0);
  });

  void (async () => {
    // The last known address first, so a phone with no internet (same Wi-Fi) connects at once.
    const saved = parseDirect(await secureStore.getItem(storageKey(computerId)).catch(() => null));
    if (saved) await open(saved);
    const fresh = await invokeChannel<unknown>(client, RELAY_CLIENT_COMMANDS.computer).catch(() => null);
    if (stopped || fresh === null) return;
    const direct = decodeOptionalBoundary(fresh, computerDirectSchema)?.direct ?? null;
    if (!direct) {
      current = null;
      closeConnection();
      await secureStore.deleteItem(storageKey(computerId)).catch(() => undefined);
      return;
    }
    if (!sameDirect(direct, saved)) await secureStore.setItem(storageKey(computerId), JSON.stringify(direct)).catch(() => undefined);
    await open(direct);
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    appState.remove();
    closeConnection();
    if (routes.get(computerId) === route) routes.delete(computerId);
  };
}

async function timeRequest(fetch: RemoteFetch, url: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return response.ok ? Date.now() - started : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function storageKey(computerId: string): string {
  return `pane.direct.${computerId}`;
}

function parseDirect(text: string | null): RelayDirectEndpoint | null {
  if (!text) return null;
  try {
    return decodeOptionalBoundary(JSON.parse(text), directSchema) ?? null;
  } catch {
    return null;
  }
}

function sameDirect(a: RelayDirectEndpoint | null, b: RelayDirectEndpoint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
