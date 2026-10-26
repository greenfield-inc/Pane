import { ChevronRight, Repeat } from 'lucide-react';
import { navigateToLoops, openLoopRun, type LoopRunRef } from '../../stores/loopsStore';
import { cn } from '../../utils/cn';
import { RUN_DOT_CLASS, formatDuration, formatRunTime, runWarning, useLoopRunViews } from './loopRunView';

/** Above a run Pane's tabs: where the run sits (Loops › loop › run), with a way back to the loop. */
export function LoopRunHeader({ runRef }: { runRef: LoopRunRef }) {
  const { loop, run } = runRef;
  return (
    <div className="flex flex-shrink-0 border-b border-border-primary bg-surface-primary px-3 py-2" data-testid="loop-run-header">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
        <button type="button" onClick={() => navigateToLoops()} className="flex items-center gap-1 rounded px-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          <Repeat className="h-3 w-3" aria-hidden="true" />Loops
        </button>
        <ChevronRight className="h-3 w-3 flex-shrink-0 text-text-muted" aria-hidden="true" />
        <button type="button" onClick={() => navigateToLoops(loop.id)} className="min-w-0 truncate rounded px-0.5 font-medium text-text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          {loop.name}
        </button>
        <ChevronRight className="h-3 w-3 flex-shrink-0 text-text-muted" aria-hidden="true" />
        <span className="flex-shrink-0" aria-current="page">Run {formatRunTime(run.slotAtMs)}</span>
      </nav>
    </div>
  );
}

/** Beside a run Pane: the loop's other runs, newest first; a click switches to that run's Pane. */
export function LoopRunsRail({ runRef }: { runRef: LoopRunRef }) {
  const views = useLoopRunViews(runRef.loop);
  return (
    <aside className="flex w-52 flex-shrink-0 flex-col border-l border-border-primary bg-surface-primary" aria-label="Runs of this loop" data-testid="loop-runs-rail">
      <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Runs of this loop</p>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
        {views.map(view => {
          const current = view.run.id === runRef.run.id;
          const sessionId = view.session?.id;
          const trailing = view.outcome === 'failed' || view.outcome === 'skipped' || view.outcome === 'warning'
            ? view.outcome
            : view.durationMs === null ? '' : formatDuration(view.durationMs);
          return (
            <button
              key={view.run.id}
              type="button"
              aria-current={current ? 'page' : undefined}
              aria-disabled={!sessionId}
              title={runWarning(view) ?? view.run.error ?? undefined}
              onClick={() => { if (sessionId && !current) openLoopRun(sessionId); }}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive aria-disabled:cursor-default',
                current ? 'bg-surface-selected text-text-primary' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
              )}
            >
              <span className="flex h-3 w-3 flex-shrink-0 items-center justify-center" aria-hidden="true">
                <span className={cn('h-2 w-2 rounded-full', RUN_DOT_CLASS[view.outcome])} />
              </span>
              <span className="min-w-0 flex-1 truncate tabular-nums">{formatRunTime(view.run.slotAtMs)}</span>
              <span className="flex-shrink-0 text-[11px] text-text-tertiary tabular-nums">{trailing}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
