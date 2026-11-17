import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { todoRef } from '../../../../../shared/types/todos';
import { useTodosStore } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { TodoStatusIcon } from '../TodoStatusIcon';
import { groupTodos, requesterLabel, tabCounts, type TodoEntry, type TodosTab } from '../todoList';
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
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

const SCROLL_KEY = 'list';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  const setTab = (next: TodosTab) => {
    shownTab = next;
    setTabState(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // Back from a to-do lands where the list was, once its rows are there to scroll to.
  useLayoutEffect(() => {
    if (restored.current || !loaded || !scrollRef.current) return;
    restored.current = true;
    scrollRef.current.scrollTop = recalledScroll(SCROLL_KEY);
  }, [loaded]);

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
          </button>
        ))}
      </div>
      <div ref={scrollRef} onScroll={(event) => rememberScroll(SCROLL_KEY, event.currentTarget.scrollTop)} className={PHONE_SCROLL} role="list" aria-label="To-dos" data-testid="phone-todos-scroll">
        {!loaded && <p className="p-6 text-center text-[14px] text-text-tertiary" role="status">Loading to-dos…</p>}
        {loaded && groups.length === 0 && <p className="p-6 text-center text-[14px] text-text-tertiary">Nothing here.</p>}
        {groups.map((group) => (
          <div key={group.key} role="presentation">
            <div className="sticky top-0 z-[1] flex h-[34px] items-center gap-2 border-b border-border-secondary bg-surface-secondary pl-[max(1rem,env(safe-area-inset-left))] pr-4 text-[13px] font-semibold" data-testid="phone-todos-group">
              {group.status && <TodoStatusIcon status={group.status} />}
              <span className="truncate">{group.label}</span>
              <span className="font-medium text-text-tertiary">{group.entries.length}</span>
            </div>
            {group.entries.map((entry) => <PhoneTodoRow key={entry.key} entry={entry} now={now} onOpen={onOpen} />)}
          </div>
        ))}
        <div className="h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </div>
    </PhoneScreen>
  );
}

/** "T-12 · Which currencies…", "T-20 · You · 6m": its reason, else who asked for it, and its age. */
function metaLine(entry: TodoEntry, now: number): string {
  const { row } = entry;
  const reason = row.status.reason || requesterLabel(row);
  return [todoRef(row.todo.number), reason, row.status.status === 'waiting' ? '' : relativeAge(row.todo.updatedAt, now)].filter(Boolean).join(' · ');
}

function PhoneTodoRow({ entry, now, onOpen }: { entry: TodoEntry; now: number; onOpen: (number: number) => void }) {
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
          <span className={cn('mt-px block text-[12.5px] leading-snug [overflow-wrap:anywhere]', reasonTone)} data-testid="phone-todo-row-meta">{metaLine(entry, now)}</span>
        </span>
        <ChevronRight className="mt-[3px] h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
      </button>
    </div>
  );
}
