import { create as createStore } from 'zustand';
import { API } from '../utils/api';
import { showActionError } from '../stores/errorStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import type { Session } from '../types/session';

/** An archive waiting for the person to confirm it. */
export interface ArchiveRequest {
  /** Shown in the title, "Archive <name>?": the label the person clicked. */
  name: string;
  message: string;
  archive: () => Promise<void>;
  /** Takes focus on close when the control that opened the dialog is gone, such as a closed menu item. */
  returnFocus?: HTMLElement | null;
}

export const useArchiveConfirmStore = createStore<{ request: ArchiveRequest | null }>(() => ({ request: null }));

// A dialog opened for one host must never archive on another: a host change cancels it.
useOrchestrationSessionStore.subscribe((state, previous) => {
  if (state.hostRevision !== previous.hostRevision) useArchiveConfirmStore.setState({ request: null });
});

/** Opens the archive confirm; `archive` runs only when the person confirms. */
function confirmArchive(request: ArchiveRequest): void {
  useArchiveConfirmStore.setState({ request });
}

/** The name a Pane row shows: its pull request's title when it has one. */
function paneLabel(pane: Pick<Session, 'name' | 'gitStatus'>): string {
  return pane.gitStatus?.prTitle || pane.name || 'Untitled';
}

function paneArchiveEffect(pane: Pick<Session, 'isMainRepo' | 'worktreeOwnership'>): string {
  if (pane.isMainRepo) return 'Its agents stop. The repository folder stays as it is.';
  if (pane.worktreeOwnership === 'external') return 'Its agents stop. The externally managed worktree stays as it is.';
  return 'Its agents stop and its git worktree is removed, uncommitted changes included.';
}

/** Asks before archiving a Pane on this machine. */
export function confirmPaneArchive(pane: Session, options: { label?: string; returnFocus?: HTMLElement | null } = {}): void {
  confirmArchive({
    name: options.label ?? paneLabel(pane),
    message: `${paneArchiveEffect(pane)}\n\nYou can restore it from Archived at the bottom of the sidebar.`,
    returnFocus: options.returnFocus,
    archive: async () => {
      try {
        const response = await API.sessions.delete(pane.id);
        if (!response.success) showActionError('Could not archive the Pane', response.error);
      } catch (cause) {
        showActionError('Could not archive the Pane', cause);
      }
    },
  });
}

/** Asks before archiving a Pane or Session on another machine, from All machines. */
export function confirmMachineArchive(
  target: { kind: 'pane'; pane: Session } | { kind: 'session'; name: string },
  machineName: string,
  archive: () => Promise<void>,
  returnFocus?: HTMLElement | null,
): void {
  confirmArchive(target.kind === 'pane'
    ? { name: paneLabel(target.pane), message: `On ${machineName}: ${paneArchiveEffect(target.pane)}\n\nYou can restore it from Archived on that machine.`, archive, returnFocus }
    : { name: target.name || 'Untitled', message: `On ${machineName}: archiving this Session also archives its Panes. You can restore it from Archived on that machine.`, archive, returnFocus });
}
