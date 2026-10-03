import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import { API } from '../../utils/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  MIN_INTERVAL_MINUTES,
  type ScheduledRun,
  type ScheduledRunInput,
  type ScheduleKind,
} from '../../../../shared/types/schedule';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isScheduleKind(value: string): value is ScheduleKind {
  return value === 'interval' || value === 'daily' || value === 'weekly';
}

function isToolType(value: string): value is ScheduledRun['toolType'] {
  return value === 'claude' || value === 'none';
}

/** One sentence describing a schedule for the list rows. */
function describe(run: Pick<ScheduledRun, 'kind' | 'intervalMinutes' | 'timeOfDay' | 'weekday'>): string {
  if (run.kind === 'interval') {
    const minutes = run.intervalMinutes ?? MIN_INTERVAL_MINUTES;
    if (minutes % (60 * 24) === 0) return `Every ${minutes / (60 * 24)} days`;
    if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  if (run.kind === 'daily') return `Every day at ${run.timeOfDay}`;
  return `Every ${WEEKDAYS[run.weekday ?? 0]} at ${run.timeOfDay}`;
}

function formatWhen(atMs: number | null): string {
  if (!atMs) return '—';
  const date = new Date(atMs);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const EMPTY_FORM: ScheduledRunInput = {
  name: '',
  projectId: 0,
  prompt: '',
  toolType: 'claude',
  enabled: true,
  kind: 'daily',
  timeOfDay: '03:30',
};

export interface ScheduledRunsDialogProps {
  projectId: number;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

/**
 * Recurring agent runs for one project.
 *
 * Three shapes rather than cron syntax — every day, every week, every N
 * minutes — because each can be stated in a sentence and read back in the list,
 * and because nobody debugs a cron expression at 3am to find out why the sweep
 * did not run.
 */
export function ScheduledRunsDialog({ projectId, projectName, isOpen, onClose, onOpenSession }: ScheduledRunsDialogProps) {
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduledRunInput>({ ...EMPTY_FORM, projectId });
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await API.schedules.list(projectId);
      if (!response.success || !response.data) throw new Error(response.error || 'Could not load schedules');
      setRuns(response.data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load schedules');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setShowForm(false);
    setForm({ ...EMPTY_FORM, projectId });
    void load();
  }, [isOpen, projectId, load]);

  const save = useCallback(async () => {
    setError(null);
    try {
      const response = await API.schedules.save({ ...form, projectId });
      if (!response.success) throw new Error(response.error || 'Could not save the schedule');
      setShowForm(false);
      setForm({ ...EMPTY_FORM, projectId });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the schedule');
    }
  }, [form, projectId, load]);

  const act = useCallback(async (id: string, action: () => Promise<{ success: boolean; error?: string }>) => {
    setBusyId(id);
    setError(null);
    try {
      const response = await action();
      if (!response.success) throw new Error(response.error || 'That did not work');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const canSave = form.prompt.trim().length > 0
    && (form.kind !== 'interval' || (form.intervalMinutes ?? 0) >= MIN_INTERVAL_MINUTES);

  const nextUp = useMemo(
    () => runs.filter(run => run.enabled && run.nextRunAtMs).sort((a, b) => (a.nextRunAtMs ?? 0) - (b.nextRunAtMs ?? 0))[0],
    [runs]
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" ariaLabel="Scheduled runs" showCloseButton={false}>
      <ModalHeader
        title="Scheduled runs"
        icon={<CalendarClock className="h-4 w-4" />}
        description={nextUp
          ? `${projectName} — next: ${nextUp.name} at ${formatWhen(nextUp.nextRunAtMs)}`
          : projectName}
        onClose={onClose}
      />

      <ModalBody className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : (
          <>
            {runs.length === 0 && !showForm && (
              <p className="py-6 text-center text-sm text-text-secondary">
                No scheduled runs yet. A schedule starts a session with a fixed prompt — a nightly bug sweep, a
                weekly dependency check.
              </p>
            )}

            <ul className="space-y-2">
              {runs.map(run => (
                <li
                  key={run.id}
                  className={`rounded border p-2 ${run.enabled ? 'border-border-primary' : 'border-border-secondary opacity-60'}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{run.name}</p>
                      <p className="text-[11px] text-text-tertiary">
                        {describe(run)} · {run.toolType === 'none' ? 'terminal' : 'Claude'}
                        {run.enabled && run.nextRunAtMs && <> · next {formatWhen(run.nextRunAtMs)}</>}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-text-muted" title={run.prompt}>
                        {run.prompt}
                      </p>
                      {run.lastRunAtMs && (
                        <p className={`mt-0.5 text-[11px] ${run.lastRunStatus === 'failed' ? 'text-status-error' : 'text-text-muted'}`}>
                          Last run {formatWhen(run.lastRunAtMs)} — {run.lastRunStatus}
                          {run.lastRunError ? `: ${run.lastRunError}` : ''}
                        </p>
                      )}
                      {run.lastSessionId && (
                        <button
                          type="button"
                          onClick={() => run.lastSessionId && onOpenSession(run.lastSessionId)}
                          className="mt-0.5 text-[11px] text-interactive hover:underline"
                        >
                          Open last session
                        </button>
                      )}
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        title="Run now, without moving the schedule"
                        disabled={busyId === run.id}
                        onClick={() => { void act(run.id, () => API.schedules.runNow(run.id)); }}
                        className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                      >
                        <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        title={run.enabled ? 'Pause' : 'Resume'}
                        disabled={busyId === run.id}
                        onClick={() => { void act(run.id, () => API.schedules.setEnabled(run.id, !run.enabled)); }}
                        className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                      >
                        {run.enabled
                          ? <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                          : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        title="Delete this schedule"
                        disabled={busyId === run.id}
                        onClick={() => { void act(run.id, () => API.schedules.remove(run.id)); }}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-status-error/15 hover:text-status-error disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {showForm ? (
              <div className="space-y-3 rounded border border-border-primary p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider text-text-muted">Name</span>
                    <input
                      value={form.name}
                      placeholder="Nightly sweep"
                      onChange={event => setForm({ ...form, name: event.target.value })}
                      className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider text-text-muted">Agent</span>
                    <select
                      value={form.toolType}
                      onChange={event => {
                        if (isToolType(event.target.value)) setForm({ ...form, toolType: event.target.value });
                      }}
                      className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                    >
                      <option value="claude">Claude</option>
                      <option value="none">Terminal only</option>
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="text-[11px] uppercase tracking-wider text-text-muted">Prompt</span>
                  <textarea
                    value={form.prompt}
                    rows={3}
                    placeholder="Look for flaky tests and open an issue for each one you can reproduce."
                    onChange={event => setForm({ ...form, prompt: event.target.value })}
                    className="mt-1 w-full resize-y rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider text-text-muted">Repeats</span>
                    <select
                      value={form.kind}
                      onChange={event => {
                        const kind = event.target.value;
                        if (!isScheduleKind(kind)) return;
                        const nextForm = { ...form, kind };
                        if (kind === 'interval') nextForm.intervalMinutes = form.intervalMinutes ?? 60;
                        else nextForm.timeOfDay = form.timeOfDay ?? '03:30';
                        if (kind === 'weekly') nextForm.weekday = form.weekday ?? 1;
                        setForm(nextForm);
                      }}
                      className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                    >
                      <option value="daily">Every day</option>
                      <option value="weekly">Every week</option>
                      <option value="interval">Every N minutes</option>
                    </select>
                  </label>

                  {form.kind === 'interval' ? (
                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wider text-text-muted">Minutes</span>
                      <input
                        type="number"
                        min={MIN_INTERVAL_MINUTES}
                        value={form.intervalMinutes ?? 60}
                        onChange={event => setForm({ ...form, intervalMinutes: Number(event.target.value) })}
                        className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm tabular-nums text-text-primary focus:border-interactive focus:outline-none"
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wider text-text-muted">At</span>
                      <input
                        type="time"
                        value={form.timeOfDay ?? '03:30'}
                        onChange={event => setForm({ ...form, timeOfDay: event.target.value })}
                        className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm tabular-nums text-text-primary focus:border-interactive focus:outline-none"
                      />
                    </label>
                  )}

                  {form.kind === 'weekly' && (
                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wider text-text-muted">On</span>
                      <select
                        value={form.weekday ?? 1}
                        onChange={event => setForm({ ...form, weekday: Number(event.target.value) })}
                        className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                      >
                        {WEEKDAYS.map((day, index) => (
                          <option key={day} value={index}>{day}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                <p className="text-[11px] text-text-muted">
                  Each run creates a session in a fresh worktree. A run that comes due while Pane is closed is
                  skipped rather than caught up later.
                </p>

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={() => { void save(); }} disabled={!canSave}>
                    Save schedule
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setShowForm(true)}
              >
                New scheduled run
              </Button>
            )}

            {error && (
              <p role="alert" className="rounded border border-status-error/30 bg-status-error/10 p-2 text-xs text-status-error">
                {error}
              </p>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}
