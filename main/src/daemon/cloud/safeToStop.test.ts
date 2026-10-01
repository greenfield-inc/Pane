import { describe, expect, it, vi } from 'vitest';
import type { CloudDurableFlushResult, CloudSafeToStopRequest } from '../../../../shared/types/cloudDaemon';
import {
  DEFAULT_CLIENT_WINDOW_MS,
  DEFAULT_RECENT_OUTPUT_MS,
  parseSafeToStopRequest,
  runSafeToStop,
  WATCHER_GAP_GRACE_MS,
  type SafeToStopSources,
} from './safeToStop';

const NOW = 10_000_000;
const FLUSHED: CloudDurableFlushResult = {
  walCheckpoint: { busy: 0, log: 4, checkpointed: 4 },
  fsynced: ['/pane/sessions.db'],
  syncedFilesystem: true,
  durable: true,
  failures: [],
  durationMs: 12,
};

function idleSources(overrides: Partial<SafeToStopSources> = {}): SafeToStopSources {
  return {
    terminals: () => [{ panelId: 'claude-1', paneId: 'pane-1', agentState: 'idle', lastOutputAt: NOW - DEFAULT_RECENT_OUTPUT_MS }],
    runningCommands: () => [],
    locks: () => [],
    watchers: () => [{ channel: 'runpane:workspace:wait', inFlight: 0 }],
    pendingPrChecks: async () => [],
    userClients: () => [],
    ...overrides,
  };
}

async function check(sources: SafeToStopSources, request: CloudSafeToStopRequest = {}, flushed = FLUSHED) {
  const flush = vi.fn(async () => flushed);
  const result = await runSafeToStop({ sources, flush, version: '2.4.141', now: () => NOW }, request);
  return { result, flush };
}

describe('runSafeToStop', () => {
  it('flushes and answers safe when nothing blocks', async () => {
    const { result, flush } = await check(idleSources());

    expect(result).toEqual({
      ok: true,
      safe: true,
      checkedAt: new Date(NOW).toISOString(),
      version: '2.4.141',
      blockers: [],
      flush: FLUSHED,
      stopLease: null,
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['agent-working', { terminals: () => [{ panelId: 'claude-1', paneId: 'pane-1', agentState: 'working' as const }] }],
    ['command-running', {
      runningCommands: () => [{ panelId: 'claude-1', paneId: 'pane-1', kind: 'agent-shell' as const, command: 'bash pid 42' }],
    }],
    ['recent-terminal-output', { terminals: () => [{ panelId: 'shell-1', paneId: 'pane-1', lastOutputAt: NOW - 5_000 }] }],
    ['lock-held', { locks: () => [{ name: 'deploy', ownerLabel: 'worker', paneId: 'pane-1' }] }],
    ['watcher-active', { watchers: () => [{ channel: 'runpane:workspace:wait', inFlight: 1 }] }],
    ['pr-checks-pending', { pendingPrChecks: async () => [{ paneId: 'pane-1', prNumber: 42 }] }],
    ['user-client-attached', {
      userClients: () => [{ kind: 'events-stream' as const, clientId: 'desktop', label: 'MacBook', at: NOW }],
    }],
  ])('refuses without flushing while %s', async (condition, overrides) => {
    const { result, flush } = await check(idleSources(overrides));

    expect(result.safe).toBe(false);
    expect(result.flush).toBeNull();
    expect(result.blockers.map(blocker => blocker.condition)).toEqual([condition]);
    expect(flush).not.toHaveBeenCalled();
  });

  it('keeps a watch loop blocking between its calls, then lets it go', async () => {
    const between = await check(idleSources({
      watchers: () => [{ channel: 'runpane:workspace:wait', inFlight: 0, lastFinishedAt: NOW - 1_000 }],
    }));
    expect(between.result.blockers.map(blocker => blocker.condition)).toEqual(['watcher-active']);

    const gone = await check(idleSources({
      watchers: () => [{ channel: 'runpane:workspace:wait', inFlight: 0, lastFinishedAt: NOW - WATCHER_GAP_GRACE_MS }],
    }));
    expect(gone.result.safe).toBe(true);
  });

  it('asks for user clients active within the client window', async () => {
    const userClients = vi.fn(() => []);
    await check(idleSources({ userClients }));
    expect(userClients).toHaveBeenCalledWith(NOW - DEFAULT_CLIENT_WINDOW_MS);

    await check(idleSources({ userClients }), { clientWindowMs: 60_000 });
    expect(userClients).toHaveBeenLastCalledWith(NOW - 60_000);
  });

  it('flushes a blocked daemon when the stop was asked for anyway', async () => {
    const { result, flush } = await check(
      idleSources({ locks: () => [{ name: 'deploy' }] }),
      { flush: 'always' },
    );

    expect(result.safe).toBe(false);
    expect(result.flush).toEqual(FLUSHED);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('answers unsafe when the flush could not be made durable', async () => {
    const failed = { ...FLUSHED, syncedFilesystem: false, durable: false, failures: ['syncing the filesystem holding /pane failed'] };
    const { result } = await check(idleSources(), {}, failed);

    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual([
      { condition: 'flush-failed', message: 'State is not durable: syncing the filesystem holding /pane failed' },
    ]);
    expect(result.flush).toEqual(failed);
  });

  it('only checks when flush is never', async () => {
    const { result, flush } = await check(idleSources(), { flush: 'never' });

    expect(result.safe).toBe(true);
    expect(result.flush).toBeNull();
    expect(flush).not.toHaveBeenCalled();
  });

  it('reports every blocker at once, with where it is', async () => {
    const { result } = await check(idleSources({
      terminals: () => [{ panelId: 'claude-1', paneId: 'pane-1', agentState: 'working', lastOutputAt: NOW - 1_000 }],
      locks: () => [{ name: 'deploy', panelId: 'claude-1' }],
    }));

    expect(result.blockers).toEqual([
      { condition: 'agent-working', message: 'Agent in panel claude-1 is working', paneId: 'pane-1', panelId: 'claude-1' },
      { condition: 'recent-terminal-output', message: 'Panel claude-1 printed output 1s ago', paneId: 'pane-1', panelId: 'claude-1' },
      { condition: 'lock-held', message: 'Lock "deploy" is held', panelId: 'claude-1' },
    ]);
  });
});

describe('parseSafeToStopRequest', () => {
  it('fills defaults', () => {
    expect(parseSafeToStopRequest(undefined)).toEqual({
      flush: 'if-safe',
      recentOutputMs: DEFAULT_RECENT_OUTPUT_MS,
      clientWindowMs: DEFAULT_CLIENT_WINDOW_MS,
      stopLeaseMs: 0,
    });
  });

  it('rejects bad values', () => {
    expect(() => parseSafeToStopRequest({ flush: 'sometimes' })).toThrow();
    expect(() => parseSafeToStopRequest({ recentOutputMs: -1 })).toThrow('recentOutputMs must be a non-negative number');
  });
});
