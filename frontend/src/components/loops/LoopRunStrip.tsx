import { LOOP_KEPT_RUNS } from '../../../../shared/types/loop';
import { openLoopRun } from '../../stores/loopsStore';
import { cn } from '../../utils/cn';
import { Tooltip } from '../ui/Tooltip';
import { RUN_DOT_CLASS, formatDuration, formatRunTime, runWarning, type LoopRunView } from './loopRunView';

/** What the run did, for its tooltip: "Exited after 22m · loop-sweep-1023" or why it never started. */
function runDetail(view: LoopRunView): string {
  const warning = runWarning(view);
  if (warning) return view.branch ? `${warning} · ${view.branch}` : warning;
  if (view.outcome === 'failed' || view.outcome === 'skipped') return view.run.error ?? (view.outcome === 'skipped' ? 'Pane was not running, or the computer was asleep, when this run came due.' : 'The Pane could not be created.');
  const duration = view.durationMs === null ? null : formatDuration(view.durationMs);
  const lead = view.outcome === 'running' ? (duration ? `Running for ${duration}` : 'Running') : (duration ? `Finished after ${duration}` : 'Finished');
  return view.branch ? `${lead} · ${view.branch}` : lead;
}

/**
 * The last ten runs as squares, oldest on the left and empty slots for runs
 * that have not happened. Hover shows a run's time, outcome, duration and
 * branch; a click opens its Pane.
 */
export function LoopRunStrip({ views }: { views: LoopRunView[] }) {
  const oldestFirst = views.slice(0, LOOP_KEPT_RUNS).reverse();
  const empty = LOOP_KEPT_RUNS - oldestFirst.length;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Last 10 runs">
      {Array.from({ length: empty }, (_, index) => (
        <span key={`empty-${index}`} aria-hidden="true" className="h-3.5 w-3.5 rounded-sm border border-border-primary" />
      ))}
      {oldestFirst.map(view => {
        const sessionId = view.session?.id;
        const label = `${formatRunTime(view.run.slotAtMs, true)} · ${view.outcome}`;
        return (
          <Tooltip
            key={view.run.id}
            side="bottom"
            content={(
              <span className="flex flex-col gap-0.5 text-xs">
                <span className="font-medium text-text-primary">{label}</span>
                <span className="text-text-secondary">{runDetail(view)}</span>
                {sessionId && <span className="text-interactive">Click to open its Pane</span>}
              </span>
            )}
          >
            <button
              type="button"
              aria-label={label}
              aria-disabled={!sessionId}
              onClick={() => { if (sessionId) openLoopRun(sessionId); }}
              className={cn(
                'h-3.5 w-3.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive aria-disabled:cursor-default',
                RUN_DOT_CLASS[view.outcome],
              )}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}
