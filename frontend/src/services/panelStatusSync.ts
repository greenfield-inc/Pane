import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { usePanelStore } from '../stores/panelStore';
import { useSessionStore } from '../stores/sessionStore';
import { rollupSessionAgentState } from '../utils/agentStatus';

const statusSnapshotSchema = boundary.object({
  success: boundary.literal(true),
  data: boundary.array(boundary.object({
    sessionId: boundary.string,
    panelId: boundary.string,
    state: boundary.enumeration('blocked', 'working', 'idle', 'unknown'),
  })),
});

/** Subscribe before requesting the baseline; events during a read always win. */
export function subscribePanelStatus(): () => void {
  const api = window.electronAPI;
  let disposed = false;
  let requestId = 0;
  let changedDuringRead = new Set<string>();
  const deleted = new Set<string>();

  const unsubscribeStatus = api.events.onPanelAgentStatus?.(data => {
    changedDuringRead.add(data.panelId);
    if (deleted.has(data.panelId)) return;
    if (data.reason === 'exit' || data.reason === 'destroyed') {
      // Rebaseline notification subscribers atomically, as with a snapshot.
      // A stopped process must not become an unseen completed agent turn.
      usePanelStore.setState(state => ({
        agentStatus: { ...state.agentStatus, [data.panelId]: data.state },
        agentStatusSession: { ...state.agentStatusSession, [data.panelId]: data.sessionId },
        agentStatusSnapshotVersion: state.agentStatusSnapshotVersion + 1,
      }));
      return;
    }
    const store = usePanelStore.getState();
    const prevState = store.agentStatus[data.panelId];
    store.setAgentStatus(data.panelId, data.sessionId, data.state);
    if (prevState === 'working' && data.state === 'idle') {
      const next = usePanelStore.getState();
      const activeSessionId = useSessionStore.getState().activeSessionId;
      const sessionSettled = rollupSessionAgentState(next.agentStatus, next.agentStatusSession, data.sessionId) === 'idle';
      if (sessionSettled && activeSessionId !== data.sessionId) {
        next.markUnviewedCompletedActivity(data.sessionId);
      }
    }
  });
  const unsubscribeActivity = api.events.onPanelActivityStatus?.(data => {
    if (!deleted.has(data.panelId)) {
      usePanelStore.getState().setActivityStatus(data.panelId, data.status, data.lastActivityAt);
    }
  });
  const unsubscribeDeleted = api.events.onPanelDeleted?.(data => {
    changedDuringRead.add(data.panelId);
    deleted.add(data.panelId);
    usePanelStore.getState().removePanel(data.sessionId, data.panelId);
  });
  const unsubscribeCreated = api.events.onPanelCreated?.(panel => {
    changedDuringRead.add(panel.id);
    deleted.delete(panel.id);
  });

  const refresh = async () => {
    const currentRequest = ++requestId;
    changedDuringRead = new Set();
    try {
      const response: unknown = await api.invoke('panels:agent-statuses');
      const snapshot = decodeBoundary(response, statusSnapshotSchema);
      if (disposed || currentRequest !== requestId) return;
      usePanelStore.setState(state => {
        const agentStatus = { ...state.agentStatus };
        const agentStatusSession = { ...state.agentStatusSession };
        const activityStatus = { ...state.activityStatus };
        for (const panelId of Object.keys(agentStatus)) {
          if (!changedDuringRead.has(panelId)) {
            delete agentStatus[panelId];
            delete agentStatusSession[panelId];
            delete activityStatus[panelId];
          }
        }
        for (const panel of snapshot.data) {
          if (changedDuringRead.has(panel.panelId)) continue;
          deleted.delete(panel.panelId);
          agentStatus[panel.panelId] = panel.state;
          agentStatusSession[panel.panelId] = panel.sessionId;
          activityStatus[panel.panelId] = panel.state === 'working' || panel.state === 'blocked' ? 'active' : 'idle';
        }
        return { agentStatus, agentStatusSession, activityStatus, agentStatusSnapshotVersion: state.agentStatusSnapshotVersion + 1 };
      });
    } catch (error) {
      if (!disposed && currentRequest === requestId) console.error('[panelStatusSync] Failed to refresh agent statuses:', error);
    }
  };
  const unsubscribeResync = api.events.onRemoteDaemonResyncRequested?.(() => { void refresh(); });
  void refresh();

  return () => {
    disposed = true;
    unsubscribeStatus?.();
    unsubscribeActivity?.();
    unsubscribeDeleted?.();
    unsubscribeCreated?.();
    unsubscribeResync?.();
  };
}
