import { create as createStore } from 'zustand';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import type { OrchestrationSessionUpdateInput } from '../../../shared/types/orchestrationSession';

interface ArchivedSessionToast {
  sessionId: string;
  sessionName: string;
  wasOpen: boolean;
  /** The host that archived the Session; Undo is offered only while that host is current. */
  hostRevision: number;
}

/** The pending archive Undo, shared so the toast survives a switch between the rail and the tree. */
export const useArchivedSessionToastStore = createStore<{ toast: ArchivedSessionToast | null }>(() => ({ toast: null }));
export const setArchivedToast = (toast: ArchivedSessionToast | null) => useArchivedSessionToastStore.setState({ toast });
export const clearArchivedToast = () => setArchivedToast(null);

/**
 * Archives a Session and offers Undo. Archiving the open Session lands on Home
 * first, never on a Session the server or the auto-selection picks, so a person
 * who opens something else while the request is in flight keeps what they opened.
 * Throws when the host refuses.
 */
export async function archiveOrchestrationSession(sessionId: string, sessionName: string): Promise<void> {
  const before = useOrchestrationSessionStore.getState();
  const wasOpen = useNavigationStore.getState().activeView === 'pane-chat' && before.selectedSessionId === sessionId;
  if (wasOpen) {
    void useSessionStore.getState().setActiveSession(null);
    useNavigationStore.getState().navigateToSessions();
  }
  await before.update({ sessionId }, { archived: true } satisfies OrchestrationSessionUpdateInput);
  // A host switch during the request leaves nothing on the new host to undo.
  if (useOrchestrationSessionStore.getState().hostRevision !== before.hostRevision) return;
  setArchivedToast({ sessionId, sessionName, wasOpen, hostRevision: before.hostRevision });
  await useOrchestrationSessionStore.getState().refresh();
}

/** Pins or unpins a Session. Throws when the host refuses. */
export async function setOrchestrationSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
  const store = useOrchestrationSessionStore.getState();
  await store.update({ sessionId }, { isPinned } satisfies OrchestrationSessionUpdateInput);
  await store.refresh();
}
