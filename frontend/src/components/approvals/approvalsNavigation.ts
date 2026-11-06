import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';

/** Opens Approvals (on `itemId` when given), remembering the view and Pane to come back to. */
export function openApprovals(itemId?: string): void {
  useNavigationStore.getState().navigateToNotify({ itemId, returnPaneId: useSessionStore.getState().activeSessionId });
}

/** The badge: opens Approvals, or, while it is open, returns to the view you left. */
export function toggleApprovals(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'notify') {
    openApprovals();
    return;
  }
  const back = navigation.leaveApprovals();
  const sessions = useSessionStore.getState();
  // Selecting a worker's item shows its Pane; going back restores the Pane you were on.
  if (back.paneId !== sessions.activeSessionId) void sessions.setActiveSession(back.paneId);
}
