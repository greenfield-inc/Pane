import { create } from 'zustand';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { SessionActivity } from '../../../shared/types/orchestrationSession';

/** One Session's activity as the host sends it. */
export const sessionActivitySchema = boundary.object({
  sessionId: boundary.string,
  state: boundary.enumeration('working', 'idle'),
  workingPanes: boundary.number,
});
/** The data of an `orchestration-sessions:activity-list` response. */
export const sessionActivityListSchema = boundary.array(sessionActivitySchema);
const activityListResponseSchema = boundary.object({ success: boundary.literal(true), data: sessionActivityListSchema });

interface SessionActivityStore {
  /** By Session id; a Session missing here is idle. */
  activity: Record<string, SessionActivity>;
}

/**
 * The connected host's Session activity, fed only by the host's event and baseline: clients keep
 * no timers of their own, so every client shows the host's answer.
 */
export const useSessionActivityStore = create<SessionActivityStore>(() => ({ activity: {} }));

type Unsubscribe = (() => void) | undefined;

/** Where a client hears the host's Session activity: the desktop's IPC, or a phone's event stream. */
export interface SessionActivitySource {
  onActivity: (callback: (activity: SessionActivity) => void) => Unsubscribe;
  /** Fires when events may have been missed, so the baseline is read again. */
  onResync: (callback: () => void) => Unsubscribe;
  /** Reads the host's baseline; absent on a host too old to have one. */
  readActivity?: () => Promise<SessionActivity[]>;
}

function desktopActivitySource(): SessionActivitySource {
  const api = window.electronAPI;
  const read = api.orchestrationSessions?.activityList;
  return {
    onActivity: callback => api.events.onOrchestrationSessionActivity?.(callback),
    onResync: callback => api.events.onRemoteDaemonResyncRequested?.(() => callback()),
    readActivity: read ? async () => decodeBoundary(await read(), activityListResponseSchema).data : undefined,
  };
}

/**
 * Subscribe before reading the baseline; events during a read win. A baseline replaces what the
 * store had, so a resync or reconnect re-reads the host rather than keep an old spinner. A host
 * without the read leaves every Session idle.
 */
export function subscribeSessionActivity(source: SessionActivitySource = desktopActivitySource()): () => void {
  let disposed = false;
  let requestId = 0;
  let changedDuringRead = new Set<string>();

  const unsubscribeActivity = source.onActivity(value => {
    const activity = decodeOptionalBoundary(value, sessionActivitySchema);
    if (!activity) return;
    changedDuringRead.add(activity.sessionId);
    useSessionActivityStore.setState(state => ({ activity: { ...state.activity, [activity.sessionId]: activity } }));
  });

  const refresh = async () => {
    const currentRequest = ++requestId;
    changedDuringRead = new Set();
    let snapshot: SessionActivity[] = [];
    try {
      snapshot = source.readActivity ? await source.readActivity() : [];
    } catch (error) {
      // An older host has no Session activity: its Sessions read idle.
      if (!disposed && currentRequest === requestId) console.warn('[sessionActivitySync] Session activity is unavailable; Sessions show idle:', error);
    }
    if (disposed || currentRequest !== requestId) return;
    useSessionActivityStore.setState(state => {
      const activity: Record<string, SessionActivity> = {};
      for (const sessionId of changedDuringRead) {
        const kept = state.activity[sessionId];
        if (kept) activity[sessionId] = kept;
      }
      for (const item of snapshot) {
        if (!changedDuringRead.has(item.sessionId)) activity[item.sessionId] = item;
      }
      return { activity };
    });
  };
  const unsubscribeResync = source.onResync(() => { void refresh(); });
  void refresh();

  return () => {
    disposed = true;
    unsubscribeActivity?.();
    unsubscribeResync?.();
    // Activity belongs to this host; the next host starts from its own baseline.
    useSessionActivityStore.setState({ activity: {} });
  };
}

/** A Session's activity from the connected host; idle when the host has said nothing. */
export function useSessionActivity(sessionId: string): SessionActivity {
  const state = useSessionActivityStore(store => store.activity[sessionId]?.state ?? 'idle');
  const workingPanes = useSessionActivityStore(store => store.activity[sessionId]?.workingPanes ?? 0);
  return { sessionId, state, workingPanes };
}
