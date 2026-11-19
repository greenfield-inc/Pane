import { describe, expect, it } from 'vitest';
import type { UsageAccount, UsageByModel, UsageRateLimitSample, UsageReport, UsageTotals } from '../../../../shared/types/usage';
import { accountUsage, mergeMachineReports, type MachineUsage } from './allMachinesUsage';

const totals = (totalTokens: number, inputTokens = 0): UsageTotals => ({
  inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens,
  messageCount: 1, estimatedCostUsd: 0, costIncomplete: false, cacheSavingsUsd: 0,
});
const model = (provider: UsageByModel['provider'], name: string, tokens: number): UsageByModel => ({ ...totals(tokens), provider, model: name });
const limit = (usedPercent: number, capturedAtMs: number): UsageRateLimitSample => ({
  provider: 'codex', limitId: 'codex', scope: 'primary', usedPercent, windowMinutes: 300, resetsAtMs: null, planType: 'pro',
  capturedAtMs, creditsHas: null, creditsBalance: null, creditsUnlimited: null, rateLimitReachedType: null, spendControlReached: null, limitName: null,
});

function machine(name: string, byModel: UsageByModel[], extra: { accounts?: UsageAccount[]; rateLimits?: UsageRateLimitSample[]; day?: number } = {}): MachineUsage {
  const sum = byModel.reduce((total, entry) => total + entry.totalTokens, 0);
  const report: UsageReport = {
    totals: totals(sum),
    series: [{ ...totals(sum), bucketStartMs: extra.day ?? 0 }],
    byModel,
    byProject: [{ ...totals(sum), path: `/${name}/repo`, label: 'repo' }],
    byPane: { panes: [], unattributed: { ...totals(0), uncachedCostUsd: 0, uncachedInputTokens: 0, cacheHitRate: 0, byModel: [] } },
    rateLimits: extra.rateLimits ?? [],
    accounts: extra.accounts,
    index: { lastScanStartedMs: null, lastScanFinishedMs: 5, filesTracked: 2, eventsIndexed: 3, missingRoots: [], scanning: false, filesScanned: 0, filesTotal: 0, lastError: null },
    pricingAsOf: 'test',
  };
  return { machineId: name, name, stale: false, report, readAt: 0 };
}

const work = { provider: 'codex' as const, key: 'ws-1:user-1', label: 'me@work.com', plan: 'pro' };
const personal = { provider: 'claude' as const, key: 'acc-1:org-1', label: 'me@home.com', plan: 'Max' };

describe('accountUsage', () => {
  it('shows a shared account once, names both machines, and keeps the newer limit reading', () => {
    const mac = machine('Mac', [model('codex', 'gpt-5', 100), model('claude', 'opus', 40)], { accounts: [work, personal], rateLimits: [limit(20, 1_000)] });
    const devbox = machine('devbox', [model('codex', 'gpt-5', 60)], { accounts: [work], rateLimits: [limit(35, 2_000)] });

    const accounts = accountUsage([mac, devbox]);

    expect(accounts).toEqual([
      { ...personal, machines: ['Mac'], tokens: 40, limits: [] },
      { ...work, machines: ['Mac', 'devbox'], tokens: 160, limits: [limit(35, 2_000)] },
    ]);
  });

  it('keeps a Pane that does not report accounts separate, named for its machine', () => {
    const old = machine('devbox', [model('codex', 'gpt-5', 60)]);
    expect(accountUsage([old])).toEqual([
      { provider: 'codex', key: 'unreported:devbox:codex', label: 'Account not reported by devbox', plan: null, machines: ['devbox'], tokens: 60, limits: [] },
    ]);
  });
});

describe('mergeMachineReports', () => {
  it('adds machines up and names each project with its machine', () => {
    const mac = machine('Mac', [model('codex', 'gpt-5', 100)], { accounts: [work], rateLimits: [limit(20, 1_000)] });
    const devbox = machine('devbox', [model('codex', 'gpt-5', 60), model('claude', 'opus', 10)], { accounts: [work], rateLimits: [limit(35, 2_000)], day: 86_400_000 });

    const merged = mergeMachineReports([mac, devbox]);

    expect(merged?.totals.totalTokens).toBe(170);
    expect(merged?.byModel.map(entry => [entry.model, entry.totalTokens])).toEqual([['gpt-5', 160], ['opus', 10]]);
    expect(merged?.series.map(bucket => [bucket.bucketStartMs, bucket.totalTokens])).toEqual([[0, 100], [86_400_000, 70]]);
    expect(merged?.byProject.map(project => project.label)).toEqual(['repo · Mac', 'repo · devbox']);
    expect(merged?.rateLimits).toEqual([limit(35, 2_000)]);
    expect(merged?.index.eventsIndexed).toBe(6);
  });

  it('shows one machine as its own report, with nothing renamed', () => {
    const merged = mergeMachineReports([machine('Mac', [model('codex', 'gpt-5', 100)])]);
    expect(merged?.byProject.map(project => project.label)).toEqual(['repo']);
    expect(mergeMachineReports([])).toBeNull();
  });
});
