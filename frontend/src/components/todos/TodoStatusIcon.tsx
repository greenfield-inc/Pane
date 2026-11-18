import { CircleCheck, CircleHelp, CircleMinus, CircleX, Clock, Moon } from 'lucide-react';
import type { TodoShownStatus } from '../../../../shared/types/todos';
import { cn } from '../../utils/cn';

/** The word each status reads as, on group headers, pills, rows and the details rail. */
export const TODO_STATUS_LABEL = {
  waiting: 'Waiting on you',
  working: 'Working',
  queued: 'Queued',
  idle: 'Idle',
  snoozed: 'Snoozed',
  done: 'Done',
  dropped: 'Dropped',
} as const satisfies Record<TodoShownStatus, string>;

/** The icon's box and glyph sizes: 14 px on the page, rail and sidebar; 16 px in the To-dos list (T-6). */
const ICON_SIZES = {
  md: { box: 'w-3.5 h-3.5', glyph: 'w-3.5 h-3.5', spinner: 'w-3 h-3' },
  lg: { box: 'w-4 h-4', glyph: 'w-4 h-4', spinner: 'w-3.5 h-3.5' },
} as const;

/**
 * A to-do's status icon. Every status shares one fixed box (14 px, or 16 px at `size="lg"`) so
 * swapping never shifts a row, and each has its own shape so it reads without colour (J6). Working
 * is the Session activity spinner, with the same period (AGENTS.md: animations on one surface share
 * a period).
 */
export function TodoStatusIcon({ status, className, size = 'md' }: { status: TodoShownStatus; className?: string; size?: keyof typeof ICON_SIZES }) {
  const label = TODO_STATUS_LABEL[status];
  const { box, glyph, spinner } = ICON_SIZES[size];
  return (
    <span
      className={cn('inline-flex items-center justify-center flex-shrink-0', box, className)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="todo-status-icon"
      data-status={status}
    >
      {status === 'working' && <span className={cn('inline-block box-border rounded-full border-2 border-status-info/30 border-t-status-info animate-spin', spinner)} />}
      {status === 'waiting' && <CircleHelp className={cn(glyph, 'text-status-warning')} strokeWidth={2.25} />}
      {status === 'queued' && <Clock className={cn(glyph, 'text-text-secondary')} strokeWidth={2.25} />}
      {status === 'idle' && <CircleMinus className={cn(glyph, 'text-text-muted')} strokeWidth={2.25} />}
      {status === 'snoozed' && <Moon className={cn(glyph, 'text-text-secondary')} strokeWidth={2.25} />}
      {status === 'done' && <CircleCheck className={cn(glyph, 'text-status-success')} strokeWidth={2.25} />}
      {status === 'dropped' && <CircleX className={cn(glyph, 'text-text-muted')} strokeWidth={2.25} />}
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
