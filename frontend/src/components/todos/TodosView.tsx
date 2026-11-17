import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Gauge, Plus, SlidersHorizontal } from 'lucide-react';
import { todoRef, type TodoAction } from '../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { useNavigationStore } from '../../stores/navigationStore';
import { useRemoteTodosPoll, useTodosStore, type CreatedTodo } from '../../stores/todosStore';
import { cn } from '../../utils/cn';
import { Dropdown } from '../ui/Dropdown';
import { useNow } from '../notify/useNow';
import { TodoPage } from './page/TodoPage';
import { NewTodoDialog } from './NewTodoDialog';
import { TodoConfirm, type TodoConfirmRequest } from './TodoConfirm';
import { TodoRow } from './TodoRow';
import { TodoStatusIcon } from './TodoStatusIcon';
import {
  TODOS_GROUPINGS, TODOS_GROUPING_LABEL, actionForKey, flattenGroups, groupTodos, moveSelection, nextGrouping, tabCounts,
  type TodoEntry, type TodoRowActionKind, type TodosGrouping, type TodosTab,
} from './todoList';
import { isTypingTarget, leaveTodos, overlayOpen } from './todosNavigation';
import { TODOS_BUTTON, TODOS_PILL, TODOS_PILL_OFF, TODOS_PILL_ON } from './todoStyles';
import { useTodoEntries } from './useTodoEntries';

interface TabItem {
  id: TodosTab;
  label: string;
}

const TABS: readonly TabItem[] = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

const GROUPING_PREFERENCE = 'pane-todos-grouping';
const FLASH_MS = 1800;

function readGrouping(): TodosGrouping {
  try {
    const saved = localStorage.getItem(GROUPING_PREFERENCE);
    return TODOS_GROUPINGS.find(grouping => grouping === saved) ?? 'status';
  } catch {
    return 'status';
  }
}

function saveGrouping(grouping: TodosGrouping): void {
  try { localStorage.setItem(GROUPING_PREFERENCE, grouping); } catch { /* A remembered grouping is a convenience. */ }
}

/** The TodoAction a row's action sends. */
function actionOf(kind: TodoRowActionKind, number: number): TodoAction {
  if (kind === 'start-anyway') return { kind: 'start', number, anyway: true };
  return { kind, number };
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map(key => (
        <kbd key={key} className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[10.5px] leading-none text-text-secondary">{key}</kbd>
      ))}
      <span className="ml-0.5">{label}</span>
    </span>
  );
}

/**
 * The To-dos screen (D-393, D-409, round 6): every to-do on this machine and each saved one, in
 * tabs (Open, Waiting on you, Done, All) and groups (Status, Requested by, Repo, Machine). J and K
 * move, ↵ opens, S and R stop and resume after a confirmation, G changes the grouping, C opens New
 * to-do, and Esc goes back to where you were. A selected to-do's page shows in place of the list.
 */
export function TodosView() {
  const selected = useNavigationStore(state => state.selectedTodoNumber);
  const selectTodo = useNavigationStore(state => state.selectTodo);
  useRemoteTodosPoll();
  if (selected !== null) {
    return <TodoPage key={selected} number={selected} onBack={() => selectTodo(null)} onOpenTodo={number => selectTodo(number)} />;
  }
  return <TodosList onOpen={number => selectTodo(number)} />;
}

function TodosList({ onOpen }: { onOpen: (number: number) => void }) {
  const entries = useTodoEntries();
  const loaded = useTodosStore(state => state.snapshot !== null);
  const gate = useTodosStore(state => state.snapshot?.gate);
  const act = useTodosStore(state => state.act);
  const actOn = useTodosStore(state => state.actOn);
  const now = useNow();
  const [tab, setTab] = useState<TodosTab>('open');
  const [grouping, setGroupingState] = useState<TodosGrouping>(readGrouping);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TodoConfirmRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => tabCounts(entries), [entries]);
  const groups = useMemo(() => groupTodos(entries, tab, grouping), [entries, tab, grouping]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const foundIndex = flat.findIndex(entry => entry.key === selectedKey);
  const selectedIndex = foundIndex >= 0 ? foundIndex : 0;
  const current: TodoEntry | undefined = flat[selectedIndex];

  const setGrouping = useCallback((next: TodosGrouping) => {
    setGroupingState(next);
    saveGrouping(next);
  }, []);

  // Keys belong to the list once it is open, wherever the click that opened it came from.
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!flashKey) return;
    const timer = window.setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  useEffect(() => {
    if (!current) return;
    document.getElementById(`todo-row-${current.key}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const openEntry = useCallback((entry: TodoEntry | undefined) => {
    if (!entry || entry.remote) return;
    setSelectedKey(entry.key);
    onOpen(entry.row.todo.number);
  }, [onOpen]);

  const askAction = useCallback((entry: TodoEntry, kind: TodoRowActionKind, anchor?: DOMRect) => {
    const rect = anchor ?? document.getElementById(`todo-row-${entry.key}`)?.getBoundingClientRect();
    if (!rect) return;
    setSelectedKey(entry.key);
    setConfirm({ kind, row: entry.row, machineId: entry.machineId, anchor: rect });
  }, []);

  const runConfirmed = useCallback(() => {
    if (!confirm) return;
    setConfirm(null);
    const action = actionOf(confirm.kind, confirm.row.todo.number);
    // A saved machine's to-do: the action runs on that machine, through its own checks (J46).
    if (confirm.machineId === LOCAL_MACHINE_ID) void act(action);
    else void actOn(confirm.machineId, action);
    rootRef.current?.focus({ preventScroll: true });
  }, [act, actOn, confirm]);

  const cancelConfirm = useCallback(() => {
    setConfirm(null);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const onCreated = useCallback((created: CreatedTodo) => {
    const key = `${created.machineId}:${created.number}`;
    setCreating(false);
    setTab('open');
    setSelectedKey(key);
    setFlashKey(key);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (creating || confirm || isTypingTarget(event.target) || overlayOpen()) return;
      // The list's keys work while focus is on it (or nowhere); the sidebar keeps its own J and K.
      const active = document.activeElement;
      if (active && active !== document.body && !viewRef.current?.contains(active)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === 'Escape') {
        if (event.shiftKey) return;
        event.preventDefault();
        leaveTodos();
        return;
      }
      if (event.shiftKey) return;
      if (key === 'j' || key === 'ArrowDown' || key === 'k' || key === 'ArrowUp') {
        event.preventDefault();
        const next = moveSelection(selectedIndex, flat.length, key === 'j' || key === 'ArrowDown' ? 1 : -1);
        if (flat[next]) setSelectedKey(flat[next].key);
      } else if (key === 'Enter') {
        if (!current) return;
        event.preventDefault();
        openEntry(current);
      } else if (key === 's' || key === 'r') {
        if (!current || current.offline) return;
        const action = actionForKey(current.row, key);
        if (!action) return;
        event.preventDefault();
        askAction(current, action);
      } else if (key === 'g') {
        event.preventDefault();
        setGrouping(nextGrouping(grouping));
      } else if (key === 'c') {
        event.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askAction, confirm, creating, current, flat, grouping, openEntry, selectedIndex, setGrouping]);

  const loadLine = gate && gate.state !== 'normal' && gate.line ? gate.line : null;

  return (
    <div ref={viewRef} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary text-[13px] text-text-primary" data-testid="todos-view">
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
        <h1 className="mr-1.5 text-[14px] font-semibold">To-dos</h1>
        <div role="tablist" aria-label="Which to-dos" className="flex items-center gap-2">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              data-testid={`todos-tab-${item.id}`}
              onClick={() => { setTab(item.id); setSelectedKey(null); }}
              className={cn(TODOS_PILL, tab === item.id ? TODOS_PILL_ON : TODOS_PILL_OFF)}
            >
              {item.label}
              {item.id === 'waiting' && <b className="font-semibold text-status-warning" data-testid="todos-waiting-count">{counts.waiting}</b>}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Dropdown
          trigger={(
            <button type="button" className={TODOS_BUTTON} data-testid="todos-group" aria-label={`Group by ${TODOS_GROUPING_LABEL[grouping]}`}>
              <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
              Group: {TODOS_GROUPING_LABEL[grouping]}
              <ChevronDown className="h-3 w-3 text-text-tertiary" aria-hidden="true" />
            </button>
          )}
          header="Group by"
          items={TODOS_GROUPINGS.map(id => ({ id, label: TODOS_GROUPING_LABEL[id], onClick: () => setGrouping(id) }))}
          selectedId={grouping}
          selectedMark="check"
          position="bottom-right"
          width="md"
        />
        <button type="button" className={TODOS_BUTTON} onClick={() => setCreating(true)} data-testid="todos-new">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />New to-do
        </button>
      </div>

      <div
        ref={rootRef}
        tabIndex={-1}
        role="list"
        aria-label="To-dos"
        className="min-h-0 flex-1 overflow-auto focus:outline-none"
        data-testid="todos-list"
      >
        {flat.length === 0 && loaded && <p className="p-6 text-text-tertiary">Nothing here.</p>}
        {groups.map(group => (
          <div key={group.key} role="presentation">
            <div className="sticky top-0 z-[1] flex h-[34px] items-center gap-2 border-b border-border-secondary bg-surface-secondary pl-3.5 pr-4 text-[12.5px] font-semibold" data-testid="todos-group-header" data-group={group.key}>
              {group.status && <TodoStatusIcon status={group.status} />}
              <span className="truncate">{group.label}</span>
              <span className="font-medium text-text-tertiary">{group.entries.length}</span>
            </div>
            {group.status === 'queued' && loadLine && (
              <div className="flex h-[30px] items-center gap-2 border-b border-border-secondary pl-[38px] pr-4 text-[12px] text-text-secondary" data-testid="todos-load-line">
                <Gauge className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="truncate">{loadLine} · queued to-dos start when load comes down</span>
              </div>
            )}
            {group.entries.map(entry => (
              <TodoRow
                key={entry.key}
                entry={entry}
                grouping={grouping}
                selected={entry.key === current?.key}
                flash={entry.key === flashKey}
                now={now}
                onSelect={() => setSelectedKey(entry.key)}
                onOpen={() => openEntry(entry)}
                onAction={(kind, anchor) => askAction(entry, kind, anchor)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex h-[30px] shrink-0 items-center gap-3.5 border-t border-border-primary px-4 text-[11.5px] text-text-tertiary" data-testid="todos-footer">
        <KeyHint keys={['J', 'K']} label="move" />
        <KeyHint keys={['↵']} label="open" />
        <KeyHint keys={['S']} label="stop" />
        <KeyHint keys={['R']} label="resume" />
        <KeyHint keys={['G']} label="group by" />
        <KeyHint keys={['C']} label="new to-do" />
        <span className="flex-1" />
        <span>{counts.open} open</span>
      </div>

      {confirm && <TodoConfirm request={confirm} onCancel={cancelConfirm} onConfirm={runConfirmed} />}
      {creating && <NewTodoDialog onClose={() => { setCreating(false); rootRef.current?.focus({ preventScroll: true }); }} onCreated={onCreated} />}
      <span className="sr-only" role="status" aria-live="polite">{flashKey ? `${todoRef(Number(flashKey.split(':').pop()))} created` : ''}</span>
    </div>
  );
}
