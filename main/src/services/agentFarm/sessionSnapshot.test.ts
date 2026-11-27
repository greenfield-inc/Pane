import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSnapshotCreated, ReceiptHashes, receiptFilesHash, terminalSnapshot, snapshotHoldsProfile, sessionSnapshotForTab, snapshotPluginHashes, snapshotProblem, snapshotRefused, unreadableSnapshots, withSnapshotEnv, type SnapshotHolder } from './sessionSnapshot';

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

describe('snapshotPluginHashes and receiptFilesHash', () => {
  /** A config root with plugin `team` installed: its files and the receipt that lists them. */
  function installedRoot(files: Record<string, string>, listed: string[] = Object.keys(files)): string {
    const root = tempFolder();
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, 'plugins', 'team', relative)), { recursive: true });
      fs.writeFileSync(path.join(root, 'plugins', 'team', relative), content);
    }
    fs.mkdirSync(path.join(root, '.plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, '.plugins', 'team.json'), JSON.stringify({ name: 'team', version: '1.0.0', checksums: Object.fromEntries(listed.map(relative => [relative, 'x'])) }));
    return root;
  }

  // Review r2: a snapshot copies only the files a plugin's receipt lists, so the dot compares only those.
  it('hashes only the files the receipt lists, so caches and .DS_Store left in the installed folder change nothing', async () => {
    const plain = await receiptFilesHash(installedRoot({ 'plugin.yaml': 'name: team\n', 'agents/lead.md': 'Lead.' }), 'team');
    const cluttered = await receiptFilesHash(installedRoot({ 'plugin.yaml': 'name: team\n', 'agents/lead.md': 'Lead.', '.DS_Store': 'x', 'skills/s/.venv/bin/python': 'x' }, ['plugin.yaml', 'agents/lead.md']), 'team');
    expect(plain).toBeDefined();
    expect(cluttered).toBe(plain);
  });

  it('changes when a listed file is edited in place or deleted, and is undefined without a receipt', async () => {
    const plain = await receiptFilesHash(installedRoot({ 'plugin.yaml': 'name: team\n', 'agents/lead.md': 'Lead.' }), 'team');
    expect(await receiptFilesHash(installedRoot({ 'plugin.yaml': 'name: team\n', 'agents/lead.md': 'Lead, edited.' }), 'team')).not.toBe(plain);
    expect(await receiptFilesHash(installedRoot({ 'plugin.yaml': 'name: team\n' }, ['plugin.yaml', 'agents/lead.md']), 'team')).not.toBe(plain);
    expect(await receiptFilesHash(tempFolder(), 'team')).toBeUndefined();
    expect(await receiptFilesHash(tempFolder(), '../team')).toBeUndefined();
  });

  it('gives a snapshot\'s plugins the same hash as the installed plugin it was copied from', async () => {
    const session = tempFolder();
    const receipt = JSON.stringify({ name: 'team', version: '1.0.0', layout: 2, checksums: { 'plugin.yaml': 'x', 'agents/lead.md': 'x' } });
    const folder = writeSnapshot(session, 'abc', { 'plugins/team/plugin.yaml': 'name: team\n', 'plugins/team/agents/lead.md': 'Lead.', '.plugins/team.json': receipt });
    const installed = installedRoot({ 'plugin.yaml': 'name: team\n', 'agents/lead.md': 'Lead.', '.DS_Store': 'x' }, ['plugin.yaml', 'agents/lead.md']);
    const hashes = await snapshotPluginHashes(folder);
    expect(Object.keys(hashes)).toEqual(['team']);
    expect(hashes.team).toBe(await receiptFilesHash(installed, 'team'));
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

// T-110 (D-3): whether a Session's snapshot can run a tab's profile on a computer that lacks its plugin.
describe('snapshotHoldsProfile', () => {
  it('holds a profile or agent its plugin folder has, in a snapshot that passes its checksums', async () => {
    const session = tempFolder();
    const folder = writeSnapshot(session, 'abc', { 'plugins/team/profiles/lead.yaml': 'agent: lead\n', 'plugins/team/agents/helper.md': 'Helper.', 'settings.json': '{"default_plugin":"team"}' });
    expect(await snapshotHoldsProfile(folder, 'team/lead')).toBe(true);
    expect(await snapshotHoldsProfile(folder, 'team/helper')).toBe(true);
    // A bare name resolves through the snapshot's default_plugin, as Agent Farm does.
    expect(await snapshotHoldsProfile(folder, 'lead')).toBe(true);
    expect(await snapshotHoldsProfile(folder, 'team/missing')).toBe(false);
    // QA F2: greenfield 0.1 makes planner a variant set (agents/planner.yaml with planner-claude.md, planner-codex.md).
    const sets = writeSnapshot(tempFolder(), 'def', { 'plugins/greenfield/agents/planner.yaml': 'variants: {}\n', 'plugins/greenfield/agents/planner-claude.md': 'Planner.' });
    expect(await snapshotHoldsProfile(sets, 'greenfield/planner')).toBe(true);
    expect(await snapshotHoldsProfile(folder, 'other/lead')).toBe(false);
    expect(await snapshotHoldsProfile(folder, '../team/lead')).toBe(false);
  });

  it('holds nothing when the snapshot fails its checksums or is gone', async () => {
    const session = tempFolder();
    const folder = writeSnapshot(session, 'abc', { 'plugins/team/profiles/lead.yaml': 'agent: lead\n' });
    fs.writeFileSync(path.join(folder, 'plugins', 'team', 'profiles', 'lead.yaml'), 'agent: other\n');
    expect(await snapshotHoldsProfile(folder, 'team/lead')).toBe(false);
    expect(await snapshotHoldsProfile(path.join(session, 'nowhere'), 'team/lead')).toBe(false);
  });
});

// Review F-5: which snapshot a terminal tab exports; a WSL or SSH shell can't read this machine's path.
describe('terminalSnapshot', () => {
  it.each([
    ['a local tab with a pinned snapshot', { agentFarmSnapshot: '/s/d1' }, false, '/s/d1'],
    ['a WSL tab', { agentFarmSnapshot: '/s/d1' }, true, undefined],
    ['an SSH tab', { agentFarmSnapshot: '/s/d1', sshHost: 'box' }, false, undefined],
    ['a tab with none', {}, false, undefined],
  ])('%s', (_name, state, isWSL, expected) => {
    expect(terminalSnapshot(state, isWSL)).toBe(expected);
  });
});

// Review F-4: the 10 s check rehashes a plugin's files only when one of them, or its receipt, changed on disk.
describe('ReceiptHashes', () => {
  it('reuses a plugin\'s hash while its files keep their size and mtime, and rehashes when one changes', async () => {
    const root = tempFolder();
    const file = path.join(root, 'plugins', 'team', 'agents', 'lead.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Lead.');
    fs.mkdirSync(path.join(root, '.plugins'));
    fs.writeFileSync(path.join(root, '.plugins', 'team.json'), JSON.stringify({ checksums: { 'agents/lead.md': 'x' } }));
    // A whole-second mtime, which utimes can set back exactly.
    const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    fs.utimesSync(file, mtime, mtime);
    const hashes = new ReceiptHashes(root);
    const first = await hashes.hash('team');
    expect(first).toBe(await receiptFilesHash(root, 'team'));
    // Same size and mtime: nothing is read again, so the old hash comes back.
    fs.writeFileSync(file, 'Lean.');
    fs.utimesSync(file, mtime, mtime);
    expect(await hashes.hash('team')).toBe(first);
    // A real edit moves the mtime.
    // Review r2 N-4: the same size, so only the mtime tells the edit apart.
    fs.writeFileSync(file, 'Leap.');
    fs.utimesSync(file, new Date(mtime.getTime() + 5000), new Date(mtime.getTime() + 5000));
    expect(await hashes.hash('team')).toBe(await receiptFilesHash(root, 'team'));
    expect(await hashes.hash('team')).not.toBe(first);
    expect(await hashes.hash('missing')).toBeUndefined();
  });
});
