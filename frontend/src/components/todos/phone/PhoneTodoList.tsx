import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { todoRef } from '../../../../../shared/types/todos';
import { useTodosStore } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { SkeletonSwap } from '../../ui/Skeleton';
import { TodoStatusIcon } from '../TodoStatusIcon';
import { PhoneTodoListSkeleton } from '../TodoSkeletons';
import { groupTodos, isFolded, nextWake, readFolds, requesterLabel, tabCounts, withFold, writeFolds, type TodoEntry, type TodoFolds, type TodoGroup, type TodosTab } from '../todoList';
import { snoozeReason, snoozeWhen, viewerZone } from '../snoozeTime';
import { TODOS_PILL_OFF, TODOS_PILL_ON } from '../todoStyles';
import { useTodoEntries } from '../useTodoEntries';
import { PHONE_ICON_BUTTON, PHONE_SCROLL, PhoneHeader, PhoneScreen, recalledScroll, rememberScroll } from './phoneParts';

interface PillItem {
  id: TodosTab;
  label: string;
}

const PILLS: readonly PillItem[] = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

const SCROLL_KEY = 'list';

function deviceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Folds on this device (D-432): the same rules as the desktop, kept in this browser's storage. */
function usePhoneFolds(): [TodoFolds, (tab: TodosTab, groupKey: string, folded: boolean) => void] {
  const [folds, setFolds] = useState<TodoFolds>(() => {
    const storage = deviceStorage();
    return storage ? readFolds(storage) : {};
  });
  const setFold = useCallback((tab: TodosTab, groupKey: string, folded: boolean) => {
    setFolds((current) => {
      const next = withFold(current, tab, 'status', groupKey, folded);
      const storage = deviceStorage();
      if (storage) writeFolds(storage, next);
      return next;
    });
  }, []);
  return [folds, setFold];
}
/** The pill the list shows, kept for the visit so back from a to-do lands on the same one. */
let shownTab: TodosTab = 'open';

export interface PhoneTodoListProps {
  onOpen: (number: number) => void;
  onNew: () => void;
  /** Left of the title: the app's menu (the web app's drawer). */
  lead?: ReactNode;
}

/**
 * To-dos on a phone (D-422): the filter pills scroll sideways, rows have two lines (title, then T-n
 * and the reason), groups are as on the desktop, and + opens New to-do. A tap opens the to-do; back
 * returns here at the same scroll position (R23).
 */
export function PhoneTodoList({ onOpen, onNew, lead }: PhoneTodoListProps) {
  const entries = useTodoEntries();
  const loaded = useTodosStore((state) => state.snapshot !== null);
  const now = useNow();
  const [tab, setTabState] = useState<TodosTab>(shownTab);
  const counts = useMemo(() => tabCounts(entries), [entries]);
  const groups = useMemo(() => groupTodos(entries, tab, 'status'), [entries, tab]);
  const [folds, setFold] = usePhoneFolds();
  const zone = useMemo(viewerZone, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  const setTab = (next: TodosTab) => {
    shownTab = next;
    setTabState(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // Back from a to-do lands where the list was, once its rows are there to scroll to (after the skeleton).
  const [rowsShown, setRowsShown] = useState(false);
  useLayoutEffect(() => {
    if (restored.current || !rowsShown || !scrollRef.current) return;
    restored.current = true;
    scrollRef.current.scrollTop = recalledScroll(SCROLL_KEY);
  }, [rowsShown]);

  return (
    <PhoneScreen testId="phone-todos-list">
      <PhoneHeader
        title="To-dos"
        lead={lead}
        right={<button type="button" onClick={onNew} aria-label="New to-do" className={PHONE_ICON_BUTTON} data-testid="phone-todos-new"><Plus className="h-5 w-5" aria-hidden="true" /></button>}
      />
      <div role="tablist" aria-label="Which to-dos" className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto border-b border-border-secondary py-2.5 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]" data-testid="phone-todos-pills">
        {PILLS.map((pill) => (
          <button
            key={pill.id}
            type="button"
            role="tab"
            aria-selected={tab === pill.id}
            onClick={() => setTab(pill.id)}
            className={cn('inline-flex h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-interactive', tab === pill.id ? TODOS_PILL_ON : TODOS_PILL_OFF)}
            data-testid={`phone-todos-tab-${pill.id}`}
          >
            {pill.label}
            {pill.id === 'waiting' && <b className="font-semibold text-status-warning" data-testid="phone-todos-waiting-count">{counts.waiting}</b>}
            {pill.id === 'snoozed' && counts.snoozed > 0 && <span className="text-text-tertiary">{counts.snoozed}</span>}
          </button>
        ))}
      </div>
      <div ref={scrollRef} onScroll={(event) => rememberScroll(SCROLL_KEY, event.currentTarget.scrollTop)} className={PHONE_SCROLL} role="list" aria-label="To-dos" data-testid="phone-todos-scroll">
        <SkeletonSwap loading={!loaded} skeleton={<PhoneTodoListSkeleton />}>
          {loaded && groups.length === 0 && <p className="p-6 text-center text-[14px] text-text-tertiary">Nothing here.</p>}
          {groups.map((group) => {
            const folded = isFolded(folds, tab, 'status', group, groups.length);
            return (
              <div key={group.key} role="presentation">
                <PhoneGroupHeader group={group} folded={folded} now={now} zone={zone} onToggle={() => setFold(tab, group.key, !folded)} />
                {!folded && group.entries.map((entry) => <PhoneTodoRow key={entry.key} entry={entry} now={now} zone={zone} onOpen={onOpen} />)}
              </div>
            );
          })}
          {loaded && <OnShown run={() => setRowsShown(true)} />}
        </SkeletonSwap>
        <div className="h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </div>
    </PhoneScreen>
  );
}

/** Runs once its content is on screen: rendered inside a SkeletonSwap, after the skeleton steps aside. */
function OnShown({ run }: { run: () => void }) {
  const ran = useRef(run);
  useLayoutEffect(() => { ran.current(); }, []);
  return null;
}

/**
 * A group's header: tap to fold or open it; it keeps its count, and a folded Snoozed shows its next wake.
 * `note` is a line at its end in place of that (a Session's folded Done this week: "older ones in To-dos").
 */
export function PhoneGroupHeader({ group, folded, now, zone, onToggle, note }: { group: TodoGroup; folded: boolean; now: number; zone: string; onToggle: () => void; note?: string }) {
  const wake = group.status === 'snoozed' && folded ? nextWake(group) : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!folded}
      className="sticky top-0 z-[1] flex h-11 w-full items-center gap-2 border-b border-border-secondary bg-surface-secondary pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-left text-[14px] font-semibold outline-none active:bg-surface-hover focus-visible:bg-surface-hover"
      data-testid="phone-todos-group"
      data-group={group.key}
      data-folded={folded || undefined}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary" aria-hidden="true">
        {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </span>
      {group.status && <TodoStatusIcon status={group.status} />}
      <span className="truncate">{group.label}</span>
      <span className="font-medium text-text-tertiary">{group.entries.length}</span>
      <span className="flex-1" />
      {wake !== null && <span className="shrink-0 text-[12.5px] font-normal text-text-tertiary" data-testid="phone-todos-next-wake">next {snoozeWhen(wake, now, zone)}</span>}
      {note && <span className="shrink-0 text-[12.5px] font-normal text-text-tertiary">{note}</span>}
    </button>
  );
}

/** "T-12 · Which currencies…", "T-20 · You · 6m": its reason, else who asked for it, and its age; a snoozed one its wake time. */
function metaLine(entry: TodoEntry, now: number, zone: string): string {
  const { row } = entry;
  if (row.status.status === 'snoozed' && row.todo.snooze) return [todoRef(row.todo.number), snoozeReason(row.todo.snooze, now, zone, entry.offline)].join(' · ');
  const reason = row.status.reason || requesterLabel(row);
  return [todoRef(row.todo.number), reason, row.status.status === 'waiting' ? '' : relativeAge(row.todo.updatedAt, now)].filter(Boolean).join(' · ');
}

export function PhoneTodoRow({ entry, now, zone, onOpen }: { entry: TodoEntry; now: number; zone: string; onOpen: (number: number) => void }) {
  const { row } = entry;
  const reasonTone = row.status.alert ? 'text-status-error' : 'text-text-tertiary';
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={() => onOpen(row.todo.number)}
        disabled={entry.remote}
        className="flex w-full items-start gap-2.5 border-b border-border-secondary py-[11px] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-left outline-none active:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-60"
        data-testid="phone-todo-row"
        data-todo={row.todo.number}
        data-status={row.status.status}
      >
        <span className="mt-[3px] flex shrink-0"><TodoStatusIcon status={row.status.status} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium leading-snug text-text-primary [overflow-wrap:anywhere]">{row.todo.title}</span>
          <span className={cn('mt-px block text-[12.5px] leading-snug [overflow-wrap:anywhere]', reasonTone)} data-testid="phone-todo-row-meta">{metaLine(entry, now, zone)}</span>
        </span>
        <ChevronRight className="mt-[3px] h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
      </button>
    </div>
  );
}
