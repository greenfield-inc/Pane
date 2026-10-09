import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { panelStatusesSchema, subscribePanelStatus } from '../../services/panelStatusSync';
import { usePanelStore } from '../../stores/panelStore';
import { useRemoteSessionStore } from '../stores/remoteSessionStore';
import type { RemoteRuntimeAdapter } from './remoteRuntimeAdapter';

const agentStatusSchema = boundary.object({
  panelId: boundary.string,
  sessionId: boundary.string,
  state: boundary.enumeration('blocked', 'working', 'idle', 'unknown'),
  reason: boundary.optional(boundary.nullable(boundary.string)),
});
const activityStatusSchema = boundary.object({
  panelId: boundary.string,
  status: boundary.enumeration('active', 'idle'),
  lastActivityAt: boundary.optional(boundary.string),
});
const panelRefSchema = boundary.object({ panelId: boundary.string, sessionId: boundary.string });
const createdPanelSchema = boundary.object({ id: boundary.string });

type StatusAdapter = Pick<RemoteRuntimeAdapter, 'onEvent' | 'onStatus'> & {
  invoke: (channel: 'panels:agent-statuses') => Promise<JsonValue>;
};

/**
 * Keeps the shared panel store's agent status in step with a remote host, the
 * same way the desktop does: a baseline on connect and after every dropped
 * stream, with live events winning over a read in flight. "Done" belongs to
 * this client: it clears when this client opens the Pane.
 */
export function subscribeRemotePanelStatus(adapter: StatusAdapter): () => void {
  const on = <Value>(channel: string, schema: BoundarySchema<Value>, callback: (value: Value) => void) =>
    adapter.onEvent(event => {
      if (event.channel !== channel) return;
      const value = decodeOptionalBoundary(event.args[0], schema);
      if (value) callback(value);
    });

  const unsubscribeStatus = subscribePanelStatus({
    onAgentStatus: callback => on('panel:agentStatus', agentStatusSchema, event => callback({ ...event, reason: event.reason ?? null })),
    onActivityStatus: callback => on('panel:activityStatus', activityStatusSchema, callback),
    onPanelDeleted: callback => on('panel:deleted', panelRefSchema, callback),
    onPanelCreated: callback => on('panel:created', createdPanelSchema, callback),
    onResync: callback => {
      let streamDropped = false;
      return adapter.onStatus(state => {
        if (state.status === 'connected' && streamDropped) callback();
        if (state.status !== 'connecting') streamDropped = state.status !== 'connected';
      });
    },
    readStatuses: async () => decodeBoundary(await adapter.invoke('panels:agent-statuses'), panelStatusesSchema),
    viewedSessionId: () => useRemoteSessionStore.getState().selectedSessionId,
  });

  const clearViewed = (sessionId: string | null) => {
    if (sessionId) usePanelStore.getState().clearUnviewedCompletedActivity(sessionId);
  };
  clearViewed(useRemoteSessionStore.getState().selectedSessionId);
  const unsubscribeViewed = useRemoteSessionStore.subscribe((state, previous) => {
    if (state.selectedSessionId !== previous.selectedSessionId) clearViewed(state.selectedSessionId);
  });

  return () => {
    unsubscribeStatus();
    unsubscribeViewed();
    // Statuses belong to this host; the next host starts from its own baseline.
    usePanelStore.setState({ agentStatus: {}, agentStatusSession: {}, activityStatus: {}, lastActivityAt: {}, unviewedCompletedActivity: {} });
  };
}
