import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import { usePanelStore } from '../stores/panelStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAttentionInboxStore } from '../stores/attentionInboxStore';
import { rollupSessionAgentState } from '../utils/agentStatus';

/** The data of a `panels:agent-statuses` response. */
export const panelStatusesSchema = boundary.array(boundary.object({
  sessionId: boundary.string,
  panelId: boundary.string,
  state: boundary.enumeration('blocked', 'working', 'idle', 'unknown'),
}));
const statusSnapshotSchema = boundary.object({ success: boundary.literal(true), data: panelStatusesSchema });
type PanelStatuses = ReturnType<typeof panelStatusesSchema.decode>;

type Unsubscribe = (() => void) | undefined;

/** Where a client hears the host's panel status: the desktop's IPC, or a phone's event stream. */
export interface PanelStatusSource {
  onAgentStatus: (callback: (event: PanelAgentStatusEvent) => void) => Unsubscribe;
  onActivityStatus: (callback: (event: { panelId: string; status: 'active' | 'idle'; lastActivityAt?: string }) => void) => Unsubscribe;
  onPanelDeleted: (callback: (event: { panelId: string; sessionId: string }) => void) => Unsubscribe;
  onPanelCreated: (callback: (panel: { id: string }) => void) => Unsubscribe;
  /** Fires when events may have been missed, so the baseline is read again. */
  onResync: (callback: () => void) => Unsubscribe;
  /** Reads and decodes the host's `panels:agent-statuses` baseline. */
  readStatuses: () => Promise<PanelStatuses>;
  /** The Pane this client shows; an agent finishing anywhere else reads as done. */
  viewedSessionId: () => string | null;
}

function desktopStatusSource(): PanelStatusSource {
  const api = window.electronAPI;
  return {
    onAgentStatus: callback => api.events.onPanelAgentStatus?.(callback),
    onActivityStatus: callback => api.events.onPanelActivityStatus?.(callback),
    onPanelDeleted: callback => api.events.onPanelDeleted?.(callback),
    onPanelCreated: callback => api.events.onPanelCreated?.(callback),
    onResync: callback => api.events.onRemoteDaemonResyncRequested?.(() => callback()),
    readStatuses: async () => decodeBoundary(await api.invoke('panels:agent-statuses'), statusSnapshotSchema).data,
    viewedSessionId: () => useSessionStore.getState().activeSessionId,
  };
}

/** Subscribe before requesting the baseline; events during a read always win. */
export function subscribePanelStatus(source: PanelStatusSource = desktopStatusSource()): () => void {
  let disposed = false;
  let requestId = 0;
  let changedDuringRead = new Set<string>();
  const deleted = new Set<string>();

  const unsubscribeStatus = source.onAgentStatus(data => {
    changedDuringRead.add(data.panelId);
    if (deleted.has(data.panelId)) return;
    if (data.reason === 'exit' || data.reason === 'destroyed') {
      // Rebaseline notification subscribers atomically, as with a snapshot.
      // A stopped process must not become an unseen completed agent turn.
      usePanelStore.setState(state => ({
        agentStatus: { ...state.agentStatus, [data.panelId]: data.state },
        agentStatusSession: { ...state.agentStatusSession, [data.panelId]: data.sessionId },
        agentStatusReason: { ...state.agentStatusReason, [data.panelId]: data.reason },
        agentStatusSnapshotVersion: state.agentStatusSnapshotVersion + 1,
      }));
      return;
    }
    const store = usePanelStore.getState();
    const prevState = store.agentStatus[data.panelId];
    store.setAgentStatus(data.panelId, data.sessionId, data.state, data.reason);
    // Visible work before idle is a real turn; startup and stray output are not.
    if (data.state === 'idle' && data.workedVisibly) {
      useAttentionInboxStore.getState().markFinished(data.sessionId);
    }
    if (prevState === 'working' && data.state === 'idle') {
      const next = usePanelStore.getState();
      const viewedSessionId = source.viewedSessionId();
      const sessionSettled = rollupSessionAgentState(next.agentStatus, next.agentStatusSession, data.sessionId) === 'idle';
      if (sessionSettled && viewedSessionId !== data.sessionId) {
        next.markUnviewedCompletedActivity(data.sessionId);
      }
    }
  });
  const unsubscribeActivity = source.onActivityStatus(data => {
    if (!deleted.has(data.panelId)) {
      usePanelStore.getState().setActivityStatus(data.panelId, data.status, data.lastActivityAt);
    }
  });
  const unsubscribeDeleted = source.onPanelDeleted(data => {
    changedDuringRead.add(data.panelId);
    deleted.add(data.panelId);
    usePanelStore.getState().removePanel(data.sessionId, data.panelId);
  });
  const unsubscribeCreated = source.onPanelCreated(panel => {
    changedDuringRead.add(panel.id);
    deleted.delete(panel.id);
  });

  const refresh = async () => {
    const currentRequest = ++requestId;
    changedDuringRead = new Set();
    try {
      const snapshot = await source.readStatuses();
      if (disposed || currentRequest !== requestId) return;
      usePanelStore.setState(state => {
        const agentStatus = { ...state.agentStatus };
        const agentStatusSession = { ...state.agentStatusSession };
        // The snapshot carries no reason; keep only reasons from events seen during the read.
        const agentStatusReason = { ...state.agentStatusReason };
        const activityStatus = { ...state.activityStatus };
        for (const panelId of Object.keys(agentStatus)) {
          if (!changedDuringRead.has(panelId)) {
            delete agentStatus[panelId];
            delete agentStatusSession[panelId];
            delete agentStatusReason[panelId];
            delete activityStatus[panelId];
          }
        }
        for (const panel of snapshot) {
          if (changedDuringRead.has(panel.panelId)) continue;
          deleted.delete(panel.panelId);
          agentStatus[panel.panelId] = panel.state;
          agentStatusSession[panel.panelId] = panel.sessionId;
          activityStatus[panel.panelId] = panel.state === 'working' || panel.state === 'blocked' ? 'active' : 'idle';
        }
        return { agentStatus, agentStatusSession, agentStatusReason, activityStatus, agentStatusSnapshotVersion: state.agentStatusSnapshotVersion + 1 };
      });
    } catch (error) {
      if (!disposed && currentRequest === requestId) console.error('[panelStatusSync] Failed to refresh agent statuses:', error);
    }
  };
  const unsubscribeResync = source.onResync(() => { void refresh(); });
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
