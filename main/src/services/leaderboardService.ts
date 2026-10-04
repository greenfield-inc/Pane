import { app } from 'electron';
import { execFileSync } from 'child_process';
import * as os from 'os';
import { usageManager } from './usage/usageManager';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { ShellDetector } from '../utils/shellDetector';
import type { ConfigManager } from './configManager';
import type { AnalyticsIdentity } from '../types/config';
import type {
  LeaderboardSubmission,
  LeaderboardSubmitResult,
  LeaderboardResponse,
  LeaderboardStatus,
} from '../../../shared/types/leaderboard';
import { usageProviderFrom, type UsageReport, type UsageReportRequest, type UsageTotals } from '../../../shared/types/usage';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

const LEADERBOARD_API_BASE =
  process.env.PANE_LEADERBOARD_URL || 'https://runpane.com';
const SUBMIT_TIMEOUT_MS = 10_000;
const SCAN_WAIT_MS = 15_000;

const usageTotalsFields = {
  totalTokens: boundary.number,
  inputTokens: boundary.number,
  outputTokens: boundary.number,
  cacheReadTokens: boundary.number,
  cacheCreationTokens: boundary.number,
  messageCount: boundary.number,
  // Absent from backends that predate unmetered (Cursor) messages.
  unmeteredMessageCount: boundary.optional(boundary.number),
  estimatedCostUsd: boundary.number,
  costIncomplete: boundary.boolean,
  cacheSavingsUsd: boundary.number,
};
// Decode only the aggregate fields used in the submission, excluding paths and transcripts.
const usageReportSchema = boundary.object({
  totals: boundary.object(usageTotalsFields),
  byModel: boundary.array(boundary.object({
    ...usageTotalsFields,
    model: boundary.string,
    // A newer backend may report a provider this version does not know; that row is skipped.
    provider: boundary.string,
  })),
});
const usageStatusSchema = boundary.object({ scanning: boundary.boolean });
const usageResponseSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.json),
  error: boundary.optional(boundary.string),
});

type UsageResponse = ReturnType<typeof usageResponseSchema.decode>;

function readUsageResponse<Value>(result: UsageResponse, schema: BoundarySchema<Value>): Value {
  if (!result.success || result.data === undefined) {
    throw new Error(result.error || 'Failed to read usage from the selected runtime');
  }
  return decodeBoundary(result.data, schema);
}

function resolveDoNotTrack(): boolean {
  let value = process.env.DO_NOT_TRACK;

  if (value === undefined || value === '') {
    try {
      const shell = ShellDetector.getDefaultShell().path;
      const output = execFileSync(shell, ['-l', '-c', 'echo $DO_NOT_TRACK'], {
        encoding: 'utf8',
        timeout: 5000,
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (output) value = output;
    } catch {
      // Shell probe failed — treat as unset
    }
  }

  if (value === undefined || value === '') return false;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return true;
}

function withUnmeteredCount(totals: Omit<UsageTotals, 'unmeteredMessageCount'> & { unmeteredMessageCount?: number }): UsageTotals {
  return { ...totals, unmeteredMessageCount: totals.unmeteredMessageCount ?? 0 };
}

function sumTotals(rows: UsageTotals[]): UsageTotals {
  return rows.reduce<UsageTotals>((sum, row) => ({
    inputTokens: sum.inputTokens + row.inputTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    cacheCreationTokens: sum.cacheCreationTokens + row.cacheCreationTokens,
    totalTokens: sum.totalTokens + row.totalTokens,
    messageCount: sum.messageCount + row.messageCount,
    unmeteredMessageCount: sum.unmeteredMessageCount + row.unmeteredMessageCount,
    estimatedCostUsd: sum.estimatedCostUsd + row.estimatedCostUsd,
    costIncomplete: sum.costIncomplete || row.costIncomplete,
    cacheSavingsUsd: sum.cacheSavingsUsd + row.cacheSavingsUsd,
  }), {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
    messageCount: 0, unmeteredMessageCount: 0, estimatedCostUsd: 0, costIncomplete: false, cacheSavingsUsd: 0,
  });
}

const MAX_SUBMITTED_MODELS = 50;

/**
 * The model rows that fit the server's limit, largest first. Cursor rows have
 * no tokens and would sort last, so they are kept ahead of the cut: the totals
 * count their messages, and the rows must too.
 */
function submittedModelRows<Row extends Pick<UsageTotals, 'messageCount' | 'unmeteredMessageCount'>>(rows: Row[]): Row[] {
  const unmetered = rows.filter(row => row.unmeteredMessageCount > 0);
  const metered = rows.filter(row => row.unmeteredMessageCount === 0);
  return [...metered.slice(0, Math.max(0, MAX_SUBMITTED_MODELS - unmetered.length)), ...unmetered]
    .slice(0, MAX_SUBMITTED_MODELS);
}

function buildSubmission(
  report: Pick<UsageReport, 'totals' | 'byModel'>,
  identity: AnalyticsIdentity,
  paneVersion: string,
): LeaderboardSubmission {
  return {
    installId: identity.installId!,
    githubUsername: identity.githubUsername || undefined,
    gitEmailHash: identity.gitEmailHash || undefined,
    totalTokens: report.totals.totalTokens,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    cacheReadTokens: report.totals.cacheReadTokens,
    cacheCreationTokens: report.totals.cacheCreationTokens,
    messageCount: report.totals.messageCount,
    estimatedCostUsd: report.totals.estimatedCostUsd,
    costIncomplete: report.totals.costIncomplete,
    cacheSavingsUsd: report.totals.cacheSavingsUsd,
    byModel: submittedModelRows(report.byModel).map(m => ({
      model: m.model,
      provider: m.provider,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      totalTokens: m.totalTokens,
      messageCount: m.messageCount,
      estimatedCostUsd: m.estimatedCostUsd,
      costIncomplete: m.costIncomplete,
    })),
    windowDays: 30,
    submittedAtMs: Date.now(),
    paneVersion,
  };
}

export class LeaderboardService {
  private doNotTrack: boolean;

  constructor(private configManager: ConfigManager, private readonly dependencies: {
    usage?: Pick<typeof usageManager, 'getReport' | 'getStatus'>;
    runtime?: Pick<typeof remotePaneClientController, 'invoke'>;
  } = {}) {
    this.doNotTrack = resolveDoNotTrack();
  }

  private async getUsageReport(request: UsageReportRequest): Promise<Pick<UsageReport, 'totals' | 'byModel'>> {
    const response = await (this.dependencies.runtime ?? remotePaneClientController).invoke('usage:get-report', [request], async () => ({
      success: true, data: (this.dependencies.usage ?? usageManager).getReport(request),
    }));
    const report = readUsageResponse(decodeBoundary(response, usageResponseSchema), usageReportSchema);
    const byModel = report.byModel.flatMap(row => {
      const provider = usageProviderFrom(row.provider);
      return provider ? [{ ...withUnmeteredCount(row), model: row.model, provider }] : [];
    });
    // The report's totals fold every row, so once a row is skipped they are rebuilt from the rest.
    const totals = byModel.length === report.byModel.length ? withUnmeteredCount(report.totals) : sumTotals(byModel);
    return { totals, byModel };
  }

  private async getUsageStatus(): Promise<{ scanning: boolean }> {
    const response = await (this.dependencies.runtime ?? remotePaneClientController).invoke('usage:get-status', [], async () => ({
      success: true, data: (this.dependencies.usage ?? usageManager).getStatus(),
    }));
    return readUsageResponse(decodeBoundary(response, usageResponseSchema), usageStatusSchema);
  }

  private async post(submission: LeaderboardSubmission): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      return await fetch(`${LEADERBOARD_API_BASE}/api/runpane/leaderboard/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  getStatus(): LeaderboardStatus {
    const config = this.configManager.getConfig().leaderboard;
    return {
      optIn: config?.optIn ?? false,
      lastRank: config?.lastRank ?? null,
      lastDisplayName: config?.lastDisplayName ?? null,
      lastSubmittedAtMs: config?.lastSubmittedAtMs ?? null,
      doNotTrack: this.doNotTrack,
    };
  }

  async join(): Promise<LeaderboardSubmitResult> {
    if (this.doNotTrack) {
      throw new Error('DO_NOT_TRACK is set — leaderboard submissions are blocked');
    }

    await this.configManager.updateConfig({
      leaderboard: {
        ...this.configManager.getConfig().leaderboard,
        optIn: true,
        joinedAtMs: Date.now(),
      },
    });

    return this.submit();
  }

  async leave(): Promise<void> {
    const config = this.configManager.getConfig();
    const installId = config.analytics?.installId;

    if (installId) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
        await fetch(`${LEADERBOARD_API_BASE}/api/runpane/leaderboard/submit`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ installId }),
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (error) {
        console.warn('[Leaderboard] DELETE failed (row will expire):', error);
      }
    }

    await this.configManager.updateConfig({
      leaderboard: {
        optIn: false,
      },
    });
  }

  async submit(): Promise<LeaderboardSubmitResult> {
    if (this.doNotTrack) {
      throw new Error('DO_NOT_TRACK is set — leaderboard submissions are blocked');
    }

    const config = this.configManager.getConfig();
    if (!config.leaderboard?.optIn) {
      throw new Error('Not opted in to the leaderboard');
    }

    const analytics = config.analytics;
    if (!analytics?.installId) {
      throw new Error('No install ID available');
    }

    const identity: AnalyticsIdentity = {
      distinctId: analytics.distinctId || '',
      identitySource: analytics.identitySource || 'anonymous',
      installId: analytics.installId,
      githubUsername: analytics.githubUsername,
      gitEmail: analytics.gitEmail,
      gitEmailHash: analytics.gitEmailHash,
    };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const toMs = Date.now();
    const report = await this.getUsageReport({
      fromMs: toMs - 30 * DAY_MS,
      toMs,
    });

    let response = await this.post(buildSubmission(report, identity, app.getVersion()));
    // Read once: the body says why a submission was rejected.
    let rejection = response.ok ? '' : await response.text().catch(() => '');
    if (response.status === 400 && rejection.includes('byModel') && report.byModel.some(row => row.provider === 'cursor')) {
      // A server that predates Cursor rejects the whole submission over its
      // model rows. Send the rest once more, so Claude and Codex keep updating
      // until it is deployed.
      const withoutCursor = report.byModel.filter(row => row.provider !== 'cursor');
      console.warn('[Leaderboard] Server rejected Cursor usage; resubmitting without it.');
      response = await this.post(buildSubmission({ totals: sumTotals(withoutCursor), byModel: withoutCursor }, identity, app.getVersion()));
      rejection = response.ok ? '' : await response.text().catch(() => '');
    }

    if (!response.ok) {
      throw new Error(`Leaderboard submit failed (${response.status}): ${rejection}`);
    }

    const result: LeaderboardSubmitResult = await response.json();

    await this.configManager.updateConfig({
      leaderboard: {
        ...config.leaderboard,
        lastSubmittedAtMs: Date.now(),
        lastRank: result.rank,
        lastDisplayName: result.displayName,
      },
    });

    return result;
  }

  async fetchLeaderboard(): Promise<LeaderboardResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    const response = await fetch(
      `${LEADERBOARD_API_BASE}/api/runpane/leaderboard`,
      { signal: controller.signal },
    );
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Failed to fetch leaderboard (${response.status})`);
    }

    return response.json();
  }

  async submitOnAppOpen(): Promise<void> {
    if (this.doNotTrack) return;
    if (!this.configManager.getConfig().leaderboard?.optIn) return;

    try {
      let status = await this.getUsageStatus();
      const started = Date.now();
      while (status.scanning && Date.now() - started < SCAN_WAIT_MS) {
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        status = await this.getUsageStatus();
      }

      if (status.scanning) {
        console.log('[Leaderboard] Scan still running after wait bound — skipping app-open submission');
        return;
      }

      await this.submit();
      console.log('[Leaderboard] App-open submission succeeded');
    } catch (error) {
      console.warn('[Leaderboard] App-open submission failed:', error);
    }
  }
}
