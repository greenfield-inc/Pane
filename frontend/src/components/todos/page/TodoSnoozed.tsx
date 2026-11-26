import { useReadOnlyHost } from '../../../stores/readOnlyHostStore';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Moon } from 'lucide-react';
import type { TodoAction, TodoDetail, TodoRecord, TodoSnooze } from '../../../../../shared/types/todos';
import { snoozeRequestedFor, useTodosStore } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';
import { useNow } from '../../notify/useNow';
import { isTypingTarget, overlayOpen } from '../todosNavigation';
import { setByText, snoozeFull, snoozeWhen, viewerZone, wakesInShort, zoneNote } from '../snoozeTime';
import type { SnoozeChoice, SnoozeTarget } from '../SnoozeMenu';

/**
 * A snoozed to-do's page (round 9, T-17): the header button, the banner with Change and Wake now,
 * and the words the chip, composer and held comments use. Times read in the viewer's zone and are
 * worked out again every minute.
 */

const MINUTE = 60_000;

/** Top-level, open, and not In review or Accepted: what the service lets you snooze. */
/**
 * A pure reminder: no Session of its own (nor a parent's), so the only one acting is Pane. Snoozed, or waiting on
 * its reminder card once the time came (no agent exists to ask anything else).
 */
export function isReminderOnly(detail: TodoDetail): boolean {
  if (detail.todo.sessionId || detail.parent?.todo.sessionId) return false;
  return detail.todo.snooze !== undefined || detail.status.status === 'waiting';
}

export function canSnoozeTodo(todo: TodoRecord): boolean {
  return todo.parentNumber === null && (todo.state === 'todo' || todo.state === 'in_progress' || todo.state === 'stopped');
}

export function snoozeTarget(detail: TodoDetail): SnoozeTarget {
  const { todo } = detail;
  return { ref: todo.ref, title: todo.title, sessionId: todo.sessionId, snooze: todo.snooze };
}

export function snoozeActionOf(number: number, choice: SnoozeChoice): TodoAction {
  return { kind: 'snooze', number, until: choice.until, zone: choice.zone, note: choice.note, action: choice.action };
}

/** The chip's words: "Snoozed until Wed 9:00 AM", then "wakes in 17h · set by the orchestrator". */
export function useSnoozeWords(snooze: TodoSnooze | undefined) {
  const now = useNow(MINUTE);
  const zone = useMemo(viewerZone, []);
  if (!snooze) return null;
  const when = snoozeWhen(snooze.until, now, zone);
  const late = snooze.until <= now;
  return {
    when,
    chip: `Snoozed until ${when}`,
    after: [late ? 'waking now' : `wakes in ${wakesInShort(snooze.until, now)}`, setByText(snooze.by)].join(' · '),
    tooltip: [snoozeFull(snooze.until, zone), zoneNote(snooze, zone)].filter(Boolean).join(' · '),
  };
}

/** "Snoozed · Wed 9:00 AM ▾": the header's state button while snoozed; it opens the menu (Change). */
export const SnoozeHeaderButton = forwardRef<HTMLButtonElement, { snooze: TodoSnooze; onOpen: () => void }>(function SnoozeHeaderButton({ snooze, onOpen }, ref) {
  const words = useSnoozeWords(snooze);
  const readOnly = useReadOnlyHost();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      disabled={readOnly}
      aria-haspopup="dialog"
      title={words?.tooltip}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-2.5 text-[12.5px] text-text-primary hover:border-border-hover"
      data-testid="todo-page-snoozed"
    >
      <Moon className="h-3.5 w-3.5 text-status-snoozed" aria-hidden="true" />
      Snoozed · {words?.when}
      <ChevronDown className="needs-full-access h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
    </button>
  );
});

/** What waking does, for the banner. */
function wakeWords(detail: TodoDetail, snooze: TodoSnooze): string {
  if (snooze.action === 'remind' || !detail.todo.sessionId) return 'Then Pane raises a reminder card for you';
  return 'Then Pane sets it back to In progress, restarts the orchestrator in the same conversation and types';
}

/**
 * The banner under the chips: the full time, what will happen, and the note, with Change and Wake
 * now.
 */
/** Under this width the banner's buttons go below its words. */
const BANNER_STACK_PX = 480;

export function SnoozeBanner({ detail, onChange, onWake, stacked = false }: { detail: TodoDetail; onChange: () => void; onWake: () => void; stacked?: boolean }) {
  const snooze = detail.todo.snooze;
  const zone = useMemo(viewerZone, []);
  // In a narrow page column (the split beside it) the buttons go under the words, not beside them.
  const ref = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const shown = snooze !== undefined;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setNarrow(element.clientWidth < BANNER_STACK_PX);
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < BANNER_STACK_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  if (!snooze) return null;
  const note = snooze.note.trim();
  const where = zoneNote(snooze, zone);
  const under = stacked || narrow;
  return (
    <section ref={ref} className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-status-snoozed-border bg-status-snoozed-subtle px-3.5 py-3 text-[13.5px] leading-[1.5] text-text-primary" aria-label="Snoozed" data-testid="todo-snooze-banner">
      <Moon className="mt-[3px] h-4 w-4 shrink-0 text-status-snoozed" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>
          <b className="font-semibold" title={where ?? undefined}>Snoozed until {snoozeFull(snooze.until, zone)}.</b>{' '}
          {wakeWords(detail, snooze)}{note ? ':' : '.'}
        </p>
        {note && <p className="mt-1 whitespace-pre-wrap text-text-secondary [overflow-wrap:anywhere]" data-testid="todo-snooze-note">“{note}”</p>}
        {under && <BannerButtons onChange={onChange} onWake={onWake} className="mt-2.5" large={stacked} />}
      </div>
      {!under && <BannerButtons onChange={onChange} onWake={onWake} className="shrink-0" />}
    </section>
  );
}

function BannerButtons({ onChange, onWake, className, large = false }: { onChange: () => void; onWake: () => void; className?: string; large?: boolean }) {
  const button = cn('inline-flex items-center rounded-[7px] border border-border-primary bg-surface-primary text-text-primary hover:border-border-hover', large ? 'h-10 px-3.5 text-[15px]' : 'h-7 px-2.5 text-[12.5px]');
  return (
    <div className={cn('needs-full-access flex gap-1.5', className)}>
      <button type="button" onClick={onChange} className={button} data-testid="todo-snooze-change">Change</button>
      <button type="button" onClick={onWake} className={button} data-testid="todo-snooze-wake">Wake now</button>
    </div>
  );
}

/**
 * The page's snooze menu state: Z opens it (where the to-do can be snoozed), and so does a reminder
 * card's "Snooze to another time…" (the store's request). Anchored under the header.
 */
export function usePageSnooze(detail: TodoDetail, anchorOf: () => DOMRect | null) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const act = useTodosStore((state) => state.act);
  const request = useTodosStore((state) => state.snoozeRequest);
  const number = detail.todo.number;
  const readOnly = useReadOnlyHost();
  const can = canSnoozeTodo(detail.todo) && !readOnly;
  const open = useCallback(() => {
    if (!can) return;
    setAnchor(anchorOf() ?? new DOMRect(window.innerWidth - 24, 52, 0, 0));
  }, [anchorOf, can]);
  useEffect(() => {
    if (!snoozeRequestedFor(request, number)) return;
    useTodosStore.getState().requestSnooze(null);
    open();
  }, [request, number, open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'z' || isTypingTarget(event.target) || overlayOpen()) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const submit = useCallback((choice: SnoozeChoice) => {
    setAnchor(null);
    void act(snoozeActionOf(number, choice));
  }, [act, number]);
  const wake = useCallback(() => {
    setAnchor(null);
    void act({ kind: 'wake', number });
  }, [act, number]);
  return { anchor, open, close: () => setAnchor(null), submit, wake, can };
}

/** The composer's hint while snoozed, with "Wake now and send". */
export function HeldHint({ snooze, onWakeAndSend, className }: { snooze: TodoSnooze; onWakeAndSend: () => void; className?: string }) {
  const words = useSnoozeWords(snooze);
  return (
    <div className={cn('mb-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-status-snoozed-on-tint', className)} data-testid="todo-composer-held">
      <Moon className="h-3.5 w-3.5 shrink-0 text-status-snoozed" aria-hidden="true" />
      <span>Snoozed: comments are held until it wakes ({words?.when}).</span>
      <button type="button" onClick={onWakeAndSend} className="font-medium text-interactive-text hover:underline" data-testid="todo-composer-wake-send">Wake now and send</button>
    </div>
  );
}

/** A held comment's line: who it goes to at waking. */
export function heldText(detail: TodoDetail): string {
  const snooze = detail.todo.snooze;
  if (snooze && (snooze.action === 'remind' || !detail.todo.sessionId)) return 'Held: goes to the agent that takes it when it wakes';
  return `Held: goes to the ${detail.chatTarget.kind === 'assignee' ? detail.chatTarget.name : 'orchestrator'} with the wake-up note`;
}
