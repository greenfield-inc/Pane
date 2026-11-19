import { ListTodo } from 'lucide-react';
import { cn } from '../../utils/cn';
import { TodoStatusIcon } from './TodoStatusIcon';
import { toggleTodos } from './todosNavigation';
import { useTodosNav } from './useTodoEntries';
import { useTodosEnabled } from '../../stores/todosStore';

/** The sidebar row classes ProjectSessionList's other entries use (Loops, Approvals). */
const ROW = 'mx-2 flex w-[calc(100%-1rem)] items-center gap-2 px-2 text-left transition-colors h-7 rounded-md text-[13px] hover:bg-surface-hover hover:text-text-primary';

/**
 * Opens To-dos, and clicked again returns to the view you left (D-409). The Working spinner shows
 * while any to-do is worked on; the amber count is to-dos waiting on you. The spinner keeps its box
 * while hidden, so the count never shifts. Absent while To-dos is off (T-39).
 */
export function TodosNavRow() {
  const nav = useTodosNav();
  const enabled = useTodosEnabled();
  if (!enabled) return null;
  return (
    <button
      type="button"
      data-testid="todos-nav"
      data-sidebar-item
      data-sidebar-key="todos"
      aria-pressed={nav.open}
      aria-label={nav.label}
      title={nav.label}
      onClick={toggleTodos}
      className={cn(ROW, nav.open ? 'bg-surface-hover text-text-primary' : 'text-text-secondary')}
    >
      <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
      <span>To-dos</span>
      <span className="ml-auto flex items-center gap-1.5" aria-hidden="true">
        {nav.working
          ? <TodoStatusIcon status="working" className="pointer-events-none" />
          : <span className="h-3.5 w-3.5" />}
        {nav.waiting > 0 && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning" data-testid="todos-nav-count">
            {nav.waiting}
          </span>
        )}
      </span>
    </button>
  );
}

/** The compact rail's To-dos button, with the same count and spinner. */
export function TodosRailButton({ buttonClass, activeClass, idleClass }: { buttonClass: string; activeClass: string; idleClass: string }) {
  const nav = useTodosNav();
  return (
    <button
      type="button"
      data-testid="compact-todos"
      data-compact-rail-item
      onClick={toggleTodos}
      aria-pressed={nav.open}
      aria-label={nav.label}
      className={`${buttonClass} ${nav.open ? activeClass : idleClass}`}
    >
      <ListTodo className="h-4 w-4" />
      {nav.waiting > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-warning px-0.5 text-[9px] font-semibold tabular-nums text-text-on-status-warning" aria-hidden="true">
          {nav.waiting}
        </span>
      ) : nav.working ? (
        <span className="absolute right-0 top-0" aria-hidden="true"><TodoStatusIcon status="working" className="h-3 w-3" /></span>
      ) : null}
    </button>
  );
}
