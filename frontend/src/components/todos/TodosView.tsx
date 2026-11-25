import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronRight, Gauge, Plus, SlidersHorizontal } from 'lucide-react';
import { todoRef, type TodoAction } from '../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { useNavigationStore, type SelectedTodo } from '../../stores/navigationStore';
import { todoKey } from '../../../../shared/todoKey';
import { openOnMachine } from '../../utils/machineRowActions';
import { shownSnapshot, useRemoteTodosPoll, useShownHostId, useTodosStore, type CreatedTodo } from '../../stores/todosStore';
import { cn } from '../../utils/cn';
import { Dropdown } from '../ui/Dropdown';
import { useNow } from '../notify/useNow';
import { TodoPage } from './page/TodoPage';
import { MAIN_AREA, SplitAreaContext } from '../../utils/mainSplits';
import { NewTodoDialog } from './NewTodoDialog';
import { TodoConfirm, type TodoConfirmRequest } from './TodoConfirm';
import { TodoRow } from './TodoRow';
import { TodoStatusIcon } from './TodoStatusIcon';
import { SnoozeMenu, type SnoozeChoice } from './SnoozeMenu';
import { snoozeWhen, viewerZone } from './snoozeTime';
import {
  TODOS_GROUPINGS, TODOS_GROUPING_LABEL, actionForKey, canSnooze, groupTodos, headerKey, isFolded, listStops, moveSelection, nextGrouping, nextWake,
  readFolds, resolveStop, stopAfterLeaving, tabCounts, withFold, writeFolds,
  type TodoEntry, type TodoFolds, type TodoGroup, type TodoRowActionKind, type TodosGrouping, type TodosTab,
} from './todoList';
import { isTypingTarget, leaveTodos, overlayOpen, readGrouping, saveGrouping } from './todosNavigation';
import { TODOS_HEADER_BUTTON, TODOS_PILL, TODOS_PILL_OFF, TODOS_PILL_ON, TODOS_REF_COLUMN, TODOS_ROW_LEAD } from './todoStyles';
import { useTodoEntries } from './useTodoEntries';

interface TabItem {
  id: TodosTab;
  label: string;
  /** Its label in a narrow list. */
  short?: string;
}

const TABS: readonly TabItem[] = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting on you', short: 'Waiting' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

/** Under this width the header and footer shorten their words so nothing wraps or clips (T-6). */
const NARROW_LIST_PX = 720;
const FLASH_MS = 1800;


/** The TodoAction a row's action sends. */
function actionOf(kind: TodoRowActionKind, number: number): TodoAction {
  if (kind === 'start-anyway') return { kind: 'start', number, anyway: true };
  return { kind, number };
}

const SNOOZED_GROUP = 'status:snoozed';

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The person's folds (D-432), per tab × grouping × group, kept in the renderer's saved UI state. */
function useFolds(): [TodoFolds, (tab: TodosTab, grouping: TodosGrouping, groupKey: string, folded: boolean) => void] {
  const [folds, setFolds] = useState<TodoFolds>(() => {
    const storage = safeStorage();
    return storage ? readFolds(storage) : {};
  });
  const setFold = useCallback((tab: TodosTab, grouping: TodosGrouping, groupKey: string, folded: boolean) => {
    setFolds(current => {
      const next = withFold(current, tab, grouping, groupKey, folded);
      const storage = safeStorage();
      if (storage) writeFolds(storage, next);
      return next;
    });
  }, []);
  return [folds, setFold];
}

/** A row snoozed into a folded Snoozed: "Snoozed T-14 until Wed 9:00 AM · Show". */
interface SnoozedNote {
  key: string;
  ref: string;
  until: number;
}

/** What the open snooze menu snoozes. */
interface SnoozeRequest {
  entry: TodoEntry;
  anchor: DOMRect;
}

/** Whether the list is narrower than NARROW_LIST_PX, measured before paint and on every resize. */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setNarrow(element.clientWidth < NARROW_LIST_PX);
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_LIST_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map(key => (
        <kbd key={key} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[11px] leading-none text-text-secondary">{key}</kbd>
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
  const chosen = useNavigationStore(state => state.selectedTodo);
  const selectTodo = useNavigationStore(state => state.selectTodo);
  const shownHost = useShownHostId();
  useRemoteTodosPoll();
  // A page is the to-do of the computer it was opened on (T-51): once the window shows another, it is not shown.
  const selected = chosen?.machineId === shownHost ? chosen.number : null;
  // Back on the list, the row you opened stays selected (round 7 QA, R1), on the computer it was opened on.
  const [lastOpened, setLastOpened] = useState<SelectedTodo | null>(null);
  useEffect(() => { if (chosen !== null) setLastOpened(chosen); }, [chosen]);
  if (selected !== null) {
    // The whole main area: the to-do page and one file may be its two splits (D-448).
    return (
      <SplitAreaContext.Provider value={MAIN_AREA}>
        <TodoPage key={todoKey(shownHost, selected)} number={selected} machineId={shownHost} onBack={() => selectTodo(null)} onOpenTodo={number => selectTodo(number)} />
      </SplitAreaContext.Provider>
    );
  }
  return <TodosList onOpen={number => selectTodo(number)} lastOpened={lastOpened?.machineId === shownHost ? lastOpened.number : null} />;
}

function TodosList({ onOpen, lastOpened }: { onOpen: (number: number) => void; lastOpened: number | null }) {
  const entries = useTodoEntries();
  const shownHost = useShownHostId();
  const loaded = useTodosStore(state => shownSnapshot(state, shownHost) !== null);
  const gate = useTodosStore(state => shownSnapshot(state, shownHost)?.gate);
  const act = useTodosStore(state => state.act);
  const actOn = useTodosStore(state => state.actOn);
  const now = useNow();
  const [tab, setTab] = useState<TodosTab>('open');
  const [grouping, setGroupingState] = useState<TodosGrouping>(readGrouping);
  const [selectedKey, setSelectedKey] = useState<string | null>(lastOpened === null ? null : `${LOCAL_MACHINE_ID}:${lastOpened}`);
  const [confirm, setConfirm] = useState<TodoConfirmRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [snoozing, setSnoozing] = useState<SnoozeRequest | null>(null);
  const [snoozedNote, setSnoozedNote] = useState<SnoozedNote | null>(null);
  const [folds, setFold] = useFolds();
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(viewRef);
  const zone = useMemo(viewerZone, []);

  const counts = useMemo(() => tabCounts(entries), [entries]);
  const groups = useMemo(() => groupTodos(entries, tab, grouping), [entries, tab, grouping]);
  const folded = useCallback((group: TodoGroup) => isFolded(folds, tab, grouping, group, groups.length), [folds, tab, grouping, groups.length]);
  // J and K stop on every row of an open group, and once on a folded group's header (D-432).
  const stops = useMemo(() => listStops(groups, folded), [groups, folded]);
  const selectedIndex = resolveStop(stops, groups, selectedKey);
  const currentStop = selectedIndex >= 0 ? stops[selectedIndex] : undefined;
  const current: TodoEntry | undefined = currentStop?.kind === 'row' ? currentStop.entry : undefined;

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
    if (!currentStop) return;
    const id = currentStop.kind === 'row' ? `todo-row-${currentStop.key}` : `todos-group-${currentStop.group.key}`;
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }, [currentStop]);

  useEffect(() => {
    if (!snoozedNote) return;
    const timer = window.setTimeout(() => setSnoozedNote(null), 8000);
    return () => window.clearTimeout(timer);
  }, [snoozedNote]);

  /** Folds or opens a group: folding selects its header if the selection was inside; opening selects its first row. */
  const foldGroup = useCallback((group: TodoGroup, fold: boolean) => {
    setFold(tab, grouping, group.key, fold);
    if (fold) {
      if (current && group.entries.some(entry => entry.key === current.key)) setSelectedKey(headerKey(group.key));
    } else if (group.entries[0]) {
      setSelectedKey(group.entries[0].key);
    }
  }, [current, grouping, setFold, tab]);

  const askSnooze = useCallback((entry: TodoEntry, anchor?: DOMRect) => {
    const rect = anchor ?? document.getElementById(`todo-row-${entry.key}`)?.getBoundingClientRect();
    if (!rect || !canSnooze(entry)) return;
    setSelectedKey(entry.key);
    setSnoozing({ entry, anchor: rect });
  }, []);

  const runSnooze = useCallback((choice: SnoozeChoice) => {
    if (!snoozing) return;
    const { entry } = snoozing;
    setSnoozing(null);
    const action: TodoAction = { kind: 'snooze', number: entry.row.todo.number, until: choice.until, zone: choice.zone, note: choice.note, action: choice.action };
    if (entry.machineId === LOCAL_MACHINE_ID) void act(action);
    else void actOn(entry.machineId, action);
    // Into a folded Snoozed: the selection goes on to the next row, and a note offers Show.
    const intoFolded = grouping === 'status' && (tab === 'open' || tab === 'all') && entry.row.status.status !== 'snoozed'
      && isFolded(folds, tab, grouping, { key: SNOOZED_GROUP, label: '', entries: [] }, groups.filter(group => group.key !== SNOOZED_GROUP).length + 1);
    if (intoFolded) {
      setSelectedKey(stopAfterLeaving(stops, entry.key));
      setSnoozedNote({ key: entry.key, ref: todoRef(entry.row.todo.number), until: choice.until });
    }
    rootRef.current?.focus({ preventScroll: true });
  }, [act, actOn, folds, grouping, groups, snoozing, stops, tab]);

  const showSnoozed = useCallback(() => {
    if (!snoozedNote) return;
    setFold(tab, grouping, SNOOZED_GROUP, false);
    setSelectedKey(snoozedNote.key);
    setSnoozedNote(null);
    rootRef.current?.focus({ preventScroll: true });
  }, [grouping, setFold, snoozedNote, tab]);

  const openEntry = useCallback((entry: TodoEntry | undefined) => {
    if (!entry) return;
    setSelectedKey(entry.key);
    // Another machine's to-do opens on that machine: the window switches to it and shows the to-do (T-18).
    if (entry.remote) void openOnMachine(entry.machineId, { kind: 'todo', id: entry.row.todo.number, name: `${todoRef(entry.row.todo.number)} ${entry.row.todo.title}` });
    else onOpen(entry.row.todo.number);
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
      if (creating || confirm || snoozing || isTypingTarget(event.target) || overlayOpen()) return;
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
        const next = moveSelection(Math.max(0, selectedIndex), stops.length, key === 'j' || key === 'ArrowDown' ? 1 : -1);
        if (stops[next]) setSelectedKey(stops[next].key);
      } else if (currentStop?.kind === 'header' && (key === 'Enter' || key === 'ArrowRight' || key === ' ')) {
        // A folded header: →, Enter or Space opens it and selects its first row.
        event.preventDefault();
        foldGroup(currentStop.group, false);
      } else if (key === 'ArrowLeft') {
        // ← on a row folds its group and selects the header.
        if (currentStop?.kind !== 'row') return;
        event.preventDefault();
        foldGroup(currentStop.group, true);
      } else if (key === 'Enter') {
        if (!current) return;
        event.preventDefault();
        openEntry(current);
      } else if (key === 'z') {
        if (!current || !canSnooze(current)) return;
        event.preventDefault();
        askSnooze(current);
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
  }, [askAction, askSnooze, confirm, creating, current, currentStop, foldGroup, grouping, openEntry, selectedIndex, setGrouping, snoozing, stops]);

  const loadLine = gate && gate.state !== 'normal' && gate.line ? gate.line : null;

  return (
    <div ref={viewRef} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary text-[14px] text-text-primary" data-testid="todos-view">
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
        <h1 className="mr-1.5 shrink-0 whitespace-nowrap text-[15px] font-semibold">To-dos</h1>
        <div role="tablist" aria-label="Which to-dos" className="scrollbar-none flex min-w-0 items-center gap-2 overflow-x-auto">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-label={narrow && item.short ? item.label : undefined}
              data-testid={`todos-tab-${item.id}`}
              onClick={() => { setTab(item.id); setSelectedKey(null); }}
              className={cn(TODOS_PILL, 'shrink-0', tab === item.id ? TODOS_PILL_ON : TODOS_PILL_OFF)}
            >
              {narrow && item.short ? item.short : item.label}
              {item.id === 'waiting' && <b className="font-semibold text-status-warning" data-testid="todos-waiting-count">{counts.waiting}</b>}
              {item.id === 'snoozed' && counts.snoozed > 0 && <span className="text-text-tertiary" data-testid="todos-snoozed-count">{counts.snoozed}</span>}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Dropdown
          trigger={(
            <button type="button" className={cn(TODOS_HEADER_BUTTON, 'shrink-0')} data-testid="todos-group" aria-label={`Group by ${TODOS_GROUPING_LABEL[grouping]}`}>
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              {narrow ? TODOS_GROUPING_LABEL[grouping] : `Group: ${TODOS_GROUPING_LABEL[grouping]}`}
              <ChevronDown className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
            </button>
          )}
          header="Group by"
          items={TODOS_GROUPINGS.map(id => ({ id, label: TODOS_GROUPING_LABEL[id], onClick: () => setGrouping(id) }))}
          selectedId={grouping}
          selectedMark="check"
          position="bottom-right"
          width="md"
        />
        <button type="button" className={cn('needs-full-access', TODOS_HEADER_BUTTON, 'shrink-0')} onClick={() => setCreating(true)} data-testid="todos-new" aria-label="New to-do" title="New to-do">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />{narrow ? null : 'New to-do'}
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
        {groups.length === 0 && loaded && <p className="p-6 text-text-tertiary">Nothing here.</p>}
        {groups.map(group => {
          const isFold = folded(group);
          const wake = group.key === SNOOZED_GROUP ? nextWake(group) : null;
          return (
          <div key={group.key} role="presentation">
            <button
              type="button"
              id={`todos-group-${group.key}`}
              aria-expanded={!isFold}
              aria-label={`${group.label}, ${group.entries.length}${isFold ? ', folded' : ''}`}
              tabIndex={-1}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { foldGroup(group, !isFold); if (!isFold) setSelectedKey(headerKey(group.key)); rootRef.current?.focus({ preventScroll: true }); }}
              className={cn(
                'sticky top-0 z-[1] flex h-[38px] w-full items-center gap-2 border-b border-border-secondary pl-2 pr-4 text-left text-[13.5px] font-semibold outline-none',
                currentStop?.kind === 'header' && currentStop.group.key === group.key ? 'bg-surface-selected' : 'bg-surface-secondary hover:bg-surface-hover',
              )}
              data-testid="todos-group-header"
              data-group={group.key}
              data-folded={isFold || undefined}
              data-selected={(currentStop?.kind === 'header' && currentStop.group.key === group.key) || undefined}
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary" aria-hidden="true">
                {isFold ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
              {group.status && <TodoStatusIcon status={group.status} size="lg" />}
              <span className="truncate">{group.label}</span>
              <span className="font-medium text-text-tertiary" data-testid="todos-group-count">{group.entries.length}</span>
              <span className="flex-1" />
              {wake !== null && (
                <span className="truncate text-[12.5px] font-normal text-text-tertiary" data-testid="todos-group-next-wake">
                  {isFold ? `next wakes ${snoozeWhen(wake, now, zone)}${narrow ? '' : ' · folded until you open it'}` : narrow ? 'soonest first' : 'soonest first · Pane wakes each at its time'}
                </span>
              )}
            </button>
            {!isFold && group.status === 'queued' && loadLine && (
              <div className={cn('flex h-8 items-center border-b border-border-secondary pr-4 text-[12.5px] text-text-secondary', TODOS_ROW_LEAD)} data-testid="todos-load-line">
                <span className={TODOS_REF_COLUMN} aria-hidden="true" />
                <Gauge className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="truncate">{loadLine} · queued to-dos start when load comes down</span>
              </div>
            )}
            {!isFold && group.entries.map(entry => (
              <TodoRow
                key={entry.key}
                entry={entry}
                grouping={grouping}
                selected={entry.key === current?.key}
                flash={entry.key === flashKey}
                now={now}
                zone={zone}
                onSelect={() => setSelectedKey(entry.key)}
                onOpen={() => openEntry(entry)}
                onAction={(kind, anchor) => askAction(entry, kind, anchor)}
                onSnooze={canSnooze(entry) ? anchor => askSnooze(entry, anchor) : undefined}
              />
            ))}
          </div>
          );
        })}
      </div>

      {snoozedNote && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border-secondary bg-status-snoozed-subtle px-4 text-[12.5px] text-text-secondary" role="status" data-testid="todos-snoozed-note">
          <span>Snoozed {snoozedNote.ref} until {snoozeWhen(snoozedNote.until, now, zone)}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={showSnoozed} className="font-medium text-interactive-text hover:underline" data-testid="todos-snoozed-show">Show</button>
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-border-primary px-4 text-[12px] text-text-tertiary" data-testid="todos-footer">
        {/* The hints give way first: the open count always shows. */}
        <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
          <KeyHint keys={['J', 'K']} label="move" />
          <KeyHint keys={['↵']} label="open" />
          <KeyHint keys={['←', '→']} label="fold · open group" />
          <KeyHint keys={['Z']} label="snooze" />
          <KeyHint keys={['S']} label="stop" />
          <KeyHint keys={['R']} label="resume · wake now" />
          {!narrow && <KeyHint keys={['G']} label="group by" />}
          {!narrow && <KeyHint keys={['C']} label="new to-do" />}
        </div>
        <span className="shrink-0">{counts.open} open</span>
      </div>

      {confirm && <TodoConfirm request={confirm} onCancel={cancelConfirm} onConfirm={runConfirmed} />}
      {snoozing && (
        <SnoozeMenu
          target={{ ref: todoRef(snoozing.entry.row.todo.number), title: snoozing.entry.row.todo.title, sessionId: snoozing.entry.row.todo.sessionId, snooze: snoozing.entry.row.todo.snooze }}
          anchor={snoozing.anchor}
          onSubmit={runSnooze}
          onClose={() => { setSnoozing(null); rootRef.current?.focus({ preventScroll: true }); }}
        />
      )}
      {creating && <NewTodoDialog onClose={() => { setCreating(false); rootRef.current?.focus({ preventScroll: true }); }} onCreated={onCreated} />}
      <span className="sr-only" role="status" aria-live="polite">{flashKey ? `${todoRef(Number(flashKey.split(':').pop()))} created` : ''}</span>
    </div>
  );
}
