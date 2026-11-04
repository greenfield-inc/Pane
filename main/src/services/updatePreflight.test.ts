import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUpdateDirectoryWritable } from '../../../packages/runpane/src/updatePreflight';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
describe('update directory permissions', () => {
  it('proves create, write, rename and cleanup without leaving a probe', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-preflight-'));
    directories.push(directory);
    assertUpdateDirectoryWritable(directory);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('rejects a Windows-style ACL denial even when access would report writable', () => {
    vi.spyOn(fs, 'accessSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw Object.assign(new Error('Access is denied'), { code: 'EACCES' }); });
    expect(() => assertUpdateDirectoryWritable('owned-install')).toThrow(expect.objectContaining({
      code: 'ERR_UPDATE_PREFLIGHT',
      next: expect.stringContaining('Pane has not been stopped'),
    }));
  });
});

describe('snapshot capacity before downtime', () => {
  it('counts exclusively locked live Windows profile files but refuses ACL denial', async () => {
    const { assertUpdateCapacity } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const profile = path.join(directory, 'profile');
    const data = path.join(directory, 'data');
    const install = path.join(directory, 'install');
    for (const folder of [profile, data, install]) fs.mkdirSync(folder);
    const cookies = path.join(profile, 'Cookies');
    fs.writeFileSync(cookies, 'live database');
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const open = fs.openSync;
    let code = 'EBUSY';
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === cookies) throw Object.assign(new Error('File unavailable'), { code });
      return open(...args);
    });
    expect(() => assertUpdateCapacity(data, { paneDir: data, userData: profile }, install)).not.toThrow();
    code = 'EACCES';
    expect(() => assertUpdateCapacity(data, { paneDir: data, userData: profile }, install)).toThrow('File unavailable');
    code = 'EBUSY';
    expect(() => assertUpdateCapacity(profile, { paneDir: profile, userData: data }, install)).toThrow('File unavailable');
  });

  // On one machine Pane data held 147k files of repository checkouts and 2.5 GB
  // of someone's backups; opening each file kept preflight silent for minutes.
  it('copies only Pane state from Pane data and lists what it leaves out', async () => {
    const { assertUpdateCapacity, copyUpdateSnapshot, updateSnapshotSkips } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const data = path.join(directory, 'data');
    const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(data, file)), { recursive: true }); fs.writeFileSync(path.join(data, file), content); };
    write('sessions.db', 'pane state');
    write(path.join('notes', 'today.md'), 'pane state');
    write(path.join('notes', 'clone', '.git', 'HEAD'), 'ref');
    write(path.join('notes', 'clone', 'README.md'), 'repository file');
    write(path.join('projects', 'Pane', 'README.md'), 'repository file');
    write(path.join('remediation', 'Firefox.exe'), "someone else's file");
    write(path.join('updates', 'status.json'), '{}');
    write(path.join('bin', 'runpane.cjs'), 'rebuilt at startup');
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (!/sessions\.db|today\.md/.test(String(args[0]))) throw Object.assign(new Error(`Opened ${String(args[0])}`), { code: 'EACCES' });
      return open(...args);
    });
    const install = path.join(directory, 'install');
    fs.mkdirSync(install);
    expect(() => assertUpdateCapacity(data, { paneDir: data, userData: install }, install)).not.toThrow();
    vi.restoreAllMocks();
    expect(updateSnapshotSkips(data).sort()).toEqual([path.join(data, 'notes', 'clone'), path.join(data, 'remediation')]);
    const snapshot = path.join(directory, 'snapshot');
    copyUpdateSnapshot(data, snapshot, true);
    expect(fs.readFileSync(path.join(snapshot, 'sessions.db'), 'utf8')).toBe('pane state');
    expect(fs.readFileSync(path.join(snapshot, 'notes', 'today.md'), 'utf8')).toBe('pane state');
    for (const skipped of [path.join('notes', 'clone'), 'projects', 'remediation', 'updates', 'bin']) expect(fs.existsSync(path.join(snapshot, skipped)), skipped).toBe(false);
  });

  it('rejects a snapshot that exceeds actual available capacity', async () => {
    const { assertUpdateCapacity } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const disk = fs.statfsSync(directory);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...disk, bavail: 1, bsize: 4096 });
    expect(() => assertUpdateCapacity(directory, { paneDir: directory, userData: directory }, directory)).toThrow(expect.objectContaining({ code: 'ERR_UPDATE_DISK_SPACE' }));
  });
});
