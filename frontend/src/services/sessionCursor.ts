/**
 * Arrow keys open chat Sessions (T-87, Settings > Shortcuts, on unless turned off).
 *
 * ↑/↓ onto a chat Session's sidebar row shows that Session in the focused tile at once
 * (`showAtCursor`), and keyboard focus stays on the row. The cursor *settles* when it
 * rests on the row for SETTLE_MS, or on Enter, Space, a click, typing, or focus leaving
 * the sidebar: only then is the Session selected (saved) and its chat's agent started,
 * with one `open` call. Passing over a Session starts nothing and saves nothing, and
 * the cursor never resumes a paused chat (Enter or a click does, as before).
 *
 * Only this machine's Sessions follow the cursor: the All machines view, worktree Pane
 * and project rows keep Enter, and so does a window showing another machine. A Session
 * whose agent runs in a terminal is shown only by Enter or a click, as before.
 */
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useSessionStore } from '../stores/sessionStore';
import { cachedSessionView, peekSessionView } from '../stores/sessionViewCache';
import { usePanelStore } from '../stores/panelStore';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { panePausedMark } from '../../../shared/types/panels';
import type { AppConfig } from '../types/config';

/** How long the cursor rests on a row before its Session is selected and its agent starts. */
const SETTLE_MS = 1000;

/** The sidebar row attribute naming the chat Session a row shows; set only where the cursor may follow. */
export const SESSION_CURSOR_ATTRIBUTE = 'data-session-cursor';

/** The window's host: null on this machine, undefined before the config loads. */
function hostIdOf(config: AppConfig | null | undefined): string | null | undefined {
  return config ? getActiveRemoteHostId(config.remoteDaemon) : undefined;
}

/** Whether cursor-follow is on: the setting, and the window showing this machine. */
export function cursorFollowEnabled(config: AppConfig | null | undefined = useConfigStore.getState().config): boolean {
  return !!config && config.arrowKeysOpenSessions !== false && hostIdOf(config) === null;
}

/** The same, for a component that should re-render when it changes. */
export function useCursorFollowEnabled(): boolean {
  return useConfigStore(state => cursorFollowEnabled(state.config));
}

let pending: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let listening = false;

function clearTimer(): void {
  clearTimeout(timer);
  timer = undefined;
}

/** Focus that leaves the sidebar (a click in the chat, Tab, ⌘⌥→) is the person using what the cursor shows. */
function onFocusIn(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!pending || !target) return;
  if (target.closest('[data-focus-region="sidebar"], [data-sidebar-item]')) return;
  settleSessionCursor();
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('focusin', onFocusIn, true);
  // Leaving the Sessions view drops what the cursor showed; nothing was selected.
  useNavigationStore.subscribe(state => {
    if (state.activeView !== 'pane-chat') dropSessionCursor();
  });
  useSessionStore.subscribe(state => {
    if (state.activeSessionId) dropSessionCursor();
  });
  // A selection made any other way (a tile, a restore, another host) ends the cursor's intent,
  // and so does turning the setting off or the window leaving this machine.
  useOrchestrationSessionStore.subscribe(state => {
    if (pending !== undefined && state.cursorSessionId !== pending) { clearTimer(); pending = undefined; }
  });
  useConfigStore.subscribe(state => {
    if (!cursorFollowEnabled(state.config)) dropSessionCursor();
  });
}

/** A Session whose agent runs in a terminal keeps Enter (known once it was read). */
function isTerminalSession(sessionId: string): boolean {
  const entry = cachedSessionView(sessionId);
  if (entry) return entry.view.panel.type !== 'chat';
  const record = useOrchestrationSessionStore.getState().sessions.find(session => session.id === sessionId);
  const agentPanel = record && usePanelStore.getState().panels[record.internalSessionId]?.find(panel => panel.id === record.panelIds[record.agent]);
  return agentPanel !== undefined && agentPanel.type !== 'chat';
}

/**
 * The sidebar cursor moved onto a chat Session's row: show it now, and settle on it
 * after SETTLE_MS unless the cursor moves on first.
 */
export function showSessionAtCursor(sessionId: string): void {
  listen();
  clearTimer();
  const sessions = useOrchestrationSessionStore.getState();
  if (isTerminalSession(sessionId)) { pauseSessionCursor(); return; }
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'pane-chat') navigation.navigateToPaneChat();
  if (useSessionStore.getState().activeSessionId) void useSessionStore.getState().setActiveSession(null);
  if (sessionId === sessions.selectedSessionId) {
    pending = undefined;
    sessions.showAtCursor(undefined);
    return;
  }
  pending = sessionId;
  sessions.showAtCursor(sessionId);
  timer = setTimeout(settleSessionCursor, SETTLE_MS);
  const record = sessions.sessions.find(session => session.id === sessionId);
  if (!record || cachedSessionView(sessionId)) return;
  // One read-only peek per Session not held; a Session that turns out to be a terminal one goes back.
  void peekSessionView({ sessionId, internalSessionId: record.internalSessionId, hostId: hostIdOf(useConfigStore.getState().config) })
    .then(entry => {
      if (entry && entry.view.panel.type !== 'chat' && pending === sessionId) dropSessionCursor();
    })
    .catch(() => undefined);
}

/** The cursor moved to a row that is not a chat Session: what it showed stays, and does not settle by itself. */
export function pauseSessionCursor(): void {
  clearTimer();
}

/**
 * Settle now on what the cursor shows, by itself (the rest, typing, focus leaving the
 * sidebar): it is selected and its agent started, but a paused chat stays paused (the open
 * says `resume: false`, and main also checks, so a tab paused since it was read stays paused too).
 */
export function settleSessionCursor(): void {
  clearTimer();
  const sessionId = pending;
  pending = undefined;
  const sessions = useOrchestrationSessionStore.getState();
  // Only what the cursor still shows, with the setting on and the window on this machine.
  if (!sessionId || sessions.cursorSessionId !== sessionId || !cursorFollowEnabled()) return;
  void sessions.settle(sessionId, hostIdOf(useConfigStore.getState().config), { resume: !chatPaused(sessionId) }).catch(() => undefined);
}

/** Whether the Session's chat is paused, from its record or the tabs this window holds for it. */
function chatPaused(sessionId: string): boolean {
  const record = useOrchestrationSessionStore.getState().sessions.find(session => session.id === sessionId);
  if (record?.paused) return true;
  const panels = cachedSessionView(sessionId)?.panels ?? (record ? usePanelStore.getState().panels[record.internalSessionId] : undefined);
  return panels !== undefined && panePausedMark(panels) !== undefined;
}

/** Forget what the cursor shows without selecting it. */
export function dropSessionCursor(): void {
  clearTimer();
  pending = undefined;
  if (useOrchestrationSessionStore.getState().cursorSessionId) useOrchestrationSessionStore.getState().showAtCursor(undefined);
}

/** The Session shown by the cursor and not settled yet, if any. */
export function pendingCursorSession(): string | undefined {
  return pending;
}

/** A click, Enter or Space on a Session row: select it now, whatever the cursor showed, resuming a paused chat as opening one does. */
export function settleOnSession(sessionId: string): Promise<void> {
  clearTimer();
  pending = undefined;
  const sessions = useOrchestrationSessionStore.getState();
  // Already settled and shown (the cursor rested on it, then Enter): nothing to read again,
  // unless it settled by itself and a paused chat waits for this Enter or click to resume.
  if (sessionId === sessions.selectedSessionId && !sessions.cursorSessionId && sessions.quietSessionId !== sessionId
    && sessions.availability === 'ready' && !sessions.selectionError) return Promise.resolve();
  return sessions.settle(sessionId, hostIdOf(useConfigStore.getState().config));
}
