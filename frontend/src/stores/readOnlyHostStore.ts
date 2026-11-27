import { create } from 'zustand';
import type { ReadOnlyMark } from '../../../shared/types/accessLevel';
import { API } from '../utils/api';

/**
 * Whether the computer this window shows gives it read-only access. The host refuses every change
 * either way; this only hides the controls that make them. Controls that change something carry the
 * class `needs-full-access` (index.css); handlers without an element ask `isReadOnlyHost`.
 */
const useReadOnlyHostStore = create<{ readOnly: boolean }>(() => ({ readOnly: false }));

export function useReadOnlyHost(): boolean {
  return useReadOnlyHostStore((state) => state.readOnly);
}

export function isReadOnlyHost(): boolean {
  return useReadOnlyHostStore.getState().readOnly;
}

/** The connected computer's level changed: from the desktop's connection state, or the browser app's. */
export function setHostAccess(access: ReadOnlyMark | undefined): void {
  const readOnly = access === 'read';
  useReadOnlyHostStore.setState({ readOnly });
  if (!globalThis.document) return;
  if (readOnly) document.documentElement.dataset.hostAccess = 'read';
  else delete document.documentElement.dataset.hostAccess;
}

/** Follows the desktop's connection. Returns the unsubscribe. */
export function followHostAccess(): () => void {
  let pushed = false;
  const stop = API.remoteDaemon.onConnectionStateChanged((state) => {
    pushed = true;
    setHostAccess(state.mode === 'remote' ? state.access : undefined);
  });
  void API.remoteDaemon.getConnectionState().then((response) => {
    if (!pushed && response.success && response.data) setHostAccess(response.data.mode === 'remote' ? response.data.access : undefined);
  }).catch(() => undefined);
  return stop;
}
