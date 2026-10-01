import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushDurableState } from './durableFlush';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('flushDurableState', () => {
  it('checkpoints the WAL, fsyncs the Pane directory files, then syncs the filesystem', async () => {
    const paneDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-flush-'));
    tempDirs.push(paneDirectory);
    fs.writeFileSync(path.join(paneDirectory, 'sessions.db'), 'db');
    fs.writeFileSync(path.join(paneDirectory, 'sessions.db-wal'), 'wal');
    fs.mkdirSync(path.join(paneDirectory, 'logs'));
    const order: string[] = [];
    const checkpointWal = vi.fn(() => {
      order.push('checkpoint');
      return { busy: 0, log: 3, checkpointed: 3 };
    });
    const syncFilesystem = vi.fn(async () => {
      order.push('sync');
      return true;
    });
    const backupTailnetState = vi.fn(async () => {
      order.push('tailnet-backup');
      return true;
    });
    let clock = 100;

    const result = await flushDurableState({
      checkpointWal,
      paneDirectory,
      databaseFile: path.join(paneDirectory, 'sessions.db'),
      syncFilesystem,
      backupTailnetState,
      now: () => (clock += 5),
    });

    // The tailscaled.state copy is written before the final sync, so the snapshot has it.
    expect(order).toEqual(['checkpoint', 'tailnet-backup', 'sync']);
    expect(result.walCheckpoint).toEqual({ busy: 0, log: 3, checkpointed: 3 });
    expect(result.fsynced.slice(0, 2)).toEqual([
      path.join(paneDirectory, 'sessions.db'),
      path.join(paneDirectory, 'sessions.db-wal'),
    ]);
    expect(result.syncedFilesystem).toBe(true);
    expect(result).toMatchObject({ durable: true, failures: [] });
    expect(result.durationMs).toBe(5);
    expect(syncFilesystem).toHaveBeenCalledWith(paneDirectory);
  });

  it('fails closed when the Pane directory is missing', async () => {
    const paneDirectory = path.join(os.tmpdir(), 'pane-cloud-flush-missing-dir');
    const syncFilesystem = vi.fn(async () => true);
    const result = await flushDurableState({
      checkpointWal: () => ({ busy: 0, log: 0, checkpointed: 0 }),
      paneDirectory,
      databaseFile: path.join(paneDirectory, 'sessions.db'),
      syncFilesystem,
      backupTailnetState: async () => 'not-installed',
    });

    // It still tries the rest, so a later stop the user forces gets what could be flushed.
    expect(syncFilesystem).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fsynced: [], syncedFilesystem: true, durable: false });
    expect(result.failures.join('\n')).toContain(paneDirectory);
  });

  describe('verified durability', () => {
    function paneDirectoryWithDatabase(): string {
      const paneDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-flush-'));
      tempDirs.push(paneDirectory);
      fs.writeFileSync(path.join(paneDirectory, 'sessions.db'), 'db');
      fs.writeFileSync(path.join(paneDirectory, 'sessions.db-wal'), '');
      return paneDirectory;
    }

    async function flushWith(overrides: Partial<Parameters<typeof flushDurableState>[0]>) {
      const paneDirectory = paneDirectoryWithDatabase();
      return flushDurableState({
        checkpointWal: () => ({ busy: 0, log: 2, checkpointed: 2 }),
        paneDirectory,
        databaseFile: path.join(paneDirectory, 'sessions.db'),
        syncFilesystem: async () => true,
        backupTailnetState: async () => 'backed-up',
        ...overrides,
      });
    }

    it('is durable when every required step succeeded and the tailnet guard is not installed', async () => {
      const result = await flushWith({ backupTailnetState: async () => 'not-installed' });

      expect(result).toMatchObject({ durable: true, failures: [] });
    });

    it('is not durable when the WAL checkpoint throws, but keeps flushing the rest', async () => {
      const syncFilesystem = vi.fn(async () => true);
      const result = await flushWith({
        checkpointWal: () => { throw new Error('SQLITE_IOERR'); },
        syncFilesystem,
      });

      expect(result.walCheckpoint).toBeNull();
      expect(result.durable).toBe(false);
      expect(result.failures.join('\n')).toContain('SQLITE_IOERR');
      expect(syncFilesystem).toHaveBeenCalledTimes(1);
    });

    it('is not durable when no WAL checkpoint ran', async () => {
      const result = await flushWith({ checkpointWal: () => null });

      expect(result.durable).toBe(false);
    });

    it('is not durable when the filesystem sync fails', async () => {
      const result = await flushWith({ syncFilesystem: async () => false });

      expect(result.durable).toBe(false);
      expect(result.failures.join('\n')).toMatch(/sync/);
    });

    it('is not durable when the installed tailnet-state backup fails', async () => {
      const result = await flushWith({ backupTailnetState: async () => 'failed' });

      expect(result.durable).toBe(false);
      expect(result.failures.join('\n')).toMatch(/tailscaled state/);
    });

    it('is not durable when the database file is missing', async () => {
      const paneDirectory = paneDirectoryWithDatabase();
      const result = await flushWith({ paneDirectory, databaseFile: path.join(paneDirectory, 'elsewhere.db') });

      expect(result.durable).toBe(false);
      expect(result.failures.join('\n')).toContain('elsewhere.db');
    });

    it('accepts a busy checkpoint once the remaining WAL is fsynced', async () => {
      const result = await flushWith({ checkpointWal: () => ({ busy: 1, log: 9, checkpointed: 4 }) });

      expect(result.durable).toBe(true);
      expect(result.fsynced).toContain(path.join(path.dirname(result.fsynced[0] ?? ''), 'sessions.db-wal'));
    });

    it('rejects a busy checkpoint whose WAL file is gone', async () => {
      const paneDirectory = paneDirectoryWithDatabase();
      fs.rmSync(path.join(paneDirectory, 'sessions.db-wal'));
      const result = await flushWith({ paneDirectory, databaseFile: path.join(paneDirectory, 'sessions.db'), checkpointWal: () => ({ busy: 1, log: 9, checkpointed: 4 }) });

      expect(result.durable).toBe(false);
      expect(result.failures.join('\n')).toContain('sessions.db-wal');
    });

    it('fsyncs a database that lives outside the Pane directory', async () => {
      const elsewhere = paneDirectoryWithDatabase();
      const result = await flushWith({ databaseFile: path.join(elsewhere, 'sessions.db') });

      expect(result.durable).toBe(true);
      expect(result.fsynced).toContain(path.join(elsewhere, 'sessions.db'));
      expect(result.fsynced).toContain(path.join(elsewhere, 'sessions.db-wal'));
    });
  });
});
