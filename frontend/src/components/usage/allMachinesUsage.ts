import type {
  UsageAccount,
  UsageByModel,
  UsageBucket,
  UsagePaneCostSlice,
  UsageProvider,
  UsageRateLimitSample,
  UsageReport,
  UsageTotals,
} from '../../../../shared/types/usage';

/** One machine's latest usage report, as Usage & Limits read it. */
export interface MachineUsage {
  machineId: string;
  name: string;
  /** The report is the last one read: the machine is offline or did not answer this time. */
  stale: boolean;
  report: UsageReport;
  readAt: number;
}

/** An account and the machines signed in to it, counted once. */
export interface AccountUsage {
  provider: UsageProvider;
  key: string;
  label: string;
  plan: string | null;
  /** Names of the machines using it, in machine order. */
  machines: string[];
  /** Tokens its machines used in the range, each machine's events counted once. */
  tokens: number;
  /** The newest sample of each limit any of its machines reported. */
  limits: UsageRateLimitSample[];
}

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
  messageCount: 0, estimatedCostUsd: 0, costIncomplete: false, cacheSavingsUsd: 0,
};

function addTotals<T extends UsageTotals>(into: T, add: UsageTotals): T {
  return {
    ...into,
    inputTokens: into.inputTokens + add.inputTokens,
    outputTokens: into.outputTokens + add.outputTokens,
    cacheReadTokens: into.cacheReadTokens + add.cacheReadTokens,
    cacheCreationTokens: into.cacheCreationTokens + add.cacheCreationTokens,
    totalTokens: into.totalTokens + add.totalTokens,
    messageCount: into.messageCount + add.messageCount,
    estimatedCostUsd: into.estimatedCostUsd + add.estimatedCostUsd,
    costIncomplete: into.costIncomplete || add.costIncomplete,
    cacheSavingsUsd: into.cacheSavingsUsd + add.cacheSavingsUsd,
  };
}

function mergeModels(lists: UsageByModel[][]): UsageByModel[] {
  const merged = new Map<string, UsageByModel>();
  for (const entry of lists.flat()) {
    const key = `${entry.provider}\n${entry.model}`;
    const current = merged.get(key);
    merged.set(key, current ? addTotals(current, entry) : entry);
  }
  return [...merged.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function mergeSlices(slices: UsagePaneCostSlice[]): UsagePaneCostSlice {
  const totals = slices.reduce<UsageTotals>((sum, slice) => addTotals(sum, slice), ZERO_TOTALS);
  const uncachedInputTokens = slices.reduce((sum, slice) => sum + slice.uncachedInputTokens, 0);
  const readable = totals.inputTokens + totals.cacheReadTokens;
  return {
    ...totals,
    uncachedCostUsd: slices.reduce((sum, slice) => sum + slice.uncachedCostUsd, 0),
    uncachedInputTokens,
    cacheHitRate: readable > 0 ? totals.cacheReadTokens / readable : 0,
    byModel: mergeModels(slices.map(slice => slice.byModel)),
  };
}

/**
 * A machine's accounts. A provider it has usage or limits for but no account it can name (not
 * signed in through the CLI, or a Pane from before accounts) gets one row of its own, so its
 * usage and limits still show.
 */
function accountsOf(usage: MachineUsage): UsageAccount[] {
  const named = usage.report.accounts ?? [];
  const used = new Set([...usage.report.byModel, ...usage.report.rateLimits].map(entry => entry.provider));
  const unnamed = [...used].filter(provider => !named.some(account => account.provider === provider)).map(provider => ({
    provider,
    key: `unidentified:${usage.machineId}:${provider}`,
    label: `Account not identified on ${usage.name}`,
    plan: usage.report.rateLimits.find(limit => limit.provider === provider && limit.planType)?.planType ?? null,
  }));
  return [...named, ...unnamed];
}

/**
 * Each account once, with the machines signed in to it. Usage adds up across its machines,
 * because each machine reads only its own transcripts; limits belong to the account, so two
 * machines reporting the same limit show only the newer reading.
 */
export function accountUsage(machines: MachineUsage[]): AccountUsage[] {
  const accounts = new Map<string, AccountUsage>();
  for (const usage of machines) {
    for (const account of accountsOf(usage)) {
      const id = `${account.provider}\n${account.key}`;
      const entry = accounts.get(id) ?? { ...account, machines: [], tokens: 0, limits: [] };
      if (!entry.machines.includes(usage.name)) entry.machines.push(usage.name);
      entry.tokens += usage.report.byModel.filter(model => model.provider === account.provider).reduce((sum, model) => sum + model.totalTokens, 0);
      for (const sample of usage.report.rateLimits.filter(limit => limit.provider === account.provider)) {
        const same = entry.limits.findIndex(limit => limit.limitId === sample.limitId && limit.scope === sample.scope);
        if (same === -1) entry.limits.push(sample);
        else if (sample.capturedAtMs > entry.limits[same].capturedAtMs) entry.limits[same] = sample;
      }
      accounts.set(id, entry);
    }
  }
  return [...accounts.values()].sort((a, b) => a.provider.localeCompare(b.provider) || b.tokens - a.tokens);
}

/**
 * Every machine's report as one: tokens, charts and tables add up, projects and Panes are
 * named with their machine, and limits come once per account.
 */
export function mergeMachineReports(machines: MachineUsage[]): UsageReport | null {
  if (machines.length === 0) return null;
  const several = machines.length > 1;
  const named = (label: string, name: string) => (several ? `${label} · ${name}` : label);
  const reports = machines.map(usage => usage.report);

  const buckets = new Map<number, UsageBucket>();
  for (const bucket of reports.flatMap(report => report.series)) {
    const current = buckets.get(bucket.bucketStartMs);
    buckets.set(bucket.bucketStartMs, current ? addTotals(current, bucket) : bucket);
  }

  const index = reports.map(report => report.index);
  const finished = index.map(item => item.lastScanFinishedMs).filter((value): value is number => value !== null);
  return {
    totals: reports.reduce<UsageTotals>((sum, report) => addTotals(sum, report.totals), ZERO_TOTALS),
    series: [...buckets.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    byModel: mergeModels(reports.map(report => report.byModel)),
    byProject: machines
      .flatMap(usage => usage.report.byProject.map(project => ({ ...project, label: named(project.label, usage.name) })))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byPane: {
      panes: machines.flatMap(usage => usage.report.byPane.panes.map(pane => ({
        ...pane, paneId: `${usage.machineId}\n${pane.paneId}`, paneName: named(pane.paneName, usage.name),
      }))),
      unattributed: mergeSlices(reports.map(report => report.byPane.unattributed)),
    },
    rateLimits: accountUsage(machines).flatMap(account => account.limits),
    accounts: undefined,
    index: {
      // The oldest machine's last scan: every number on screen is at least this fresh.
      lastScanStartedMs: null,
      lastScanFinishedMs: finished.length === index.length ? Math.min(...finished) : null,
      filesTracked: index.reduce((sum, item) => sum + item.filesTracked, 0),
      eventsIndexed: index.reduce((sum, item) => sum + item.eventsIndexed, 0),
      missingRoots: [],
      scanning: index.some(item => item.scanning),
      filesScanned: index.reduce((sum, item) => sum + item.filesScanned, 0),
      filesTotal: index.reduce((sum, item) => sum + item.filesTotal, 0),
      lastError: machines.map(usage => usage.report.index.lastError && `${usage.name}: ${usage.report.index.lastError}`).find(Boolean) ?? null,
    },
    pricingAsOf: reports[0].pricingAsOf,
  };
}
