import { useCallback, useEffect, useRef } from 'react';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { useCommittedRef } from '../hooks/useCommittedRef';

/** `pane:<id>` or `session:<id>`; null when nothing is open. */
export type RemoteHistoryView = string | null;

/** What one browser history entry owned by the PWA records. */
export interface RemoteHistoryEntry {
  view: RemoteHistoryView;
  overlay: boolean;
}

export type RemoteHistoryAction = 'push' | 'replace' | 'back' | null;

/**
 * How the browser history should follow the screen. `top` is the current history
 * entry; `pendingView` is a view the person asked for that has not opened yet.
 * Only a requested view or a new overlay pushes, so automatic selection and
 * in-place changes never pile up entries.
 */
export function nextHistoryAction(
  top: RemoteHistoryEntry | null,
  current: RemoteHistoryEntry,
  pendingView: RemoteHistoryView | undefined,
): RemoteHistoryAction {
  if (!top) return 'replace';
  if (current.overlay) {
    if (!top.overlay) return 'push';
    return top.view === current.view ? null : 'replace';
  }
  if (top.overlay) {
    // Closed by navigating away: the overlay's entry becomes the new view.
    if (top.view !== current.view) return 'replace';
    // Closed while a requested view is still loading: its entry replaces this one.
    if (pendingView !== undefined && pendingView !== current.view) return null;
    return 'back';
  }
  if (top.view === current.view) return null;
  return pendingView === current.view ? 'push' : 'replace';
}

const STATE_KEY = 'paneRemote';

const HISTORY_STATE = boundary.object({
  [STATE_KEY]: boundary.object({ host: boundary.string, view: boundary.nullable(boundary.string), overlay: boundary.boolean }),
});

interface RemoteBrowserHistoryOptions {
  /** Off in the native shell, whose back button has its own handler. */
  enabled: boolean;
  /** The connected host's profile id; entries from another host are skipped. */
  host: string;
  view: RemoteHistoryView;
  overlayOpen: boolean;
  onNavigate: (view: RemoteHistoryView) => void;
  onCloseOverlays: () => void;
}

/**
 * Gives browser back a step inside the PWA: it closes the open drawer or sheet,
 * else returns to the previous Pane or Session. Returns `requestView`, which marks
 * the next view the person opens so it gets its own history entry, and
 * `cancelRequest`, which drops that mark when the view fails to open.
 */
export function useRemoteBrowserHistory({ enabled, host, view, overlayOpen, onNavigate, onCloseOverlays }: RemoteBrowserHistoryOptions) {
  const pendingViewRef = useRef<RemoteHistoryView | undefined>(undefined);
  const latestRef = useCommittedRef({ enabled, host, view, overlayOpen, onNavigate, onCloseOverlays });

  const syncHistory = useCallback(() => {
    const latest = latestRef.current;
    if (!latest.enabled) return;
    const current: RemoteHistoryEntry = { view: latest.view, overlay: latest.overlayOpen };
    const stored = decodeOptionalBoundary(window.history.state, HISTORY_STATE)?.[STATE_KEY];
    const top = stored && stored.host === latest.host ? stored : null;
    const action = nextHistoryAction(top, current, pendingViewRef.current);
    if (pendingViewRef.current === latest.view) pendingViewRef.current = undefined;
    const state = { [STATE_KEY]: { ...current, host: latest.host } };
    if (action === 'push') window.history.pushState(state, '');
    else if (action === 'replace') window.history.replaceState(state, '');
    else if (action === 'back') window.history.back();
  }, [latestRef]);

  useEffect(() => { syncHistory(); }, [enabled, host, overlayOpen, view, syncHistory]);

  useEffect(() => {
    if (!enabled) return;
    const handlePopState = (event: PopStateEvent) => {
      const entry = decodeOptionalBoundary(event.state, HISTORY_STATE)?.[STATE_KEY];
      if (!entry) return;
      const latest = latestRef.current;
      // An entry from a host connected earlier in this tab: step past it.
      if (entry.host !== latest.host) {
        window.history.back();
        return;
      }
      pendingViewRef.current = undefined;
      if (latest.overlayOpen) latest.onCloseOverlays();
      if (entry.view !== latest.view) latest.onNavigate(entry.view);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [enabled, latestRef]);

  const requestView = useCallback((next: RemoteHistoryView) => {
    pendingViewRef.current = next === latestRef.current.view ? undefined : next;
  }, [latestRef]);
  const cancelRequest = useCallback(() => {
    if (pendingViewRef.current === undefined) return;
    pendingViewRef.current = undefined;
    syncHistory();
  }, [syncHistory]);
  return { requestView, cancelRequest };
}
