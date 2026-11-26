import { create } from 'zustand';
import { API } from '../utils/api';
import { readPaneLayout } from '../utils/paneLayoutMemory';
import { switchMark } from '../../../shared/switchMarks';
import type { Session } from '../types/session';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import type { OrchestrationSessionOpenResult, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';

/**
 * What this window last read of a Session, so showing it again paints at once (T-87, B):
 * the view (record, internal session, agent tab), its tabs, the host's stored layout,
 * this desktop's remembered layout, and the chat's newest messages.
 *
 * Filled by one `peek` (the sidebar cursor passing over a Session this window holds
 * nothing for; read-only, starts nothing) or one `open` (the cursor settled, Enter, a
 * click; starts the chat's agent and revalidates). Live changes reach a shown Session
 * through the panel and chat events as before; `open` replaces the entry. Cleared when
 * the window switches machine, since every id here belongs to one host.
 */
export interface SessionViewEntry {
  view: OrchestrationSessionView<Session>;
  panels: ToolPanel[];
  /** The host's last-used layout (`panels:get-layout`). */
  layout: SessionPanelLayout | null;
  /** This desktop's own layout for the Session's internal Pane (`paneLayoutMemory`). */
  remembered: SessionPanelLayout | null;
  /** The agent's chat as last read, for priming its viewer; absent for a terminal agent. */
  chat?: ChatTabView;
  /** Read by `open` (the agent was started) rather than only peeked. */
  opened: boolean;
}

interface SessionViewCacheState {
  entries: Record<string, SessionViewEntry>;
  /** Sessions a peek found nothing to show for yet (their agent tab is created on open). */
  unpeekable: Record<string, true>;
}

export const useSessionViewCache = create<SessionViewCacheState>(() => ({ entries: {}, unpeekable: {} }));

/** Sessions kept; the least recently read go first. A chat's messages are the bulk of an entry. */
const KEPT_SESSIONS = 30;

let generation = 0;
const peeks = new Map<string, Promise<SessionViewEntry | null>>();
const opens = new Map<string, Promise<OrchestrationSessionOpenResult<Session>>>();
/** Most recently read last. */
const order: string[] = [];

/**
 * Tab changes while a Session is held but not on screen (an agent opened a page, another
 * window closed a tab) or while its read is in flight: kept per internal Pane id and
 * applied to what the read returns, so a held Session never comes back with old tabs.
 */
type PanelChange = { kind: 'set'; panel: ToolPanel } | { kind: 'deleted'; panelId: string };
const changesDuringRead = new Map<string, PanelChange[]>();
let followingPanels = false;

function applyChanges(panels: ToolPanel[], changes: readonly PanelChange[]): ToolPanel[] {
  let next = panels;
  for (const change of changes) {
    if (change.kind === 'deleted') next = next.filter(panel => panel.id !== change.panelId);
    else next = next.some(panel => panel.id === change.panel.id)
      ? next.map(panel => (panel.id === change.panel.id ? change.panel : panel))
      : [...next, change.panel];
  }
  return next;
}

function panelChanged(internalSessionId: string, change: PanelChange): void {
  changesDuringRead.get(internalSessionId)?.push(change);
  const state = useSessionViewCache.getState();
  const held = Object.entries(state.entries).filter(([, entry]) => entry.view.internalSession.id === internalSessionId);
  if (held.length === 0) return;
  const entries = { ...state.entries };
  for (const [sessionId, entry] of held) {
    const panels = applyChanges(entry.panels, [change]);
    // The agent tab's own record carries its readiness; a held view keeps it current too.
    const panel = change.kind === 'set' && change.panel.id === entry.view.panel.id ? change.panel : entry.view.panel;
    entries[sessionId] = { ...entry, panels, view: panel === entry.view.panel ? entry.view : { ...entry.view, panel } };
  }
  useSessionViewCache.setState({ entries });
}

function followPanels(): void {
  if (followingPanels) return;
  const events = window.electronAPI?.events;
  if (!events) return;
  followingPanels = true;
  events.onPanelCreated(panel => panelChanged(panel.sessionId, { kind: 'set', panel }));
  events.onPanelUpdated(panel => panelChanged(panel.sessionId, { kind: 'set', panel }));
  events.onPanelDeleted(({ sessionId, panelId }) => panelChanged(sessionId, { kind: 'deleted', panelId }));
}

/** Runs a read with every tab change made meanwhile kept for it. */
async function whileReading<T>(internalSessionId: string, read: (changes: readonly PanelChange[]) => Promise<T>): Promise<T> {
  followPanels();
  const own: PanelChange[] = [];
  const outer = changesDuringRead.get(internalSessionId);
  // Reads of the same Pane at once share the list: each applies what it saw.
  const changes = outer ?? own;
  if (!outer) changesDuringRead.set(internalSessionId, changes);
  try {
    return await read(changes);
  } finally {
    if (!outer) changesDuringRead.delete(internalSessionId);
  }
}

function touch(sessionId: string): string[] {
  const at = order.indexOf(sessionId);
  if (at >= 0) order.splice(at, 1);
  order.push(sessionId);
  return order.length > KEPT_SESSIONS ? order.splice(0, order.length - KEPT_SESSIONS) : [];
}

function store(sessionId: string, entry: SessionViewEntry): void {
  const dropped = touch(sessionId);
  useSessionViewCache.setState(state => {
    const entries = { ...state.entries, [sessionId]: entry };
    for (const id of dropped) delete entries[id];
    const { [sessionId]: _found, ...unpeekable } = state.unpeekable;
    return { entries, unpeekable };
  });
}

function responseData<T>(response: { success: boolean; data?: T; error?: string }, fallback: string): T {
  if (!response.success || response.data === undefined) throw new Error(response.error || fallback);
  return response.data;
}

/** Where a Session is shown: its id, its internal Pane's id (from the list), and the window's host. */
export interface SessionViewTarget {
  sessionId: string;
  internalSessionId: string;
  hostId: string | null | undefined;
}

/** This desktop's layout for the Session: held already, or read beside the host call. */
function rememberedLayout(target: SessionViewTarget): Promise<SessionPanelLayout | null> {
  const held = cachedSessionView(target.sessionId);
  if (held && held.view.internalSession.id === target.internalSessionId) return Promise.resolve(held.remembered);
  return readPaneLayout(target.hostId, target.internalSessionId);
}

function entryFrom(result: OrchestrationSessionOpenResult<Session>, remembered: SessionPanelLayout | null, opened: boolean, changes: readonly PanelChange[]): SessionViewEntry | null {
  if (!result.view) return null;
  const panels = applyChanges(result.panels, changes);
  const panel = panels.find(candidate => candidate.id === result.view?.panel.id) ?? result.view.panel;
  return { view: panel === result.view.panel ? result.view : { ...result.view, panel }, panels, layout: result.layout, remembered, chat: result.chat, opened };
}

/** Forget every Session (the window switched machine). Replies still in flight are dropped. */
export function clearSessionViewCache(): void {
  generation += 1;
  peeks.clear();
  opens.clear();
  order.length = 0;
  useSessionViewCache.setState({ entries: {}, unpeekable: {} });
}

export function cachedSessionView(sessionId: string): SessionViewEntry | undefined {
  return useSessionViewCache.getState().entries[sessionId];
}

/**
 * Reads a Session to show it under the sidebar cursor: one read-only `peek` (and this
 * desktop's remembered layout beside it), never for a Session already held, at most one
 * at a time per Session. Resolves null when there is nothing to show yet.
 */
export function peekSessionView(target: SessionViewTarget): Promise<SessionViewEntry | null> {
  const { sessionId } = target;
  const held = cachedSessionView(sessionId);
  if (held) return Promise.resolve(held);
  const pending = peeks.get(sessionId) ?? opens.get(sessionId)?.then(() => cachedSessionView(sessionId) ?? null);
  if (pending) return pending;
  const started = generation;
  switchMark('session:peek', { sessionId });
  const peek = whileReading(target.internalSessionId, async changes => {
    const [response, remembered] = await Promise.all([API.orchestrationSessions.peek({ sessionId }), rememberedLayout(target)]);
    const result = responseData(response, 'Failed to show Session');
    if (started !== generation) return null;
    const entry = entryFrom(result, remembered, false, changes);
    if (entry) store(sessionId, entry);
    else useSessionViewCache.setState(state => ({ unpeekable: { ...state.unpeekable, [sessionId]: true } }));
    return entry;
  }).finally(() => { if (peeks.get(sessionId) === peek) peeks.delete(sessionId); });
  peeks.set(sessionId, peek);
  return peek;
}

/**
 * Opens a Session for real: one `open` call that reads everything `peek` does, starts
 * its chat's agent and, with `select`, saves the selection. The entry it returns replaces
 * the held one. Calls for the same Session while one is in flight share it.
 */
export function openSessionView(target: SessionViewTarget, { select = false }: { select?: boolean } = {}): Promise<OrchestrationSessionOpenResult<Session>> {
  const { sessionId } = target;
  const pending = opens.get(sessionId);
  // A selecting open is never folded into a reading one: it saves something the other does not.
  if (pending && !select) return pending;
  const started = generation;
  switchMark('session:open', { sessionId });
  const open = whileReading(target.internalSessionId, async changes => {
    const [response, remembered] = await Promise.all([API.orchestrationSessions.open({ sessionId }, { select }), rememberedLayout(target)]);
    const result = responseData(response, 'Failed to open Session');
    if (started === generation) {
      const entry = entryFrom(result, remembered, true, changes);
      if (entry) store(sessionId, entry);
    }
    return result;
  }).finally(() => { if (opens.get(sessionId) === open) opens.delete(sessionId); });
  opens.set(sessionId, open);
  return open;
}

/** Whether an open for this Session is in flight. */
export function isOpening(sessionId: string): boolean {
  return opens.has(sessionId);
}

/** The desktop remembered another layout for a Session's Pane (it changed tabs or splits). */
export function rememberCachedLayout(internalSessionId: string, layout: SessionPanelLayout | null): void {
  const state = useSessionViewCache.getState();
  const found = Object.entries(state.entries).find(([, entry]) => entry.view.internalSession.id === internalSessionId);
  if (!found || found[1].remembered === layout) return;
  const [sessionId, entry] = found;
  useSessionViewCache.setState({ entries: { ...state.entries, [sessionId]: { ...entry, remembered: layout } } });
}

/** A shown Session's tabs as its workspace left them, so the next visit starts from them. */
export function rememberCachedPanels(internalSessionId: string, panels: ToolPanel[] | undefined): void {
  if (!panels) return;
  const state = useSessionViewCache.getState();
  const held = Object.entries(state.entries).filter(([, entry]) => entry.view.internalSession.id === internalSessionId && entry.panels !== panels);
  if (held.length === 0) return;
  const entries = { ...state.entries };
  for (const [sessionId, entry] of held) entries[sessionId] = { ...entry, panels };
  useSessionViewCache.setState({ entries });
}

/** A newer record (a rename, a pin) or chat window for a held Session. */
export function updateCachedSession(sessionId: string, patch: Partial<Pick<SessionViewEntry, 'view' | 'chat' | 'panels'>>): void {
  const state = useSessionViewCache.getState();
  const entry = state.entries[sessionId];
  if (!entry) return;
  useSessionViewCache.setState({ entries: { ...state.entries, [sessionId]: { ...entry, ...patch } } });
}
