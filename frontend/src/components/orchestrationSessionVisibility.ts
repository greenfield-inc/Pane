import type { OrchestrationSessionRecord, OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';

/**
 * A to-do's own Session (D-409, T-7). The record says so from its first write (`todoNumber`), so it
 * reads as the to-do's before any to-dos snapshot arrives; `todoSessionIds` (the snapshot's
 * `ownSessionIds`) covers Sessions made before records carried the number.
 */
export function isTodoSession(session: Pick<OrchestrationSessionRecord, 'id' | 'todoNumber'>, todoSessionIds: ReadonlySet<string>): boolean {
  return session.todoNumber != null || todoSessionIds.has(session.id);
}

export interface SessionListFilter {
  todoSessionIds: ReadonlySet<string>;
  /** The Session on screen: listed even when it is a loop's, never when it is a to-do's. */
  openSessionId?: string | null;
  /** Loops' Sessions, which live under Loops. */
  loopSessionIds?: { has(sessionId: string): boolean };
  /** Cards waiting on the person from this Session: a loop's Session joins the list while one waits. */
  waitingCount?: (sessionId: string) => number;
}

/**
 * The active Sessions the Sessions sidebar lists. A to-do's Session never shows, open or with a card
 * waiting: the to-do, search and Approvals reach it (J17). A loop's joins while a card from it
 * waits or while it is open.
 */
export function visibleOrchestrationSessions<Session extends OrchestrationSessionSummary>(
  sessions: readonly Session[],
  { todoSessionIds, openSessionId, loopSessionIds, waitingCount }: SessionListFilter,
): Session[] {
  return sessions.filter(session => {
    if (session.archived === true || isTodoSession(session, todoSessionIds)) return false;
    if (session.id === openSessionId || !loopSessionIds?.has(session.id)) return true;
    return (waitingCount?.(session.id) ?? 0) > 0;
  });
}
