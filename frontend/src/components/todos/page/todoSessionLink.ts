import type { TodoShownStatus } from '../../../../../shared/types/todos';
import type { TodoSessionOrigin } from '../../../stores/navigationStore';

/** What the lookup reads of a to-dos snapshot row. */
export interface SessionTodoRow {
  todo: { number: number; ref: string; title: string; sessionId: string | null };
  status: { status: TodoShownStatus };
}

/** The to-do a Session's breadcrumb names: `← T-12 · Invoice PDFs`. */
export interface TodoSessionLink {
  number: number;
  ref: string;
  /** Absent until the to-dos snapshot has the row. */
  title?: string;
  status?: TodoShownStatus;
  /** The Session was opened from this to-do, so the breadcrumb goes back to it. */
  cameFrom: boolean;
}

/**
 * The to-do a Session belongs to (round 8, T-4): the one you opened it from, which may be a
 * sub-to-do on its parent's Session; else the to-do whose own Session it is, by the snapshot or
 * by the record's `todoNumber` (written with the Session, so it is there before the snapshot).
 */
export function todoForSession(
  session: { id: string; todoNumber?: number | null },
  rows: readonly SessionTodoRow[] | undefined,
  origin: TodoSessionOrigin | null,
): TodoSessionLink | null {
  const byNumber = (number: number) => rows?.find((row) => row.todo.number === number);
  if (origin && origin.sessionId === session.id) return link(origin.number, byNumber(origin.number), true);
  const recorded = session.todoNumber ?? undefined;
  const owner = rows?.find((row) => row.todo.sessionId === session.id) ?? (recorded !== undefined ? byNumber(recorded) : undefined);
  if (owner) return link(owner.todo.number, owner, false);
  return recorded !== undefined ? link(recorded, undefined, false) : null;
}

function link(number: number, row: SessionTodoRow | undefined, cameFrom: boolean): TodoSessionLink {
  if (!row) return { number, ref: `T-${number}`, cameFrom };
  return { number, ref: row.todo.ref, title: row.todo.title, status: row.status.status, cameFrom };
}
