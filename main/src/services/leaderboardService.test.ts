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
    cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 1, unmeteredMessageCount: 0,
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

  it('sends Cursor rows as unmetered message counts with an incomplete cost', async () => {
    const cursor: UsageTotals = {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      messageCount: 7, unmeteredMessageCount: 7, estimatedCostUsd: 0, costIncomplete: true, cacheSavingsUsd: 0,
    };
    mocks.invoke.mockResolvedValue({
      success: true,
      data: {
        totals: { ...totals(1200), messageCount: 8, unmeteredMessageCount: 7, costIncomplete: true },
        byModel: [
          { ...totals(1200), model: 'gpt-5', provider: 'codex' },
          { ...cursor, model: 'cursor', provider: 'cursor' },
        ],
      },
    });

    await service.submit();

    expect(submittedBody()).toMatchObject({
      totalTokens: 1200,
      messageCount: 8,
      costIncomplete: true,
      byModel: [
        { provider: 'codex', costIncomplete: false },
        {
          provider: 'cursor', model: 'cursor', totalTokens: 0, inputTokens: 0, estimatedCostUsd: 0,
          messageCount: 7, costIncomplete: true,
        },
      ],
    });
  });

  it('submits a report from an older backend and skips providers this version does not know', async () => {
    const { unmeteredMessageCount: _omitted, ...olderTotals } = totals(1200);
    mocks.invoke.mockResolvedValue({
      success: true,
      data: {
        totals: olderTotals,
        byModel: [
          { ...olderTotals, model: 'gpt-5', provider: 'codex' },
          { ...olderTotals, model: 'gemini-3-pro', provider: 'gemini' },
        ],
      },
    });

    await service.submit();

    expect(submittedBody()).toMatchObject({ totalTokens: 1200, byModel: [{ provider: 'codex' }] });
    expect(submittedBody().byModel).toHaveLength(1);
  });

  it('leaves a skipped provider out of the submitted totals too', async () => {
    mocks.invoke.mockResolvedValue({
      success: true,
      data: {
        totals: { ...totals(1700), messageCount: 2, estimatedCostUsd: 3, costIncomplete: true },
        byModel: [
          { ...totals(1200), model: 'gpt-5', provider: 'codex' },
          { ...totals(500), model: 'gemini-3-pro', provider: 'gemini', estimatedCostUsd: 2, costIncomplete: true },
        ],
      },
    });

    await service.submit();

    expect(submittedBody()).toMatchObject({
      totalTokens: 1200,
      inputTokens: 1198,
      messageCount: 1,
      estimatedCostUsd: 1,
      costIncomplete: false,
    });
  });

  const cursorRow = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    messageCount: 7, unmeteredMessageCount: 7, estimatedCostUsd: 0, costIncomplete: true, cacheSavingsUsd: 0,
    model: 'cursor', provider: 'cursor',
  };

  function submittedBodyAt(call: number): JsonObject {
    return decodeBoundary(JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body)), boundary.jsonObject);
  }

  it('resends without Cursor rows when a server that predates Cursor rejects them', async () => {
    mocks.invoke.mockResolvedValue({
      success: true,
      data: {
        totals: { ...totals(1200), messageCount: 8, unmeteredMessageCount: 7, costIncomplete: true },
        byModel: [{ ...totals(1200), model: 'gpt-5', provider: 'codex' }, cursorRow],
      },
    });
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"invalid byModel entry"}', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rank: 2, displayName: '@windows-user', verified: true, total: 10, installs: 1 })));

    await expect(service.submit()).resolves.toMatchObject({ rank: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submittedBodyAt(1)).toMatchObject({ totalTokens: 1200, messageCount: 1, costIncomplete: false, byModel: [{ provider: 'codex' }] });
    expect(submittedBodyAt(1).byModel).toHaveLength(1);
  });

  it('does not resend when the server rejects a Cursor submission for another reason', async () => {
    mocks.invoke.mockResolvedValue({
      success: true,
      data: {
        totals: { ...totals(1200), messageCount: 8, unmeteredMessageCount: 7, costIncomplete: true },
        byModel: [{ ...totals(1200), model: 'gpt-5', provider: 'codex' }, cursorRow],
      },
    });
    fetchMock.mockResolvedValue(new Response('{"error":"invalid paneVersion"}', { status: 400 }));

    await expect(service.submit()).rejects.toThrow('Leaderboard submit failed (400): {"error":"invalid paneVersion"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not resend a rejected submission that has no Cursor rows', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"invalid paneVersion"}', { status: 400 }));

    await expect(service.submit()).rejects.toThrow('Leaderboard submit failed (400)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Cursor rows when trimming the model list to the server limit', async () => {
    const metered = Array.from({ length: 60 }, (_, index) => ({ ...totals(1000 - index), model: `gpt-${index}`, provider: 'codex' }));
    mocks.invoke.mockResolvedValue({
      success: true,
      data: { totals: { ...totals(60_000), messageCount: 67, unmeteredMessageCount: 7, costIncomplete: true }, byModel: [...metered, cursorRow] },
    });

    await service.submit();

    const byModel = decodeBoundary(submittedBody().byModel, boundary.array(boundary.jsonObject));
    expect(byModel).toHaveLength(50);
    expect(byModel.filter(row => row.provider === 'cursor')).toHaveLength(1);
  });

  it('reports a rejected submission with the server status and reason', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"invalid byModel entry"}', { status: 400 }));

    await expect(service.submit()).rejects.toThrow('Leaderboard submit failed (400): {"error":"invalid byModel entry"}');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
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
