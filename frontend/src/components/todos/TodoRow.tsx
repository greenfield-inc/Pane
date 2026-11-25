import type { MouseEvent } from 'react';
import { Bell, MessageSquare, Monitor, Moon, Play, Square, Sun } from 'lucide-react';
import { todoRef } from '../../../../shared/types/todos';
import { cn } from '../../utils/cn';
import { agentIdIcon } from '../ui/brandIconRegistry';
import { relativeAge } from '../notify/notifyFormat';
import { TodoStatusIcon } from './TodoStatusIcon';
import { firstLine, snoozeWhen, wakesIn, wakesInShort, zoneNote } from './snoozeTime';
import { entryAction, requesterLabel, type TodoEntry, type TodoRowActionKind, type TodosGrouping } from './todoList';
import { TODOS_BUTTON, TODOS_CHIP, TODOS_REF_COLUMN, TODOS_ROW_LEAD } from './todoStyles';

interface TodoRowProps {
  entry: TodoEntry;
  grouping: TodosGrouping;
  selected: boolean;
  /** Just created: the row flashes once. */
  flash: boolean;
  now: number;
  /** The viewer's zone: a snoozed row's time reads in it. */
  zone: string;
  /** Its computer gives read-only access: no snooze or state action. */
  readOnly?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onAction: (kind: TodoRowActionKind, anchor: DOMRect) => void;
  /** Z: opens the snooze menu under this rect; absent where the to-do can't be snoozed. */
  onSnooze?: (anchor: DOMRect) => void;
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
  const label = kind === 'stop' ? 'Stop' : kind === 'resume' ? 'Resume' : kind === 'start' ? 'Start' : kind === 'wake' ? 'Wake now' : 'Start anyway';
  const key = kind === 'stop' ? 'S' : kind === 'start-anyway' ? null : 'R';
  return (
    <button type="button" className={TODOS_BUTTON} onClick={onClick} data-testid={`todo-row-${kind}`}>
      {kind === 'stop' && <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
      {kind === 'wake' && <Sun className="h-3 w-3" aria-hidden="true" />}
      {kind !== 'stop' && kind !== 'wake' && <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
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
export function TodoRow({ entry, grouping, selected, flash, now, zone, readOnly = false, onSelect, onOpen, onAction, onSnooze }: TodoRowProps) {
  const { row } = entry;
  const { todo, status } = row;
  // Snoozed (round 9): "until Wed 9:00 AM" in the viewer's zone, then the note's first line.
  const snooze = status.status === 'snoozed' ? todo.snooze : undefined;
  const reminder = todo.snooze && (todo.snooze.action === 'remind' || !todo.sessionId);
  const action = readOnly ? null : entryAction(entry);
  const reasonClass = status.alert ? 'text-status-error' : status.status === 'waiting' ? 'text-text-secondary' : 'text-text-tertiary';
  const requester = requesterLabel(row);
  // A saved machine's to-do acts there; its page opens on that machine, not here.
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
        {snooze ? (
          <span className="ml-2 font-normal text-text-tertiary" data-testid="todo-row-reason" title={zoneNote(snooze, zone) ?? undefined}>
            <span className="text-status-snoozed">until {snoozeWhen(snooze.until, now, zone)}</span>
            {[firstLine(snooze.note) || (reminder ? 'reminder for you' : ''), entry.offline ? 'machine offline' : ''].filter(Boolean).map(part => ` · ${part}`).join('')}
          </span>
        ) : status.reason && <span className={cn('ml-2 font-normal', reasonClass)} data-testid="todo-row-reason">{status.reason}</span>}
      </span>
      <span className={cn('inline-flex shrink-0 items-center gap-2', selected ? 'hidden' : 'group-hover:hidden')}>
        {row.unread ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-interactive/15 px-2 text-[12px] font-semibold text-interactive-text" title="New replies">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />{row.unread}
          </span>
        ) : null}
        {reminder && <span className={TODOS_CHIP} data-testid="todo-row-reminder"><Bell className="h-3.5 w-3.5" aria-hidden="true" />Reminder</span>}
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
        {snooze
          ? <span className="w-[38px] shrink-0 text-right text-[12.5px] tabular-nums text-status-snoozed" title={`Wakes in ${wakesIn(snooze.until, now)}`} data-testid="todo-row-wakes-in">{wakesInShort(snooze.until, now)}</span>
          : <span className="w-[38px] shrink-0 text-right text-[12.5px] text-text-tertiary">{relativeAge(todo.updatedAt, now)}</span>}
      </span>
      <span className={cn('shrink-0 gap-1', selected ? 'inline-flex' : 'hidden group-hover:inline-flex')} onMouseDown={event => event.stopPropagation()}>
        {onSnooze && (
          // A narrow window keeps the row's title: Z still snoozes there.
          <button type="button" className={cn(TODOS_BUTTON, 'hidden lg:inline-flex')} onClick={event => { event.stopPropagation(); onSnooze(event.currentTarget.getBoundingClientRect()); }} data-testid="todo-row-snooze">
            <Moon className="h-3 w-3" aria-hidden="true" />{snooze ? 'Change' : 'Snooze'} <KeyCap>Z</KeyCap>
          </button>
        )}
        {action && <ActionButton kind={action} onClick={event => { event.stopPropagation(); onAction(action, event.currentTarget.getBoundingClientRect()); }} />}
        {/* Another machine's to-do opens there (T-18): the window switches to that machine. */}
        <button type="button" className={TODOS_BUTTON} onClick={event => { event.stopPropagation(); onOpen(); }} data-testid="todo-row-open" title={entry.remote ? `Switch to ${row.machine} and open it` : undefined}>
          {entry.remote ? `Open on ${row.machine}` : 'Open'} <KeyCap>↵</KeyCap>
        </button>
      </span>
    </div>
  );
}
