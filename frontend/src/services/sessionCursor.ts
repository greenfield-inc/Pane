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
 * The Sessions of the machine the window shows follow the cursor (`rowShowsInstantly`), in its
 * own sidebar and in the All machines view, and so do the Sessions of the owner's other machines
 * in All machines (T-116 PR 6, D-20), this computer's included when the window shows another:
 * those show read-only from the mirror, and a rest engages them (PR 7, `remoteEngage`): the
 * window switches to that machine and opens the Session there. Any arrow press cancels that rest,
 * or the switch it started (D-6). A teammate's machine, worktree Pane and project rows keep
 * Enter. A Session whose agent runs in a terminal is shown only by Enter or a click, as before.
 */
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useSessionStore } from '../stores/sessionStore';
import { cachedSessionView, peekSessionView } from '../stores/sessionViewCache';
import { usePanelStore } from '../stores/panelStore';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { useMachineMirrorStore } from '../stores/machineMirrorStore';
import { clearRemoteSession, showRemoteSession } from '../stores/remoteSessionView';
import { armRestEngage, cancelRemoteEngage } from './remoteEngage';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { chatPausedMarkOf, panePausedMark } from '../../../shared/types/panels';
import type { AppConfig } from '../types/config';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';

/** How long the cursor rests on a row before its Session is selected and its agent starts. */
const SETTLE_MS = 1000;

/** The sidebar row attribute naming the chat Session a row shows; set only where the cursor may follow. */
export const SESSION_CURSOR_ATTRIBUTE = 'data-session-cursor';
/** Beside it, the machine the Session is on (T-116 PR 6): the same Session id can be on two machines. */
export const SESSION_CURSOR_MACHINE_ATTRIBUTE = 'data-session-cursor-machine';

/** The two attributes a Session row carries when `rowShowsInstantly` says the cursor shows it. */
export function sessionCursorAttributes(machineId: string, sessionId: string | undefined) {
  return { [SESSION_CURSOR_ATTRIBUTE]: sessionId, [SESSION_CURSOR_MACHINE_ATTRIBUTE]: sessionId ? machineId : undefined } as const;
}

/**
 * The window's host by config object: every Session row's selector asks on each store change, and
 * reading it normalizes the whole remote config (T-132's rig: most of the renderer's time during
 * a switch). The store replaces its config, never changes one in place.
 */
const hostIds = new WeakMap<AppConfig, string | null>();

/** The window's host: null on this machine, undefined before the config loads. */
function hostIdOf(config: AppConfig | null | undefined): string | null | undefined {
  if (!config) return undefined;
  const known = hostIds.get(config);
  if (known !== undefined) return known;
  const hostId = getActiveRemoteHostId(config.remoteDaemon);
  hostIds.set(config, hostId);
  return hostId;
}

/** Whether cursor-follow is on: the setting, whichever machine the window shows (T-116 D-20). */
export function cursorFollowEnabled(config: AppConfig | null | undefined = useConfigStore.getState().config): boolean {
  return !!config && config.arrowKeysOpenSessions !== false;
}

/**
 * The machine the window shows, by its All machines id: `LOCAL_MACHINE_ID` on this computer, else
 * the saved computer's id. Its rows show from the window's own Session cache (D-20).
 */
export function windowMachineId(config: AppConfig | null | undefined = useConfigStore.getState().config): string {
  return hostIdOf(config) ?? LOCAL_MACHINE_ID;
}

/** The same, for a component that should re-render when it changes. */
export function useWindowMachineId(): string {
  return useConfigStore(state => windowMachineId(state.config));
}

/** The same, for a component that should re-render when it changes. */
export function useCursorFollowEnabled(): boolean {
  return useConfigStore(state => cursorFollowEnabled(state.config));
}

/**
 * Whether a Session row on `machineId` shows its Session as the cursor passes, rather than
 * waiting for Enter (T-116). Both sidebars' Session rows ask it before they carry
 * `sessionCursorAttributes`. The window's own machine's rows do (D-20: whichever machine it
 * shows), and so do the rows of each of the owner's machines the mirror lists (PR 6, D-500;
 * this computer lists there from its own snapshots): those show read-only from the mirror, or from
 * one read of their host for a Session the mirror lacks, without switching the window. A
 * teammate's machine, or one the mirror doesn't hold, keeps Enter (D-5).
 */
export function rowShowsInstantly(
  machineId: string,
  config: AppConfig | null | undefined = useConfigStore.getState().config,
  mirrored: (machineId: string) => boolean = id => useMachineMirrorStore.getState().listings[id] !== undefined,
): boolean {
  return cursorFollowEnabled(config) && (machineId === windowMachineId(config) || mirrored(machineId));
}

/** The same, for a row that should re-render when it changes. */
export function useRowShowsInstantly(machineId: string): boolean {
  const isMirrored = useMachineMirrorStore(state => state.listings[machineId] !== undefined);
  return useConfigStore(state => rowShowsInstantly(machineId, state.config, () => isMirrored));
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
  useOrchestrationSessionStore.subscribe((state, prior) => {
    if (pending !== undefined && state.cursorSessionId !== pending) { clearTimer(); pending = undefined; }
    // So does a Session of this computer selected or shown: another machine's stops showing.
    if (state.selectedSessionId !== prior.selectedSessionId || (state.cursorSessionId && state.cursorSessionId !== prior.cursorSessionId)) clearRemoteSession();
  });
  useConfigStore.subscribe(state => {
    if (!cursorFollowEnabled(state.config)) dropSessionCursor();
  });
}

/**
 * This machine's record of a Session: from the Sessions list, or from the All machines
 * view's read of this machine while the list is still loading at startup or failed to load.
 */
function sessionRecord(sessionId: string): OrchestrationSessionSummary | undefined {
  return useOrchestrationSessionStore.getState().sessions.find(session => session.id === sessionId)
    ?? useAllMachinesStore.getState().snapshots[LOCAL_MACHINE_ID]?.sessions.find(session => session.id === sessionId);
}

/** A Session whose agent runs in a terminal keeps Enter (known once it was read). */
function isTerminalSession(sessionId: string): boolean {
  const entry = cachedSessionView(sessionId);
  if (entry) return entry.view.panel.type !== 'chat';
  const record = sessionRecord(sessionId);
  const agentPanel = record && usePanelStore.getState().panels[record.internalSessionId]?.find(panel => panel.id === record.panelIds[record.agent]);
  return agentPanel !== undefined && agentPanel.type !== 'chat';
}

/**
 * The sidebar cursor moved onto another machine's Session row (T-116 PR 6): show it, read-only.
 * Resting on it for a second engages it (PR 7, D-2): the window switches there and opens it.
 */
function showRemoteSessionAtCursor(machineId: string, sessionId: string): void {
  pending = undefined;
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'pane-chat') navigation.navigateToPaneChat();
  if (useSessionStore.getState().activeSessionId) void useSessionStore.getState().setActiveSession(null);
  // This computer's Session of the same id, if the cursor showed it, is not what it shows now.
  useOrchestrationSessionStore.getState().showAtCursor(undefined);
  showRemoteSession({ machineId, sessionId });
  armRestEngage({ machineId, sessionId });
}

/**
 * The sidebar cursor moved onto a chat Session's row: show it now, and settle on it
 * after SETTLE_MS unless the cursor moves on first. Another machine's row shows its
 * Session and engages it after the same rest.
 */
export function showSessionAtCursor(sessionId: string, machineId: string = windowMachineId()): void {
  listen();
  clearTimer();
  // The cursor moved: a rest on another machine's Session, or the switch it started, is off (D-6).
  cancelRemoteEngage({ machineId, sessionId });
  if (machineId !== windowMachineId()) { showRemoteSessionAtCursor(machineId, sessionId); return; }
  clearRemoteSession();
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
  const record = sessionRecord(sessionId);
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
  cancelRemoteEngage();
}

/**
 * Settle now on what the cursor shows, by itself (the rest, typing, focus leaving the
 * sidebar): it is selected and its agent started, but a paused chat stays paused. The open
 * says `resume: true` only when this window knows the chat is not paused; otherwise it says
 * `resume: false` and main decides from the tab itself (`isPaused`), starting a chat that is not.
 */
export function settleSessionCursor(): void {
  clearTimer();
  const sessionId = pending;
  pending = undefined;
  const sessions = useOrchestrationSessionStore.getState();
  // Only what the cursor still shows, with the setting on and the window on this machine.
  if (!sessionId || sessions.cursorSessionId !== sessionId || !cursorFollowEnabled()) return;
  void sessions.settle(sessionId, hostIdOf(useConfigStore.getState().config), { resume: chatPaused(sessionId) === false, record: sessionRecord(sessionId) }).catch(() => undefined);
}

/**
 * Whether the Session's chat is paused: from its record, its chat tab's own mark (idle auto-pause
 * marks only the chat tab, T-134 QA F-1) or its terminal tabs, as this window holds them, live
 * tabs before the cursor's peek. Undefined when this window holds neither its record nor its chat tab.
 */
function chatPaused(sessionId: string): boolean | undefined {
  const record = sessionRecord(sessionId);
  if (record?.paused) return true;
  const entry = cachedSessionView(sessionId);
  const live = record ? usePanelStore.getState().panels[record.internalSessionId] : undefined;
  const agentId = record ? record.panelIds[record.agent] : entry?.view.panel.id;
  const chat = live?.find(panel => panel.id === agentId) ?? (entry?.view.panel.id === agentId ? entry?.view.panel : undefined);
  if (chat && chatPausedMarkOf(chat)) return true;
  const panels = live ?? entry?.panels;
  if (panels && panePausedMark(panels)) return true;
  return chat?.type === 'chat' ? false : undefined;
}

/** Forget what the cursor shows without selecting it. */
export function dropSessionCursor(): void {
  clearTimer();
  pending = undefined;
  clearRemoteSession();
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
  clearRemoteSession();
  const sessions = useOrchestrationSessionStore.getState();
  // Already settled and shown (the cursor rested on it, then Enter): nothing to read again,
  // unless it settled by itself and a paused chat waits for this Enter or click to resume.
  if (sessionId === sessions.selectedSessionId && !sessions.cursorSessionId && sessions.quietSessionId !== sessionId
    && sessions.availability === 'ready' && !sessions.selectionError) return Promise.resolve();
  return sessions.settle(sessionId, hostIdOf(useConfigStore.getState().config), { record: sessionRecord(sessionId) });
}
