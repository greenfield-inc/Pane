import { useMemo } from 'react';
import { todoKeyOfRow } from '../../../../shared/todoKey';
import { todoRef } from '../../../../shared/types/todos';
import { useSessionTodoApprovals, useSessionTodoEntries } from '../../stores/todosStore';
import { cn } from '../../utils/cn';
import { useNow } from '../notify/useNow';
import { TodoStatusIcon, TODO_STATUS_LABEL } from './TodoStatusIcon';
import { sessionTodoGroups } from './sessionTodosList';
import { flattenGroups } from './todoList';

interface SessionTodosSidebarProps {
  /** The Session whose requested to-dos these are. */
  sessionId: string;
  /** The machine the Session runs on; absent for the host this window shows. */
  machineId?: string;
  /** Opens one in the split's To-dos tab. */
  onOpen: (number: number) => void;
}

/**
 * The Session sidebar's To-dos (T-37), beside Files and Changes: the to-dos this Session requested, in the
 * To-dos tab's order (open by status, then done this week), each with its status, sub-to-do progress and
 * the approvals waiting on you. A click opens it in the split's To-dos tab.
 */
export function SessionTodosSidebar({ sessionId, machineId, onOpen }: SessionTodosSidebarProps) {
  const entries = useSessionTodoEntries(sessionId, machineId);
  // The same approvals as the tab's count, so a row's count clears with it (dismissed, sent or answered).
  const { byTodo, machineId: todosMachine } = useSessionTodoApprovals(sessionId, machineId);
  const now = useNow();
  const shown = useMemo(() => flattenGroups(sessionTodoGroups(entries ?? [], now)), [entries, now]);
  if (entries === null) return null;
  // Like Changes' "No Panes in this Session yet.": the tab stays, and says so quietly. Older closed ones are on the To-dos screen.
  if (shown.length === 0) return <p className="p-3 text-[12px] text-text-muted" data-testid="sidebar-todos-empty">No open or recent to-dos from this Session.</p>;
  return (
    <ul className="flex flex-col gap-0.5 p-2 text-[12px]" aria-label="To-dos this Session requested" data-testid="sidebar-todos">
      {shown.map(({ key, row }) => {
        const { todo, status, subCounts } = row;
        const waiting = byTodo.get(todoKeyOfRow(todosMachine, row)) ?? 0;
        return (
          <li key={key}>
            <button type="button" onClick={() => onOpen(todo.number)}
              title={[`${todoRef(todo.number)} ${todo.title}`, TODO_STATUS_LABEL[status.status], status.reason].filter(Boolean).join(' · ')}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus"
              data-testid="sidebar-todo-row" data-todo={todo.number} data-status={status.status}>
              <TodoStatusIcon status={status.status} />
              <span className="shrink-0 tabular-nums text-text-tertiary">{todoRef(todo.number)}</span>
              <span className={cn('min-w-0 flex-1 truncate', status.status === 'done' ? 'text-text-secondary' : 'font-medium text-text-primary')}>{todo.title}</span>
              {subCounts && subCounts.total > 0 && <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border-primary px-1.5 text-[11px] tabular-nums text-text-secondary" title="Sub-to-dos done" data-testid="sidebar-todo-progress">{subCounts.done}/{subCounts.total}</span>}
              {waiting > 0 && (
                <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning"
                  title={`${waiting} waiting on you`} data-testid="sidebar-todo-waiting">{waiting}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
