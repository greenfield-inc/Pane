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
import { openOnMachine } from '../utils/machineRowActions';
import { handOverChatDraft, onChatTabShown } from '../utils/chatDraftHandover';
import { useAllMachinesStore, isMachineDimmed } from '../stores/allMachinesStore';
import { cachedRemoteSession, heldRemoteChat, remoteSessionKey } from '../stores/remoteSessionView';
import { chatTabViewer, firstPaintWindow } from '../../../shared/chatTabViewer';
import { switchMark } from '../../../shared/switchMarks';
import type { ChatTabClient } from '../../../shared/types/chatTab';

export type EngageCause = 'rest' | 'enter' | 'click' | 'type';

export interface EngageTarget {
  machineId: string;
  sessionId: string;
}

export interface Engaging extends EngageTarget {
  cause: EngageCause;
  /** The Session's chat tab, as the mirror holds it: the live one there that takes the text. */
  panelId?: string;
  /** The window is on that machine now; the mirror's view waits for its chat to paint. */
  switched: boolean;
}

/** What was typed into a Session of another machine and not delivered yet. */
export interface HeldText {
  text: string;
  /** Enter was pressed: the chat there sends it once it shows. */
  send: boolean;
}

interface RemoteEngageState {
  engaging?: Engaging;
  held: Record<string, HeldText>;
  /** Why the last engage of this Session did not open it; what was typed stays beside it. */
  failure?: EngageTarget & { message: string };
  /**
   * The engage landed and its restore is still finishing: the main area stays live (not dimmed or
   * inert) meanwhile, since the person is already typing in the chat there. App clears it once
   * the connection says connected.
   */
  settling?: boolean;
}

export const useRemoteEngage = create<RemoteEngageState>(() => ({ held: {} }));

/** How long the cursor rests on another machine's Session before it engages (D-2), as this computer's settle. */
export const REST_ENGAGE_MS = 1000;
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
    return held?.send ? { held: { ...state.held, [engageKey(target)]: { ...held, send: false } } } : {};
  });
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
    useRemoteEngage.setState({ held: { ...state.held, [key]: { ...state.held[key], send: true } } });
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
  shownMeanwhile.clear();
  const panelId = heldRemoteChat(cachedRemoteSession(target.machineId, target.sessionId))?.panelId;
  personMovedFocus = false;
  boxRestores = 0;
  useRemoteEngage.setState({ engaging: { ...target, cause, panelId, switched: false }, failure: undefined });
  switchMark('engage:start', { machineId: target.machineId, sessionId: target.sessionId, status: cause });
  const opening = openOnMachine(target.machineId, { kind: 'session', id: target.sessionId, name: sessionName(target) }, { quiet: cause === 'rest', reportErrors: false });
  notifySwitch(cause);
  void opening.then(outcome => {
    if (ticket !== engageTicket) return;
    if (outcome.kind === 'opened') {
      switched(target, panelId);
      return;
    }
    useRemoteEngage.setState({ engaging: undefined });
    if (outcome.kind === 'failed') {
      keepUnsent(target);
      useRemoteEngage.setState({ failure: { ...target, message: outcome.reason } });
    }
    switchMark('engage:end', { machineId: target.machineId, sessionId: target.sessionId, status: outcome.kind });
  });
}

/** The window is on the Session's machine: the chat there paints from what the mirror held, and takes over once it does. */
function switched(target: EngageTarget, panelId: string | undefined): void {
  const chat = heldRemoteChat(cachedRemoteSession(target.machineId, target.sessionId));
  // SAFETY: the window's own chat client is what the live chat tab reads through (ChatTabRoute).
  const liveClient = window.electronAPI?.chatTab as ChatTabClient | undefined;
  // The newest 30 only: drawing 200 there is a long task while the switch finishes (D-6); its own read brings the rest.
  if (chat && liveClient) chatTabViewer(liveClient, chat.panelId).prime(firstPaintWindow(chat), performance.now());
  useRemoteEngage.setState(state => (state.engaging ? { engaging: { ...state.engaging, switched: true } } : {}));
  switchMark('engage:switched', { machineId: target.machineId, sessionId: target.sessionId });
  if (panelId && shownMeanwhile.has(panelId)) {
    land();
    return;
  }
  // A Session whose agent runs in a terminal has no chat to paint: the view there takes over anyway.
  liveWait = setTimeout(() => { liveWait = undefined; land(); }, LIVE_VIEW_WAIT_MS);
}

let settleCap: ReturnType<typeof setTimeout> | undefined;
/** At most this long after landing does the main area stay live while the connection still says restoring. */
const SETTLE_CAP_MS = 5000;

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
  const { engaging, held } = useRemoteEngage.getState();
  if (!engaging) return;
  const key = engageKey(engaging);
  const text = held[key];
  const rest = { ...held };
  delete rest[key];
  // Ended first, so focus moving into the chat there is not taken back to the held box.
  useRemoteEngage.setState({ engaging: undefined, held: rest, settling: true });
  clearTimeout(settleCap);
  settleCap = setTimeout(endEngageSettling, SETTLE_CAP_MS);
  if (text && engaging.panelId) {
    handOverChatDraft(engaging.panelId, {
      text: text.text,
      selectionStart: text.text.length,
      selectionEnd: text.text.length,
      focused: true,
      send: text.send && !!text.text.trim(),
    });
  }
  switchMark('engage:end', { machineId: engaging.machineId, sessionId: engaging.sessionId, status: 'landed' });
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
  // Too late once the window is on that machine: the Session there stays open.
  if (!engaging.switched) void API.remoteDaemon.cancelSwitch(engaging.machineId).catch(() => undefined);
}

/** Whether an engage keeps the mirror's view of `target` on screen. */
export function isEngaging(target: EngageTarget): boolean {
  return sameTarget(useRemoteEngage.getState().engaging, target);
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
