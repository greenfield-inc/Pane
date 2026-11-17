import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appBackupPath } from '../../../packages/runpane/src/updateArtifacts';
import { writeUpdateJson } from '../../../packages/runpane/src/updateOperation';
import { pruneReplacedUpdates, replacedUpdates } from '../../../packages/runpane/src/updateRetention';

describe('replacedUpdates', () => {
  it('removes every update older than the newest completed one, whatever its outcome', () => {
    const replaced = replacedUpdates([
      { id: 'u1', phase: 'complete', updatedAt: Date.parse('2026-10-01') },
      { id: 'u2', phase: 'needs-attention', updatedAt: Date.parse('2026-10-31') },
      { id: 'u3', phase: 'complete', updatedAt: Date.parse('2026-11-10') },
      { id: 'u4', phase: 'failed', updatedAt: Date.parse('2026-11-12') },
      { id: 'u5', phase: 'install', updatedAt: Date.parse('2026-11-15') },
    ]);
    expect(replaced).toEqual(['u1', 'u2']);
  });

  it('keeps everything until one update has completed', () => {
    expect(replacedUpdates([
      { id: 'u1', phase: 'needs-attention', updatedAt: 1 },
      { id: 'u2', phase: 'failed', updatedAt: 2 },
    ])).toEqual([]);
  });
});

describe('pruneReplacedUpdates', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
    directories.push(root);
    const paneDir = path.join(root, 'pane');
    const installPath = path.join(root, 'Applications', 'Pane.app');
    fs.mkdirSync(installPath, { recursive: true });
    const operation = (id: string, phase: string, updatedAt: string, completed: string[], snapshotBytes = 0) => {
      const directory = path.join(paneDir, 'updates', id);
      writeUpdateJson(path.join(directory, 'status.json'), { id, host: 'mac', scope: 'both', version: '2.5.0', phase, completed, updatedAt, appUpdated: false, cliUpdated: false, hostReachable: false, restored: [] });
      const backupPath = appBackupPath(installPath, id);
      writeUpdateJson(path.join(directory, 'staged.json'), { app: { version: '2.5.0', artifact: path.join(directory, 'app', 'Pane.zip'), installPath, backupPath, sha256: 'a'.repeat(64) }, cli: null });
      if (snapshotBytes) {
        fs.mkdirSync(path.join(directory, 'snapshot', 'data'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'snapshot', 'data', 'sessions.db'), Buffer.alloc(snapshotBytes));
      }
      if (completed.includes('install')) fs.mkdirSync(path.join(backupPath, 'Contents'), { recursive: true });
      return { directory, backupPath };
    };
    return { paneDir, installPath, operation };
  }

  it('removes the snapshots and previous app copies of earlier ended updates once one completes', () => {
    const { paneDir, operation } = setup();
    const attention = operation('u-attention', 'needs-attention', '2026-10-01T00:00:00Z', ['stage', 'checkpoint', 'stop', 'snapshot', 'install', 'launch'], 4096);
    const failed = operation('u-failed', 'failed', '2026-10-05T00:00:00Z', ['stage']);
    const older = operation('u-older', 'complete', '2026-09-01T00:00:00Z', ['stage', 'checkpoint', 'stop', 'snapshot', 'install', 'launch', 'health', 'restore'], 1024);
    const current = operation('u-current', 'complete', '2026-11-10T00:00:00Z', ['stage', 'checkpoint', 'stop', 'snapshot', 'install', 'launch', 'health', 'restore'], 1024);
    const pruned = pruneReplacedUpdates(paneDir);
    expect(pruned.failed).toEqual([]);
    expect(pruned.removed.sort()).toEqual([attention.backupPath, attention.directory, failed.directory, older.backupPath, older.directory].sort());
    for (const gone of [attention.directory, attention.backupPath, failed.directory, older.directory, older.backupPath]) expect(fs.existsSync(gone), gone).toBe(false);
    // The completed update keeps its snapshot and previous app for rollback.
    expect(fs.existsSync(path.join(current.directory, 'snapshot', 'data', 'sessions.db'))).toBe(true);
    expect(fs.existsSync(current.backupPath)).toBe(true);
  });

  it('keeps an operation that may still have an installer running, and a folder with no readable journal', () => {
    const { paneDir, operation } = setup();
    const midInstall = operation('u-mid-install', 'needs-attention', '2026-10-01T00:00:00Z', ['stage', 'checkpoint', 'stop', 'snapshot'], 2048);
    const running = operation('u-running', 'install', '2026-10-02T00:00:00Z', ['stage', 'checkpoint', 'stop', 'snapshot'], 2048);
    operation('u-current', 'complete', '2026-11-10T00:00:00Z', ['stage', 'install', 'health', 'restore']);
    const unknown = path.join(paneDir, 'updates', 'not-an-update');
    fs.mkdirSync(unknown);
    expect(pruneReplacedUpdates(paneDir)).toEqual({ removed: [], failed: [] });
    for (const kept of [midInstall.directory, running.directory, unknown]) expect(fs.existsSync(kept), kept).toBe(true);
  });

  it('never removes a previous-app path its manifest does not name as Pane\'s own copy', () => {
    const { paneDir, installPath, operation } = setup();
    const old = operation('u-old', 'failed', '2026-10-01T00:00:00Z', ['stage']);
    writeUpdateJson(path.join(old.directory, 'staged.json'), { app: { version: '2.5.0', artifact: '', installPath, backupPath: installPath, sha256: '' }, cli: null });
    operation('u-current', 'complete', '2026-11-10T00:00:00Z', ['stage', 'install']);
    expect(pruneReplacedUpdates(paneDir).removed).toEqual([old.directory]);
    expect(fs.existsSync(installPath)).toBe(true);
  });

  it('does nothing until an update has completed', () => {
    const { paneDir, operation } = setup();
    const attention = operation('u-attention', 'needs-attention', '2026-10-01T00:00:00Z', ['stage', 'stop', 'snapshot', 'install'], 1024);
    expect(pruneReplacedUpdates(paneDir).removed).toEqual([]);
    expect(fs.existsSync(attention.directory)).toBe(true);
    expect(fs.existsSync(attention.backupPath)).toBe(true);
  });
});
