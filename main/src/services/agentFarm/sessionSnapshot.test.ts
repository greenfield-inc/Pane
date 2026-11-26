import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSnapshotCreated, sessionSnapshotForTab, snapshotPluginHashes, snapshotProblem, snapshotRefused, unreadableSnapshots, withSnapshotEnv, type SnapshotHolder } from './sessionSnapshot';
import { hashDirectory } from '../skillCacheManager';

const folders: string[] = [];
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-snapshot-'));
  folders.push(folder);
  return folder;
}
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

/** A snapshot as Agent Farm writes one: plugins, receipts, snapshot.json and checksums.json over all of them. */
function writeSnapshot(sessionFolder: string, digest: string, files: Record<string, string>): string {
  const folder = path.join(sessionFolder, '.agent-farm', 'snapshots', digest);
  const all = { ...files, 'snapshot.json': JSON.stringify({ format: 1, digest, plugins: { team: '1.0.0' } }) };
  const checksums = new Map<string, string>();
  for (const [relative, content] of Object.entries(all)) {
    const file = path.join(folder, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    checksums.set(path.join(...relative.split('/')), sha256(content));
  }
  fs.writeFileSync(path.join(folder, 'checksums.json'), JSON.stringify(Object.fromEntries(checksums), null, 2));
  return folder;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('parseSnapshotCreated', () => {
  it('keeps the snapshot\'s path relative to the Session folder, so it still resolves after a move', () => {
    const session = tempFolder();
    const created = parseSnapshotCreated(JSON.stringify({ path: path.join(session, '.agent-farm', 'snapshots', 'abc123'), digest: 'abc123', plugins: { greenfield: '0.1.2', pane: '1.0.0' } }), session);
    expect(created).toEqual({ path: '.agent-farm/snapshots/abc123', digest: 'abc123', plugins: { greenfield: '0.1.2', pane: '1.0.0' } });
  });

  it('refuses output that isn\'t a snapshot, or a folder outside the Session\'s snapshots', () => {
    const session = tempFolder();
    expect(() => parseSnapshotCreated('Snapshot saved', session)).toThrow(expect.objectContaining({ code: 'AGENT_FARM_SNAPSHOT_FAILED' }));
    expect(() => parseSnapshotCreated(JSON.stringify({ path: '/elsewhere/abc', digest: 'abc', plugins: {} }), session)).toThrow(expect.objectContaining({ code: 'AGENT_FARM_SNAPSHOT_FAILED' }));
  });
});

describe('snapshotRefused', () => {
  it('knows Agent Farm\'s refusal of an unreadable snapshot, and nothing else', () => {
    expect(snapshotRefused('Error: Snapshot /s/.agent-farm/snapshots/abc failed its checksum (a file in it was changed, added or removed). Agent Farm will not fall back to the installed plugins. Use Reload profile (in Pane), or resume with --resume ID --reload, to take a new snapshot of what is installed now.')).toBe(true);
    expect(snapshotRefused('Error: Snapshot /s/.agent-farm/snapshots/abc is missing. Agent Farm will not fall back to the installed plugins. Use Reload profile (in Pane)…')).toBe(true);
    expect(snapshotRefused('Error: Unknown profile team/lead')).toBe(false);
    expect(snapshotRefused(undefined)).toBe(false);
  });
});

describe('snapshotProblem and unreadableSnapshots', () => {
  it('passes a snapshot whose files match its checksums', async () => {
    const session = tempFolder();
    const folder = writeSnapshot(session, 'abc', { 'plugins/team/plugin.yaml': 'name: team\n', '.plugins/team.json': '{}' });
    expect(await snapshotProblem(folder)).toBeUndefined();
    expect(await unreadableSnapshots(session)).toEqual([]);
  });

  it('names a changed, missing or added file, and a folder with no checksums', async () => {
    const session = tempFolder();
    const changed = writeSnapshot(session, 'changed', { 'plugins/team/plugin.yaml': 'name: team\n' });
    fs.writeFileSync(path.join(changed, 'plugins', 'team', 'plugin.yaml'), 'name: other\n');
    const missing = writeSnapshot(session, 'missing', { 'plugins/team/plugin.yaml': 'name: team\n' });
    fs.rmSync(path.join(missing, 'plugins', 'team', 'plugin.yaml'));
    const added = writeSnapshot(session, 'added', { 'plugins/team/plugin.yaml': 'name: team\n' });
    fs.writeFileSync(path.join(added, 'extra.md'), 'x');
    fs.mkdirSync(path.join(session, '.agent-farm', 'snapshots', 'bare'));
    // A staging folder a killed launch left behind is not a snapshot.
    fs.mkdirSync(path.join(session, '.agent-farm', 'snapshots', '.building-x'));
    expect(await unreadableSnapshots(session)).toEqual([
      { path: '.agent-farm/snapshots/added', problem: 'extra.md was added' },
      { path: '.agent-farm/snapshots/bare', problem: expect.stringContaining('checksums.json can\'t be read') },
      { path: '.agent-farm/snapshots/changed', problem: `${path.join('plugins', 'team', 'plugin.yaml')} changed` },
      { path: '.agent-farm/snapshots/missing', problem: `${path.join('plugins', 'team', 'plugin.yaml')} is missing` },
    ]);
  });

  it('finds nothing in a Session folder without snapshots', async () => {
    expect(await unreadableSnapshots(tempFolder())).toEqual([]);
  });
});

describe('snapshotPluginHashes', () => {
  it('hashes each plugin folder the way Pane hashes the installed copy, so equal files compare equal', async () => {
    const session = tempFolder();
    const folder = writeSnapshot(session, 'abc', { 'plugins/team/plugin.yaml': 'name: team\n', 'plugins/team/agents/lead.md': 'Lead.', 'plugins/other/plugin.yaml': 'name: other\n' });
    const installed = path.join(tempFolder(), 'team');
    fs.mkdirSync(path.join(installed, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'plugin.yaml'), 'name: team\n');
    fs.writeFileSync(path.join(installed, 'agents', 'lead.md'), 'Lead.');
    const hashes = await snapshotPluginHashes(folder);
    expect(Object.keys(hashes)).toEqual(['other', 'team']);
    expect(hashes.team).toBe(await hashDirectory(installed));
    expect(await snapshotPluginHashes(path.join(session, 'nowhere'))).toEqual({});
  });
});

// T-110 (D-4): every Agent Farm tab in a Session's Panes reads its Session's snapshot.
describe('sessionSnapshotForTab', () => {
  const folderOf = (id: string) => `/pane/sessions/${id}`;
  const sessions: SnapshotHolder[] = [
    { id: 's1', internalSessionId: 'own-1', associations: [{ paneId: 'worker-1', panelIds: [], attachedAt: '' }, { paneId: 'remote', panelIds: [], attachedAt: '', machine: { id: 'm', label: 'Studio' } }], agentFarmSnapshot: '.agent-farm/snapshots/d1' },
    { id: 's2', internalSessionId: 'own-2', associations: [{ paneId: 'worker-2', panelIds: [], attachedAt: '' }] },
    { id: 's3', internalSessionId: 'own-3', associations: [{ paneId: 'worker-3', panelIds: [], attachedAt: '' }], agentFarmSnapshot: '.agent-farm/snapshots/d3', archived: true },
  ];
  it('gives the Session\'s own tabs and its Panes\' tabs the Session\'s snapshot folder', () => {
    expect(sessionSnapshotForTab(sessions, { paneId: 'own-1', orchestrationSessionId: 's1' }, folderOf)).toBe(path.join('/pane/sessions/s1', '.agent-farm', 'snapshots', 'd1'));
    expect(sessionSnapshotForTab(sessions, { paneId: 'own-1' }, folderOf)).toBe(path.join('/pane/sessions/s1', '.agent-farm', 'snapshots', 'd1'));
    expect(sessionSnapshotForTab(sessions, { paneId: 'worker-1' }, folderOf)).toBe(path.join('/pane/sessions/s1', '.agent-farm', 'snapshots', 'd1'));
  });
  it('gives none outside a Session, for a Session without one, an archived one, or a Pane on another machine', () => {
    expect(sessionSnapshotForTab(sessions, { paneId: 'loose' }, folderOf)).toBeUndefined();
    expect(sessionSnapshotForTab(sessions, { paneId: 'worker-2' }, folderOf)).toBeUndefined();
    expect(sessionSnapshotForTab(sessions, { paneId: 'worker-3' }, folderOf)).toBeUndefined();
    expect(sessionSnapshotForTab(sessions, { paneId: 'remote' }, folderOf)).toBeUndefined();
  });
});

describe('withSnapshotEnv', () => {
  it('sets AGENT_FARM_SNAPSHOT with Profiles on, and drops an inherited one outside a Session', () => {
    expect(withSnapshotEnv({ PATH: '/bin', AGENT_FARM_SNAPSHOT: '/old' }, '/s/.agent-farm/snapshots/d1', true)).toEqual({ PATH: '/bin', AGENT_FARM_SNAPSHOT: '/s/.agent-farm/snapshots/d1' });
    expect(withSnapshotEnv({ PATH: '/bin', AGENT_FARM_SNAPSHOT: '/old' }, undefined, true)).toEqual({ PATH: '/bin' });
  });
  it('leaves the environment as it is with Profiles off', () => {
    expect(withSnapshotEnv({ PATH: '/bin', AGENT_FARM_SNAPSHOT: '/old' }, '/s/d1', false)).toEqual({ PATH: '/bin', AGENT_FARM_SNAPSHOT: '/old' });
  });
});
