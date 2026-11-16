import { create as createStore } from 'zustand';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import type { Session } from '../types/session';

export type PaneToArchive = Pick<Session, 'id' | 'name' | 'isMainRepo' | 'worktreeOwnership'>;

/** The Pane waiting for the person to confirm its sidebar archive. */
export const usePaneArchiveConfirmStore = createStore<{ pane: PaneToArchive | null }>(() => ({ pane: null }));

// A dialog opened for one host must never archive on another: a host change cancels it.
useOrchestrationSessionStore.subscribe((state, previous) => {
  if (state.hostRevision !== previous.hostRevision) usePaneArchiveConfirmStore.setState({ pane: null });
});

/** Asks before a sidebar archive of a Pane; the Pane is archived only when the person confirms. */
export function confirmPaneArchive(pane: PaneToArchive): void {
  usePaneArchiveConfirmStore.setState({ pane });
}
