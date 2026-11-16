import { create as createStore } from 'zustand';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useLoopsStore } from '../stores/loopsStore';
import type { Loop } from '../../../shared/types/loop';
import type {
  OrchestrationSessionArchivedPanes,
  OrchestrationSessionArchivePane,
  OrchestrationSessionUpdateInput,
} from '../../../shared/types/orchestrationSession';

interface ArchivedSessionToast {
  sessionId: string;
  sessionName: string;
  wasOpen: boolean;
  /** The host that archived the Session; Undo is offered only while that host is current. */
  hostRevision: number;
  /** What the host did with each Pane; Undo restores `archivedPaneIds`. */
  panes: OrchestrationSessionArchivedPanes;
  /** The loops archiving paused because they send to this Session; Undo resumes them. */
  pausedLoops: Array<{ id: string; name: string }>;
}

/**
 * What to archive. `keep` archives the Session and its Panes without work in progress, keeping any
 * that have some (the plain confirm, with none, sends `keep`); `archive` takes those Panes too.
 */
type ArchiveChoice = 'keep' | 'archive';

/** Archiving a Session waits on the person's choice here. */
export interface SessionArchiveConfirm {
  sessionName: string;
  /** "standup runs here daily at 7:30 AM. …": what archiving does to the loops that send here. */
  loopNote?: string;
  /** Every Pane the archive would take along; `blocked` marks the ones with work in progress. */
  panes: OrchestrationSessionArchivePane[];
  choose: (choice: ArchiveChoice | null) => void;
}

export const useSessionArchiveConfirmStore = createStore<{ confirm: SessionArchiveConfirm | null }>(() => ({ confirm: null }));

// A dialog opened for one host must never act on another: a host change cancels it.
useOrchestrationSessionStore.subscribe((state, previous) => {
  if (state.hostRevision !== previous.hostRevision) useSessionArchiveConfirmStore.getState().confirm?.choose(null);
});

function askArchive(sessionName: string, panes: OrchestrationSessionArchivePane[], loopNote: string | undefined): Promise<ArchiveChoice | null> {
  // A second archive replaces a dialog still open, which then counts as cancelled.
  useSessionArchiveConfirmStore.getState().confirm?.choose(null);
  return new Promise(resolve => {
    useSessionArchiveConfirmStore.setState({
      confirm: {
        sessionName,
        loopNote,
        panes,
        choose: choice => {
          useSessionArchiveConfirmStore.setState(state => state.confirm?.panes === panes ? { confirm: null } : state);
          resolve(choice);
        },
      },
    });
  });
}

/** The pending archive Undo, shared so the toast survives a switch between the rail and the tree. */
export const useArchivedSessionToastStore = createStore<{ toast: ArchivedSessionToast | null }>(() => ({ toast: null }));
export const setArchivedToast = (toast: ArchivedSessionToast | null) => useArchivedSessionToastStore.setState({ toast });
export const clearArchivedToast = () => setArchivedToast(null);

/**
 * Archives a Session with its Panes and offers Undo. The person confirms first; when a Pane has work
 * in progress (an agent mid-turn or waiting, unsent input, unsaved work), they choose to archive it
 * too or keep it open, or cancel. The host archives only the Panes the person approved, and keeps one
 * that was safe in the preview but no longer is. Archiving the open Session lands on Home first,
 * never on a Session the server or the auto-selection picks, so a person who opens something else
 * while the request is in flight keeps what they opened. Throws when the host refuses.
 */
/** What archiving a Session does to the loops that send to it: each pauses, so no run restores it. */
function loopArchiveNote(loops: readonly Loop[]): string | undefined {
  if (loops.length === 0) return undefined;
  const runs = loops.map(loop => `${loop.name} runs here ${loop.scheduleText.charAt(0).toLowerCase()}${loop.scheduleText.slice(1)}`).join('; ');
  const one = loops.length === 1;
  return `${runs}. Archiving the Session pauses ${one ? 'the loop' : 'those loops'}; resume ${one ? 'it' : 'them'} on the Loops page to bring the Session back.`;
}

export async function archiveOrchestrationSession(sessionId: string, sessionName: string): Promise<void> {
  const before = useOrchestrationSessionStore.getState();
  const hostChanged = () => useOrchestrationSessionStore.getState().hostRevision !== before.hostRevision;
  const preview = await API.orchestrationSessions.archivePreview({ sessionId });
  if (!preview.success || !preview.data) throw new Error(preview.error ?? 'Could not check the Session\'s Panes');
  if (hostChanged()) return;
  const { panes } = preview.data;
  const loops = useLoopsStore.getState().loops.filter(loop => loop.enabled && loop.orchestrationSessionId === sessionId);
  const choice = await askArchive(sessionName, panes, loopArchiveNote(loops));
  if (!choice || hostChanged()) return;
  const wasOpen = useNavigationStore.getState().activeView === 'pane-chat' && useOrchestrationSessionStore.getState().selectedSessionId === sessionId;
  if (wasOpen) {
    void useSessionStore.getState().setActiveSession(null);
    useNavigationStore.getState().navigateToSessions();
  }
  const response = await API.orchestrationSessions.archive({ sessionId }, {
    archivePaneIds: panes.filter(pane => !pane.blocked).map(pane => pane.paneId),
    forcePaneIds: choice === 'archive' ? panes.filter(pane => pane.blocked).map(pane => pane.paneId) : [],
  });
  if (!response.success || !response.data) throw new Error(response.error ?? 'Failed to archive Session');
  // A host switch during the request leaves nothing on the new host to undo.
  if (hostChanged()) return;
  const { archivedPaneIds, keptPanes, failedPanes } = response.data;
  for (const loop of loops) await useLoopsStore.getState().setEnabled(loop.id, false);
  const pausedLoops = loops.map(loop => ({ id: loop.id, name: loop.name }));
  setArchivedToast({ sessionId, sessionName, wasOpen, hostRevision: before.hostRevision, panes: { archivedPaneIds, keptPanes, failedPanes }, pausedLoops });
  await useOrchestrationSessionStore.getState().refresh();
}

/** Restores the Panes a Session archive took along. Throws naming the ones that could not be restored. */
export async function restoreArchivedPanes(paneIds: string[]): Promise<void> {
  const failures: string[] = [];
  for (const paneId of paneIds) {
    const response = await API.sessions.restore(paneId);
    if (!response.success) failures.push(response.error ?? paneId);
  }
  if (failures.length > 0) {
    throw new Error(`The Session is back, but ${failures.length === 1 ? 'a Pane' : `${failures.length} Panes`} could not be restored: ${failures.join('; ')}. Restore them from the repository's Archived list.`);
  }
}

/** Pins or unpins a Session. Throws when the host refuses. */
export async function setOrchestrationSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
  const store = useOrchestrationSessionStore.getState();
  await store.update({ sessionId }, { isPinned } satisfies OrchestrationSessionUpdateInput);
  await store.refresh();
}
