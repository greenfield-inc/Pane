import type { SavedHosts } from '@/auth/hosts';

/** A pane to open, on a host named by its profile ID or base URL. No pane means the host's pane list. */
export interface OpenTarget {
  host: string;
  paneId?: string;
  panelId?: string;
}

export type IncomingLink =
  | { type: 'open'; target: OpenTarget }
  /** Anything else: let Expo Router match it as a path. */
  | { type: 'route' };

export type ResolvedTarget =
  | { type: 'open'; hostId: string; switchHost: boolean; paneId?: string; panelId?: string }
  | { type: 'unknown-host' };

/**
 * Reads the routing keys a Pane host puts in its push notifications
 * (main/src/daemon/mobilePushSender.ts). Takes an expo-notifications
 * `NotificationRequest`. On iOS the keys sit beside `aps`, which expo exposes
 * only as `trigger.payload`; Android puts them in `remoteMessage.data`.
 */
export function parsePushTarget(request: unknown): OpenTarget | null {
  const trigger = field(request, 'trigger');
  const candidates = [field(trigger, 'payload'), field(field(trigger, 'remoteMessage'), 'data'), field(field(request, 'content'), 'data')];
  for (const data of candidates) {
    const host = stringField(data, 'hostProfileId');
    if (host) return withPane({ host }, stringField(data, 'paneId'), stringField(data, 'panelId'));
  }
  return null;
}

/**
 * Recognises `pane://pane/<paneId>?host=<profile id or base URL>&panel=<panelId>`,
 * a pane on a given host. `pane-remote://` pairing links are handled in features/pairing.
 */
export function parseIncomingLink(url: string): IncomingLink {
  const trimmed = url.trim();
  const match = /^pane:\/\/pane\/([^/?#]+)\/?(?:\?([^#]*))?/.exec(trimmed);
  if (!match) return { type: 'route' };
  const params = new URLSearchParams(match[2] ?? '');
  const host = params.get('host');
  if (!host) return { type: 'route' };
  let paneId: string;
  try {
    paneId = decodeURIComponent(match[1]);
  } catch {
    return { type: 'route' };
  }
  return { type: 'open', target: withPane({ host }, paneId, params.get('panel') ?? undefined) };
}

/** Finds the saved host a target names. It never resolves to a host this phone has not paired with. */
export function resolveOpenTarget(target: OpenTarget, hosts: SavedHosts): ResolvedTarget {
  const wanted = stripSlash(target.host);
  const profile = hosts.profiles.find(p => p.id === target.host || stripSlash(p.baseUrl) === wanted);
  if (!profile) return { type: 'unknown-host' };
  return { type: 'open', hostId: profile.id, switchHost: profile.id !== hosts.activeId, ...withPane({}, target.paneId, target.panelId) };
}

function withPane<T extends object>(base: T, paneId: string | undefined, panelId: string | undefined): T & { paneId?: string; panelId?: string } {
  if (!paneId) return base;
  return panelId ? { ...base, paneId, panelId } : { ...base, paneId };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The `/open` route for a target, used by links and notification taps. */
export function openHref(target: OpenTarget): string {
  const params = Object.entries({ host: target.host, paneId: target.paneId, panelId: target.panelId })
    .flatMap(([key, value]) => value ? [`${key}=${encodeURIComponent(value)}`] : []);
  return `/open?${params.join('&')}`;
}
