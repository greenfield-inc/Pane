import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useLoopsStore } from '../stores/loopsStore';
import { paneHasWaitingQuestion, useNotifyStore } from '../stores/notifyStore';
import type { Session } from '../types/session';

/**
 * The Panes the sidebar lists, and the hotkeys number. A loop's run Pane lives under Loops: it is
 * listed only while a card from it waits on the person, or while it is the open Pane.
 */
export function useListedPanes(): Session[] {
  const panes = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const runsBySessionId = useLoopsStore(s => s.runsBySessionId);
  const snapshot = useNotifyStore(s => s.snapshot);
  return useMemo(
    () => panes.filter(pane => !runsBySessionId.has(pane.id) || pane.id === activeSessionId || paneHasWaitingQuestion(snapshot, pane.id)),
    [panes, activeSessionId, runsBySessionId, snapshot],
  );
}

/** A loop's run Pane is never pinned in the sidebar. */
export function useIsLoopRun(): (paneId: string) => boolean {
  const runsBySessionId = useLoopsStore(s => s.runsBySessionId);
  return useMemo(() => (paneId: string) => runsBySessionId.has(paneId), [runsBySessionId]);
}
