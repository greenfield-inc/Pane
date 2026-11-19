import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, CalendarDays, Clock, Moon, Sun } from 'lucide-react';
import type { TodoDetail } from '../../../../../shared/types/todos';
import { cn } from '../../../utils/cn';
import { WakeActionSwitch, noteHeading, snoozeButtonLabel, snoozeHint, useSnoozeForm, type SnoozeChoice, type SnoozePick } from '../SnoozeMenu';
import { snoozeTarget } from '../page/TodoSnoozed';

const ICONS = { hour: Clock, tomorrow: Sun, monday: CalendarDays, custom: AlarmClock } as const satisfies Record<SnoozePick, typeof Clock>;
const PICKS: readonly SnoozePick[] = ['hour', 'tomorrow', 'monday', 'custom'];

export interface PhoneSnoozeSheetProps {
  detail: TodoDetail;
  onSubmit: (choice: SnoozeChoice) => void;
  /** Already snoozed: Wake now. */
  onWake?: () => void;
  onClose: () => void;
}

/**
 * The snooze choices on a phone (round 9, P5): a bottom sheet from the to-do's ⋯ menu, with the
 * desktop menu's logic and the phone's own date and time input. Clear of the home indicator; a tap
 * on the dimmed page or Esc closes it.
 */
export function PhoneSnoozeSheet({ detail, onSubmit, onWake, onClose }: PhoneSnoozeSheetProps) {
  const target = snoozeTarget(detail);
  const form = useSnoozeForm(target);
  const sheet = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (next: SnoozePick) => {
    form.setPick(next);
    if (next === 'custom') requestAnimationFrame(() => picker.current?.focus());
  };

  return createPortal(
    <div className="fixed inset-0 z-modal flex flex-col justify-end" data-testid="phone-snooze-sheet">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-modal-overlay" data-testid="phone-snooze-backdrop" />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`Snooze ${target.ref} until…`}
        tabIndex={-1}
        className="relative max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-[16px] bg-surface-primary pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-2 text-text-primary shadow-modal outline-none"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border-primary" aria-hidden="true" />
        <h2 className="mb-2 px-1 text-[17px] font-semibold">Snooze {target.ref} until…</h2>
        <div role="radiogroup" aria-label="Until" className="flex flex-col">
          {PICKS.map((id) => {
            const Icon = ICONS[id];
            const preset = form.presets.find((candidate) => candidate.id === id);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={form.pick === id}
                onClick={() => pick(id)}
                className={cn('flex min-h-[46px] items-center gap-3 rounded-[10px] px-3 text-left text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-interactive', form.pick === id ? 'bg-surface-tertiary' : 'active:bg-surface-hover')}
                data-testid={`phone-snooze-pick-${id}`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="flex-1">{preset?.label ?? 'Pick a date and time…'}</span>
                {preset && <span className="shrink-0 text-[14px] tabular-nums text-text-tertiary">{preset.when}</span>}
              </button>
            );
          })}
          {form.pick === 'custom' && (
            <input
              ref={picker}
              type="datetime-local"
              value={form.custom}
              onChange={(event) => form.setCustom(event.target.value)}
              aria-label="Date and time"
              className="mx-3 mt-1 h-11 min-w-0 rounded-[10px] border border-border-primary bg-surface-primary px-3 text-[16px] text-text-primary outline-none focus:border-border-focus"
              data-testid="phone-snooze-datetime"
            />
          )}
        </div>
        <div className="mt-3 border-t border-border-secondary px-1 pt-3">
          <label htmlFor="phone-snooze-note" className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">{noteHeading(form.action)}</label>
          <textarea
            id="phone-snooze-note"
            rows={3}
            value={form.note}
            onChange={(event) => form.setNote(event.target.value)}
            placeholder={form.action === 'agents' ? 'What should they check or do then?' : 'What should Pane remind you of?'}
            className="block w-full resize-none rounded-[10px] border border-border-primary bg-surface-primary px-3 py-2 text-[16px] leading-normal text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
            data-testid="phone-snooze-note"
          />
          <div className="mt-3"><WakeActionSwitch action={form.action} onChange={form.setAction} large /></div>
          <p className="mt-2 text-[14px] text-text-tertiary">{snoozeHint(target, form.action)}</p>
          {form.problem && <p className="mt-1 text-[14px] text-status-error" role="alert">{form.problem}</p>}
          <div className="mt-3 flex items-center gap-3">
            {onWake && <button type="button" onClick={onWake} className="h-11 px-1 text-[15px] font-medium text-interactive-text" data-testid="phone-snooze-wake">Wake now</button>}
            <span className="flex-1" />
            <button
              type="button"
              disabled={!form.choice}
              onClick={() => { if (form.choice) onSubmit(form.choice); }}
              className="inline-flex h-12 min-w-0 items-center gap-2 rounded-[12px] bg-interactive px-4 text-[16px] font-medium text-text-on-interactive disabled:opacity-50"
              data-testid="phone-snooze-submit"
            >
              <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{snoozeButtonLabel(form)}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
