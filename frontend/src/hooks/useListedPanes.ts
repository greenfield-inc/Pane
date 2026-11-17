import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useLoopsStore } from '../stores/loopsStore';
import { paneHasWaitingQuestion, useNotifyStore } from '../stores/notifyStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useTodoSessionIds } from '../stores/todosStore';
import type { Session } from '../types/session';

/** The Panes of this machine's to-dos' own Sessions, which live under To-dos (D-409). */
function useTodoSessionPaneIds(): ReadonlySet<string> {
  const todoSessionIds = useTodoSessionIds();
  const sessions = useOrchestrationSessionStore(s => s.sessions);
  return useMemo(() => new Set(sessions
    .filter(session => todoSessionIds.has(session.id))
    .flatMap(session => session.associations.map(association => association.paneId))), [sessions, todoSessionIds]);
}

/**
 * The Panes the sidebar lists, and the hotkeys number. A loop's run Pane lives under Loops, and a
 * to-do's own Session's Panes under To-dos: each is listed only while a card from it waits on the
 * person, or while it is the open Pane.
 */
export function useListedPanes(): Session[] {
  const panes = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const runsBySessionId = useLoopsStore(s => s.runsBySessionId);
  const todoPaneIds = useTodoSessionPaneIds();
  const snapshot = useNotifyStore(s => s.snapshot);
  return useMemo(
    () => panes.filter(pane => pane.id === activeSessionId || (!todoPaneIds.has(pane.id) && (!runsBySessionId.has(pane.id) || paneHasWaitingQuestion(snapshot, pane.id)))),
    [panes, activeSessionId, runsBySessionId, todoPaneIds, snapshot],
  );
}

/** A loop's run Pane is never pinned in the sidebar. */
export function useIsLoopRun(): (paneId: string) => boolean {
  const runsBySessionId = useLoopsStore(s => s.runsBySessionId);
  return useMemo(() => (paneId: string) => runsBySessionId.has(paneId), [runsBySessionId]);
}
