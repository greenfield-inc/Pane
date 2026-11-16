import { create as createStore } from 'zustand';
import { Archive } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { API } from '../utils/api';
import { showActionError } from '../stores/errorStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import type { Session } from '../types/session';

type PaneToArchive = Pick<Session, 'id' | 'name' | 'isMainRepo' | 'worktreeOwnership'>;

const usePaneArchiveConfirmStore = createStore<{ pane: PaneToArchive | null }>(() => ({ pane: null }));

// A dialog opened for one host must never archive on another: a host change cancels it.
useOrchestrationSessionStore.subscribe((state, previous) => {
  if (state.hostRevision !== previous.hostRevision) usePaneArchiveConfirmStore.setState({ pane: null });
});

/** Asks before a sidebar archive of a Pane; the Pane is archived only when the person confirms. */
export function confirmPaneArchive(pane: PaneToArchive): void {
  usePaneArchiveConfirmStore.setState({ pane });
}

function worktreeLine(pane: PaneToArchive): string {
  if (pane.isMainRepo) return 'Its agents stop. The repository folder stays as it is.';
  if (pane.worktreeOwnership === 'external') return 'Its agents stop. The externally managed worktree stays as it is.';
  return 'Its agents stop and its git worktree is removed, uncommitted changes included.';
}

export function PaneArchiveConfirmDialog() {
  const pane = usePaneArchiveConfirmStore(state => state.pane);
  if (!pane) return null;

  const archive = async () => {
    try {
      const response = await API.sessions.delete(pane.id);
      if (!response.success) showActionError('Could not archive the Pane', response.error);
    } catch (cause) {
      showActionError('Could not archive the Pane', cause);
    }
  };

  return (
    <ConfirmDialog
      isOpen
      onClose={() => usePaneArchiveConfirmStore.setState({ pane: null })}
      onConfirm={() => void archive()}
      title={`Archive ${pane.name}?`}
      message={`${worktreeLine(pane)}\n\nYou can restore it from Archived at the bottom of the sidebar.`}
      confirmText="Archive"
      variant="warning"
      icon={<Archive className="h-6 w-6 flex-shrink-0 text-status-warning" />}
    />
  );
}
