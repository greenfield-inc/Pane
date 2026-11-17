import { CircleCheck, CircleHelp, CircleMinus, CircleX, Clock } from 'lucide-react';
import type { TodoShownStatus } from '../../../../shared/types/todos';
import { cn } from '../../utils/cn';

/** The word each status reads as, on group headers, pills, rows and the details rail. */
export const TODO_STATUS_LABEL = {
  waiting: 'Waiting on you',
  working: 'Working',
  queued: 'Queued',
  idle: 'Idle',
  done: 'Done',
  dropped: 'Dropped',
} as const satisfies Record<TodoShownStatus, string>;

/**
 * A to-do's status icon. Every status shares one fixed 14 px box so swapping never shifts a row, and
 * each has its own shape so it reads without colour (J6). Working is the Session activity spinner,
 * with the same period (AGENTS.md: animations on one surface share a period).
 */
export function TodoStatusIcon({ status, className }: { status: TodoShownStatus; className?: string }) {
  const label = TODO_STATUS_LABEL[status];
  return (
    <span
      className={cn('inline-flex items-center justify-center w-3.5 h-3.5 flex-shrink-0', className)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="todo-status-icon"
      data-status={status}
    >
      {status === 'working' && <span className="inline-block box-border w-3 h-3 rounded-full border-2 border-status-info/30 border-t-status-info animate-spin" />}
      {status === 'waiting' && <CircleHelp className="w-3.5 h-3.5 text-status-warning" strokeWidth={2.25} />}
      {status === 'queued' && <Clock className="w-3.5 h-3.5 text-text-secondary" strokeWidth={2.25} />}
      {status === 'idle' && <CircleMinus className="w-3.5 h-3.5 text-text-muted" strokeWidth={2.25} />}
      {status === 'done' && <CircleCheck className="w-3.5 h-3.5 text-status-success" strokeWidth={2.25} />}
      {status === 'dropped' && <CircleX className="w-3.5 h-3.5 text-text-muted" strokeWidth={2.25} />}
    </span>
  );
}

/** The status as a pill: icon and word, as on the page's status line and the details rail. */
export function TodoStatusPill({ status, className }: { status: TodoShownStatus; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border border-border-primary px-2 py-0.5 text-xs text-text-primary', className)} data-testid="todo-status-pill" data-status={status}>
      <TodoStatusIcon status={status} />
      {TODO_STATUS_LABEL[status]}
    </span>
  );
}
