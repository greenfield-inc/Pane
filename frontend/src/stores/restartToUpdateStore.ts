import { useEffect } from 'react';
import { create } from 'zustand';
import { showActionError } from './errorStore';
import type { IPCResponse } from '../utils/api';
import type { RestartToUpdateSource, RestartToUpdateState, UpdateRestoreResult } from '../../../shared/types/updater';

interface RestartToUpdateStore {
  /** Main's restart-to-update state; null until the first read. */
  state: RestartToUpdateState | null;
  /** The user opened the toast from the pill. */
  pillToastOpen: boolean;
  /** Set on the launch after a restart to update, until its toast is dismissed. */
  restoreResult: UpdateRestoreResult | null;
  togglePillToast: () => void;
  closePillToast: () => void;
  showRestoreResult: (result: UpdateRestoreResult | null) => void;
}

export const useRestartToUpdateStore = create<RestartToUpdateStore>((set) => ({
  state: null,
  pillToastOpen: false,
  restoreResult: null,
  togglePillToast: () => set(current => ({ pillToastOpen: !current.pillToastOpen })),
  closePillToast: () => set({ pillToastOpen: false }),
  showRestoreResult: (restoreResult) => set({ restoreResult }),
}));

function applyState(state: RestartToUpdateState): void {
  useRestartToUpdateStore.setState(current => ({
    state,
    // Nothing left to restart into, so a pill-opened toast has nothing to say.
    pillToastOpen: current.pillToastOpen && state.readyVersion !== null,
  }));
}

/** Loads main's state and follows its changes, so the pill survives renderer reloads. Call once, from the app shell. */
export function useRestartToUpdateSync(): void {
  useEffect(() => {
    const updater = window.electronAPI?.updater;
    if (!updater?.getRestartState) return;
    let cancelled = false;
    void updater.getRestartState()
      .then(response => {
        if (!cancelled && response.success && response.data) applyState(response.data);
      })
      .catch(error => console.warn('[restartToUpdate] Failed to read the update state:', error));
    const removeListener = window.electronAPI.events.onRestartToUpdateState?.(applyState);
    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, []);
}

async function runStateAction(
  failureTitle: string,
  action: () => Promise<IPCResponse<RestartToUpdateState>>,
): Promise<void> {
  try {
    const response = await action();
    if (!response.success) {
      showActionError(failureTitle, response);
      return;
    }
    if (response.data) applyState(response.data);
  } catch (error) {
    showActionError(failureTitle, error);
  }
}

export function snoozeRestartToUpdate(): Promise<void> {
  return runStateAction('Could not hide the update reminder', () => window.electronAPI.updater.snooze());
}

export function setRestartTonight(enabled: boolean): Promise<void> {
  return runStateAction(
    enabled ? 'Could not schedule the restart for tonight' : 'Could not cancel tonight\'s restart',
    () => window.electronAPI.updater.setTonight(enabled),
  );
}

export async function restartToUpdate(source: RestartToUpdateSource): Promise<void> {
  try {
    const response = await window.electronAPI.updater.restartToUpdate(source);
    if (!response.success) showActionError('Could not restart to update', response);
  } catch (error) {
    showActionError('Could not restart to update', error);
  }
}
