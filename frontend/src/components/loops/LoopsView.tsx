import { useEffect, useMemo } from 'react';
import { Plus, Repeat } from 'lucide-react';
import { LOOP_KEPT_RUNS, type Loop } from '../../../../shared/types/loop';
import { openLoopRun, openLoopSession, useLoopsStore } from '../../stores/loopsStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { LoopActions } from './LoopActions';
import { LoopRunStrip } from './LoopRunStrip';
import {
  RUN_DOT_CLASS,
  describeLoopCommand,
  describeRun,
  formatDuration,
  formatNextRun,
  formatRunTime,
  runWarning,
  useLoopRunViews,
  type LoopRunView,
} from './loopRunView';
import { useProjectList } from './useProjectList';

/** A loop's state in one dot: its latest run's outcome, hollow while paused or before its first run. */
function LoopStatusDot({ loop, latest }: { loop: Loop; latest: LoopRunView | undefined }) {
  const running = latest?.outcome === 'running';
  const hollow = !running && (!loop.enabled || !latest);
  return (
    <span className="flex h-3 w-3 flex-shrink-0 items-center justify-center" aria-hidden="true">
      <span className={cn('h-2 w-2 rounded-full', hollow ? 'border border-text-muted' : RUN_DOT_CLASS[latest?.outcome ?? 'ok'])} />
    </span>
  );
}

function loopState(loop: Loop, latest: LoopRunView | undefined): string {
  if (latest?.outcome === 'running') return describeRun(latest);
  if (!loop.enabled) return 'paused';
  return latest ? describeRun(latest) : 'no runs yet';
}

function LoopListItem({ loop, projectName, selected, onSelect }: { loop: Loop; projectName: string; selected: boolean; onSelect: () => void }) {
  const [latest] = useLoopRunViews(loop);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-testid="loop-list-item"
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors',
        selected ? 'bg-surface-selected' : 'hover:bg-surface-hover',
      )}
    >
      <span className="mt-1"><LoopStatusDot loop={loop} latest={latest} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{loop.name}</span>
          <span className="max-w-[40%] flex-shrink-0 truncate text-[11px] text-text-tertiary">{projectName}</span>
        </span>
        <span className="truncate text-xs text-text-secondary">{loop.scheduleText} · {loopState(loop, latest)}</span>
      </span>
    </button>
  );
}

function SummaryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border-primary px-3 py-2.5">
      <p className="text-[11px] text-text-tertiary">{label}</p>
      {children}
    </div>
  );
}

function LoopDetail({ loop, projectName }: { loop: Loop; projectName: string }) {
  const views = useLoopRunViews(loop);
  // The counts cover the strip's runs; older runs kept for their Panes are only in the table.
  const recent = views.slice(0, LOOP_KEPT_RUNS);
  const count = (outcome: LoopRunView['outcome']) => recent.filter(view => view.outcome === outcome).length;
  const [okCount, warningCount, failedCount] = [count('ok'), count('warning'), count('failed')];
  const counts = [
    okCount > 0 && `${okCount} ok`,
    warningCount > 0 && `${warningCount} with a warning`,
    failedCount > 0 && `${failedCount} failed`,
  ].filter(Boolean).join(' · ') || 'No runs yet';
  const latestSessionId = views.find(view => view.session)?.session?.id;
  const sessionTarget = loop.orchestrationSessionId;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="loop-detail">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Repeat className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
        <h2 className="min-w-0 truncate text-lg font-semibold text-text-primary">{loop.name}</h2>
        <span className="rounded-full border border-border-primary px-2 py-0.5 text-[11px] text-text-secondary">{projectName}</span>
        {!loop.enabled && <span className="rounded-full border border-border-primary px-2 py-0.5 text-[11px] text-text-tertiary">paused</span>}
        <div className="ml-auto flex items-center gap-2">
          {sessionTarget && (
            <Button size="sm" variant="secondary" onClick={() => openLoopSession(sessionTarget)}>Open Session</Button>
          )}
          {latestSessionId && (
            <Button size="sm" variant="secondary" onClick={() => openLoopRun(latestSessionId)}>Open latest run</Button>
          )}
          <LoopActions loop={loop} />
        </div>
      </div>

      {/* A paused loop is dimmed below its actions, which all still work. */}
      <div className={cn('flex min-w-0 flex-col gap-4', !loop.enabled && 'opacity-60')}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SummaryCard label="Schedule">
          <p className="truncate text-[13px] font-medium text-text-primary">{loop.scheduleText}</p>
          <p className="truncate font-mono text-xs text-text-secondary">{loop.cron}</p>
        </SummaryCard>
        <SummaryCard label="Next run">
          {loop.nextRunAtMs === null ? (
            <p className="text-[13px] font-medium text-text-primary">Paused</p>
          ) : (
            <>
              <p className="truncate text-[13px] font-medium text-text-primary">{formatNextRun(loop.nextRunAtMs)}</p>
              <p className="text-xs text-text-secondary">in {formatDuration(Math.max(0, loop.nextRunAtMs - Date.now()))}</p>
            </>
          )}
        </SummaryCard>
        <SummaryCard label="Last 10 runs">
          <div className="py-0.5"><LoopRunStrip views={views} /></div>
          <p className="text-xs text-text-secondary">{counts}</p>
        </SummaryCard>
      </div>

      <div className="min-w-0">
        <p className="text-xs text-text-tertiary">Runs</p>
        <p className="truncate font-mono text-xs text-text-primary" title={describeLoopCommand(loop)}>{describeLoopCommand(loop)}</p>
      </div>

      {views.length > 0 && (
        <div className="border-t border-border-primary" role="table" aria-label="Runs">
          {views.map(view => (
            <div
              key={view.run.id}
              role="row"
              className="grid grid-cols-[minmax(9rem,1.1fr)_minmax(6rem,1fr)_minmax(0,1.6fr)_auto] items-center gap-3 border-b border-border-primary py-1.5 text-[13px]"
              title={runWarning(view) ?? view.run.error ?? undefined}
            >
              <span role="cell" className="flex min-w-0 items-center gap-2 text-text-primary">
                <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', RUN_DOT_CLASS[view.outcome])} aria-hidden="true" />
                <span className="truncate">{formatRunTime(view.run.slotAtMs, true)}</span>
              </span>
              <span role="cell" className="truncate text-text-secondary">{describeRun(view)}</span>
              {/* Only a branch name is code; warnings and errors read as text. */}
              <span role="cell" className={cn('truncate text-xs', view.outcome === 'warning' ? 'text-status-warning' : 'text-text-secondary', !runWarning(view) && view.branch && 'font-mono')}>
                {runWarning(view) ?? view.branch ?? view.run.error ?? ''}
              </span>
              <span role="cell" className="flex w-16 justify-end">
                {view.session && (
                  <Button size="sm" variant="secondary" aria-label={`Open run ${formatRunTime(view.run.slotAtMs)}`} onClick={openLoopRun.bind(null, view.session.id)}>Open</Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-text-tertiary">Keeps the last 10 runs · unattended, permission prompts skipped</p>
      </div>
    </div>
  );
}

/** Every loop across projects: a list on the left and the selected loop on the right. */
export function LoopsView() {
  const loops = useLoopsStore(state => state.loops);
  const selectedLoopId = useLoopsStore(state => state.selectedLoopId);
  const selectLoop = useLoopsStore(state => state.selectLoop);
  const openDrawer = useLoopsStore(state => state.openDrawer);
  const projects = useProjectList();
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const loadSessions = useOrchestrationSessionStore(state => state.load);
  useEffect(() => { void loadSessions().catch(() => undefined); }, [loadSessions]);
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  const sessionNames = useMemo(() => new Map(sessions.map(session => [session.id, session.name])), [sessions]);
  const selected = loops.find(loop => loop.id === selectedLoopId) ?? loops[0];
  // Where a loop runs: its project, or the Session it messages.
  const projectName = (loop: Loop) => loop.orchestrationSessionId
    ? `Session · ${sessionNames.get(loop.orchestrationSessionId) ?? 'missing'}`
    : projectNames.get(loop.projectId ?? -1) ?? '';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-surface-primary" data-testid="loops-view">
      <aside className="flex w-72 flex-shrink-0 flex-col border-r border-border-primary">
        <div className="flex h-14 flex-shrink-0 items-center justify-between px-4">
          <h1 className="text-lg font-semibold text-text-primary">Loops</h1>
          <Button size="sm" aria-label="New loop" onClick={() => openDrawer(null)}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />New</Button>
        </div>
        <nav aria-label="Loops" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {loops.map(loop => (
            <LoopListItem
              key={loop.id}
              loop={loop}
              projectName={projectName(loop)}
              selected={loop.id === selected?.id}
              onSelect={() => selectLoop(loop.id)}
            />
          ))}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
        {selected ? (
          <LoopDetail loop={selected} projectName={projectName(selected)} />
        ) : (
          <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-3 text-center">
            <Repeat className="h-6 w-6 text-text-tertiary" aria-hidden="true" />
            <p className="text-sm font-medium text-text-primary">No loops yet</p>
            <p className="text-xs text-text-secondary">
              A loop runs an agent on a schedule, in a new Pane or in a Session, for large recurring jobs such as a nightly bug sweep. Loops run at most once an hour.
            </p>
            <Button size="sm" onClick={() => openDrawer(null)}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />New loop</Button>
          </div>
        )}
      </main>
    </div>
  );
}
