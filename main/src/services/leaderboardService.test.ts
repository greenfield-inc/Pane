import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { LeaderboardService } from './leaderboardService';
import type { UsageReport, UsageReportRequest, UsageTotals } from '../../../shared/types/usage';
import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';

const mocks = {
  getReport: vi.fn(),
  getStatus: vi.fn(),
  invoke: vi.fn(),
};

function totals(tokens: number): UsageTotals {
  return {
    totalTokens: tokens, inputTokens: tokens - 2, outputTokens: 2,
    cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1,
    estimatedCostUsd: 1, costIncomplete: false, cacheSavingsUsd: 0,
  };
}

function report(tokens: number): Pick<UsageReport, 'totals' | 'byModel'> {
  return {
    totals: totals(tokens),
    byModel: [{ ...totals(tokens), model: 'gpt-5', provider: 'codex' }],
  };
}

describe('LeaderboardService usage source', () => {
  let configManager: ConfigManager;
  let service: LeaderboardService;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DO_NOT_TRACK', '0');
    configManager = new ConfigManager();
    vi.spyOn(configManager, 'getConfig').mockReturnValue({
      gitRepoPath: '', verbose: false,
      leaderboard: { optIn: true },
      analytics: { enabled: true, installId: 'windows-install', githubUsername: 'windows-user' },
    });
    vi.spyOn(configManager, 'updateConfig').mockResolvedValue(undefined);
    mocks.getReport.mockReturnValue(report(12));
    mocks.getStatus.mockReturnValue({ scanning: false });
    mocks.invoke.mockImplementation(async (channel: string) => ({
      success: true,
      data: channel === 'usage:get-report' ? report(1200) : { scanning: false },
    }));
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      rank: 1, displayName: '@windows-user', verified: true, total: 10, installs: 1,
    })));
    vi.stubGlobal('fetch', fetchMock);
    service = new LeaderboardService(configManager, { usage: mocks, runtime: mocks });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function submittedBody(): JsonObject {
    return decodeBoundary(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)), boundary.jsonObject);
  }

  it('submits remote totals with the GUI installation identity and a 30-day window', async () => {
    const before = Date.now();
    await service.submit();

    expect(mocks.invoke).toHaveBeenCalledWith('usage:get-report', [{
      fromMs: expect.any(Number), toMs: expect.any(Number),
    }], expect.any(Function));
    const request: UsageReportRequest = mocks.invoke.mock.calls[0]?.[1]?.[0];
    expect(request.toMs! - request.fromMs!).toBe(30 * 24 * 60 * 60 * 1000);
    expect(request.toMs).toBeGreaterThanOrEqual(before);
    expect(mocks.getReport).not.toHaveBeenCalled();
    expect(submittedBody()).toMatchObject({
      installId: 'windows-install', githubUsername: 'windows-user', totalTokens: 1200,
      windowDays: 30, byModel: [{ totalTokens: 1200, provider: 'codex' }],
    });
    expect(configManager.updateConfig).toHaveBeenCalledWith({ leaderboard: expect.objectContaining({
      lastRank: 1, lastDisplayName: '@windows-user',
    }) });
  });

  it('preserves local usage when the runtime router selects local mode', async () => {
    mocks.invoke.mockImplementation(async (_channel: string, _args: unknown[], invokeLocal: () => Promise<{ success: boolean; data: UsageReport }>) => invokeLocal());
    await service.submit();
    expect(mocks.getReport).toHaveBeenCalledOnce();
    expect(submittedBody()).toMatchObject({ totalTokens: 12 });
  });

  it('does not upload or fall back to GUI usage when the backend is disconnected', async () => {
    mocks.invoke.mockRejectedValue(new Error('Remote Pane client is not connected'));
    await expect(service.submit()).rejects.toThrow('Remote Pane client is not connected');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getReport).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, error: 'Failed to build remote usage report' },
    { success: true },
    { success: true, data: { totals: {}, byModel: [] } },
  ])('does not upload an unsuccessful or incomplete backend response: %j', async response => {
    mocks.invoke.mockResolvedValue(response);
    await expect(service.submit()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getReport).not.toHaveBeenCalled();
  });

  it('waits for the remote scan before the app-open submission', async () => {
    vi.useFakeTimers();
    let scanning = true;
    mocks.invoke.mockImplementation(async (channel: string) => ({
      success: true, data: channel === 'usage:get-report' ? report(1200) : { scanning },
    }));
    const submission = service.submitOnAppOpen();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    scanning = false;
    await vi.advanceTimersByTimeAsync(1000);
    await submission;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(submittedBody()).toMatchObject({ totalTokens: 1200 });
  });

  it('uses remote readiness even when the GUI scan is still running', async () => {
    vi.useFakeTimers();
    mocks.getStatus.mockReturnValue({ scanning: true });
    await service.submitOnAppOpen();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('skips the app-open submission if the remote scan exceeds the wait bound', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue({ success: true, data: { scanning: true } });
    const submission = service.submitOnAppOpen();
    await vi.advanceTimersByTimeAsync(16_000);
    await submission;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('handles a failed backend status request without an app-open upload', async () => {
    mocks.invoke.mockRejectedValue(new Error('Backend unavailable'));
    await expect(service.submitOnAppOpen()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it.each(['not opted in', 'DO_NOT_TRACK'])('does not read usage or submit when %s', async reason => {
    if (reason === 'DO_NOT_TRACK') {
      vi.stubEnv('DO_NOT_TRACK', '1');
      service = new LeaderboardService(configManager, { usage: mocks, runtime: mocks });
    } else {
      configManager.getConfig().leaderboard = { optIn: false };
    }
    await expect(service.submit()).rejects.toThrow();
    await service.submitOnAppOpen();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
