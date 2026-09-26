import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaderboardService } from './leaderboardService';
import { ConfigManager } from './configManager';
import { databaseService } from './database';

const isolation = vi.hoisted(() => {
  const previous = process.env.PANE_DIR;
  const directory = `${process.env.TMPDIR ?? '/tmp'}/pane-leaderboard-${process.pid}-${Date.now()}`;
  process.env.PANE_DIR = directory;
  return { previous, directory };
});

afterAll(async () => {
  databaseService.getDb().close();
  await rm(isolation.directory, { recursive: true, force: true });
  if (isolation.previous === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = isolation.previous;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('LeaderboardService', () => {
  it.skipIf(process.platform === 'win32')('does not launch a login shell at construction and waits for its opt-out before joining', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pane-leaderboard-shell-'));
    const shell = join(directory, 'bash');
    const started = join(directory, 'started');
    const release = join(directory, 'release');
    await writeFile(shell, '#!/bin/sh\ntouch "$PANE_TEST_SHELL_STARTED"\nwhile ! test -e "$PANE_TEST_SHELL_RELEASE"; do sleep 0.01; done\nprintf 1\n');
    await chmod(shell, 0o755);
    vi.stubEnv('SHELL', shell);
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('PANE_TEST_SHELL_STARTED', started);
    vi.stubEnv('PANE_TEST_SHELL_RELEASE', release);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    try {
      const config = new ConfigManager();
      const service = new LeaderboardService(config);
      expect(existsSync(started)).toBe(false);
      const joining = expect(service.join()).rejects.toThrow('DO_NOT_TRACK');
      const status = service.getStatus();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(config.getConfig().leaderboard?.optIn ?? false).toBe(false);
      expect(network).not.toHaveBeenCalled();
      await writeFile(release, '');
      await joining;
      expect(await status).toMatchObject({ doNotTrack: true, optIn: false });
      await rm(shell);
      expect(await service.getStatus()).toMatchObject({ doNotTrack: true });
      await config.updateConfig({ leaderboard: { optIn: true } });
      await expect(service.submit()).rejects.toThrow('DO_NOT_TRACK');
      await service.submitOnAppOpen();
      expect(network).not.toHaveBeenCalled();
    } finally {
      await writeFile(release, '');
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it('rejects malformed leaderboard rows before returning them to the UI', async () => {
    vi.stubEnv('DO_NOT_TRACK', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      windowDays: 30, total: 1, generatedAtMs: 123,
      entries: [{ rank: 1, displayName: 'Test', verified: false, estimatedCostUsd: 2,
        costIncomplete: false, outputTokens: 'bad', messageCount: 3, topModel: null,
        installs: 1, updatedAtMs: 123 }],
    }))));
    const service = new LeaderboardService(new ConfigManager());
    await expect(service.fetchLeaderboard()).rejects.toThrow('input.entries.0.outputTokens');
  });


  it('does not persist an invalid submission receipt', async () => {
    vi.stubEnv('DO_NOT_TRACK', '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rank: 'bad', displayName: 'Test', verified: false, total: 1, installs: 1,
    }))));
    const config = new ConfigManager();
    await config.updateConfig({
      analytics: { enabled: false, installId: 'synthetic-install' },
      leaderboard: { optIn: true, lastRank: 4, lastDisplayName: 'Previous' },
    });
    const service = new LeaderboardService(config);
    await expect(service.submit()).rejects.toThrow('input.rank');
    expect((await service.getStatus()).lastRank).toBe(4);
    expect((await service.getStatus()).lastDisplayName).toBe('Previous');
  });


  it('returns a valid leaderboard and persists a valid submission receipt', async () => {
    vi.stubEnv('DO_NOT_TRACK', 'false');
    const leaderboard = {
      windowDays: 30, total: 1, generatedAtMs: 123,
      entries: [{ rank: 1, displayName: 'Test', verified: false, estimatedCostUsd: 2,
        costIncomplete: false, outputTokens: 9, messageCount: 3, topModel: null,
        installs: 1, updatedAtMs: 123 }],
    };
    const receipt = { rank: 1, displayName: 'Test', verified: false, total: 1, installs: 1 };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(leaderboard)))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt))));
    const config = new ConfigManager();
    await config.updateConfig({ analytics: { enabled: false, installId: 'synthetic-install' } });
    const service = new LeaderboardService(config);
    expect(await service.fetchLeaderboard()).toEqual(leaderboard);
    expect(await service.join()).toEqual(receipt);
    expect(await service.getStatus()).toMatchObject({ optIn: true, doNotTrack: false, lastRank: 1, lastDisplayName: 'Test' });
  });


  it.skipIf(process.platform === 'win32')('honors the Windows Git Bash login opt-out when SHELL is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pane-leaderboard-gitbash-'));
    await mkdir(join(directory, 'bin'));
    const shell = join(directory, 'bin', 'bash.exe');
    await writeFile(shell, '#!/bin/sh\nprintf 1\n');
    await chmod(shell, 0o755);
    vi.stubEnv('GIT_INSTALL_ROOT', directory);
    vi.stubEnv('SHELL', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    const service = new LeaderboardService(new ConfigManager());
    // Exercise Windows discovery with a portable executable fixture; no Windows host is needed.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    try {
      expect(await service.getStatus()).toMatchObject({ doNotTrack: true });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

});
