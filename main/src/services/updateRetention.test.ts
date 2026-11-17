import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appBackupPath } from '../../../packages/runpane/src/updateArtifacts';
import { writeUpdateJson } from '../../../packages/runpane/src/updateOperation';
import { pruneReplacedUpdates, readUpdateRecords, replacedUpdates, type UpdateRecord } from '../../../packages/runpane/src/updateRetention';

const record = (id: string, phase: string, updatedAt: number, extra: Partial<UpdateRecord> = {}): UpdateRecord =>
  ({ id, phase, updatedAt, version: '2.5.0', fromVersion: '2.4.0', installed: phase === 'complete', ...extra });

describe('replacedUpdates', () => {
  it('removes every update older than the newest completed one, whatever its outcome', () => {
    const replaced = replacedUpdates([
      record('u1', 'complete', Date.parse('2026-10-01')),
      record('u2', 'needs-attention', Date.parse('2026-10-31')),
      record('u3', 'complete', Date.parse('2026-11-10')),
      record('u4', 'failed', Date.parse('2026-11-12')),
      record('u5', 'install', Date.parse('2026-11-15')),
    ]);
    expect(replaced).toEqual(['u1', 'u2']);
  });

  it('keeps everything until one update has completed', () => {
    expect(replacedUpdates([
      record('u1', 'needs-attention', 1),
      record('u2', 'failed', 2),
    ])).toEqual([]);
  });
});

describe('replacedUpdates with the running Pane version', () => {
  // The built-in updater keeps no journal, so a failed runpane update was never followed by a completed one.
  it('replaces an ended update the running Pane has moved past, with no completed update after it', () => {
    const updates = [
      record('installed-older', 'needs-attention', 1, { version: '2.5.0', installed: true }),
      record('never-installed', 'needs-attention', 2, { version: '2.6.0', fromVersion: '2.5.0', installed: false }),
      record('failed-staging', 'failed', 3, { version: 'latest', fromVersion: '2.5.0', installed: false }),
    ];
    expect(replacedUpdates(updates, '2.6.0')).toEqual(['installed-older', 'never-installed', 'failed-staging']);
  });

  it('keeps the update that installed the running Pane, one still running, and every one when the version is unknown', () => {
    const updates = [
      record('this-install', 'needs-attention', 1, { version: '2.6.0', fromVersion: '2.5.0', installed: true }),
      record('in-flight', 'snapshot', 2, { version: '2.5.0', fromVersion: '2.4.0', installed: false }),
      record('never-installed-same', 'needs-attention', 3, { version: '2.6.0', fromVersion: '2.6.0', installed: false }),
      record('cli-only', 'failed', 4, { version: 'latest', fromVersion: null, installed: false }),
    ];
    expect(replacedUpdates(updates, '2.6.0')).toEqual([]);
    expect(replacedUpdates([record('old', 'needs-attention', 1, { version: '2.0.0' })], 'development')).toEqual([]);
  });
});

describe('readUpdateRecords', () => {
  it('reads each operation\'s outcome, target and starting version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
    try {
      const directory = path.join(root, 'updates', 'u1');
      writeUpdateJson(path.join(directory, 'status.json'), { id: 'u1', host: 'mac', scope: 'both', version: '2.6.0', phase: 'needs-attention', completed: ['stage', 'checkpoint', 'stop'], updatedAt: '2026-11-01T00:00:00.000Z', appUpdated: false, cliUpdated: false, hostReachable: false, restored: [] });
      writeUpdateJson(path.join(directory, 'preflight.json'), { host: { version: '2.5.0' } });
      fs.mkdirSync(path.join(root, 'updates', 'stray'));
      expect(readUpdateRecords(root)).toEqual([{ id: 'u1', phase: 'needs-attention', updatedAt: Date.parse('2026-11-01T00:00:00.000Z'), version: '2.6.0', fromVersion: '2.5.0', installed: false }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
