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
  [STATE_KEY]: boundary.object({ view: boundary.nullable(boundary.string), overlay: boundary.boolean }),
});

interface RemoteBrowserHistoryOptions {
  /** Off in the native shell, whose back button has its own handler. */
  enabled: boolean;
  view: RemoteHistoryView;
  overlayOpen: boolean;
  onNavigate: (view: RemoteHistoryView) => void;
  onCloseOverlays: () => void;
}

/**
 * Gives browser back a step inside the PWA: it closes the open drawer or sheet,
 * else returns to the previous Pane or Session. Returns `requestView`, which marks
 * the next view the person opens so it gets its own history entry.
 */
export function useRemoteBrowserHistory({ enabled, view, overlayOpen, onNavigate, onCloseOverlays }: RemoteBrowserHistoryOptions) {
  const pendingViewRef = useRef<RemoteHistoryView | undefined>(undefined);
  const latestRef = useCommittedRef({ view, overlayOpen, onNavigate, onCloseOverlays });

  useEffect(() => {
    if (!enabled) return;
    const current: RemoteHistoryEntry = { view, overlay: overlayOpen };
    const action = nextHistoryAction(decodeOptionalBoundary(window.history.state, HISTORY_STATE)?.[STATE_KEY] ?? null, current, pendingViewRef.current);
    if (pendingViewRef.current === view) pendingViewRef.current = undefined;
    if (action === 'push') window.history.pushState({ [STATE_KEY]: current }, '');
    else if (action === 'replace') window.history.replaceState({ [STATE_KEY]: current }, '');
    else if (action === 'back') window.history.back();
  }, [enabled, overlayOpen, view]);

  useEffect(() => {
    if (!enabled) return;
    const handlePopState = (event: PopStateEvent) => {
      const entry = decodeOptionalBoundary(event.state, HISTORY_STATE)?.[STATE_KEY];
      if (!entry) return;
      const latest = latestRef.current;
      pendingViewRef.current = undefined;
      if (latest.overlayOpen) latest.onCloseOverlays();
      if (entry.view !== latest.view) latest.onNavigate(entry.view);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [enabled, latestRef]);

  const requestView = useCallback((next: RemoteHistoryView) => { pendingViewRef.current = next; }, []);
  return { requestView };
}
