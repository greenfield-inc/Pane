import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageSnapshotCard } from './HomeUsageCard';
import type { UsageByModel, UsageIndexStatus, UsageReport, UsageTotals } from '../../../shared/types/usage';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&lt;/g, '<');

function totals(totalTokens: number, extra: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens, messageCount: 0, estimatedCostUsd: 0, costIncomplete: false, cacheSavingsUsd: 0,
    ...extra,
  };
}

const index: UsageIndexStatus = {
  lastScanStartedMs: 1, lastScanFinishedMs: 2, filesTracked: 40, eventsIndexed: 6418, missingRoots: [],
  scanning: false, filesScanned: 0, filesTotal: 0, lastError: null,
};

function model(name: string, tokens: number): UsageByModel {
  return { ...totals(tokens), model: name, provider: 'claude' };
}

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    totals: totals(48_200_000, { messageCount: 6418, estimatedCostUsd: 312.4 }),
    series: [],
    byModel: [model('opus-5-5', 24_100_000), model('gpt-6.1', 14_460_000), model('sonnet-5-5', 7_230_000), model('haiku-5-5', 2_410_000)],
    byProject: [
      { ...totals(19_800_000), path: '/code/acme-web', label: 'acme-web' },
      { ...totals(13_000_000), path: '/code/billing-api', label: 'billing-api' },
      { ...totals(8_700_000), path: '/code/mobile-app', label: 'mobile-app' },
      { ...totals(1_000_000), path: '/code/docs', label: 'docs' },
    ],
    byPane: { panes: [], unattributed: { ...totals(0), uncachedCostUsd: 0, uncachedInputTokens: 0, cacheHitRate: 0, byModel: [] } },
    rateLimits: [],
    index,
    pricingAsOf: 'OpenRouter · 2026-11-01',
    ...overrides,
  };
}

const render = (value: UsageReport | null, failed = false, extra: { status?: UsageIndexStatus; host?: string } = {}) =>
  renderToStaticMarkup(<UsageSnapshotCard report={value} failed={failed} {...extra} />);

describe('UsageSnapshotCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 13, 15, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('shows the total, estimated cost and message count over the top three projects', () => {
    const markup = text(render(report()));
    expect(markup).toContain('48.2Mtokens · $312.40 est. at API rates · 6,418 messages');
    expect(markup).toContain('acme-web19.8M');
    expect(markup).toContain('billing-api13.0M');
    expect(markup).toContain('mobile-app8.7M');
    expect(markup).not.toContain('docs');
    expect(markup).toContain('Join the leaderboard');
  });

  it('folds models past the second into Other', () => {
    const markup = text(render(report()));
    expect(markup).toContain('opus-5-550%');
    expect(markup).toContain('gpt-6.130%');
    expect(markup).toContain('Other20%');
    expect(markup).not.toContain('sonnet-5-5');
  });

  it('says n/a when a model has no price', () => {
    const markup = text(render(report({ totals: totals(1_500, { messageCount: 3, costIncomplete: true }) })));
    expect(markup).toContain('1.5Ktokens · cost n/a · 3 messages');
  });

  it("charts each day bucket of Usage & Limits' rolling 30 days, today included", () => {
    const today = Date.UTC(2026, 10, 13);
    const markup = render(report({ series: [{ ...totals(1_200_000), bucketStartMs: today }] }));
    expect(markup).toContain('<title>Nov 13: 1.2M tokens</title>');
    const chart = /<svg[^>]*aria-label="Tokens per day"[\s\S]*?<\/svg>/.exec(markup)?.[0] ?? '';
    // 30 days back from mid-afternoon reaches into a 31st calendar day.
    expect(chart.match(/<rect /g)).toHaveLength(31);
  });

  it('shows a model under 1% as <1%', () => {
    const markup = text(render(report({ byModel: [model('opus-5-5', 48_000_000), model('haiku-5-5', 200_000)] })));
    expect(markup).toContain('haiku-5-5<1%');
  });

  it('names the host when the window shows another machine', () => {
    const markup = text(render(report(), false, { host: 'devbox' }));
    expect(markup).toContain('Claude Code and Codex on devbox · last 30 days');
    expect(markup).toContain('Read from files on devbox.');
    expect(markup).not.toContain('this computer');
  });

  it('shows scan progress until the first pass over the transcripts finishes', () => {
    const scanning = report({
      totals: totals(0),
      index: { ...index, lastScanFinishedMs: null, scanning: true, filesScanned: 312, filesTotal: 1204 },
    });
    const markup = text(render(scanning));
    expect(markup).toContain('Reading 312 of 1,204 transcript files…');
    expect(markup).not.toContain('No Claude Code or Codex history');
    expect(text(render(null))).toContain('Reading transcript files…');
  });

  it('keeps showing scan progress while a scan is still adding to the numbers', () => {
    const markup = text(render(report({ index: { ...index, lastScanFinishedMs: null, scanning: true, filesScanned: 40, filesTotal: 90 } })));
    expect(markup).toContain('48.2M');
    expect(markup).toContain('Reading 40 of 90 transcript files…');
    expect(markup).not.toContain('Join the leaderboard');
  });

  it('says there is no history once a finished pass found none', () => {
    const markup = text(render(report({ totals: totals(0), byModel: [], byProject: [] })));
    expect(markup).toContain('No Claude Code or Codex history on this computer yet');
    expect(markup).not.toContain('Join the leaderboard');
  });

  it('takes scan progress from the latest status read', () => {
    const before = report({ totals: totals(0), index: { ...index, lastScanFinishedMs: null, lastScanStartedMs: null } });
    const markup = text(render(before, false, { status: { ...index, lastScanFinishedMs: null, scanning: true, filesScanned: 5, filesTotal: 9 } }));
    expect(markup).toContain('Reading 5 of 9 transcript files…');
  });

  it('says the history could not be read when a finished pass ended with an error', () => {
    const errored = report({ totals: totals(0), index: { ...index, lastScanFinishedMs: null, scanning: false, lastError: 'EACCES' } });
    const markup = text(render(errored));
    expect(markup).toContain("Pane couldn't read your agent history");
    expect(markup).not.toContain('Reading transcript files');
  });

  it('says the history could not be read when the report fails', () => {
    expect(text(render(null, true))).toContain("Pane couldn't read your agent history");
  });
});
