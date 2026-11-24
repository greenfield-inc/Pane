import type { NotifyItem } from '../../../../shared/types/notify';
import { isOpenTodoState, type TodoListRow } from '../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { machineOfItem, todoKey, todoKeyOfItem, todoKeyOfRow, type TodoKey } from '../../../../shared/todoKey';

/**
 * A Session's to-dos (T-22, T-23): the top-level to-dos it requested (its orchestrator created them), or, for a
 * to-do's own hidden Session, that to-do. Any state, in list order; callers that need only open ones filter.
 */
export function sessionTodos(rows: readonly TodoListRow[], sessionId: string): TodoListRow[] {
  return rows.filter(({ todo }) => todo.parentNumber === null
    && (todo.sessionId === sessionId || (todo.requester.kind === 'orchestrator' && todo.requester.sessionId === sessionId)));
}

/**
 * Where a Session's to-dos' approvals come from: their own hidden Sessions, and the to-dos (with their sub-to-dos)
 * themselves, all on one machine (T-51). Two machines each have a T-28, so a card belongs only when it came from
 * `machineId` too; `sessionTodoMachine` (todosStore) decides which machine that is.
 */
export interface TodoApprovalScope {
  machineId: string;
  sessionIds: ReadonlySet<string>;
  todoKeys: ReadonlySet<TodoKey>;
}

/** No to-dos on machine `machineId`: the scope still says whose cards a Session takes. */
export function emptyTodoScope(machineId: string): TodoApprovalScope {
  return { machineId, sessionIds: new Set(), todoKeys: new Set() };
}

export const EMPTY_TODO_SCOPE: TodoApprovalScope = emptyTodoScope(LOCAL_MACHINE_ID);

/** The open to-dos a Session requested or owns on machine `machineId` (its `rows`), as the approvals scope its row and column add (T-22). */
export function todoApprovalScope(rows: readonly TodoListRow[], sessionId: string, machineId: string = LOCAL_MACHINE_ID): TodoApprovalScope {
  const own = sessionTodos(rows, sessionId).filter(({ todo }) => isOpenTodoState(todo.state));
  if (own.length === 0) return emptyTodoScope(machineId);
  const numbers = new Set(own.map(({ todo }) => todo.number));
  for (const { todo } of rows) if (todo.parentNumber !== null && numbers.has(todo.parentNumber) && isOpenTodoState(todo.state)) numbers.add(todo.number);
  const sessionIds = new Set(own.flatMap(({ todo }) => (todo.sessionId && todo.sessionId !== sessionId ? [todo.sessionId] : [])));
  const todoKeys = new Set(rows.filter(({ todo }) => numbers.has(todo.number)).map(row => todoKeyOfRow(machineId, row)));
  return { machineId, sessionIds, todoKeys };
}

/** Whether an approval belongs to one of those to-dos: from their machine, and asked in its hidden Session, connected to it, or linked to it. */
export function inTodoScope(item: NotifyItem, scope: TodoApprovalScope): boolean {
  if (scope.todoKeys.size === 0 || machineOfItem(item) !== scope.machineId) return false;
  const key = todoKeyOfItem(item);
  if (key && scope.todoKeys.has(key)) return true;
  if (item.source.session && scope.sessionIds.has(item.source.session.id)) return true;
  return item.connected?.kind === 'session' && scope.sessionIds.has(item.connected.id);
}

/**
 * Which to-do an approval shown in a Session belongs to, as "T-n" (T-24): the one it is linked to, or the one whose own
 * hidden Session asked it. None for the Session's own approvals, nor inside a to-do's own Session (its page says which).
 */
export function todoRefOf(item: NotifyItem, rows: readonly TodoListRow[], sessionId: string): string | undefined {
  if (rows.some(({ todo }) => todo.sessionId === sessionId)) return undefined;
  if (item.todo) return `T-${item.todo.number}`;
  const asking = item.source.session?.id;
  if (!asking || asking === sessionId) return undefined;
  const owner = rows.find(({ todo }) => todo.sessionId === asking && todo.parentNumber === null);
  return owner ? owner.todo.ref : undefined;
}

/**
 * How many of `approvals` each top-level to-do has (T-37): one linked to it or to one of its sub-to-dos, or
 * asked (or connected) in its own hidden Session. `rows` is machine `machineId`'s whole list, sub-to-dos
 * included, and the result is keyed by its numbers. A card is matched to a row by key (T-51), so another
 * machine's card on the same T-n never counts.
 */
export function approvalsByTodo(approvals: readonly NotifyItem[], rows: readonly TodoListRow[], machineId: string): Map<number, number> {
  const byKey = new Map(rows.map(row => [todoKeyOfRow(machineId, row), row.todo]));
  const counts = new Map<number, number>();
  for (const item of approvals) {
    const connected = item.connected?.kind === 'session' ? item.connected.id : undefined;
    const ownedBy = (sessionId: string | undefined) => (sessionId ? rows.find(({ todo }) => todo.sessionId === sessionId && todo.parentNumber === null)?.todo : undefined);
    const linked = todoKeyOfItem(item);
    let todo = (linked ? byKey.get(linked) : undefined) ?? ownedBy(item.source.session?.id) ?? ownedBy(connected);
    for (let depth = 0; todo && todo.parentNumber !== null && depth < rows.length; depth += 1) todo = byKey.get(todoKey(machineId, todo.parentNumber));
    if (todo) counts.set(todo.number, (counts.get(todo.number) ?? 0) + 1);
  }
  return counts;
}
