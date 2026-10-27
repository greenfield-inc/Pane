import { create } from 'zustand';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../../shared/types/notify';

/**
 * The renderer's copy of main's Notify queue. Main owns every decision (what the
 * strip shows, where, what is docked); surfaces render this snapshot and send
 * commands back.
 */
interface NotifyState {
  snapshot: NotifySnapshot | null;
}

export const useNotifyStore = create<NotifyState>(() => ({ snapshot: null }));

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

export function runNotify(command: NotifyCommand): void {
  void window.electronAPI.notify.run(command)
    .catch((error) => console.error(`Notify command ${command.type} failed:`, error));
}

export function notifyItem(snapshot: NotifySnapshot | null, id: string | null | undefined): NotifyItem | undefined {
  if (!snapshot || !id) return undefined;
  return snapshot.items.find((item) => item.id === id);
}

/** Questions still waiting for an answer. Updates never count. */
export function waitingCount(snapshot: NotifySnapshot | null): number {
  return snapshot?.items.filter((item) => item.state === 'waiting').length ?? 0;
}

export function paneHasWaitingQuestion(snapshot: NotifySnapshot | null, paneId: string): boolean {
  return snapshot?.items.some((item) => item.state === 'waiting' && item.source.paneId === paneId) ?? false;
}
