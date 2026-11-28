import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../stores/sessionStore';

/**
 * Profiles there and back (T-63), like To-dos: the sidebar entry opens Profiles, and the same
 * entry, or Esc on the list, returns to the view, Pane and Session you left.
 */

let returnSessionId: string | undefined;

function openProfiles(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'profiles') returnSessionId = useOrchestrationSessionStore.getState().selectedSessionId;
  navigation.navigateToProfiles({ returnPaneId: useSessionStore.getState().activeSessionId });
}

/** Leaves Profiles for where you were. */
export function leaveProfiles(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'profiles') return;
  const sessionId = returnSessionId;
  returnSessionId = undefined;
  const back = navigation.leaveProfiles();
  const sessions = useSessionStore.getState();
  if (back.paneId !== sessions.activeSessionId) void sessions.setActiveSession(back.paneId);
  if (back.view === 'pane-chat' && sessionId && useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
    void useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => undefined);
  }
}

/** Leaves Profiles for Pane `paneId`'s own view, as opening an agent in a tab of that Pane does (T-83 P4). */
export async function leaveProfilesFor(paneId: string): Promise<void> {
  const navigation = useNavigationStore.getState();
  returnSessionId = undefined;
  if (navigation.activeView === 'profiles') navigation.leaveProfiles();
  useNavigationStore.getState().navigateToSessions();
  if (useSessionStore.getState().activeSessionId !== paneId) await useSessionStore.getState().setActiveSession(paneId);
}

/** The sidebar entry: opens Profiles, or, while it is open, returns to where you were. */
export function toggleProfiles(): void {
  if (useNavigationStore.getState().activeView !== 'profiles') openProfiles();
  else leaveProfiles();
}
