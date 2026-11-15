import { useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Lock } from 'lucide-react';
import { API } from '../utils/api';
import { requestOpenSettings } from '../utils/openSettings';
import { useActiveMachineStore } from '../stores/activeMachineStore';
import { formatShare, formatTokens, formatUsd } from './ui/charts/chartScales';
import { DAY_MS, rollingUsageRange } from './usage/usageDateRange';
import { cn } from '../utils/cn';
import { DEFAULT_USAGE_RANGE_DAYS, type UsageIndexStatus, type UsageReport } from '../../../shared/types/usage';

/** How often the card checks the index while a pass is still running. */
const POLL_MS = 4000;
/** Failed reads in a row before the card stops asking until the host resyncs. */
const MAX_FAILED_READS = 3;
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
  /** progress is set while a scan is still adding to these numbers. */
  | { kind: 'ready'; report: UsageReport; progress: string | null };

/** A pass is running, or the first one has not started yet (it starts 8 s after launch). */
function passPending(index: UsageIndexStatus): boolean {
  return index.scanning || index.lastScanStartedMs === null;
}

function scanProgress(index: UsageIndexStatus | null): string {
  return index?.scanning && index.filesTotal > 0
    ? `Reading ${index.filesScanned.toLocaleString()} of ${index.filesTotal.toLocaleString()} transcript files…`
    : 'Reading transcript files…';
}

/** `failed`: the card stopped asking after reads in a row failed, so a scan it last saw running reports nothing more. */
function cardState(report: UsageReport | null, status: UsageIndexStatus | null, failed: boolean): CardState {
  const index = status ?? report?.index ?? null;
  if (report && report.totals.messageCount > 0) return { kind: 'ready', report, progress: index?.scanning && !failed ? scanProgress(index) : null };
  if (failed) return { kind: 'unavailable' };
  if (report && index && !passPending(index)) {
    // A pass that ended with an error leaves lastScanFinishedMs unset.
    return index.lastScanFinishedMs !== null ? { kind: 'empty' } : { kind: 'unavailable' };
  }
  return { kind: 'loading', progress: scanProgress(index) };
}

/**
 * Reads the report once after Home has painted. While a pass runs it checks
 * only the index status, then reads the report once more when the pass ends,
 * so the main process runs the full report at most twice per pass.
 */
function useUsageReport() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [status, setStatus] = useState<UsageIndexStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let failures = 0;
    const later = (step: () => Promise<void>) => { timer = window.setTimeout(() => void step(), POLL_MS); };
    const run = async <T,>(read: () => Promise<{ success: boolean; data?: T | null }>, apply: (data: T) => void, retry: () => Promise<void>) => {
      try {
        const response = await read();
        if (!live) return;
        if (!response.success || !response.data) throw new Error('usage read failed');
        failures = 0;
        setFailed(false);
        apply(response.data);
      } catch {
        if (!live) return;
        failures += 1;
        if (failures < MAX_FAILED_READS) later(retry);
        else setFailed(true);
      }
    };
    const loadReport = (): Promise<void> => run(() => API.usage.getReport(rollingUsageRange(DEFAULT_USAGE_RANGE_DAYS)), data => {
      setReport(data);
      setStatus(data.index);
      if (passPending(data.index)) later(checkStatus);
    }, loadReport);
    const checkStatus = (): Promise<void> => run(() => API.usage.getStatus(), data => {
      setStatus(data);
      if (passPending(data)) later(checkStatus);
      else void loadReport();
    }, checkStatus);
    const restart = () => { window.clearTimeout(timer); failures = 0; void loadReport(); };
    // After the first paint, so Home never waits on the usage database.
    const frame = window.requestAnimationFrame(restart);
    // Usage comes from the active host, so read again when it changes or reconnects.
    const unsubscribe = window.electronAPI?.events?.onRemoteDaemonResyncRequested?.(restart);
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);
  return { report, status, failed };
}

/** A fixed line box holding text, or a grey bar of the same height while loading. */
function Slot({ loading, className, barClass, children }: { loading: boolean; className: string; barClass: string; children?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 items-center', className)}>
      {loading ? <div className={cn('rounded bg-surface-tertiary', barClass)} /> : <span className="truncate">{children}</span>}
    </div>
  );
}

/** One bar per day bucket the report uses (UTC days), across the same rolling range as Usage & Limits. */
function DailyBars({ report }: { report: UsageReport | null }) {
  if (!report) return <div className="h-12 w-full rounded bg-surface-tertiary" />;
  const { fromMs, toMs } = rollingUsageRange(DEFAULT_USAGE_RANGE_DAYS);
  const days: number[] = [];
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= toMs; day += DAY_MS) days.push(day);
  const byDay = new Map(report.series.map(bucket => [bucket.bucketStartMs, bucket.totalTokens]));
  const values = days.map(day => byDay.get(day) ?? 0);
  const max = Math.max(...values, 1);
  return (
    <svg viewBox={`0 0 ${days.length} 1`} preserveAspectRatio="none" className="block h-12 w-full" aria-label="Tokens per day">
      {values.map((value, index) => {
        const height = value > 0 ? Math.max(value / max, 0.04) : 0;
        const label = `${new Date(days[index]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${formatTokens(value)} tokens`;
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
  const projects = report?.byProject ?? [];
  const top = projects[0]?.totalTokens ?? 1;
  return (
    <div className={cn(tileClass, 'bg-surface-secondary')}>
      <div className={labelClass}>Top projects</div>
      {Array.from({ length: TOP_PROJECTS }, (_, index) => {
        const project = projects[index];
        // Every slot keeps its line, so one or two projects stay where the skeleton drew them.
        if (report && !project) return <div key={index} className="h-4" />;
        return (
        <div key={project?.path ?? index} className="grid h-4 grid-cols-[minmax(0,5rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs" title={project?.path || undefined}>
          <Slot loading={!project} className="h-4 text-text-primary" barClass="h-2.5 w-16">{project?.label || 'No folder'}</Slot>
          <div className="h-1 rounded-full bg-surface-tertiary">
            {project && <div className="h-1 rounded-full bg-interactive" style={{ width: `${(project.totalTokens / top) * 100}%` }} />}
          </div>
          <Slot loading={!project} className="h-4 justify-end tabular-nums text-text-tertiary" barClass="h-2.5 w-8">
            {project && formatTokens(project.totalTokens)}
          </Slot>
        </div>
        );
      })}
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
  return (
    <div className={cn(tileClass, 'bg-surface-secondary')}>
      <div className={labelClass}>Models</div>
      {models ? (
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {models.map((model, index) => <div key={model.label} className={MODEL_COLORS[index]} style={{ width: formatShare(model.share) }} />)}
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
                  <span className="tabular-nums">{formatShare(model.share)}</span>
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
export function UsageSnapshotCard({ report, status = null, failed = false, host = null }: {
  report: UsageReport | null;
  /** The index status read since the report, while a pass runs. */
  status?: UsageIndexStatus | null;
  failed?: boolean;
  /** The remote host this window shows, or null for this computer. */
  host?: string | null;
}) {
  const state = cardState(report, status, failed);
  const where = host ? `on ${host}` : 'on this computer';
  const shown = state.kind === 'ready' ? state.report : null;
  return (
    <section aria-label="Your AI usage" data-testid="home-usage-card" className="flex flex-col gap-4 rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-7 text-text-primary">Your AI usage</h2>
          <p className="mt-1 truncate text-sm leading-5 text-text-tertiary">Claude Code and Codex {where} · last {DEFAULT_USAGE_RANGE_DAYS} days</p>
        </div>
        <button type="button" className={cn(linkClass, 'text-[13px] leading-5')} onClick={() => requestOpenSettings({ category: 'usage' })}>
          Open Usage &amp; Limits →
        </button>
      </div>
      <div className={cn('grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]', state.kind === 'loading' && 'animate-pulse')}>
        {state.kind === 'empty' && <EmptyTiles title={`No Claude Code or Codex history ${where} yet`} detail="Start an agent and each day's tokens chart here." />}
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
          <span className="truncate">Read from files {where}. Nothing leaves it unless you join the leaderboard.</span>
        </span>
        {(state.kind === 'loading' || state.kind === 'ready') && state.progress && <span className="whitespace-nowrap tabular-nums">{state.progress}</span>}
        {state.kind === 'ready' && !state.progress && (
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
  const { report, status, failed } = useUsageReport();
  const machine = useActiveMachineStore(state => state.machine);
  return <UsageSnapshotCard report={report} status={status} failed={failed} host={machine && !machine.local ? machine.name : null} />;
}
