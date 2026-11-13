import { useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Lock } from 'lucide-react';
import { API } from '../utils/api';
import { requestOpenSettings } from '../utils/openSettings';
import { formatTokens, formatUsd } from './ui/charts/chartScales';
import { presetCalendarRange, usageDateBounds } from './usage/usageDateRange';
import { cn } from '../utils/cn';
import { DEFAULT_USAGE_RANGE_DAYS, type UsageReport } from '../../../shared/types/usage';

/** How often the card asks again while the transcript index has not finished a pass. */
const POLL_MS = 4000;
const TOP_PROJECTS = 3;
/** Model legend rows; a longer list folds its tail into "Other". */
const MODEL_ROWS = 3;
const MODEL_COLORS = ['bg-interactive', 'bg-status-success', 'bg-text-tertiary'] as const;

const tileClass = 'flex h-24 min-w-0 flex-col justify-between rounded-xl px-4 py-3';
const labelClass = 'h-4 text-[11px] uppercase leading-4 tracking-wider text-text-muted';
const linkClass = 'whitespace-nowrap text-interactive hover:text-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-interactive rounded-sm';

type CardState =
  | { kind: 'loading'; progress: string }
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; report: UsageReport };

function cardState(report: UsageReport | null, failed: boolean): CardState {
  if (failed) return { kind: 'unavailable' };
  if (report && report.totals.messageCount > 0) return { kind: 'ready', report };
  if (report && report.index.lastScanFinishedMs !== null) return { kind: 'empty' };
  const index = report?.index;
  const progress = index?.scanning && index.filesTotal > 0
    ? `Reading ${index.filesScanned.toLocaleString()} of ${index.filesTotal.toLocaleString()} transcript files…`
    : 'Reading transcript files…';
  return { kind: 'loading', progress };
}

/** Reads the last 30 local days after Home has painted, and again while the index is still building. */
function useUsageReport() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await API.usage.getReport(usageDateBounds(presetCalendarRange(DEFAULT_USAGE_RANGE_DAYS)));
        if (!live) return;
        if (!response.success || !response.data) throw new Error(response.error);
        setReport(response.data);
        setFailed(false);
        if (response.data.index.scanning || response.data.index.lastScanFinishedMs === null) timer = window.setTimeout(() => void load(), POLL_MS);
      } catch {
        if (live) setFailed(true);
      }
    };
    // After the first paint, so Home never waits on the usage database.
    const frame = window.requestAnimationFrame(() => void load());
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  return { report, failed };
}

/** A fixed line box holding text, or a grey bar of the same height while loading. */
function Slot({ loading, className, barClass, children }: { loading: boolean; className: string; barClass: string; children?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 items-center', className)}>
      {loading ? <div className={cn('rounded bg-surface-tertiary', barClass)} /> : <span className="truncate">{children}</span>}
    </div>
  );
}

function DailyBars({ report }: { report: UsageReport | null }) {
  const days = usageDateBounds(presetCalendarRange(DEFAULT_USAGE_RANGE_DAYS)).dayBoundariesMs.slice(0, -1);
  if (!report) return <div className="h-12 w-full rounded bg-surface-tertiary" />;
  const byDay = new Map(report.series.map(bucket => [bucket.bucketStartMs, bucket.totalTokens]));
  const values = days.map(day => byDay.get(day) ?? 0);
  const max = Math.max(...values, 1);
  return (
    <svg viewBox={`0 0 ${days.length} 1`} preserveAspectRatio="none" className="block h-12 w-full" aria-label="Tokens per day">
      {values.map((value, index) => {
        const height = value > 0 ? Math.max(value / max, 0.04) : 0;
        const label = `${new Date(days[index]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${formatTokens(value)} tokens`;
        return (
          <rect key={days[index]} x={index + 0.18} y={1 - height} width={0.64} height={height}
            className={cn('fill-interactive', index === days.length - 1 && 'opacity-50')}>
            <title>{label}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function ChartTile({ report }: { report: UsageReport | null }) {
  const totals = report?.totals;
  const cost = totals ? (totals.costIncomplete ? 'cost n/a' : `${formatUsd(totals.estimatedCostUsd)} est. at API rates`) : '';
  return (
    <div className={cn(tileClass, 'bg-surface-secondary')}>
      <div className="flex h-6 min-w-0 items-baseline gap-2">
        <Slot loading={!totals} className="h-6 shrink-0 text-xl font-semibold tabular-nums text-text-primary" barClass="h-4 w-16">
          {totals && formatTokens(totals.totalTokens)}
        </Slot>
        <Slot loading={!totals} className="h-6 flex-1 text-xs tabular-nums text-text-tertiary" barClass="h-2.5 w-48">
          tokens · {cost} · {totals?.messageCount.toLocaleString()} messages
        </Slot>
      </div>
      <DailyBars report={report} />
    </div>
  );
}

function ProjectsTile({ report }: { report: UsageReport | null }) {
  const projects = report?.byProject.slice(0, TOP_PROJECTS) ?? [];
  const top = projects[0]?.totalTokens ?? 1;
  const rows = report ? projects : Array.from({ length: TOP_PROJECTS }, () => null);
  return (
    <div className={cn(tileClass, 'bg-surface-secondary')}>
      <div className={labelClass}>Top projects</div>
      {rows.map((project, index) => (
        <div key={project?.path ?? index} className="grid h-4 grid-cols-[5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs" title={project?.path || undefined}>
          <Slot loading={!project} className="h-4 text-text-primary" barClass="h-2.5 w-16">{project?.label || 'No folder'}</Slot>
          <div className="h-1 rounded-full bg-surface-tertiary">
            {project && <div className="h-1 rounded-full bg-interactive" style={{ width: `${(project.totalTokens / top) * 100}%` }} />}
          </div>
          <Slot loading={!project} className="h-4 justify-end tabular-nums text-text-tertiary" barClass="h-2.5 w-8">
            {project && formatTokens(project.totalTokens)}
          </Slot>
        </div>
      ))}
    </div>
  );
}

function modelShares(report: UsageReport): Array<{ label: string; share: number }> {
  const total = report.totals.totalTokens || 1;
  const models = report.byModel.map(entry => ({ label: entry.model, share: entry.totalTokens / total }));
  if (models.length <= MODEL_ROWS) return models;
  const shown = models.slice(0, MODEL_ROWS - 1);
  const rest = models.slice(MODEL_ROWS - 1).reduce((sum, entry) => sum + entry.share, 0);
  return [...shown, { label: 'Other', share: rest }];
}

function ModelsTile({ report }: { report: UsageReport | null }) {
  const models = report ? modelShares(report) : null;
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  return (
    <div className={cn(tileClass, 'bg-surface-secondary')}>
      <div className={labelClass}>Models</div>
      {models ? (
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {models.map((model, index) => <div key={model.label} className={MODEL_COLORS[index]} style={{ width: percent(model.share) }} />)}
        </div>
      ) : <div className="h-1.5 rounded-full bg-surface-tertiary" />}
      <div className="flex flex-col gap-px">
        {Array.from({ length: MODEL_ROWS }, (_, index) => {
          const model = models?.[index];
          return (
            <div key={index} className="flex h-3.5 items-center gap-1.5 text-[11px] leading-[14px] text-text-tertiary">
              {!models ? <div className="h-2 w-28 rounded bg-surface-tertiary" /> : model && (
                <>
                  <span className={cn('h-2 w-2 flex-none rounded-sm', MODEL_COLORS[index])} />
                  <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  <span className="tabular-nums">{percent(model.share)}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyTiles({ title, detail }: { title: string; detail: string }) {
  const empty = cn(tileClass, 'border border-dashed border-border-primary');
  const track = <div className="flex h-4 items-center"><div className="h-1 w-full rounded-full bg-surface-secondary" /></div>;
  return (
    <>
      <div className={empty}>
        <div className="flex h-9 min-w-0 items-center gap-2.5 text-text-tertiary">
          <BarChart3 className="h-[18px] w-[18px] flex-none" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium leading-5 text-text-primary">{title}</div>
            <div className="truncate text-xs leading-4">{detail}</div>
          </div>
        </div>
        <div className="h-8 border-b border-dashed border-border-primary" />
      </div>
      <div className={empty}>
        <div className={labelClass}>Top projects</div>
        {track}{track}{track}
      </div>
      <div className={empty}>
        <div className={labelClass}>Models</div>
        <div className="h-2 rounded-full bg-surface-secondary" />
        <div className="h-10 text-xs leading-4 text-text-tertiary">Your busiest projects and models show up here.</div>
      </div>
    </>
  );
}

/**
 * First-run Home's look at the Claude Code and Codex usage already on this
 * computer, read from Usage & Limits' transcript index. Every state has the
 * same footprint, so nothing below it moves when the numbers arrive.
 */
export function UsageSnapshotCard({ report, failed = false }: { report: UsageReport | null; failed?: boolean }) {
  const state = cardState(report, failed);
  const shown = state.kind === 'ready' ? state.report : null;
  return (
    <section aria-label="Your AI usage" data-testid="home-usage-card" className="flex flex-col gap-4 rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-7 text-text-primary">Your AI usage</h2>
          <p className="mt-1 truncate text-sm leading-5 text-text-tertiary">Claude Code and Codex on this computer · last {DEFAULT_USAGE_RANGE_DAYS} days</p>
        </div>
        <button type="button" className={cn(linkClass, 'text-[13px] leading-5')} onClick={() => requestOpenSettings({ category: 'usage' })}>
          Open Usage &amp; Limits →
        </button>
      </div>
      <div className={cn('grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3', state.kind === 'loading' && 'animate-pulse')}>
        {state.kind === 'empty' && <EmptyTiles title="No Claude Code or Codex history on this computer yet" detail="Start an agent and each day's tokens chart here." />}
        {state.kind === 'unavailable' && <EmptyTiles title="Pane couldn't read your agent history" detail="Open Usage & Limits to read it again." />}
        {(state.kind === 'loading' || state.kind === 'ready') && (
          <>
            <ChartTile report={shown} />
            <ProjectsTile report={shown} />
            <ModelsTile report={shown} />
          </>
        )}
      </div>
      <div className="flex h-5 items-center justify-between gap-4 text-xs text-text-tertiary">
        <span className="flex min-w-0 items-center gap-1.5">
          <Lock className="h-3 w-3 flex-none" aria-hidden="true" />
          <span className="truncate">Read from files on this computer. Nothing leaves it unless you join the leaderboard.</span>
        </span>
        {state.kind === 'loading' && <span className="whitespace-nowrap tabular-nums">{state.progress}</span>}
        {state.kind === 'ready' && (
          <button type="button" className={linkClass} onClick={() => requestOpenSettings({ category: 'usage', setting: 'usage-leaderboard' })}>
            Join the leaderboard
          </button>
        )}
      </div>
    </section>
  );
}

/** The card wired to the usage index. */
export function HomeUsageCard() {
  const { report, failed } = useUsageReport();
  return <UsageSnapshotCard report={report} failed={failed} />;
}
