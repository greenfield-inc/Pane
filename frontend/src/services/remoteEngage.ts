/**
 * Engaging another machine's Session from the mirror (T-116 PR 7, T-132).
 *
 * The sidebar cursor shows the owner's other machines' Sessions read-only (PR 6). Typing into its
 * message box, Enter, a click into it, or resting on its row for REST_ENGAGE_MS (D-2) engages it:
 * the window switches to that machine (#1770's fast, cancellable switch) and opens the Session
 * there. Arrows, shortcuts and Escape don't engage, and a new arrow press cancels a rest that has
 * not ended or a switch still running (D-6).
 *
 * While the switch runs the mirror's view stays on screen (`engaging`; App draws it over the main
 * area), and the person can keep typing into it. Once the live chat there paints, what was typed
 * goes into its own message box, once, with an Enter pressed meanwhile sending it there once. A
 * switch that fails, or a machine that is offline, keeps the text unsent beside the reason.
 *
 * A rest lands quietly: a paused chat there stays paused until the person types, presses Enter or
 * clicks (the same rule as this computer's Sessions, #1777).
 */
import { create } from 'zustand';
import { API } from '../utils/api';
import { cancelMachineOpen, openOnMachine } from '../utils/machineRowActions';
import { withdrawMachineSwitch } from '../hooks/useMachines';
import { showActionError } from '../stores/errorStore';
import { useWindowLink } from '../stores/windowLink';
import { chatDraftTakerMounted, handOverChatDraft, onChatDraftTaker, onChatTabShown } from '../utils/chatDraftHandover';
import { useAllMachinesStore, isMachineDimmed } from '../stores/allMachinesStore';
import { cachedRemoteSession, heldRemoteChat, remoteSessionKey } from '../stores/remoteSessionView';
import { chatTabViewer, firstPaintWindow } from '../../../shared/chatTabViewer';
import { switchMark } from '../../../shared/switchMarks';
import type { ChatTabClient } from '../../../shared/types/chatTab';
import type { LaunchDraft } from '../utils/launchOutline';

export type EngageCause = 'rest' | 'enter' | 'click' | 'type';

export interface EngageTarget {
  machineId: string;
  sessionId: string;
}

interface Engaging extends EngageTarget {
  cause: EngageCause;
  /** The Session's chat tab, as the mirror holds it: the live one there that takes the text. */
  panelId?: string;
  /** The window is on that machine now; the mirror's view waits for its chat to paint. */
  switched: boolean;
  /** Switched, but the link there isn't up: the held view stays, marked not sent yet (QA 1781 F-1). */
  waiting?: boolean;
}

/** What was typed into a Session of another machine and not delivered yet. */
export interface HeldText {
  text: string;
  /** Enter was pressed: the chat there sends it once it shows. */
  send: boolean;
  /** When Enter was pressed plus its window: a chat that takes it later shows it unsent (SF-4). */
  sendBy?: number;
}

interface RemoteEngageState {
  engaging?: Engaging;
  held: Record<string, HeldText>;
  /**
   * Why the last engage of this Session did not deliver what was typed, which stays beside it (the
   * kept bar over the main area, `keptEngage`): it failed, or (`pending`) the chat there hasn't
   * opened yet and takes it once it does.
   */
  failure?: EngageTarget & { message: string; panelId?: string; pending?: boolean };
  /**
   * The engage landed and its restore is still finishing: the main area stays live (not dimmed or
   * inert) meanwhile, since the person is already typing in the chat there. App clears it once
   * the connection says connected.
   */
  settling?: boolean;
}

export const useRemoteEngage = create<RemoteEngageState>(() => ({ held: {} }));

/** How long the cursor rests on another machine's Session before it engages (D-2), as this computer's settle. */
const REST_ENGAGE_MS = 1000;
/** How long, once the window is on that machine, the mirror's view waits for the chat there to paint. */
export const LIVE_VIEW_WAIT_MS = 3000;

export function engageKey(target: EngageTarget): string {
  return remoteSessionKey(target.machineId, target.sessionId);
}

function sameTarget(a: EngageTarget | undefined, b: EngageTarget | undefined): boolean {
  return !!a && !!b && a.machineId === b.machineId && a.sessionId === b.sessionId;
}

let restTimer: ReturnType<typeof setTimeout> | undefined;
let liveWait: ReturnType<typeof setTimeout> | undefined;
/** Each engage's number; a cancel or a newer engage makes an older one's outcome stale. */
let engageTicket = 0;
/** Chat tabs that painted since the current engage started, before its switch returned. */
const shownMeanwhile = new Set<string>();
let listening = false;
/** Whether the window's link is up (App says, from the connection state); a dead one keeps the hold. */
let linkUp = true;
/** Chat tabs whose live mount takes what was typed into their Session and not delivered yet. */
const undelivered = new Map<string, EngageTarget>();

/**
 * While an engage that was typed runs, a printable key that finds focus on nothing (the page body:
 * a view the switch replaced had it) still goes into the held text, and focus goes back to the
 * held box. No key typed meanwhile is lost.
 */
/** What the key handlers read of a keydown. */
type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'preventDefault'>;

function onStrayKey(event: KeyPress): void {
  const engaging = useRemoteEngage.getState().engaging;
  if (!engaging || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  event.preventDefault();
  holdRemoteText(engaging, (useRemoteEngage.getState().held[engageKey(engaging)]?.text ?? '') + event.key);
  const box = heldBox();
  if (box) {
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length + 1, box.value.length + 1);
  }
}

const DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/** The person moved focus themselves (a click, Tab, a shortcut) since the held box last had it. */
let personMovedFocus = false;
let boxRestores = 0;

function heldBox(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-testid="engage-hold"] textarea[data-remote-composer]');
}

/**
 * While an engage runs, the restore under the held view focuses what it reopens (a tab, a
 * button). Typing then went there and was lost (the rig). Focus the switch takes from the held box
 * goes back to it, as #1770's cursor hold does for the sidebar row; a click, Tab or a shortcut is
 * the person's own move and keeps it. An element that takes focus back a third time keeps it.
 */
function onFocusIn(event: FocusEvent): void {
  const engaging = useRemoteEngage.getState().engaging;
  const box = heldBox();
  if (!engaging || !box) return;
  if (event.target === box) { personMovedFocus = false; return; }
  // A dialog or menu that opened keeps focus (a first visit's welcome, a confirmation).
  if (event.target instanceof Element && event.target.closest(DIALOGS)) return;
  const previous = event.relatedTarget;
  if (previous !== box || personMovedFocus || boxRestores >= 2) return;
  boxRestores += 1;
  box.focus({ preventScroll: true });
  box.setSelectionRange(box.value.length, box.value.length);
}

function onPersonMoves(event: KeyPress | MouseEvent): void {
  if ('key' in event && !(event.key === 'Tab' || event.metaKey || event.ctrlKey || event.altKey)) return;
  personMovedFocus = true;
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', onStrayKey, true);
  window.addEventListener('keydown', onPersonMoves, true);
  window.addEventListener('mousedown', onPersonMoves, true);
  window.addEventListener('focusin', onFocusIn, true);
  onChatDraftTaker(panelId => {
    const target = undelivered.get(panelId);
    if (target) deliverHeld({ ...target, panelId }, { focused: false, sends: true });
  });
  onChatTabShown(panelId => {
    const engaging = useRemoteEngage.getState().engaging;
    if (!engaging || engaging.panelId !== panelId) return;
    if (engaging.switched) land();
    else shownMeanwhile.add(panelId);
  });
}

function machineState(machineId: string) {
  return useAllMachinesStore.getState().machines.find(machine => machine.id === machineId);
}

function machineName(machineId: string): string {
  return machineState(machineId)?.label ?? useAllMachinesStore.getState().entries.find(entry => entry.id === machineId)?.name ?? 'the other machine';
}

function sessionName(target: EngageTarget): string {
  const entry = cachedRemoteSession(target.machineId, target.sessionId);
  return entry?.read?.view?.session.name ?? entry?.snapshot?.session.name
    ?? useAllMachinesStore.getState().snapshots[target.machineId]?.sessions.find(session => session.id === target.sessionId)?.name
    ?? 'Session';
}

/** What was typed stays, no longer sending: Enter again tries again. */
function keepUnsent(target: EngageTarget): void {
  useRemoteEngage.setState(state => {
    const held = state.held[engageKey(target)];
    return held?.send ? { held: { ...state.held, [engageKey(target)]: { text: held.text, send: false } } } : {};
  });
}

/** The Session's chat tab as the mirror holds it now: the live one there that takes what was typed. */
function mirroredChatPanel(target: EngageTarget): string | undefined {
  return heldRemoteChat(cachedRemoteSession(target.machineId, target.sessionId))?.panelId;
}

/**
 * Whether typing on the Session's sidebar row goes into its message box (T-132): only when the
 * mirror holds its chat, so there is a box to show it in and a chat there to take it. Otherwise
 * the row keeps Enter, and no key is taken that nothing would show (review 1781 SF-3).
 */
export function takesTyping(target: EngageTarget): boolean {
  return mirroredChatPanel(target) !== undefined;
}

/** What `clickEngages` reads of a press in the read-only view. */
export interface ClickPress {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** It landed on a control of the view (Earlier messages, a link, a tab). */
  inControl: boolean;
}

/**
 * Whether a press into the read-only chat engages it (T-132): a plain left click, not one that
 * ends a text selection (`selected`), carries a modifier, or lands on a control (review 1781).
 */
export function clickEngages(press: ClickPress, selected: string): boolean {
  if (press.button !== 0 || press.metaKey || press.ctrlKey || press.shiftKey || press.altKey) return false;
  return selected.length === 0 && !press.inControl;
}

/** The cursor stays on another machine's Session: it engages after REST_ENGAGE_MS unless the cursor moves on. */
export function armRestEngage(target: EngageTarget): void {
  clearTimeout(restTimer);
  const shown = { ...target };
  restTimer = setTimeout(() => {
    restTimer = undefined;
    engageRemoteSession(shown, 'rest');
  }, REST_ENGAGE_MS);
}

/** The message box's text for another machine's Session, as typed. */
export function holdRemoteText(target: EngageTarget, text: string): void {
  useRemoteEngage.setState(state => {
    const key = engageKey(target);
    const held = { ...state.held };
    if (text) held[key] = { text, send: held[key]?.send ?? false };
    else delete held[key];
    return { held };
  });
}

/**
 * Switches the window to the Session's machine and opens it there, keeping the mirror's view on
 * screen meanwhile. A second engage of the Session already engaging only adds a pending Enter.
 */
export function engageRemoteSession(target: EngageTarget, cause: EngageCause, options: { send?: boolean } = {}): void {
  listen();
  clearTimeout(restTimer);
  restTimer = undefined;
  const key = engageKey(target);
  const state = useRemoteEngage.getState();
  if (options.send && state.held[key]?.text.trim()) {
    useRemoteEngage.setState({ held: { ...state.held, [key]: { ...state.held[key], send: true, sendBy: Date.now() + ENTER_WAITS_MS } } });
  }
  if (sameTarget(state.engaging, target)) return;
  const machine = machineState(target.machineId);
  if (!machine || machine.status !== 'online' || isMachineDimmed(machine)) {
    // Nothing to switch to. A rest says nothing: the view already marks the machine offline.
    if (cause !== 'rest') {
      keepUnsent(target);
      useRemoteEngage.setState({ failure: { ...target, message: `${machineName(target.machineId)} is offline, so nothing was sent. What you typed stays here until it is back.` } });
    }
    return;
  }
  const ticket = ++engageTicket;
  clearTimeout(liveWait);
  listen();
  shownMeanwhile.clear();
  const panelId = mirroredChatPanel(target);
  personMovedFocus = false;
  boxRestores = 0;
  useRemoteEngage.setState({ engaging: { ...target, cause, panelId, switched: false }, failure: undefined });
  switchMark('engage:start', { machineId: target.machineId, sessionId: target.sessionId, status: cause });
  // A dial that hangs (a dead link) says so: nothing is sent until the machine answers (QA 1781 F-1).
  liveWait = setTimeout(() => {
    liveWait = undefined;
    if (ticket === engageTicket) useRemoteEngage.setState(state => (state.engaging && !state.engaging.switched ? { engaging: { ...state.engaging, waiting: true } } : {}));
  }, LIVE_VIEW_WAIT_MS);
  const opening = openOnMachine(target.machineId, { kind: 'session', id: target.sessionId, name: sessionName(target) }, { quiet: cause === 'rest', reportErrors: false });
  notifySwitch(cause);
  void opening.then(outcome => {
    if (ticket !== engageTicket) return;
    if (outcome.kind === 'opened') {
      switched(target, panelId);
      return;
    }
    useRemoteEngage.setState({ engaging: undefined });
    if (outcome.kind === 'here') {
      // The window is on that machine already (Enter in the kept bar): the chat there takes it as it opens.
      deliverHeld({ ...target, panelId }, { focused: true, sends: true });
    } else if (outcome.kind === 'failed') {
      // It stays in the kept bar with why, and the chat there takes it, unsent, whenever it next opens live.
      keepUnsent(target);
      const chat = panelId ?? mirroredChatPanel(target);
      if (chat) undelivered.set(chat, target);
      useRemoteEngage.setState({ failure: { ...target, panelId: chat, message: outcome.reason } });
    }
    switchMark('engage:end', { machineId: target.machineId, sessionId: target.sessionId, status: outcome.kind });
  });
}

/** The window is on the Session's machine: the chat there paints from what the mirror held, and takes over once it does. */
function switched(target: EngageTarget, engagedPanelId: string | undefined): void {
  // The mirror may have learned the chat during the switch (its peek landed meanwhile).
  const panelId = engagedPanelId ?? mirroredChatPanel(target);
  const chat = heldRemoteChat(cachedRemoteSession(target.machineId, target.sessionId));
  // SAFETY: the window's own chat client is what the live chat tab reads through (ChatTabRoute).
  const liveClient = window.electronAPI?.chatTab as ChatTabClient | undefined;
  // The newest few only: the chat mounts there with its whole Session's workspace under the held
  // view, and drawing more is a long task while the switch finishes (D-6); its own read brings the rest.
  if (chat && liveClient) chatTabViewer(liveClient, chat.panelId).prime(firstPaintWindow(chat, LIVE_FIRST_PAINT_MESSAGES), performance.now());
  useRemoteEngage.setState(state => (state.engaging ? { engaging: { ...state.engaging, panelId, switched: true, waiting: false } } : {}));
  switchMark('engage:switched', { machineId: target.machineId, sessionId: target.sessionId });
  if (panelId && shownMeanwhile.has(panelId)) {
    land();
    return;
  }
  armLiveWait();
}

/**
 * The chat there gets LIVE_VIEW_WAIT_MS to paint. With the link up the view there takes over anyway
 * (a Session whose agent runs in a terminal has no chat to paint); with it down the held view stays,
 * marked not sent yet, until the link is back (QA 1781 F-1).
 */
function armLiveWait(): void {
  clearTimeout(liveWait);
  liveWait = setTimeout(() => {
    liveWait = undefined;
    if (linkUp) land();
    else useRemoteEngage.setState(state => (state.engaging ? { engaging: { ...state.engaging, waiting: true } } : {}));
  }, LIVE_VIEW_WAIT_MS);
}

/** The window's link is up or down (App, from the connection state): a hold waiting on it resumes once it is up. */
export function setEngageLinkUp(up: boolean): void {
  if (useWindowLink.getState().up !== up) useWindowLink.setState({ up });
  if (linkUp === up) return;
  linkUp = up;
  const engaging = useRemoteEngage.getState().engaging;
  if (up && engaging?.switched && !liveWait) {
    useRemoteEngage.setState({ engaging: { ...engaging, waiting: false } });
    armLiveWait();
  }
}

/** What the kept bar shows: text typed into a Session and not delivered, with why; none while an engage runs. */
export function keptEngage(state: RemoteEngageState): (EngageTarget & { text: string; message: string; pending: boolean; sendsBy?: number }) | undefined {
  const failure = state.failure;
  if (!failure || state.engaging) return undefined;
  const held = state.held[engageKey(failure)];
  if (!held) return undefined;
  const kept = { machineId: failure.machineId, sessionId: failure.sessionId, text: held.text, message: failure.message, pending: failure.pending === true };
  // An Enter waiting: the bar says whether it still sends, which depends on its deadline.
  return held.send && held.sendBy !== undefined ? { ...kept, sendsBy: held.sendBy } : kept;
}

/** The person cleared the kept bar's text themselves. */
export function dismissKept(): void {
  const failure = useRemoteEngage.getState().failure;
  if (failure?.panelId) undelivered.delete(failure.panelId);
  useRemoteEngage.setState({ failure: undefined });
}

/** Messages the chat there first draws when an engage lands. */
const LIVE_FIRST_PAINT_MESSAGES = 8;
/** How long an Enter pressed during the switch waits for the chat there to be able to send it. */
const ENTER_WAITS_MS = 60_000;
let settleCap: ReturnType<typeof setTimeout> | undefined;
/** At most this long after landing does the main area stay live while the connection still says restoring. */
const SETTLE_CAP_MS = 5000;

/**
 * Whether an engage that landed has settled (App ends `settling`): the window's connection says
 * connected, or the window is on this computer, which has no connection to wait for (review 1781).
 */
export function engageSettled(connection: { mode: string; status: string }, presence: string): boolean {
  if (connection.mode !== 'remote') return true;
  return presence === 'connected' && connection.status === 'connected';
}

/** The connection says connected (or the cap passed): the main area dims again when it drops. */
export function endEngageSettling(): void {
  clearTimeout(settleCap);
  settleCap = undefined;
  if (useRemoteEngage.getState().settling) useRemoteEngage.setState({ settling: false });
}

/** The live view took over: what was typed goes into the chat there once, and the mirror's view goes. */
function land(): void {
  clearTimeout(liveWait);
  liveWait = undefined;
  const { engaging } = useRemoteEngage.getState();
  if (!engaging) return;
  // Ended first, so focus moving into the chat there is not taken back to the held box.
  useRemoteEngage.setState({ engaging: undefined, settling: true });
  clearTimeout(settleCap);
  settleCap = setTimeout(endEngageSettling, SETTLE_CAP_MS);
  deliverHeld(engaging, { focused: true, sends: true });
  switchMark('engage:end', { machineId: engaging.machineId, sessionId: engaging.sessionId, status: 'landed' });
}

/**
 * What was typed into the Session goes into its chat there, once: focused when the person is
 * still on it, and sending a pending Enter only when `sends`. With no chat to take it (a Session
 * the mirror holds no chat for) it stays held, unsent, and the person is told where it is: typed
 * text is never dropped (review 1781 SF-3).
 */
function deliverHeld(engaging: EngageTarget & { panelId?: string }, { focused, sends }: { focused: boolean; sends: boolean }): void {
  const target = { machineId: engaging.machineId, sessionId: engaging.sessionId };
  const key = engageKey(target);
  const text = useRemoteEngage.getState().held[key];
  if (!text) return;
  const panelId = engaging.panelId ?? mirroredChatPanel(target);
  if (!panelId) {
    keepUnsent(target);
    const message = `Not sent: ${sessionName(target)} on ${machineName(target.machineId)} has no chat to take what you typed. It is kept with this Session's row: "${text.text}".`;
    useRemoteEngage.setState({ failure: { ...target, message } });
    showActionError('What you typed was not sent', message);
    return;
  }
  if (!sends) keepUnsent(target);
  if (!chatDraftTakerMounted(panelId)) {
    // The chat there isn't open live (the link is down, or the person moved on): the text stays
    // visible in the kept bar, and that chat takes it once as it opens.
    undelivered.set(panelId, target);
    useRemoteEngage.setState({ failure: { ...target, panelId, pending: true, message: `Not sent yet: it goes into ${sessionName(target)}'s message box on ${machineName(target.machineId)} once that chat opens.` } });
    return;
  }
  undelivered.delete(panelId);
  const latest = useRemoteEngage.getState().held[key] ?? text;
  useRemoteEngage.setState(state => {
    const rest = { ...state.held };
    delete rest[key];
    return { held: rest, failure: state.failure && engageKey(state.failure) === key ? undefined : state.failure };
  });
  const draft: LaunchDraft = {
    text: latest.text,
    selectionStart: latest.text.length,
    selectionEnd: latest.text.length,
    focused,
    send: sends && latest.send && !!latest.text.trim(),
    // The link may still be catching up after the switch: the Enter waits for the chat to be able to send.
    sendBy: latest.sendBy ?? Date.now() + ENTER_WAITS_MS,
  };
  // Not where the person is typing: the chat says why the text is there unsent.
  if (!focused) draft.note = 'Not sent yet: you typed this while the window switched to this machine. Press Enter to send it.';
  handOverChatDraft(panelId, draft);
}

/**
 * An arrow press (D-6): the rest that has not ended starts nothing, and a switch still running is
 * cancelled, so the window stays where it is. What was typed waits for the cursor to come back.
 */
export function cancelRemoteEngage(): void {
  clearTimeout(restTimer);
  restTimer = undefined;
  const { engaging } = useRemoteEngage.getState();
  if (!engaging) return;
  engageTicket += 1;
  clearTimeout(liveWait);
  liveWait = undefined;
  keepUnsent(engaging);
  useRemoteEngage.setState({ engaging: undefined });
  switchMark('engage:cancel', { machineId: engaging.machineId, sessionId: engaging.sessionId, status: engaging.switched ? 'after-switch' : 'switching' });
  if (engaging.switched) {
    // Too late once the window is on that machine: the Session there stays open, and its chat
    // takes what was typed, unsent, since the window's rows there are its own now (review 1781 SF-3).
    deliverHeld(engaging, { focused: false, sends: false });
    return;
  }
  // The open may not have reached the switch yet (an arrow within an IPC round trip): it starts
  // none, and a switch queued behind another is withdrawn (review 1781 SF-2). One already running
  // is stopped in main.
  cancelMachineOpen();
  withdrawMachineSwitch(engaging.machineId);
  void API.remoteDaemon.cancelSwitch(engaging.machineId).catch(() => undefined);
}

const switchListeners = new Set<(cause: EngageCause) => void>();
/** The sidebar keeps its cursor through a switch an engage started (regionFocus). */
export function onEngageSwitch(listener: (cause: EngageCause) => void): () => void {
  switchListeners.add(listener);
  return () => { switchListeners.delete(listener); };
}
function notifySwitch(cause: EngageCause): void {
  for (const listener of switchListeners) listener(cause);
}
