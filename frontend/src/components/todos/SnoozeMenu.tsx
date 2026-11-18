import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, Bell, Bot, CalendarDays, Clock, Moon, Sun } from 'lucide-react';
import { TODO_SNOOZE_MAX_MS, type TodoSnooze, type TodoWakeAction } from '../../../../shared/types/todos';
import { usePortalContainer } from '../../contexts/PortalContainerContext';
import { cn } from '../../utils/cn';
import { useNow } from '../notify/useNow';
import { fromDatetimeLocal, inAnHour, snoozePresets, snoozeWhen, toDatetimeLocal, tomorrowMorning, viewerZone, zoneAbbrev, type SnoozePresetId } from './snoozeTime';

/** What a snooze menu snoozes: a to-do, or the one New to-do is about to make. */
export interface SnoozeTarget {
  /** "T-14"; absent for a to-do not made yet. */
  ref?: string;
  title: string;
  sessionId: string | null;
  /** Its snooze now, when it already has one: the menu starts from it (Change). */
  snooze?: TodoSnooze;
}

/** What the menu sends, as `todos:act { kind: 'snooze', … }` and `TodoCreateInput.snooze` take it. */
export interface SnoozeChoice {
  until: number;
  zone: string;
  note: string;
  action: TodoWakeAction;
}

export type SnoozePick = SnoozePresetId | 'custom';

const PICKS: readonly SnoozePick[] = ['hour', 'tomorrow', 'monday', 'custom'];

/**
 * The menu's state, shared by the desktop menu and the phone's bottom sheet: the four choices with
 * the time each resolves to in the viewer's zone, the note, and Wake its agents or Just remind me
 * (remind by default with no Session).
 */
export function useSnoozeForm(target: SnoozeTarget) {
  const now = useNow(30_000);
  const zone = useMemo(viewerZone, []);
  const presets = useMemo(() => snoozePresets(now, zone), [now, zone]);
  const current = target.snooze;
  const [pick, setPick] = useState<SnoozePick>(current ? 'custom' : 'tomorrow');
  const [custom, setCustom] = useState(() => toDatetimeLocal(current?.until ?? tomorrowMorning(Date.now(), zone), zone));
  const [note, setNote] = useState(current?.note ?? '');
  const [action, setAction] = useState<TodoWakeAction>(current?.action ?? (target.sessionId ? 'agents' : 'remind'));
  const until = pick === 'custom' ? fromDatetimeLocal(custom, zone) : presets.find(preset => preset.id === pick)?.at ?? inAnHour(now);
  const problem = until === null ? 'Pick a date and a time.'
    : until <= now ? 'That time has passed: pick one in the future.'
      : until - now > TODO_SNOOZE_MAX_MS ? 'A snooze can run a year at most.' : null;
  const choice: SnoozeChoice | null = until !== null && !problem ? { until, zone, note: note.trim(), action } : null;
  return { now, zone, presets, pick, setPick, custom, setCustom, note, setNote, action, setAction, until, problem, choice };
}

export type SnoozeForm = ReturnType<typeof useSnoozeForm>;

/** "Snooze until Wed 9:00 AM", the primary button's words. */
export function snoozeButtonLabel(form: SnoozeForm, verb = 'Snooze'): string {
  return form.until !== null && !form.problem ? `${verb} until ${snoozeWhen(form.until, form.now, form.zone)}` : verb;
}

const PICK_ICON = { hour: Clock, tomorrow: Sun, monday: CalendarDays, custom: AlarmClock } as const satisfies Record<SnoozePick, typeof Clock>;

/** The note's heading: who reads it at the time. */
export function noteHeading(action: TodoWakeAction): string {
  return action === 'agents' ? 'When it wakes, tell its agents' : 'When it wakes, remind you';
}

/** The line under the switch: what happens now and at the time. */
export function snoozeHint(target: SnoozeTarget, action: TodoWakeAction): string {
  if (action === 'remind') return 'Pane raises a reminder card for you then; no agent starts.';
  return target.sessionId ? 'Its agents stop after their current step.' : 'At the time Pane starts it: its Session and an orchestrator, with the note.';
}

/** Wake its agents / Just remind me. */
export function WakeActionSwitch({ action, onChange, large = false }: { action: TodoWakeAction; onChange: (action: TodoWakeAction) => void; large?: boolean }) {
  const item = (value: TodoWakeAction, label: string, icon: ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={action === value}
      onClick={() => onChange(value)}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-interactive',
        large ? 'h-10 text-[15px]' : 'h-[26px] text-[12.5px]',
        action === value ? 'bg-surface-tertiary font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary',
      )}
      data-testid={`snooze-action-${value}`}
    >
      {icon}{label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="When it wakes" className="inline-flex divide-x divide-border-primary overflow-hidden rounded-[7px] border border-border-primary" data-testid="snooze-action">
      {item('agents', 'Wake its agents', <Bot className={large ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />)}
      {item('remind', 'Just remind me', <Bell className={large ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />)}
    </div>
  );
}

export interface SnoozeMenuProps {
  target: SnoozeTarget;
  /** Opens under (or above) this rect, right-aligned to it. */
  anchor: DOMRect;
  onSubmit: (choice: SnoozeChoice) => void;
  /** Already snoozed: Wake now, beside Cancel. */
  onWake?: () => void;
  onClose: () => void;
  /** The primary button's verb: "Snooze", or "Remind me" in New to-do. */
  verb?: string;
}

const WIDTH = 344;

/**
 * The snooze menu (round 9, T-17), shared by a list row (Z), the to-do page and New to-do's Remind
 * me…: 1 In an hour, 2 Tomorrow morning, 3 Next Monday, 4 Pick a date and time, each with its time;
 * the wake-up note; Wake its agents or Just remind me. ⏎ snoozes, Esc closes; focus stays inside
 * while it is open and goes back where it came from.
 */
export function SnoozeMenu({ target, anchor, onSubmit, onWake, onClose, verb = 'Snooze' }: SnoozeMenuProps) {
  const form = useSnoozeForm(target);
  const ref = useRef<HTMLDivElement>(null);
  const pickRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dateRef = useRef<HTMLInputElement>(null);
  const container = usePortalContainer();
  const [top, setTop] = useState(anchor.bottom + 6);
  const width = Math.min(WIDTH, window.innerWidth - 24);
  // Right-aligned to the anchor, kept on screen.
  const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));

  // Opens above the anchor when there is no room below it.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 6;
    setTop(below + height > window.innerHeight - 12 ? Math.max(12, Math.min(anchor.top - height - 6, window.innerHeight - height - 12)) : below);
  }, [anchor]);

  // Focus starts on the chosen time and returns where it came from.
  const openedOn = useRef(form.pick);
  useEffect(() => {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pickRefs.current[PICKS.indexOf(openedOn.current)]?.focus({ preventScroll: true });
    return () => { if (from?.isConnected) from.focus({ preventScroll: true }); };
  }, []);

  const submit = () => {
    if (form.choice) onSubmit(form.choice);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      // ⏎ snoozes from anywhere in the menu, but a focused button still presses itself.
      if (event.target instanceof HTMLButtonElement && !PICKS.some((_, at) => pickRefs.current[at] === event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    if (event.key === 'Tab') {
      trapTab(event, ref.current);
      return;
    }
    if (!typing && !event.metaKey && !event.ctrlKey && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next = PICKS[Number(event.key) - 1];
      form.setPick(next);
      if (next === 'custom') dateRef.current?.focus();
      else pickRefs.current[PICKS.indexOf(next)]?.focus();
      return;
    }
    // The list's and page's keys (J, K, S, R, Z…) stay out while the menu is open.
    if (!typing) event.stopPropagation();
  };

  const [date, time] = form.custom.split('T');
  const label = target.ref ? <><b className="font-semibold text-text-primary">{target.ref} {target.title}</b></> : <b className="font-semibold text-text-primary">this to-do</b>;
  const menu = (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Snooze ${target.ref ?? 'the new to-do'} until…`}
      onKeyDown={onKey}
      onMouseDown={event => event.stopPropagation()}
      className="pointer-events-auto fixed z-modal flex flex-col rounded-[12px] border border-border-primary bg-surface-primary text-[13px] text-text-primary shadow-modal"
      style={{ top, left, width }}
      data-testid="snooze-menu"
      data-todos-confirm=""
    >
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border-secondary px-3.5 py-2.5 text-[12.5px] text-text-secondary">
        <Moon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 truncate">Snooze {label} until…</span>
      </div>
      <div className="flex flex-col gap-px p-1.5" role="radiogroup" aria-label="Until">
        {PICKS.map((pick, at) => {
          const Icon = PICK_ICON[pick];
          const preset = form.presets.find(candidate => candidate.id === pick);
          return (
            <button
              key={pick}
              ref={element => { pickRefs.current[at] = element; }}
              type="button"
              role="radio"
              aria-checked={form.pick === pick}
              onClick={() => { form.setPick(pick); if (pick === 'custom') dateRef.current?.focus(); }}
              className={cn('flex h-8 items-center gap-2 rounded-[7px] px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-interactive', form.pick === pick ? 'bg-surface-hover' : 'hover:bg-surface-hover')}
              data-testid={`snooze-pick-${pick}`}
            >
              <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[10.5px] leading-none text-text-secondary">{at + 1}</kbd>
              <Icon className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="flex-1">{preset?.label ?? 'Pick a date and time…'}</span>
              {preset && <span className="shrink-0 text-[12px] tabular-nums text-text-tertiary" data-testid="snooze-pick-when">{preset.when}</span>}
            </button>
          );
        })}
        <div className="flex items-center gap-1.5 pb-1 pl-[52px] pr-1 pt-0.5">
          <input
            ref={dateRef}
            type="date"
            value={date ?? ''}
            onChange={event => { form.setCustom(`${event.target.value}T${time ?? '09:00'}`); form.setPick('custom'); }}
            onFocus={() => form.setPick('custom')}
            aria-label="Date"
            className="h-7 min-w-0 flex-1 rounded-[7px] border border-border-primary bg-surface-primary px-2 text-[12.5px] text-text-primary outline-none focus:border-border-focus"
            data-testid="snooze-date"
          />
          <input
            type="time"
            value={time ?? ''}
            onChange={event => { form.setCustom(`${date ?? ''}T${event.target.value}`); form.setPick('custom'); }}
            onFocus={() => form.setPick('custom')}
            aria-label="Time"
            className="h-7 w-[116px] shrink-0 rounded-[7px] border border-border-primary bg-surface-primary px-2 text-[12.5px] text-text-primary outline-none focus:border-border-focus"
            data-testid="snooze-time"
          />
          <span className="shrink-0 text-[12px] text-text-tertiary">{zoneAbbrev(form.until ?? form.now, form.zone)}</span>
        </div>
      </div>
      <div className="border-t border-border-secondary px-3.5 pb-3 pt-2.5">
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary" htmlFor="snooze-note">{noteHeading(form.action)}</label>
        <textarea
          id="snooze-note"
          rows={3}
          value={form.note}
          onChange={event => form.setNote(event.target.value)}
          placeholder={form.action === 'agents' ? 'What should they check or do then?' : 'What should Pane remind you of?'}
          className="block w-full resize-none rounded-[8px] border border-border-primary bg-surface-primary px-2.5 py-2 text-[13px] leading-normal text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
          data-testid="snooze-note"
        />
        <div className="mt-2.5"><WakeActionSwitch action={form.action} onChange={form.setAction} /></div>
        <p className="mt-2 text-[12px] text-text-tertiary" data-testid="snooze-hint">{snoozeHint(target, form.action)}</p>
        {form.problem && <p className="mt-1 text-[12px] text-status-error" role="alert" data-testid="snooze-problem">{form.problem}</p>}
        <div className="mt-2.5 flex items-center gap-2">
          {onWake && (
            <button type="button" onClick={onWake} className="text-[12.5px] font-medium text-interactive-text hover:underline" data-testid="snooze-wake-now">Wake now</button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="inline-flex h-8 items-center rounded-[7px] px-3 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="snooze-cancel">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!form.choice}
            className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-interactive px-3 text-[13px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50"
            data-testid="snooze-submit"
          >
            <Moon className="h-3.5 w-3.5" aria-hidden="true" />
            {snoozeButtonLabel(form, verb)}
            <kbd className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-current px-1 opacity-70 font-mono text-[10.5px] leading-none">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(menu, container ?? document.body);
}

/** Tab and Shift+Tab stay inside the menu. */
function trapTab(event: KeyboardEvent<HTMLDivElement>, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
