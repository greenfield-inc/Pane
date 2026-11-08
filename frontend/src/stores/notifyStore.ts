import { create } from 'zustand';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import { showActionError } from './errorStore';

/**
 * The renderer's copy of main's Notify queue. Main owns every decision (what the
 * strip shows, where, what is docked); surfaces render this snapshot and send
 * commands back.
 */
interface NotifyState {
  snapshot: NotifySnapshot | null;
}

export const useNotifyStore = create<NotifyState>(() => ({ snapshot: null }));

const NO_ITEMS: readonly NotifyItem[] = [];

/** Every item, or one shared empty list before the first snapshot: a fresh `[]` per read would re-render forever. */
export function selectNotifyItems(state: NotifyState): readonly NotifyItem[] {
  return state.snapshot?.items ?? NO_ITEMS;
}

/** Keeps the store in step with main. Returns the unsubscribe. */
export function subscribeNotify(): () => void {
  const api = window.electronAPI?.notify;
  if (!api) return () => undefined;
  let pushed = false;
  const unsubscribe = api.onSnapshot((snapshot) => {
    pushed = true;
    useNotifyStore.setState({ snapshot });
  });
  void api.getSnapshot()
    .then((snapshot) => {
      // A push that arrived first is newer than this read.
      if (!pushed) useNotifyStore.setState({ snapshot });
    })
    .catch((error) => console.error('Failed to read the Notify queue:', error));
  return unsubscribe;
}

/** The title a refused card command shows under; commands nobody waits on fail quietly. */
function failedTitle(type: NotifyCommand['type']): string | undefined {
  switch (type) {
    case 'answer': return 'Your answer was not sent';
    case 'override': return 'Your correction was not sent';
    case 'close': return 'Could not close this approval';
    case 'reopen': return 'Could not reopen this approval';
    case 'undo': return 'Could not undo your answer';
    default: return undefined;
  }
}

/** Runs a card's command; a refusal (asker gone, machine offline, already answered) shows the person why. */
export function runNotify(command: NotifyCommand): void {
  void window.electronAPI.notify.run(command)
    .catch((error) => {
      console.error(`Notify command ${command.type} failed:`, error);
      const title = failedTitle(command.type);
      if (title) showActionError(title, error);
    });
}

export function notifyItem(snapshot: NotifySnapshot | null, id: string | null | undefined): NotifyItem | undefined {
  if (!snapshot || !id) return undefined;
  return snapshot.items.find((item) => item.id === id);
}

/**
 * An item the person can answer now: what every count counts. A stale item waits in its own group,
 * an offline machine's collapses to one row, and a mirror from an older machine takes no answer.
 */
export function countsAsWaiting(item: NotifyItem): boolean {
  return item.state === 'waiting' && !item.unreachable && item.staleSince === undefined && !item.relay;
}

/** Questions still waiting for an answer. Updates never count. */
export function waitingCount(snapshot: NotifySnapshot | null): number {
  return snapshot?.items.filter(countsAsWaiting).length ?? 0;
}

/**
 * How many items from this Session (its orchestrator, worker prompts, fallback items) wait on you;
 * with `machineId`, only that machine's (`local` for this computer).
 */
export function sessionWaitingCount(snapshot: NotifySnapshot | null, sessionId: string, machineId?: string): number {
  return snapshot?.items.filter((item) => countsAsWaiting(item) && item.source.session?.id === sessionId
    && (machineId === undefined || (item.machineId ?? 'local') === machineId)).length ?? 0;
}

/** Waiting items from machines other than the one the app is on (`local` for this computer). */
export function waitingElsewhere(snapshot: NotifySnapshot | null, activeMachineId: string): number {
  return snapshot?.items.filter((item) => countsAsWaiting(item) && (item.machineId ?? 'local') !== activeMachineId).length ?? 0;
}

export function paneHasWaitingQuestion(snapshot: NotifySnapshot | null, paneId: string): boolean {
  return snapshot?.items.some((item) => countsAsWaiting(item) && item.source.paneId === paneId) ?? false;
}
