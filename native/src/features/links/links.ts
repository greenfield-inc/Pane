import type { NotifyUi } from '@shared/types/notify';

import type { SavedHosts } from '@/auth/hosts';

/** A pane to open, on a host named by its profile ID or base URL. No pane means the host's pane list. */
export interface OpenTarget {
  host: string;
  paneId?: string;
  panelId?: string;
  /** A Notify question to answer: opens its sheet instead of the pane. */
  notifyId?: string;
  /** An orchestrator Session to open instead of a pane. */
  sessionId?: string;
}

export type IncomingLink =
  | { type: 'open'; target: OpenTarget }
  /** Anything else: let Expo Router match it as a path. */
  | { type: 'route' };

export type ResolvedTarget =
  | { type: 'open'; hostId: string; switchHost: boolean; paneId?: string; panelId?: string; notifyId?: string; sessionId?: string }
  | { type: 'unknown-host' };

/**
 * Reads the routing keys a Pane host puts in its push notifications
 * (main/src/daemon/mobilePushSender.ts). Takes an expo-notifications
 * `NotificationRequest`. On iOS the keys sit beside `aps`, which expo exposes
 * only as `trigger.payload`; Android puts them in `remoteMessage.data`. An
 * Android background task's button press carries the alert's data as JSON in
 * `content.dataString`.
 */
export function parsePushTarget(request: unknown): OpenTarget | null {
  const data = pushData(request);
  const host = stringField(data, 'hostProfileId');
  if (!host) return null;
  const notifyId = stringField(data, 'notifyId');
  return withPane(notifyId ? { host, notifyId } : { host }, stringField(data, 'paneId'), stringField(data, 'panelId'));
}

/** A Notify question's alert, as the host sends it (main/src/daemon/mobilePushSender.ts, observeQuestion). */
export interface NotifyPush {
  host: string;
  notifyId: string;
  paneId?: string;
  sessionPaneId?: string;
  panelId?: string;
  ui?: NotifyUi;
  /** Choice button labels, recommended first; up to three. */
  choices: string[];
  /** Android data-only messages: the alert the app draws, and its tag. */
  title?: string;
  body?: string;
  tag?: string;
  /** A silent update: the question stopped waiting, so its alert should go. */
  clear: boolean;
}

/**
 * Reads a Notify alert or silent clear from an expo-notifications request, a
 * notification response or a background task payload. iOS sends
 * `notifyChoices` as an array and `notifyClear` as `true`; Android data
 * messages carry only strings, so a JSON array and `'1'`.
 */
export function parseNotifyPush(value: unknown): NotifyPush | null {
  // A request, a response's request, or a background task's `data`.
  const data = [pushData(value), pushData(field(field(value, 'notification'), 'request')), field(value, 'data')]
    .find(candidate => stringField(candidate, 'hostProfileId') !== undefined && stringField(candidate, 'notifyId') !== undefined);
  const host = stringField(data, 'hostProfileId');
  const notifyId = stringField(data, 'notifyId');
  if (!host || !notifyId) return null;
  const ui = stringField(data, 'notifyUi');
  const clear = field(data, 'notifyClear');
  return {
    host,
    notifyId,
    choices: choiceLabels(field(data, 'notifyChoices')),
    clear: clear === true || clear === '1',
    ...defined({
      paneId: stringField(data, 'paneId'),
      sessionPaneId: stringField(data, 'sessionPaneId'),
      panelId: stringField(data, 'panelId'),
      ui: NOTIFY_UIS.find(candidate => candidate === ui),
      title: stringField(data, 'notifyTitle'),
      body: stringField(data, 'notifyBody'),
      tag: stringField(data, 'notifyTag'),
    }),
  };
}

const NOTIFY_UIS: readonly NotifyUi[] = ['options', 'approve', 'ask', 'info'];

function choiceLabels(value: unknown): string[] {
  const list = typeof value === 'string' ? parseJson(value) : value;
  return Array.isArray(list) ? list.filter((label): label is string => typeof label === 'string' && label.length > 0) : [];
}

/** Whether a Pane host's alert is about this Pane, or about a worker of the Session this Pane is. */
export function isPushForPane(request: unknown, paneId: string): boolean {
  const data = pushData(request);
  return data !== undefined && (stringField(data, 'paneId') === paneId || stringField(data, 'sessionPaneId') === paneId);
}

function pushData(request: unknown): unknown {
  const trigger = field(request, 'trigger');
  const content = field(request, 'content');
  const candidates = [field(trigger, 'payload'), field(field(trigger, 'remoteMessage'), 'data'), field(content, 'data'), parseJson(field(content, 'dataString'))];
  return candidates.find(data => stringField(data, 'hostProfileId') !== undefined);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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
  const notify = target.notifyId ? { notifyId: target.notifyId } : {};
  const session = target.sessionId ? { sessionId: target.sessionId } : {};
  return { type: 'open', hostId: profile.id, switchHost: profile.id !== hosts.activeId, ...notify, ...session, ...withPane({}, target.paneId, target.panelId) };
}

function withPane<T extends object>(base: T, paneId: string | undefined, panelId: string | undefined): T & { paneId?: string; panelId?: string } {
  if (!paneId) return base;
  return panelId ? { ...base, paneId, panelId } : { ...base, paneId };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
  const params = Object.entries({ host: target.host, paneId: target.paneId, panelId: target.panelId, notifyId: target.notifyId, sessionId: target.sessionId })
    .flatMap(([key, value]) => value ? [`${key}=${encodeURIComponent(value)}`] : []);
  return `/open?${params.join('&')}`;
}
