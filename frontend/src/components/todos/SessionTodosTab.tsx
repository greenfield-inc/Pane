import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ListTodo, Plus } from 'lucide-react';
import { todoRef } from '../../../../shared/types/todos';
import { sessionTodoMachine, useSessionTodoApprovals, useSessionTodoEntries, useShownHostId, type CreatedTodo } from '../../stores/todosStore';
import { todoKey, todoKeyOfItem, todoKeyOfRow } from '../../../../shared/todoKey';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { openOnMachine } from '../../utils/machineRowActions';
import { useNotifyStore } from '../../stores/notifyStore';
import { useApprovalColumnStore, type ApprovalSurface } from '../../stores/approvalColumnStore';
import { cn } from '../../utils/cn';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { ApprovalColumn } from '../approvals/ApprovalColumn';
import { ApprovalOrigin } from '../approvals/ApprovalOrigin';
import { NewTodoDialog } from './NewTodoDialog';
import { TodoPage } from './page/TodoPage';
import { TodoStatusIcon } from './TodoStatusIcon';
import { firstLine, snoozeWhen, viewerZone, wakesIn, wakesInShort } from './snoozeTime';
import { SESSION_DONE_GROUP, SESSION_SNOOZED_GROUP, sessionGroupFolded, sessionOpenCount, sessionTodoGroups, stepTodo, withSessionFold } from './sessionTodosList';
import { FRESH, tabMemoryKey, useTabMemory, type TabMemory } from './sessionTodosTabMemory';
import { headerKey, listStops, moveSelection, nextWake, resolveStop, type TodoEntry, type TodoGroup } from './todoList';
import { isTypingTarget, openTodo, openTodosByRequester, overlayOpen } from './todosNavigation';
import { TODOS_BUTTON } from './todoStyles';

/**
 * A Session's To-dos tab (T-23, D-440): the to-dos this Session asked for, in the To-dos screen's groups
 * and keys, beside its chat. A to-do opens inside the tab ("‹ To-dos / T-14"), and an approval opens
 * in the same Decide view as the Session's approval column, with "‹ Back to To-dos".
 */

/** Under this width the rows drop T-n and the agent chip, keeping the title, the reason and the time. */
const NARROW_TAB_PX = 440;

function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setNarrow(element.clientWidth < NARROW_TAB_PX);
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_TAB_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

interface SessionTodosTabProps {
  sessionId: string;
  /** The machine the Session runs on; absent for this computer. */
  machineId?: string;
  /** The Session's chat: an approval asked there has no origin tab here. */
  inChat?: string;
}

export function SessionTodosTab({ sessionId, machineId, inChat }: SessionTodosTabProps) {
  const entries = useSessionTodoEntries(sessionId, machineId);
  const shownHost = useShownHostId();
  const todosMachine = sessionTodoMachine(machineId, shownHost);
  // Per Session on its machine (T-51 F-4): another machine's Session with the same id has its own view.
  const tabKey = tabMemoryKey(todosMachine, sessionId);
  const memory = useTabMemory(state => state.tabs[tabKey] ?? FRESH);
  const update = useTabMemory(state => state.update);
  const now = useNow();
  const groups = useMemo(() => sessionTodoGroups(entries ?? [], now), [entries, now]);
  const folded = useCallback((group: TodoGroup) => sessionGroupFolded(memory.folds, group, groups.length), [memory.folds, groups.length]);
  const stops = useMemo(() => listStops(groups, folded), [groups, folded]);
  // What Answer opens and the pager walks: the same approvals as the tabs' counts (T-37).
  const approvals = useSessionTodoApprovals(sessionId, machineId).items;
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(rootRef);

  const select = useCallback((key: string | null) => update(tabKey, { selected: key }), [tabKey, update]);
  const keyOf = useCallback((number: number): string => todoKey(todosMachine, number), [todosMachine]);
  const showList = useCallback((selected?: string) => update(tabKey, selected === undefined ? { view: { kind: 'list' } } : { view: { kind: 'list' }, selected }), [tabKey, update]);
  const openNumber = useCallback((number: number) => {
    // A to-do page reads only the computer the window shows (T-51 F-4): another machine's to-do opens there.
    if (todosMachine !== shownHost) void openOnMachine(todosMachine, { kind: 'todo', id: number, name: todoRef(number) });
    else update(tabKey, { view: { kind: 'todo', machineId: todosMachine, number }, selected: keyOf(number) });
  }, [keyOf, tabKey, todosMachine, shownHost, update]);
  const openApproval = useCallback((id: string, key: string) => update(tabKey, { view: { kind: 'approval', id }, selected: key }), [tabKey, update]);

  const openCreated = (created: CreatedTodo) => {
    // Made on another machine (T-51): it opens there, as the To-dos list opens one, never as this machine's to-do with that number.
    // `local` is the list's own host: the computer this window shows.
    if ((created.machineId === LOCAL_MACHINE_ID ? shownHost : created.machineId) === todosMachine) openNumber(created.number);
    else void openOnMachine(created.machineId, { kind: 'todo', id: created.number, name: todoRef(created.number) });
  };

  const { view } = memory;
  // An approval answered elsewhere (Approvals, the chat card, another machine) leaves the Decide view for the list (T-23 QA F4).
  const notifyLoaded = useNotifyStore(state => state.snapshot !== null);
  const shownApproval = view.kind === 'approval' ? view.id : null;
  useEffect(() => {
    if (shownApproval && notifyLoaded && !approvals.some(item => item.id === shownApproval)) showList();
  }, [shownApproval, notifyLoaded, approvals, showList]);
  let body;
  if (entries === null) {
    body = null;
  } else if (view.kind === 'todo' && view.machineId === todosMachine && view.machineId === shownHost) {
    body = (
      <OpenTodo
        number={view.number}
        machineId={view.machineId}
        onBack={() => showList(keyOf(view.number))}
        onOpen={openNumber}
        onStep={(step) => {
          const next = stepTodo(stops, groups, keyOf(view.number), step);
          const entry = next ? groups.flatMap(group => group.entries).find(candidate => candidate.key === next) : undefined;
          if (entry) openNumber(entry.row.todo.number);
        }}
      />
    );
  } else if (view.kind === 'approval') {
    body = (
      <TodoApproval
        sessionId={sessionId}
        itemId={view.id}
        order={approvals.map(item => item.id)}
        inChat={inChat}
        onSelect={(id) => update(tabKey, { view: { kind: 'approval', id } })}
        onBack={() => showList()}
      />
    );
  } else {
    body = (
      <TodosList
        entries={entries}
        groups={groups}
        folded={folded}
        memory={memory}
        narrow={narrow}
        now={now}
        onSelect={select}
        onFold={(group, fold) => {
          const patch: Partial<TabMemory> = { folds: withSessionFold(memory.folds, group.key, fold) };
          if (fold) patch.selected = headerKey(group.key);
          else if (group.entries[0]) patch.selected = group.entries[0].key;
          update(tabKey, patch);
        }}
        onOpen={(entry) => openNumber(entry.row.todo.number)}
        onAnswer={(entry) => {
          const id = entry.row.status.waitingApprovalId ?? approvals.find(item => todoKeyOfItem(item) === todoKeyOfRow(todosMachine, entry.row))?.id;
          if (id) openApproval(id, entry.key);
          else openNumber(entry.row.todo.number);
        }}
        onNew={() => setCreating(true)}
      />
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-col bg-bg-primary text-[14px] text-text-primary" data-testid="session-todos-tab" data-view={view.kind} data-narrow={narrow || undefined}>
      {body}
      {/* A to-do made here is yours (the dialog says so), so the list may not hold it: it opens here all the same (T-23 QA F1). */}
      {creating && <NewTodoDialog onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); openCreated(created); }} />}
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

interface TodosListProps {
  entries: TodoEntry[];
  groups: TodoGroup[];
  folded: (group: TodoGroup) => boolean;
  memory: TabMemory;
  narrow: boolean;
  now: number;
  onSelect: (key: string | null) => void;
  onFold: (group: TodoGroup, fold: boolean) => void;
  onOpen: (entry: TodoEntry) => void;
  onAnswer: (entry: TodoEntry) => void;
  onNew: () => void;
}

const ICON_BUTTON = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-40 disabled:hover:bg-transparent';

function TodosList({ entries, groups, folded, memory, narrow, now, onSelect, onFold, onOpen, onAnswer, onNew }: TodosListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const zone = useMemo(viewerZone, []);
  const stops = useMemo(() => listStops(groups, folded), [groups, folded]);
  const index = resolveStop(stops, groups, memory.selected);
  const current = index >= 0 ? stops[index] : undefined;

  // Opened from its tab (or back from a to-do), the list takes the keys; arriving with focus elsewhere (the chat) it leaves it there.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.getAttribute('role') === 'tab') listRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!current) return;
    const id = current.kind === 'row' ? rowId(current.key) : groupId(current.group.key);
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isTypingTarget(event.target) || overlayOpen()) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'j' || key === 'ArrowDown' || key === 'k' || key === 'ArrowUp') {
      event.preventDefault();
      const next = moveSelection(Math.max(0, index), stops.length, key === 'j' || key === 'ArrowDown' ? 1 : -1);
      if (stops[next]) onSelect(stops[next].key);
    } else if (current?.kind === 'header' && (key === 'Enter' || key === 'ArrowRight' || key === ' ')) {
      event.preventDefault();
      onFold(current.group, false);
    } else if (key === 'ArrowLeft' && current?.kind === 'row') {
      event.preventDefault();
      onFold(current.group, true);
    } else if (key === 'Enter' && current?.kind === 'row') {
      event.preventDefault();
      onOpen(current.entry);
    }
  };

  const open = sessionOpenCount(entries);
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-primary pl-3.5 pr-2" data-testid="session-todos-header">
        <h2 className="shrink-0 text-[15px] font-semibold">To-dos</h2>
        {entries.length > 0 && <span className="truncate text-[13px] text-text-tertiary" data-testid="session-todos-open-count">· {open} open</span>}
        <span className="flex-1" />
        {entries.length > 0 && (
          <>
            <button type="button" onClick={onNew} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="session-todos-new">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />New
            </button>
            <button type="button" onClick={openTodosByRequester} aria-label="Open in To-dos" title="Open in To-dos, grouped by Requested by" className={ICON_BUTTON} data-testid="session-todos-open-screen">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {entries.length === 0 ? <EmptyState onNew={onNew} /> : (
        <div ref={listRef} tabIndex={-1} role="list" aria-label="This Session's to-dos" onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto focus:outline-none" data-testid="session-todos-list">
          {groups.length === 0 && <p className="p-6 text-center text-[13px] text-text-tertiary">Nothing open. Older done to-dos are on the To-dos screen.</p>}
          {groups.map(group => {
            const isFold = folded(group);
            const selectedHeader = current?.kind === 'header' && current.group.key === group.key;
            return (
              <div key={group.key} role="presentation">
                <GroupHeader group={group} folded={isFold} selected={selectedHeader} now={now} zone={zone}
                  onToggle={() => { onFold(group, !isFold); listRef.current?.focus({ preventScroll: true }); }} />
                {!isFold && group.entries.map(entry => (
                  <SessionTodoRow key={entry.key} entry={entry} selected={current?.kind === 'row' && current.key === entry.key} narrow={narrow} now={now} zone={zone}
                    onSelect={() => onSelect(entry.key)} onOpen={() => onOpen(entry)} onAnswer={() => onAnswer(entry)} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const rowId = (key: string) => `session-todo-row-${key}`;
const groupId = (key: string) => `session-todos-group-${key}`;

function GroupHeader({ group, folded, selected, now, zone, onToggle }: { group: TodoGroup; folded: boolean; selected: boolean; now: number; zone: string; onToggle: () => void }) {
  const wake = folded && group.key === SESSION_SNOOZED_GROUP ? nextWake(group) : null;
  return (
    <button
      type="button"
      id={groupId(group.key)}
      tabIndex={-1}
      aria-expanded={!folded}
      aria-label={`${group.label}, ${group.entries.length}${folded ? ', folded' : ''}`}
      onMouseDown={event => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        'sticky top-0 z-[1] flex h-[34px] w-full items-center gap-2 border-b border-border-secondary pl-2.5 pr-3.5 text-left text-[13px] font-semibold outline-none',
        selected ? 'bg-surface-selected' : 'bg-surface-secondary hover:bg-surface-hover',
      )}
      data-testid="session-todos-group"
      data-group={group.key}
      data-folded={folded || undefined}
      data-selected={selected || undefined}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary" aria-hidden="true">
        {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </span>
      {group.status && <TodoStatusIcon status={group.status} />}
      <span className="truncate">{group.label}</span>
      <span className="font-medium text-text-tertiary" data-testid="session-todos-group-count">{group.entries.length}</span>
      <span className="flex-1" />
      {wake !== null && <span className="truncate text-[12.5px] font-normal text-text-tertiary" data-testid="session-todos-next-wake">next wakes {snoozeWhen(wake, now, zone)}</span>}
      {folded && group.key === SESSION_DONE_GROUP && <span className="truncate text-[12.5px] font-normal text-text-tertiary">older ones in To-dos</span>}
    </button>
  );
}

/** Who works on it, as the row's chip: the tab doing the work, else its orchestrator, else you. */
function workerLabel(entry: TodoEntry): string {
  const { todo } = entry.row;
  return todo.assignee?.name ?? (todo.agent || entry.row.agentId || todo.startedAt !== null ? 'orchestrator' : 'you');
}

/** The row's second line: a question waiting on you ("Q-31 · Three reminders or two?"), else the status's reason. */
function reasonOf(entry: TodoEntry, now: number, zone: string): string {
  const { todo, status } = entry.row;
  if (status.status === 'snoozed' && todo.snooze) return [`until ${snoozeWhen(todo.snooze.until, now, zone)}`, firstLine(todo.snooze.note)].filter(Boolean).join(' · ');
  if (status.status === 'waiting' && status.waitingQuestion) return [status.waitingQn, status.waitingQuestion].filter(Boolean).join(' · ');
  return status.reason;
}

interface SessionTodoRowProps {
  entry: TodoEntry;
  selected: boolean;
  narrow: boolean;
  now: number;
  zone: string;
  onSelect: () => void;
  onOpen: () => void;
  onAnswer: () => void;
}

/**
 * One to-do, compact for the split (T-23): its status, T-n, the title and its age; then the reason and
 * who works on it, with Answer while it waits on you. ⌘-click opens it on the To-dos screen.
 */
function SessionTodoRow({ entry, selected, narrow, now, zone, onSelect, onOpen, onAnswer }: SessionTodoRowProps) {
  const { todo, status } = entry.row;
  const waiting = status.status === 'waiting';
  const snooze = status.status === 'snoozed' ? todo.snooze : undefined;
  const reason = reasonOf(entry, now, zone);
  const click = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) openTodo(todo.number);
    else onOpen();
  };
  return (
    <div
      role="listitem"
      id={rowId(entry.key)}
      tabIndex={-1}
      onMouseDown={onSelect}
      onClick={click}
      onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(); } }}
      aria-current={selected || undefined}
      className={cn(
        'grid cursor-default grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-b border-border-secondary py-2 pl-3.5 pr-3.5',
        !narrow && 'grid-cols-[16px_36px_minmax(0,1fr)_auto]',
        selected ? 'bg-surface-selected shadow-[inset_2px_0_0_0_var(--color-interactive-primary)]' : 'hover:bg-surface-hover',
      )}
      data-testid="session-todo-row"
      data-todo={todo.number}
      data-status={status.status}
      data-selected={selected || undefined}
      title={`${todoRef(todo.number)} ${todo.title}`}
    >
      <TodoStatusIcon status={status.status} />
      {!narrow && <span className="text-[12.5px] tabular-nums text-text-tertiary" data-testid="session-todo-ref">{todoRef(todo.number)}</span>}
      <span className="truncate text-[13.5px] font-medium">{todo.title}</span>
      {snooze
        ? <span className="text-right text-[12px] tabular-nums text-status-snoozed" title={`Wakes in ${wakesIn(snooze.until, now)}`}>{wakesInShort(snooze.until, now)}</span>
        : <span className="text-right text-[12px] text-text-tertiary">{relativeAge(todo.updatedAt, now)}</span>}
      <span aria-hidden="true" />
      <span className={cn('flex min-w-0 items-center gap-2', narrow ? 'col-span-2' : 'col-span-3')}>
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', status.alert ? 'text-status-error' : waiting ? 'font-medium text-status-warning-on-tint' : snooze ? 'text-status-snoozed' : 'text-text-secondary')} data-testid="session-todo-reason">
          {reason}
        </span>
        {!narrow && <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border-primary px-2 text-[11.5px] text-text-secondary" data-testid="session-todo-worker">{workerLabel(entry)}</span>}
        {waiting && (
          <button type="button" onClick={event => { event.stopPropagation(); onAnswer(); }} onMouseDown={event => event.stopPropagation()}
            className="inline-flex h-6 shrink-0 items-center rounded-md border border-status-warning/50 bg-status-warning/10 px-2 text-[12px] font-semibold text-status-warning-on-tint hover:bg-status-warning/20"
            data-testid="session-todo-answer">Answer</button>
        )}
      </span>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-6 pt-14 text-center" data-testid="session-todos-empty">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tertiary text-text-secondary" aria-hidden="true">
        <ListTodo className="h-5 w-5" />
      </span>
      <p className="text-[14px] font-semibold text-text-primary">No to-dos in this Session yet</p>
      <p className="mt-1 max-w-[440px] text-[13px] text-text-secondary">When the orchestrator plans work, its to-dos show here with their status and approvals.</p>
      <button type="button" onClick={onNew} className={cn(TODOS_BUTTON, 'mt-3.5')} data-testid="session-todos-empty-new">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />New to-do
      </button>
    </div>
  );
}

// ── An open to-do ───────────────────────────────────────────────────────────

function OpenTodo({ number, machineId, onBack, onOpen, onStep }: { number: number; machineId: string; onBack: () => void; onOpen: (number: number) => void; onStep: (step: 1 | -1) => void }) {
  // ↑ ↓ (J K) step through the list without going back; a field, a menu or a page's own keys keep theirs.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isTypingTarget(event.target) || overlayOpen()) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key !== 'j' && key !== 'k' && key !== 'ArrowDown' && key !== 'ArrowUp') return;
    event.preventDefault();
    onStep(key === 'j' || key === 'ArrowDown' ? 1 : -1);
  };
  const trailing = (
    <>
      <button type="button" onClick={() => onStep(-1)} aria-label="Previous to-do" title="Previous to-do (K or ↑)" className={ICON_BUTTON} data-testid="session-todo-prev"><ChevronUp className="h-4 w-4" aria-hidden="true" /></button>
      <button type="button" onClick={() => onStep(1)} aria-label="Next to-do" title="Next to-do (J or ↓)" className={ICON_BUTTON} data-testid="session-todo-next"><ChevronDown className="h-4 w-4" aria-hidden="true" /></button>
      <button type="button" onClick={() => openTodo(number)} aria-label="Open in To-dos" title="Open in To-dos" className={ICON_BUTTON} data-testid="session-todo-open-screen"><ArrowUpRight className="h-4 w-4" aria-hidden="true" /></button>
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="session-todo-open">
      <TodoPage number={number} machineId={machineId} onBack={onBack} onOpenTodo={onOpen} embedded={{ trailing }} />
    </div>
  );
}

// ── An approval ─────────────────────────────────────────────────────────────

interface TodoApprovalProps {
  sessionId: string;
  itemId: string;
  order: readonly string[];
  inChat?: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}

/** The Session's approval column's Decide view, inside the tab: Send or ‹ Back to To-dos returns to the list. */
function TodoApproval({ sessionId, itemId, order, inChat, onSelect, onBack }: TodoApprovalProps) {
  const surface: ApprovalSurface = `session-todos:${sessionId}`;
  // The column's tab and nested approval are this visit's alone.
  useEffect(() => () => useApprovalColumnStore.getState().close(surface), [surface]);
  // Esc goes back wherever focus is: right after Answer it is still on the page, not in this view (T-23 QA F2).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target) || overlayOpen()) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-todo-approval">
      <div className="flex h-9 shrink-0 items-center border-b border-border-primary px-2">
        <button type="button" onClick={onBack} className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="session-todo-approval-back">
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />Back to To-dos
        </button>
      </div>
      <ApprovalColumn
        surface={surface}
        itemId={itemId}
        order={order}
        onSelect={onSelect}
        groupLabel="To-do approvals"
        inChat={inChat}
        renderOrigin={(item) => <ApprovalOrigin item={item} />}
        onSent={onBack}
      />
    </div>
  );
}
