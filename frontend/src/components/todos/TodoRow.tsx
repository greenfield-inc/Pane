import type { MouseEvent } from 'react';
import { MessageSquare, Monitor, Play, Square } from 'lucide-react';
import { todoRef } from '../../../../shared/types/todos';
import { cn } from '../../utils/cn';
import { agentIdIcon } from '../ui/brandIconRegistry';
import { relativeAge } from '../notify/notifyFormat';
import { TodoStatusIcon } from './TodoStatusIcon';
import { entryAction, requesterLabel, type TodoEntry, type TodoRowActionKind, type TodosGrouping } from './todoList';
import { TODOS_BUTTON, TODOS_CHIP, TODOS_REF_COLUMN, TODOS_ROW_LEAD } from './todoStyles';

interface TodoRowProps {
  entry: TodoEntry;
  grouping: TodosGrouping;
  selected: boolean;
  /** Just created: the row flashes once. */
  flash: boolean;
  now: number;
  onSelect: () => void;
  onOpen: () => void;
  onAction: (kind: TodoRowActionKind, anchor: DOMRect) => void;
}

/** A key cap inside a row's button, as the design draws it. */
function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[10.5px] font-normal leading-none text-text-secondary">
      {children}
    </kbd>
  );
}

function ActionButton({ kind, onClick }: { kind: TodoRowActionKind; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const stop = kind === 'stop';
  const label = kind === 'stop' ? 'Stop' : kind === 'resume' ? 'Resume' : kind === 'start' ? 'Start' : 'Start anyway';
  const key = kind === 'stop' ? 'S' : kind === 'start-anyway' ? null : 'R';
  return (
    <button type="button" className={TODOS_BUTTON} onClick={onClick} data-testid={`todo-row-${kind}`}>
      {stop
        ? <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
        : <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
      {label}
      {key && <KeyCap>{key}</KeyCap>}
    </button>
  );
}

/** The agent working it, as a small tile, or a dash when nobody is. */
function AgentTile({ agentId }: { agentId: string | undefined }) {
  return (
    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-surface-tertiary text-[11px] font-bold text-text-tertiary" aria-hidden="true">
      {agentId ? agentIdIcon(agentId, 'h-3.5 w-3.5 text-text-primary') : '–'}
    </span>
  );
}

/**
 * One to-do in the list (D-393, round 6): T-n, the status icon, the title with its reason, then its
 * chips, agent and age. Hovered or selected, the chips give way to Stop, Resume or Start anyway, and
 * Open.
 */
export function TodoRow({ entry, grouping, selected, flash, now, onSelect, onOpen, onAction }: TodoRowProps) {
  const { row } = entry;
  const { todo, status } = row;
  const action = entryAction(entry);
  const reasonClass = status.alert ? 'text-status-error' : status.status === 'waiting' ? 'text-text-secondary' : 'text-text-tertiary';
  const requester = requesterLabel(row);
  // A saved machine's to-do acts there; its page opens on that machine, not here.
  const hasActions = entry.remote ? action !== null : true;
  const title = entry.remote ? `${todo.title} · on ${row.machine}${entry.offline ? ', which can’t be reached' : ''}` : undefined;

  return (
    <div
      role="listitem"
      id={`todo-row-${entry.key}`}
      data-testid="todo-row"
      data-todo={todo.number}
      data-machine={entry.machineId}
      data-status={status.status}
      data-selected={selected || undefined}
      title={title}
      aria-current={selected || undefined}
      tabIndex={-1}
      onMouseDown={onSelect}
      onClick={onOpen}
      onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(); } }}
      className={cn(
        'group flex h-11 cursor-default items-center whitespace-nowrap border-b border-border-secondary pr-4 text-[14px]',
        TODOS_ROW_LEAD,
        selected ? 'bg-surface-selected' : 'hover:bg-surface-hover',
        flash && 'animate-todo-flash motion-reduce:animate-none',
      )}
    >
      <span className={cn(TODOS_REF_COLUMN, 'text-[13px] tabular-nums text-text-tertiary')}>{todoRef(todo.number)}</span>
      <TodoStatusIcon status={status.status} size="lg" />
      <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
        {todo.title}
        {status.reason && <span className={cn('ml-2 font-normal', reasonClass)} data-testid="todo-row-reason">{status.reason}</span>}
      </span>
      <span className={cn('inline-flex shrink-0 items-center gap-2', hasActions && (selected ? 'hidden' : 'group-hover:hidden'))}>
        {row.unread ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-interactive/15 px-2 text-[12px] font-semibold text-interactive-text" title="New replies">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />{row.unread}
          </span>
        ) : null}
        {row.subCounts && row.subCounts.total > 0 && <span className={TODOS_CHIP} title="Sub-to-dos">{row.subCounts.done}/{row.subCounts.total}</span>}
        {row.pr && <span className={TODOS_CHIP}>{row.pr.label}</span>}
        {grouping !== 'requester' && (
          <span className={TODOS_CHIP} title={todo.requester.gone ? `Requested by ${requester} (gone)` : `Requested by ${requester}`}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-text-tertiary" aria-hidden="true" />
            {requester}
          </span>
        )}
        {grouping !== 'repo' && row.projectName && <span className={TODOS_CHIP}>{row.projectName}</span>}
        {grouping !== 'machine' && entry.remote && (
          <span className={TODOS_CHIP}><Monitor className="h-3.5 w-3.5" aria-hidden="true" />{row.machine}</span>
        )}
        <AgentTile agentId={row.agentId ?? todo.agent ?? undefined} />
        <span className="w-[38px] shrink-0 text-right text-[12.5px] text-text-tertiary">{relativeAge(todo.updatedAt, now)}</span>
      </span>
      {hasActions && (
        <span className={cn('shrink-0 gap-1', selected ? 'inline-flex' : 'hidden group-hover:inline-flex')} onMouseDown={event => event.stopPropagation()}>
          {action && <ActionButton kind={action} onClick={event => { event.stopPropagation(); onAction(action, event.currentTarget.getBoundingClientRect()); }} />}
          {!entry.remote && (
            <button type="button" className={TODOS_BUTTON} onClick={event => { event.stopPropagation(); onOpen(); }} data-testid="todo-row-open">
              Open <KeyCap>↵</KeyCap>
            </button>
          )}
        </span>
      )}
    </div>
  );
}
