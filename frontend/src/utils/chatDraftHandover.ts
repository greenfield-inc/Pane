import type { LaunchDraft } from './launchOutline';
import { showActionError } from '../stores/errorStore';

/**
 * Hands a message box's text to a chat tab once (T-132): what was typed into another machine's
 * Session while the window switched to it goes into that chat's own box there, with its caret,
 * focus, and an Enter pressed meanwhile, which the chat then sends once (as the launch outline's
 * box does, D-62). A chat that is already mounted takes it at once; otherwise the next one to mount
 * with that tab takes it. Each tab keeps its own waiting handover, so one never drops another's.
 *
 * An Enter carries an absolute deadline (`sendBy`): a chat that takes it later shows the text
 * unsent with why, never sends it late, and one that nobody takes by then tells the person
 * (review 1781 SF-4).
 */

const takers = new Map<string, (draft: LaunchDraft) => void>();
/** A handover no chat has taken yet, and the timer that says so once its Enter's deadline passes. */
interface WaitingDraft {
  draft: LaunchDraft;
  expiry?: ReturnType<typeof setTimeout>;
}

const waiting = new Map<string, WaitingDraft>();
const shownListeners = new Set<(panelId: string) => void>();

/** When the chat must have sent `draft`'s Enter by: its own deadline, or `defaultMs` from now. */
export function sendDeadline(draft: LaunchDraft, defaultMs: number): number {
  return draft.sendBy ?? Date.now() + defaultMs;
}

function take(panelId: string, taker: (draft: LaunchDraft) => void): void {
  const entry = waiting.get(panelId);
  if (!entry) return;
  waiting.delete(panelId);
  clearTimeout(entry.expiry);
  taker(entry.draft);
}

const takerListeners = new Set<(panelId: string) => void>();

/** Whether a live chat tab for `panelId` is mounted, so a handover reaches it now. */
export function chatDraftTakerMounted(panelId: string): boolean {
  return takers.has(panelId);
}

/** Calls `listener` with each live chat tab that mounts and can take a draft; returns the unsubscribe. */
export function onChatDraftTaker(listener: (panelId: string) => void): () => void {
  takerListeners.add(listener);
  return () => { takerListeners.delete(listener); };
}

/** What a chat does next with an Enter handed to it (`launchSend`): send it now, keep waiting, or give up and why. */
export function pendingSendStep(pending: { until: number }, { edited, now, sendDisabled, linkUp }: { edited: boolean; now: number; sendDisabled: boolean; linkUp: boolean }): 'send' | 'wait' | 'edited' | 'expired' {
  if (edited) return 'edited';
  if (now > pending.until) return 'expired';
  // The window's link isn't up yet (a switch still restoring): main would refuse the send.
  if (sendDisabled || !linkUp) return 'wait';
  return 'send';
}

/** A chat tab that can take a handed-over draft; returns its cleanup. */
export function acceptChatDraft(panelId: string, taker: (draft: LaunchDraft) => void): () => void {
  takers.set(panelId, taker);
  take(panelId, taker);
  for (const listener of takerListeners) listener(panelId);
  return () => {
    if (takers.get(panelId) === taker) takers.delete(panelId);
  };
}

/** Gives `draft` to the chat tab `panelId`: now, or when it mounts. Each handover is taken once. */
export function handOverChatDraft(panelId: string, draft: LaunchDraft): void {
  const previous = waiting.get(panelId);
  if (previous) clearTimeout(previous.expiry);
  waiting.delete(panelId);
  const taker = takers.get(panelId);
  if (taker) {
    taker(draft);
    return;
  }
  const entry: WaitingDraft = { draft };
  if (draft.send && draft.sendBy !== undefined) {
    // Nobody took it in time: it stays waiting, unsent, and the person hears why now, not when the chat next shows.
    entry.expiry = setTimeout(() => {
      if (waiting.get(panelId) !== entry) return;
      entry.expiry = undefined;
      showActionError('Your message was not sent', 'The chat could not take it in time. It waits in that chat\'s message box: open the chat and press Enter to send it.');
    }, Math.max(0, draft.sendBy - Date.now()));
  }
  waiting.set(panelId, entry);
}

/** A live chat tab (not one shown read-only from another machine) painted its conversation. */
export function chatTabShown(panelId: string): void {
  for (const listener of shownListeners) listener(panelId);
}

/** Calls `listener` with each live chat tab that paints; returns the unsubscribe. */
export function onChatTabShown(listener: (panelId: string) => void): () => void {
  shownListeners.add(listener);
  return () => { shownListeners.delete(listener); };
}
