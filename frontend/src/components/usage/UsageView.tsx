import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CalendarDays, Check, Download, Loader2, RefreshCw, Share2 } from 'lucide-react';
import { toPng } from 'html-to-image';
import { API } from '../../utils/api';
import { useHotkey } from '../../hooks/useHotkey';
import { useCommittedRef } from '../../hooks/useCommittedRef';
import { AreaChart } from '../ui/charts/AreaChart';
import { BarChart } from '../ui/charts/BarChart';
import { DonutChart } from '../ui/charts/DonutChart';
import { formatTokens, formatUsd } from '../ui/charts/chartScales';
import { LimitBar, LimitStatusBanners, CreditsLine } from './ProviderLimits';
import { LeaderboardTab } from './LeaderboardTab';
import { PaneUsageSummary } from './PaneUsageSummary';
import { UsageDateRangeDialog } from './UsageDateRangeDialog';
import { presetCalendarRange, usageDateBounds, type UsageDateRange } from './usageDateRange';
import {
  DEFAULT_USAGE_RANGE_DAYS,
  type UsageByPane,
  type UsagePaneCostSlice,
  type UsageProvider,
  type UsageReport,
} from '../../../../shared/types/usage';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Poll while a scan is running so the progress line stays honest. */
const SCAN_POLL_MS = 4000;

const RANGE_OPTIONS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: DEFAULT_USAGE_RANGE_DAYS, label: '30d' },
  { days: 90, label: '90d' },
] as const;

const PROVIDER_OPTIONS: Array<{ value: UsageProvider | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

const PROVIDER_META = {
  claude: { label: 'Anthropic', color: '#e0913a' },
  codex: { label: 'OpenAI', color: '#37b877' },
} satisfies Record<UsageProvider, { label: string; color: string }>;

/** Chart palette, matching the graph view's lane colours. */
const SERIES_COLORS = {
  input: '#4f8ef7',
  output: '#37b877',
  cacheRead: '#8f8ff0',
  cacheWrite: '#e0913a',
} as const;

const MODEL_COLORS = ['#4f8ef7', '#37b877', '#e0913a', '#c765d6', '#e05a6b', '#3fb8c4', '#8f8ff0', '#c2a63a'];

type PaneSortKey =
  | 'paneName'
  | 'totalTokens'
  | 'estimatedCostUsd'
  | 'uncachedCostUsd'
  | 'cacheHitRate'
  | 'cacheReadTokens'
  | 'uncachedInputTokens'
  | 'cacheSavingsUsd';
type PaneSortDirection = 'asc' | 'desc';

const PANE_SORT_COLUMNS: Array<{ key: PaneSortKey; label: string }> = [
  { key: 'paneName', label: 'Pane' },
  { key: 'totalTokens', label: 'Tokens' },
  { key: 'estimatedCostUsd', label: 'Total' },
  { key: 'uncachedCostUsd', label: 'Uncached' },
  { key: 'cacheHitRate', label: 'Cache hit' },
  { key: 'cacheReadTokens', label: 'Cache read' },
  { key: 'uncachedInputTokens', label: 'Uncached input' },
  { key: 'cacheSavingsUsd', label: 'Saved' },
];

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded border border-border-primary bg-surface-secondary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">{value}</p>
      {detail && <p className="text-[10px] text-text-tertiary">{detail}</p>}
    </div>
  );
}

function PaneCostCells({ pane }: { pane: UsagePaneCostSlice }) {
  const cost = (value: number) => pane.costIncomplete ? 'n/a' : formatUsd(value);
  return (
    <>
      <td className="px-2 py-2 tabular-nums text-text-secondary">{formatTokens(pane.totalTokens)}</td>
      <td className="px-2 py-2 tabular-nums text-text-secondary">{cost(pane.estimatedCostUsd)}</td>
      <td className="px-2 py-2 tabular-nums text-text-primary">{cost(pane.uncachedCostUsd)}</td>
      <td className="px-2 py-2 tabular-nums text-text-secondary">{Math.round(pane.cacheHitRate * 100)}%</td>
      <td className="px-2 py-2 tabular-nums text-text-secondary">{formatTokens(pane.cacheReadTokens)}</td>
      <td className="px-2 py-2 tabular-nums text-text-secondary">{formatTokens(pane.uncachedInputTokens)}</td>
      <td className="px-2 py-2 tabular-nums text-status-success">{cost(pane.cacheSavingsUsd)}</td>
      <td className="px-2 py-2 text-[10px] text-text-tertiary">
        {pane.byModel.length > 0 ? (
          <ul className="space-y-0.5">
            {pane.byModel.map(model => (
              <li key={`${model.provider}-${model.model}`} className="whitespace-nowrap">
                {model.model} · {formatTokens(model.totalTokens)} · {model.costIncomplete ? 'n/a' : formatUsd(model.estimatedCostUsd)}
              </li>
            ))}
          </ul>
        ) : '—'}
      </td>
    </>
  );
}

function PaneUsageRow({ pane }: { pane: UsageByPane }) {
  return (
    <tr className="border-b border-border-primary last:border-b-0">
      <td className="px-2 py-2" title={pane.worktreePath}>
        <span className="font-medium text-text-primary">{pane.paneName}</span>
        {pane.archived && (
          <span className="ml-1.5 rounded bg-surface-tertiary px-1 py-0.5 text-[9px] uppercase tracking-wide text-text-muted">
            archived
          </span>
        )}
      </td>
      <PaneCostCells pane={pane} />
    </tr>
  );
}

/**
 * Token usage, cost and rate-limit page.
 *
 * Numbers come from two sources:
 * - **Logs**: token counts, model split, cache rates, per-project — counted
 *   directly from agent CLI transcripts.
 * - **Provider**: rate limits, credits, blocked state — reported by Codex in
 *   every token_count event. Anthropic does not expose plan limits locally.
 */
type UsageTab = 'usage' | 'leaderboard';

export function UsageView() {
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<UsageTab>('usage');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(DEFAULT_USAGE_RANGE_DAYS);
  const [customRange, setCustomRange] = useState<UsageDateRange | null>(null);
  const [showDateRange, setShowDateRange] = useState(false);
  const [trimPaneUsage, setTrimPaneUsage] = useState(false);
  const requestId = useRef(0);
  const [provider, setProvider] = useState<UsageProvider | 'all'>('all');
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'capturing' | 'done'>('idle');
  const [shareStatus, setShareStatus] = useState<'idle' | 'capturing' | 'done'>('idle');
  const [showWatermark, setShowWatermark] = useState(false);
  const [paneSort, setPaneSort] = useState<{ key: PaneSortKey; direction: PaneSortDirection }>({
    key: 'uncachedCostUsd',
    direction: 'desc',
  });
  /** Series switched off in the legend — see `visibleAreaSeries`. */
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    const id = ++requestId.current;
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);
    try {
      const toMs = Date.now();
      const response = await API.usage.getReport({
        ...(customRange ? usageDateBounds(customRange) : { fromMs: toMs - rangeDays * DAY_MS, toMs }),
        providers: provider === 'all' ? undefined : [provider],
      });
      if (id !== requestId.current) return;
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load usage');
      }
      setReport(response.data);
      setError(null);
    } catch (err: unknown) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Failed to load usage');
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [rangeDays, customRange, provider]);

  useEffect(() => {
    void load('initial');
    return () => { requestId.current += 1; };
  }, [load]);

  // While the index is still building, keep refreshing so numbers fill in.
  const scanning = report?.index.scanning ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => { void load('refresh'); }, SCAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [scanning, load]);

  const currentLoad = useCommittedRef(load);
  const handleRescan = useCallback(async () => {
    setRefreshing(true);
    try {
      await API.usage.rescan();
      await currentLoad.current('refresh');
    } catch {
      setRefreshing(false);
    }
  }, [currentLoad]);

  const rangeLabel = customRange
    ? `${customRange.start} to ${customRange.end}`
    : RANGE_OPTIONS.find(o => o.days === rangeDays)?.label ?? `${rangeDays}d`;

  const captureImage = useCallback(async (): Promise<string | null> => {
    if (!contentRef.current) return null;
    setShowWatermark(true);
    // Wait for watermark to render
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const dataUrl = await toPng(contentRef.current, { pixelRatio: 2 });
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    } catch (err) {
      console.error('[UsageView] Capture failed:', err);
      return null;
    } finally {
      setShowWatermark(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    if (downloadStatus !== 'idle' || loading || error || !report) return;
    setDownloadStatus('capturing');
    try {
      const data = await captureImage();
      if (!data) { setDownloadStatus('idle'); return; }
      const date = new Date().toISOString().slice(0, 10);
      await API.export.saveImage(data, `pane-usage-${rangeLabel}-${date}.png`);
      setDownloadStatus('done');
      setTimeout(() => setDownloadStatus('idle'), 1500);
    } catch {
      setDownloadStatus('idle');
    }
  }, [captureImage, downloadStatus, rangeLabel, loading, error, report]);

  const handleShare = useCallback(async () => {
    if (shareStatus !== 'idle' || loading || error || !report) return;
    setShareStatus('capturing');
    try {
      const data = await captureImage();
      if (!data) { setShareStatus('idle'); return; }
      const date = new Date().toISOString().slice(0, 10);
      const response = await API.export.shareImage(data, `pane-usage-${rangeLabel}-${date}.png`);
      if (response.success && response.data?.method === 'clipboard') {
        setShareStatus('done');
        setTimeout(() => setShareStatus('idle'), 1500);
      } else {
        setShareStatus('idle');
      }
    } catch {
      setShareStatus('idle');
    }
  }, [captureImage, shareStatus, rangeLabel, loading, error, report]);

  useHotkey({
    id: 'usage-download',
    label: 'Download usage image',
    category: 'tools',
    action: () => { void handleDownload(); },
  });

  useHotkey({
    id: 'usage-share',
    label: 'Share usage image',
    category: 'tools',
    action: () => { void handleShare(); },
  });

  const seriesLabels = useMemo(
    () => (report?.series ?? []).map(bucket =>
      new Date(bucket.bucketStartMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    ),
    [report]
  );

  const areaSeries = useMemo(() => {
    const buckets = report?.series ?? [];
    return [
      { label: 'Input', color: SERIES_COLORS.input, values: buckets.map(b => b.inputTokens) },
      { label: 'Output', color: SERIES_COLORS.output, values: buckets.map(b => b.outputTokens) },
      { label: 'Cache read', color: SERIES_COLORS.cacheRead, values: buckets.map(b => b.cacheReadTokens) },
      { label: 'Cache write', color: SERIES_COLORS.cacheWrite, values: buckets.map(b => b.cacheCreationTokens) },
    ];
  }, [report]);

  const visibleAreaSeries = useMemo(
    () => areaSeries.filter(entry => !hiddenSeries.includes(entry.label)),
    [areaSeries, hiddenSeries]
  );

  const toggleSeries = useCallback((label: string) => {
    setHiddenSeries(current => (
      current.includes(label)
        ? current.filter(entry => entry !== label)
        : current.length === areaSeries.length - 1
          ? current
          : [...current, label]
    ));
  }, [areaSeries.length]);

  const modelBars = useMemo(() => {
    const total = report?.totals.totalTokens ?? 0;
    return (report?.byModel ?? []).slice(0, 10).map((entry, index) => ({
      label: entry.model,
      value: entry.totalTokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      tag: PROVIDER_META[entry.provider].label,
      share: total > 0 ? entry.totalTokens / total : 0,
      detail: entry.costIncomplete ? 'n/a' : formatUsd(entry.estimatedCostUsd),
      note: entry.costIncomplete ? 'no price' : 'at API rates',
      detailTitle: entry.costIncomplete
        ? 'No published price for this id. Codex reports sub-agent profiles (for example codex-auto-review) in the model field, and those are billed under the model they run on.'
        : 'Estimated at published API rates. Not what a flat-rate plan charges.',
    }));
  }, [report]);

  /** Which worktree spent the tokens — the question only Pane can answer. */
  const projectBars = useMemo(() => {
    const total = report?.totals.totalTokens ?? 0;
    return (report?.byProject ?? []).slice(0, 8).map((entry, index) => ({
      label: entry.label,
      title: entry.path || 'No working directory recorded',
      value: entry.totalTokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      share: total > 0 ? entry.totalTokens / total : 0,
    }));
  }, [report]);

  const cacheHitRate = useMemo(() => {
    const totals = report?.totals;
    if (!totals) return null;
    const readable = totals.inputTokens + totals.cacheReadTokens;
    if (readable === 0) return null;
    return totals.cacheReadTokens / readable;
  }, [report]);

  const sortedPanes = useMemo(() => {
    const panes = [...(report?.byPane.panes ?? [])];
    const multiplier = paneSort.direction === 'asc' ? 1 : -1;
    return panes.sort((a, b) => {
      const comparison = paneSort.key === 'paneName'
        ? a.paneName.localeCompare(b.paneName)
        : a[paneSort.key] - b[paneSort.key];
      return comparison * multiplier || a.paneName.localeCompare(b.paneName);
    });
  }, [paneSort, report]);

  const updatePaneSort = useCallback((key: PaneSortKey) => {
    setPaneSort(current => ({
      key,
      direction: current.key === key
        ? current.direction === 'asc' ? 'desc' : 'asc'
        : key === 'paneName' ? 'asc' : 'desc',
    }));
  }, []);

  /** Anthropic vs OpenAI roll-up — the split the model list alone doesn't show. */
  const providerBars = useMemo(() => {
    const byProvider = new Map<UsageProvider, { tokens: number; cost: number; incomplete: boolean }>();
    for (const entry of report?.byModel ?? []) {
      const acc = byProvider.get(entry.provider) ?? { tokens: 0, cost: 0, incomplete: false };
      acc.tokens += entry.totalTokens;
      acc.cost += entry.estimatedCostUsd;
      acc.incomplete = acc.incomplete || entry.costIncomplete;
      byProvider.set(entry.provider, acc);
    }

    const total = report?.totals.totalTokens ?? 0;
    return [...byProvider.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([key, value]) => ({
        label: PROVIDER_META[key].label,
        value: value.tokens,
        color: PROVIDER_META[key].color,
        share: total > 0 ? value.tokens / total : 0,
      }));
  }, [report]);

  const cacheSlices = useMemo(() => {
    const totals = report?.totals;
    if (!totals) return [];
    return [
      { label: 'Input', value: totals.inputTokens, color: SERIES_COLORS.input },
      { label: 'Output', value: totals.outputTokens, color: SERIES_COLORS.output },
      { label: 'Cache read', value: totals.cacheReadTokens, color: SERIES_COLORS.cacheRead },
      { label: 'Cache write', value: totals.cacheCreationTokens, color: SERIES_COLORS.cacheWrite },
    ];
  }, [report]);

  const bothRootsMissing = (report?.index.missingRoots.length ?? 0) >= 2;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
          <h1 className="text-sm font-medium text-text-primary">Usage &amp; limits</h1>
        </div>

        <nav className="flex items-center gap-1" role="tablist" aria-label="Usage views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'usage'}
            onClick={() => setActiveTab('usage')}
            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              activeTab === 'usage'
                ? 'bg-interactive text-text-on-interactive'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            My usage
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'leaderboard'}
            onClick={() => setActiveTab('leaderboard')}
            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              activeTab === 'leaderboard'
                ? 'bg-interactive text-text-on-interactive'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            Leaderboard
          </button>
        </nav>

        {activeTab === 'usage' && (
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">Provider</legend>
              {PROVIDER_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={provider === option.value}
                  onClick={() => setProvider(option.value)}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    provider === option.value
                      ? 'bg-interactive text-text-on-interactive'
                      : 'text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>

            <span className="h-4 w-px bg-border-primary" aria-hidden="true" />

            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">Time range</legend>
              {RANGE_OPTIONS.map(option => (
                <button
                  key={option.days}
                  type="button"
                  aria-pressed={!customRange && rangeDays === option.days}
                  onClick={() => { setCustomRange(null); setRangeDays(option.days); }}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    !customRange && rangeDays === option.days
                      ? 'bg-interactive text-text-on-interactive'
                      : 'text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>

            <button
              type="button"
              aria-label="Choose custom date range"
              aria-pressed={customRange !== null}
              title="Choose custom date range"
              onClick={() => setShowDateRange(true)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] ${customRange ? 'bg-interactive text-text-on-interactive' : 'text-text-secondary hover:bg-surface-hover'}`}
            >
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              {customRange ? rangeLabel : 'Custom'}
            </button>

            <span className="h-4 w-px bg-border-primary" aria-hidden="true" />

            <button
              type="button"
              onClick={() => { void handleDownload(); }}
              disabled={downloadStatus === 'capturing' || !report || loading || !!error}
              aria-label="Download usage as image"
              title="Download usage as image"
              className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              {downloadStatus === 'done'
                ? <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
                : <Download className={`h-3.5 w-3.5 text-text-tertiary ${downloadStatus === 'capturing' ? 'animate-pulse' : ''}`} aria-hidden="true" />}
            </button>

            <button
              type="button"
              onClick={() => { void handleShare(); }}
              disabled={shareStatus === 'capturing' || !report || loading || !!error}
              aria-label="Share usage image"
              title="Share usage image"
              className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              {shareStatus === 'done'
                ? <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
                : <Share2 className={`h-3.5 w-3.5 text-text-tertiary ${shareStatus === 'capturing' ? 'animate-pulse' : ''}`} aria-hidden="true" />}
            </button>

            <button
              type="button"
              onClick={() => { void handleRescan(); }}
              disabled={refreshing}
              aria-label="Rescan transcripts"
              className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      {showDateRange && (
        <UsageDateRangeDialog
          initialRange={customRange ?? presetCalendarRange(rangeDays)}
          onClose={() => setShowDateRange(false)}
          onApply={range => { setCustomRange(range); setShowDateRange(false); }}
        />
      )}

      {activeTab === 'usage' && report?.index.scanning && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-tertiary px-4 py-1 text-[11px] text-text-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Indexing transcripts… {report.index.filesScanned}/{report.index.filesTotal} files
        </div>
      )}

      {activeTab === 'leaderboard' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <LeaderboardTab />
        </div>
      ) : (
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading usage…
          </div>
        ) : error ? (
          <div className="rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
            {error}
          </div>
        ) : bothRootsMissing ? (
          <div className="mx-auto max-w-lg rounded border border-border-primary bg-surface-secondary p-6 text-center">
            <h2 className="mb-2 text-sm font-medium text-text-primary">No agent transcripts found</h2>
            <p className="text-xs text-text-secondary">
              Usage is read from the Claude Code and Codex transcript files in your home directory.
              Neither <code className="font-mono">~/.claude/projects</code> nor{' '}
              <code className="font-mono">~/.codex/sessions</code> exists yet — run an agent once and
              come back.
            </p>
          </div>
        ) : report ? (
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            <p className="text-xs text-text-tertiary">{customRange ? rangeLabel : `Last ${rangeLabel}`} · {provider === 'all' ? 'All providers' : PROVIDER_OPTIONS.find(option => option.value === provider)?.label}</p>
            {/* Summary — all from logs */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard
                label="Total tokens"
                value={formatTokens(report.totals.totalTokens)}
                detail={`${report.totals.messageCount.toLocaleString()} messages`}
              />
              <StatCard label="Input" value={formatTokens(report.totals.inputTokens)} />
              <StatCard label="Output" value={formatTokens(report.totals.outputTokens)} />
              {cacheHitRate !== null ? (
                <StatCard
                  label="Cache hit rate"
                  value={`${Math.round(cacheHitRate * 100)}%`}
                  detail="of read input came from cache"
                />
              ) : (
                <StatCard
                  label="Messages"
                  value={report.totals.messageCount.toLocaleString()}
                />
              )}
            </div>

            {cacheHitRate !== null && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard
                  label="Messages"
                  value={report.totals.messageCount.toLocaleString()}
                  detail={`${formatTokens(
                    report.totals.messageCount > 0
                      ? report.totals.totalTokens / report.totals.messageCount
                      : 0
                  )} per message`}
                />
                <StatCard
                  label="Busiest project"
                  value={report.byProject[0]?.label ?? '—'}
                  detail={report.byProject[0]
                    ? `${formatTokens(report.byProject[0].totalTokens)} tokens`
                    : undefined}
                />
                {report.totals.cacheReadTokens > 0 && (
                  <StatCard
                    label="Saved by caching"
                    value={formatTokens(report.totals.cacheReadTokens)}
                    detail={report.totals.cacheSavingsUsd > 0 && !report.totals.costIncomplete
                      ? `${formatUsd(report.totals.cacheSavingsUsd)} at API rates`
                      : 'tokens served from cache instead of recomputed'}
                  />
                )}
              </div>
            )}

            <PaneUsageSummary byPane={report.byPane} trim={trimPaneUsage} onTrimChange={setTrimPaneUsage} />

            <div className="grid gap-4 lg:grid-cols-3">
              {/* Time series */}
              <section className="rounded border border-border-primary bg-surface-secondary p-3 lg:col-span-2">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Tokens over time
                </h2>
                <AreaChart
                  labels={seriesLabels}
                  series={visibleAreaSeries}
                  formatValue={formatTokens}
                  ariaLabel={`Token usage ${customRange ? `from ${rangeLabel}` : `over the last ${rangeDays} days`}, totalling ${formatTokens(report.totals.totalTokens)} tokens`}
                />
                <ul className="mt-2 flex flex-wrap gap-2">
                  {areaSeries.map(entry => {
                    const hidden = hiddenSeries.includes(entry.label);
                    const total = entry.values.reduce((sum, value) => sum + value, 0);

                    return (
                      <li key={entry.label}>
                        <button
                          type="button"
                          onClick={() => toggleSeries(entry.label)}
                          aria-pressed={!hidden}
                          title={hidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
                          className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive ${
                            hidden ? 'text-text-muted' : 'text-text-tertiary'
                          }`}
                        >
                          <span
                            className="h-2 w-2 rounded-sm border"
                            style={{
                              backgroundColor: hidden ? 'transparent' : entry.color,
                              borderColor: entry.color,
                            }}
                            aria-hidden="true"
                          />
                          <span className={hidden ? 'line-through' : undefined}>{entry.label}</span>
                          <span className="tabular-nums text-text-muted">{formatTokens(total)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Provider-reported limits */}
              <section className="rounded border border-border-primary bg-surface-secondary p-3">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Provider limits
                </h2>

                <LimitStatusBanners limits={report.rateLimits} />

                {report.rateLimits.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {report.rateLimits.map(limit => (
                      <li key={`${limit.provider}-${limit.limitId}-${limit.scope}`}>
                        <LimitBar limit={limit} />
                      </li>
                    ))}
                    <CreditsLine limits={report.rateLimits} />
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-text-muted">
                    No provider-reported limits available. Codex writes quota state
                    into its transcripts; Anthropic does not expose plan limits locally.
                  </p>
                )}
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="rounded border border-border-primary bg-surface-secondary p-3 lg:col-span-2">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By model
                </h2>
                <BarChart
                  data={modelBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage broken down by model"
                />

                <h2 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By project
                </h2>
                <BarChart
                  data={projectBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage broken down by working directory"
                />
              </section>

              <section className="rounded border border-border-primary bg-surface-secondary p-3">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  By provider
                </h2>
                <BarChart
                  data={providerBars}
                  formatValue={formatTokens}
                  ariaLabel="Token usage split between Anthropic and OpenAI"
                />

                <h2 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Token mix
                </h2>
                <DonutChart
                  slices={cacheSlices}
                  formatValue={formatTokens}
                  ariaLabel="Share of input, output and cache tokens"
                  centerLabel={formatTokens(report.totals.totalTokens)}
                  centerSublabel="tokens"
                />
              </section>
            </div>

            <section
              data-testid="usage-by-pane"
              className="rounded border border-border-primary bg-surface-secondary p-3"
            >
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                By pane
              </h2>
              {sortedPanes.length === 0 && report.byPane.unattributed.messageCount === 0 ? (
                <p className="text-xs text-text-muted">No pane usage in this range.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-border-primary">
                        {PANE_SORT_COLUMNS.map(column => (
                          <th
                            key={column.key}
                            aria-sort={paneSort.key === column.key
                              ? paneSort.direction === 'asc' ? 'ascending' : 'descending'
                              : 'none'}
                            className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-text-tertiary"
                          >
                            <button
                              type="button"
                              onClick={() => updatePaneSort(column.key)}
                              className="rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive"
                            >
                              {column.label}
                            </button>
                          </th>
                        ))}
                        <th className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                          Models
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedPanes.map(pane => (
                        <PaneUsageRow key={pane.paneId} pane={pane} />
                      ))}
                      {report.byPane.unattributed.messageCount > 0 && (
                        <tr
                          className="border-t border-border-primary text-text-muted"
                          title="Events outside any pane's lifetime or with no matching worktree"
                        >
                          <td className="px-2 py-2 font-medium">Unattributed</td>
                          <PaneCostCells pane={report.byPane.unattributed} />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-text-muted">
              <span>{report.index.eventsIndexed.toLocaleString()} messages indexed from {report.index.filesTracked.toLocaleString()} transcripts.</span>
              <span>Usage is checked every 4 hours; large scans may take longer. Refresh to check now.</span>
              <span>
                {report.index.lastScanFinishedMs === null
                  ? 'No completed scan yet.'
                  : `Last successful scan: ${new Date(report.index.lastScanFinishedMs).toLocaleString()}.`}
              </span>
              <span>Agents running inside WSL write their transcripts in the distro's home and are not counted.</span>
              {report.index.missingRoots.length > 0 && (
                <span>Not found: {report.index.missingRoots.join(', ')}</span>
              )}
              {report.index.lastError && (
                <span className="text-status-warning">Last scan error: {report.index.lastError}</span>
              )}
            </footer>
          </div>
        ) : null}

        {showWatermark && (
          <div
            className="pointer-events-none absolute bottom-4 right-4 flex items-center gap-1.5 rounded-full bg-bg-primary/60 px-2.5 py-1"
            aria-hidden="true"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="14" height="14" className="opacity-50">
              <rect x="0" y="0" width="512" height="512" rx="100" className="fill-text-primary" />
              <path d="M 147 121.954 C 143.054 123.309, 140.303 125.159, 137.265 128.502 C 129.560 136.978, 129.997 128.883, 130.022 262.432 C 130.043 375.632, 130.133 381.616, 131.848 383.845 C 133.623 386.152, 133.898 386.184, 148.576 385.826 C 161.682 385.505, 163.987 385.192, 167.500 383.253 C 172.495 380.496, 174.850 378.448, 178.137 374 C 183.395 366.885, 183.403 366.804, 184.049 315.500 C 184.381 289.100, 185.068 265.700, 185.576 263.500 C 187.005 257.312, 186.706 220.692, 185.202 217.852 C 183.612 214.846, 183.902 124.201, 185.500 125 C 186.050 125.275, 186.376 125.871, 186.225 126.324 C 186.074 126.778, 186.433 126.850, 187.024 126.485 C 188.357 125.661, 186.220 122.760, 184.662 123.279 C 184.092 123.469, 182.809 122.809, 181.813 121.813 C 179.125 119.125, 154.953 119.223, 147 121.954 M 198.861 121.917 L 196.500 123.834 196.834 146.167 C 197.140 166.677, 197.326 168.663, 199.111 170.500 C 201.002 172.445, 202.370 172.500, 248.778 172.500 C 295.868 172.500, 296.573 172.530, 302.021 174.736 C 305.058 175.966, 309.108 178.360, 311.021 180.055 C 312.935 181.750, 313.825 182.824, 313 182.442 C 312.175 182.060, 312.721 182.932, 314.213 184.380 C 318.108 188.159, 319.535 194.161, 318.147 200.922 C 316.740 207.771, 313.062 213.110, 307.125 216.920 C 298.119 222.699, 295.090 223, 246.012 223 C 207.294 223, 201.153 223.204, 199.223 224.557 C 197.035 226.089, 197.001 226.472, 197.032 248.807 C 197.056 266.352, 197.372 271.907, 198.423 273.292 C 199.705 274.983, 202.741 275.067, 251.641 274.763 C 301.926 274.451, 303.737 274.373, 311.301 272.194 C 315.592 270.957, 319.496 270.189, 319.976 270.485 C 320.457 270.782, 321.896 270.621, 323.175 270.126 C 325.061 269.397, 333.562 267.578, 339.704 266.590 C 340.367 266.483, 343.117 264.965, 345.816 263.216 C 353.494 258.241, 363.039 247.427, 367.658 238.472 C 371.442 231.135, 374.324 223.801, 372.277 226.717 C 371.739 227.483, 371.360 226.377, 371.255 223.732 C 371.163 221.420, 370.676 219.392, 370.174 219.225 C 369.659 219.053, 369.909 215.998, 370.749 212.210 C 372.706 203.381, 372.662 188.349, 370.651 179 C 365.496 155.029, 345.745 133.392, 321.275 124.907 C 309.060 120.672, 299.318 120.012, 248.861 120.006 C 203.392 120, 201.114 120.087, 198.861 121.917 M 362 301.367 C 354.852 303.458, 349.054 306.836, 343.346 312.234 C 334.291 320.798, 329.990 330.700, 330.012 342.932 C 330.044 360.480, 338.690 374.522, 354 381.890 C 360.967 385.244, 362.139 385.495, 370.500 385.427 C 377.755 385.368, 380.919 384.821, 386.819 382.605 C 391.196 380.962, 395.645 379.966, 397.885 380.128 C 402.844 380.486, 406.736 377.646, 411.916 369.888 C 415.736 364.167, 417.159 360.586, 418.426 353.500 L 418.962 350.500 417.869 353.638 C 416.856 356.544, 416.654 356.654, 415.138 355.138 C 413.824 353.824, 413.494 351.325, 413.468 342.500 C 413.442 333.542, 413.027 330.479, 411.233 326 C 407.185 315.900, 397.859 306.671, 387.803 302.814 C 381.169 300.270, 368.230 299.544, 362 301.367" className="fill-bg-primary" fillRule="evenodd"/>
            </svg>
            <span className="text-[10px] font-medium text-text-primary opacity-50">runpane.com</span>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
