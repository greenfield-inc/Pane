import { create } from 'zustand';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/**
 * The Sessions whose Panes this device shows in the sidebar, per host. Every
 * Session starts collapsed; only the person's own toggle opens one. Keyed by
 * Session id alone, so a Session opened under Pinned is open under Sessions too.
 */
const STORAGE_KEY_PREFIX = 'pane.remotePwa.expandedSessions@';
const savedIdsSchema = boundary.array(boundary.string);

export function readExpandedSessions(hostId: string): ReadonlySet<string> {
  try {
    const saved = decodeOptionalBoundary(JSON.parse(window.localStorage.getItem(STORAGE_KEY_PREFIX + hostId) ?? 'null'), savedIdsSchema);
    return new Set(saved ?? []);
  } catch {
    return new Set();
  }
}

function saveExpandedSessions(hostId: string, expanded: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_PREFIX + hostId, JSON.stringify([...expanded]));
  } catch {
    // Storage can be unavailable (private mode); the Sessions still toggle for this visit.
  }
}

interface RemoteExpandedSessionsState {
  /** The host `expanded` belongs to. */
  hostId: string | null;
  expanded: ReadonlySet<string>;
  /** Switches to a host's remembered Sessions; a no-op for the host already loaded. */
  load: (hostId: string | null) => void;
  toggle: (sessionId: string) => void;
}

export const useRemoteExpandedSessionsStore = create<RemoteExpandedSessionsState>((set, get) => ({
  hostId: null,
  expanded: new Set(),
  load: (hostId) => {
    if (get().hostId === hostId) return;
    set({ hostId, expanded: hostId ? readExpandedSessions(hostId) : new Set() });
  },
  toggle: (sessionId) => {
    const { hostId, expanded } = get();
    const next = new Set(expanded);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    if (hostId) saveExpandedSessions(hostId, next);
    set({ expanded: next });
  },
}));
