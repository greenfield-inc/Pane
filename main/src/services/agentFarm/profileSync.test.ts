import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_SYNC_CHANNELS, PROFILE_SYNC_OFF_CODE, profileSyncRecordSchema, type ProfileSyncApplyRequest } from '../../../../shared/types/profileSync';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { sendFile, writeResultSchema } from '../sessionMove/transfer';
import { agentFarmConfigRoot, bundledAgentFarm, bundledAgentFarmProcess, installBundledAgentFarm } from './bundledAgentFarm';
import { ProfileEditor } from './profileEditor';
import { ProfileSyncHost, packHash, runProfileSyncCommand, type ProfileSyncHostOptions } from './profileSync';
import { ProfileSyncCoordinator, type ProfileSyncPeer } from './profileSyncCoordinator';
import { readProfileSync, syncedPluginEdits } from './profileSyncFile';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-profile-sync-'));
  temporary.push(dir);
  return dir;
}

const bundle = bundledAgentFarm();
if (!bundle) throw new Error('Expected the pinned @greenfieldco/agent-farm package');

async function agentFarm(paneDir: string, args: string[]): Promise<string> {
  const run = bundledAgentFarmProcess(bundle!, args, agentFarmConfigRoot(paneDir));
  return (await execFileAsync(run.executable, run.args, { env: run.env })).stdout;
}

/** A small plugin someone wrote, installed into a Pane's Agent Farm with the real CLI. */
async function installFixture(paneDir: string, name = 'labtest', marker = 'APPLE'): Promise<void> {
  const source = path.join(tempDir(), name);
  const files = {
    'plugin.yaml': `name: ${name}\nversion: 0.1.0\ncli_major: 0\n`,
    'profiles/writer.yaml': 'agent: writer\n',
    'agents/writer.md': `---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts posts\n---\n\n# Writer\n\nMarker: ${marker}\n`,
  };
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    writeFileSync(path.join(source, relative), content);
  }
  await agentFarm(paneDir, ['plugin', 'install', source]);
}

const WRITER = (paneDir: string) => path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'agents', 'writer.md');

/** One computer: its Pane folder, its sync host, a clock and whether it is "online". */
interface Computer {
  name: string;
  id: string;
  paneDir: string;
  host: ProfileSyncHost;
  editor: ProfileEditor;
  clock: { now: number };
  online: boolean;
}

function computer(name: string, id: string, paneDir = tempDir(), extra: Partial<ProfileSyncHostOptions> = {}): Computer {
  const clock = { now: Date.now() };
  const host = new ProfileSyncHost({ paneDir, machine: () => id, name: () => name, bundle, now: () => clock.now, ...extra });
  // As ipc/profiles.ts wires it: every change runs under sync's lock and is recorded there.
  const editor = new ProfileEditor({ paneDir, machine: () => name, bundle, exclusive: (plugin, work) => host.exclusive(plugin, work) });
  return { name, id, paneDir, host, editor, clock, online: true };
}

/** How the desktop reaches another computer: its daemon's commands, with answers as JSON on the wire. */
function peer(target: Computer): ProfileSyncPeer {
  return {
    key: `machine-${target.name}`,
    name: target.name,
    get online() { return target.online ? undefined : false; },
    async invoke(channel, args) {
      if (!target.online) throw new Error(`${target.name} is offline`);
      const answer = await runProfileSyncCommand(target.host, channel, JSON.parse(JSON.stringify(args[0] ?? null)));
      return JSON.parse(JSON.stringify(answer ?? null));
    },
  };
}

function desktop(here: Computer, others: Computer[]): ProfileSyncCoordinator {
  return new ProfileSyncCoordinator({ local: here.host, peers: () => others.map(other => peer(other)), machine: () => here.id });
}

const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>\n`;
const OVERRIDES = (paneDir: string, plugin: string) => path.join(agentFarmConfigRoot(paneDir), 'profile-overrides', plugin);

/** Sets a profile's display with the real `agent-farm profiles set`, as the Profiles tab does, and records it. */
async function setDisplay(on: Computer, ref: string, { title, description, photo }: { title?: string; description?: string; photo?: string }): Promise<void> {
  const args = ['profiles', 'set', ref];
  if (title !== undefined) args.push('--title', title);
  if (description !== undefined) args.push('--description', description);
  if (photo !== undefined) {
    let file = '';
    if (photo) {
      file = path.join(tempDir(), 'photo.svg');
      writeFileSync(file, photo);
    }
    args.push('--photo', file);
  }
  await agentFarm(on.paneDir, args);
  await on.host.recordChange();
}

async function saveMarker(on: Computer, marker: string): Promise<void> {
  const text = readFileSync(WRITER(on.paneDir), 'utf8').replace(/Marker: \w+/, `Marker: ${marker}`);
  await on.editor.save('labtest', [{ path: 'agents/writer.md', content: text }]);
  await on.host.recordChange();
}

describe('profile sync: every save reaches the other computers', () => {
  it('sends a save to an online computer, shows an offline one waiting, and catches it up when it returns', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    const c = computer('travel', 'c-id');
    await installFixture(a.paneDir);
    c.online = false;
    const sync = desktop(a, [b, c]);
    await sync.syncNow();

    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: APPLE');
    // B holds A's save, with the same hash and time.
    const aRecord = (await readProfileSync(agentFarmConfigRoot(a.paneDir))).plugins.labtest;
    expect(aRecord).toMatchObject({ state: 'saved', machine: 'a-id' });
    expect((await readProfileSync(agentFarmConfigRoot(b.paneDir))).plugins.labtest).toEqual(aRecord);
    expect(sync.status().computers).toEqual([
      { key: 'machine-build', id: 'b-id', name: 'build', state: 'up-to-date', waiting: [] },
      { key: 'machine-travel', id: '', name: 'travel', state: 'offline', waiting: ['labtest'] },
    ]);

    a.clock.now += 60_000;
    await saveMarker(a, 'BANANA');
    await sync.syncNow();
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: BANANA');
    expect(existsSync(WRITER(c.paneDir))).toBe(false);

    // C comes back: it gets the change without anyone saving again.
    c.online = true;
    await sync.syncNow();
    expect(readFileSync(WRITER(c.paneDir), 'utf8')).toContain('Marker: BANANA');
    expect(sync.status().computers.map(entry => entry.state)).toEqual(['up-to-date', 'up-to-date']);
  }, 120_000);

  it('keeps the newest save everywhere, and settles a tie on the computer with the lower id', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await desktop(a, [b]).syncNow();

    // A saves, then B saves later: both end with B's.
    const base = Date.now() + 60_000;
    a.clock.now = base;
    await saveMarker(a, 'FIRST');
    b.clock.now = base + 1_000;
    await saveMarker(b, 'SECOND');
    await desktop(a, [b]).syncNow();
    expect(readFileSync(WRITER(a.paneDir), 'utf8')).toContain('Marker: SECOND');
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: SECOND');

    // The same time on both: a-id is lower than b-id, so A's save is kept, whichever desktop syncs.
    a.clock.now = base + 2_000;
    b.clock.now = base + 2_000;
    await saveMarker(a, 'ALPHA');
    await saveMarker(b, 'BRAVO');
    await desktop(b, [a]).syncNow();
    expect(readFileSync(WRITER(a.paneDir), 'utf8')).toContain('Marker: ALPHA');
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: ALPHA');
  }, 120_000);

  it('dates a change made while Pane was closed by when it was made, so a newer save elsewhere still wins (QA F-1)', async () => {
    const a = computer('studio', 'a-id');
    const c = computer('travel', 'c-id');
    await installFixture(a.paneDir);
    await desktop(a, [c]).syncNow();
    // C's file is edited by hand while its Pane is closed; A saves later.
    const writer = WRITER(c.paneDir);
    writeFileSync(writer, readFileSync(writer, 'utf8').replace(/Marker: \w+/, 'Marker: OFFLINE'));
    const editedAt = new Date(Date.now() + 60_000);
    utimesSync(writer, editedAt, editedAt);
    a.clock.now = Date.now() + 120_000;
    await saveMarker(a, 'NEWER');
    // C starts much later and notices its edit only now.
    c.clock.now = Date.now() + 3_600_000;
    await desktop(c, [a]).syncNow();
    expect(readFileSync(WRITER(a.paneDir), 'utf8')).toContain('Marker: NEWER');
    expect(readFileSync(writer, 'utf8')).toContain('Marker: NEWER');
  }, 120_000);

  it('records a deletion as a save, so it reaches the other computers', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    const c = computer('travel', 'c-id');
    await installFixture(a.paneDir);
    await setDisplay(a, 'labtest/writer', { title: 'Writer' });
    await desktop(a, [b, c]).syncNow();
    expect(existsSync(WRITER(c.paneDir))).toBe(true);
    expect(existsSync(path.join(OVERRIDES(c.paneDir, 'labtest'), 'writer.json'))).toBe(true);

    a.clock.now += 60_000;
    await agentFarm(a.paneDir, ['plugin', 'uninstall', 'labtest']);
    await desktop(a, [b, c]).syncNow();
    for (const other of [b, c]) {
      expect(existsSync(path.join(agentFarmConfigRoot(other.paneDir), 'plugins', 'labtest'))).toBe(false);
      expect(existsSync(OVERRIDES(other.paneDir, 'labtest'))).toBe(false);
      expect((await readProfileSync(agentFarmConfigRoot(other.paneDir))).plugins.labtest).toMatchObject({ state: 'deleted', machine: 'a-id' });
    }
  }, 120_000);

  it('refuses a pack whose files do not match its checksums, and changes nothing', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await installFixture(b.paneDir, 'labtest', 'ORIGINAL');
    b.clock.now = 0;
    // A file changed after the pack was made, with the pack's hash made to match: only the checksums catch it.
    const exported = await a.host.export('labtest');
    const transferId = exported.transferId ?? '';
    const packFile = a.host.packFile(transferId);
    const pack = decodeBoundary(JSON.parse(readFileSync(packFile, 'utf8')), boundary.object({ files: boundary.record(boundary.string), record: profileSyncRecordSchema }));
    const files = Object.fromEntries(Object.entries(pack.files).map(([file, content]) => [file, Buffer.from(content, 'base64')]));
    files['agents/writer.md'] = Buffer.from('---\nharness: claude\n---\n\nMarker: EVIL\n');
    const record = { ...pack.record, savedAt: Date.now() + 3_600_000, hash: packHash('saved', files, {}) };
    writeFileSync(packFile, JSON.stringify({ ...pack, plugin: 'labtest', overrides: {}, record, files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, content.toString('base64')])) }));
    const sender = peer(b);
    const sent = await sendFile({ write: async write => decodeBoundary(await sender.invoke(PROFILE_SYNC_CHANNELS.write, [write], 1000), writeResultSchema) }, transferId, 'pack.json', packFile);
    const request: ProfileSyncApplyRequest = { plugin: 'labtest', record, transferId, pack: sent };
    await expect(b.host.apply(request)).rejects.toMatchObject({ code: 'PROFILE_SYNC_REFUSED' });
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: ORIGINAL');
    expect(existsSync(path.join(agentFarmConfigRoot(b.paneDir), '.plugins', 'labtest.json'))).toBe(true);
  }, 120_000);

  it('syncs a display override on a Pane plugin without making it edited, and an edit of one as yours', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installBundledAgentFarm({ paneDir: a.paneDir, bundle, log: () => undefined });
    await installBundledAgentFarm({ paneDir: b.paneDir, bundle, log: () => undefined });
    await setDisplay(a, 'greenfield/orchestrator', { title: 'Chief', description: 'Runs the team', photo: SVG('red') });
    await desktop(a, [b]).syncNow();
    const overrides = OVERRIDES(b.paneDir, 'greenfield');
    expect(readFileSync(path.join(overrides, 'orchestrator.svg'), 'utf8')).toBe(SVG('red'));
    expect(readFileSync(path.join(overrides, 'orchestrator.json'), 'utf8')).toBe(readFileSync(path.join(OVERRIDES(a.paneDir, 'greenfield'), 'orchestrator.json'), 'utf8'));
    // Agent Farm on B shows A's title and photo.
    const listed = decodeBoundary(JSON.parse(await agentFarm(b.paneDir, ['profiles', 'list', '--json'])), boundary.object({ profiles: boundary.array(boundary.object({ ref: boundary.string, title: boundary.optional(boundary.string), photo: boundary.optional(boundary.nullable(boundary.string)) })) }));
    const orchestrator = listed.profiles.find(profile => profile.ref === 'greenfield/orchestrator');
    expect(orchestrator).toMatchObject({ title: 'Chief', photo: path.join(realpathSync(overrides), 'orchestrator.svg') });
    expect((await b.editor.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited).toBe(false);

    // A changes the title and removes the photo: B follows, and the removed photo goes.
    a.clock.now += 60_000;
    await setDisplay(a, 'greenfield/orchestrator', { title: 'Boss', photo: '' });
    await desktop(a, [b]).syncNow();
    expect(readFileSync(path.join(overrides, 'orchestrator.json'), 'utf8')).toContain('Boss');
    expect(existsSync(path.join(overrides, 'orchestrator.svg'))).toBe(false);

    a.clock.now += 60_000;
    const planner = 'agents/orchestrator.md';
    const text = await a.editor.read('greenfield', planner);
    await a.editor.save('greenfield', [{ path: planner, content: `${text}\nMarker: MANGO\n` }]);
    await a.host.recordChange();
    await desktop(a, [b]).syncNow();
    expect(await b.editor.read('greenfield', planner)).toContain('Marker: MANGO');
    expect((await b.editor.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited).toBe(true);
    expect(await syncedPluginEdits(agentFarmConfigRoot(b.paneDir))).toEqual(new Set(['greenfield']));
    // A Pane update on B keeps the edit that arrived (a missing manifest makes it set up again, as an update does).
    rmSync(path.join(agentFarmConfigRoot(b.paneDir), 'pane-manifest.json'));
    const status = await installBundledAgentFarm({ paneDir: b.paneDir, bundle, log: () => undefined });
    expect(status.edited).toContain('greenfield');
    expect(await b.editor.read('greenfield', planner)).toContain('Marker: MANGO');

    // Restore Pane's version on A brings it back on B too, display override kept.
    a.clock.now += 60_000;
    await a.editor.restore('greenfield');
    await a.host.recordChange();
    await desktop(a, [b]).syncNow();
    expect(await b.editor.read('greenfield', planner)).not.toContain('Marker: MANGO');
    expect((await b.editor.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited).toBe(false);
    expect(readFileSync(path.join(overrides, 'orchestrator.json'), 'utf8')).toContain('Boss');

    // Clearing the last field removes A's override files, and B's folder goes with them.
    a.clock.now += 60_000;
    await setDisplay(a, 'greenfield/orchestrator', { title: '', description: '' });
    expect(existsSync(path.join(OVERRIDES(a.paneDir, 'greenfield'), 'orchestrator.json'))).toBe(false);
    await desktop(a, [b]).syncNow();
    expect(existsSync(overrides)).toBe(false);
  }, 240_000);

  it('brings one plugin up to date on this computer before a Session uses it', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await desktop(a, [b]).syncNow();
    a.clock.now += 60_000;
    await saveMarker(a, 'CHERRY');
    // B's own desktop pulls the newest save of the profile it is about to start.
    await desktop(b, [a]).syncPlugin('labtest');
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: CHERRY');
  }, 120_000);

  it('shows a computer offline as soon as the machine connection says so, before the next sync (QA F-4)', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    const sync = desktop(a, [b]);
    await sync.syncNow();
    expect(sync.status().computers.map(entry => entry.state)).toEqual(['up-to-date']);
    b.online = false;
    expect(sync.status().computers.map(entry => entry.state)).toEqual(['offline']);
  }, 60_000);

  it('shows a computer whose Pane is too old to sync', async () => {
    const a = computer('studio', 'a-id');
    await installFixture(a.paneDir);
    const old: ProfileSyncPeer = { key: 'old', name: 'old-mac', invoke: async () => { throw Object.assign(new Error('No Pane daemon command registered for channel "profile-sync:state".'), { code: 'ERR_UNKNOWN_CHANNEL' }); } };
    const sync = new ProfileSyncCoordinator({ local: a.host, peers: () => [old], machine: () => a.id });
    const status = await sync.syncNow();
    expect(status.computers).toEqual([{ key: 'old', id: '', name: 'old-mac', state: 'outdated', waiting: [], error: 'Pane on old-mac is too old to sync profiles. Update Pane there.' }]);
  }, 60_000);
});

describe('profile sync: review fixes (fix round 2)', () => {
  it('never records a deletion when a receipt or the receipts folder can\'t be read (F-1)', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await desktop(a, [b]).syncNow();
    const receipts = path.join(agentFarmConfigRoot(a.paneDir), '.plugins');
    const receipt = path.join(receipts, 'labtest.json');
    a.clock.now += 60_000;
    chmodSync(receipt, 0o000);
    try { await desktop(a, [b]).syncNow(); }
    finally { chmodSync(receipt, 0o600); }
    chmodSync(receipts, 0o000);
    try { await desktop(a, [b]).syncNow(); }
    finally { chmodSync(receipts, 0o700); }
    expect((await readProfileSync(agentFarmConfigRoot(a.paneDir))).plugins.labtest?.state).toBe('saved');
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: APPLE');
  }, 120_000);

  it('keeps a save made here while another computer\'s save is installing (F-2)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered: () => void = () => undefined;
    const installing = new Promise<void>(resolve => { entered = resolve; });
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id', tempDir(), {
      run: async process => {
        if (process.args.includes('install')) { entered(); await gate; }
        return (await execFileAsync(process.executable, process.args, { env: process.env })).stdout;
      },
    });
    await installFixture(a.paneDir);
    await installFixture(b.paneDir);
    a.clock.now = Date.now() + 60_000;
    await saveMarker(a, 'INCOMING');
    const text = readFileSync(WRITER(b.paneDir), 'utf8').replace(/Marker: \w+/, 'Marker: LOCAL');
    const syncing = desktop(a, [b]).syncNow();
    await installing;
    // B's person saves while A's save is being installed on B, and later than it.
    b.clock.now = a.clock.now + 60_000;
    const saving = b.editor.save('labtest', [{ path: 'agents/writer.md', content: text }]);
    await new Promise(resolve => setTimeout(resolve, 200));
    release();
    await Promise.all([syncing, saving]);
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: LOCAL');
    expect((await readProfileSync(agentFarmConfigRoot(b.paneDir))).plugins.labtest).toMatchObject({ machine: 'b-id' });
  }, 120_000);

  it('keeps the last good copy when an arriving save can\'t be finished (F-3)', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await installFixture(b.paneDir, 'labtest', 'MINE');
    // A photo travels with A's save, but on B its file's name is taken by a folder, so it can't be written there.
    await setDisplay(b, 'labtest/writer', { title: 'Mine' });
    a.clock.now = Date.now() + 60_000;
    await setDisplay(a, 'labtest/writer', { title: 'Scribe', photo: SVG('red') });
    mkdirSync(path.join(OVERRIDES(b.paneDir, 'labtest'), 'writer.svg', 'in-the-way'), { recursive: true });
    const before = (await readProfileSync(agentFarmConfigRoot(b.paneDir))).plugins.labtest;
    const status = await desktop(a, [b]).syncNow();
    expect(status.computers[0]).toMatchObject({ state: 'failed' });
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: MINE');
    expect(existsSync(path.join(agentFarmConfigRoot(b.paneDir), '.plugins', 'labtest.json'))).toBe(true);
    expect((await readProfileSync(agentFarmConfigRoot(b.paneDir))).plugins.labtest).toEqual(before);
    // B's own title came back.
    expect(readFileSync(path.join(OVERRIDES(b.paneDir, 'labtest'), 'writer.json'), 'utf8')).toContain('Mine');
  }, 120_000);

  it('keeps an edited Pane plugin when restoring Pane\'s version of it fails (F-3)', async () => {
    let failInstalls = false;
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id', tempDir(), {
      run: async process => {
        if (failInstalls && process.args.includes('install')) throw Object.assign(new Error('install failed'), { stderr: 'error: disk full' });
        return (await execFileAsync(process.executable, process.args, { env: process.env })).stdout;
      },
    });
    await installBundledAgentFarm({ paneDir: a.paneDir, bundle, log: () => undefined });
    await installBundledAgentFarm({ paneDir: b.paneDir, bundle, log: () => undefined });
    const planner = 'agents/orchestrator.md';
    a.clock.now = Date.now() + 60_000;
    await a.editor.save('greenfield', [{ path: planner, content: `${await a.editor.read('greenfield', planner)}\nMarker: MANGO\n` }]);
    await desktop(a, [b]).syncNow();
    expect(await b.editor.read('greenfield', planner)).toContain('Marker: MANGO');
    a.clock.now += 60_000;
    await a.editor.restore('greenfield');
    failInstalls = true;
    await desktop(a, [b]).syncNow();
    expect(await b.editor.read('greenfield', planner)).toContain('Marker: MANGO');
    expect(existsSync(path.join(agentFarmConfigRoot(b.paneDir), 'pane-installing.json'))).toBe(false);
    expect((await readProfileSync(agentFarmConfigRoot(b.paneDir))).plugins.greenfield?.state).toBe('saved');
  }, 240_000);

  it('reads only the profile a Session is about to use, here and on the other computers (F-4)', async () => {
    const reads: string[] = [];
    const a = computer('studio', 'a-id', tempDir(), { onInventory: plugin => reads.push(`a:${plugin}`) });
    const b = computer('build', 'b-id', tempDir(), { onInventory: plugin => reads.push(`b:${plugin}`) });
    await installFixture(a.paneDir);
    await installFixture(a.paneDir, 'labtwo');
    await desktop(a, [b]).syncNow();
    reads.length = 0;
    await desktop(a, [b]).syncPlugin('labtest');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(entry => entry.endsWith(':labtest'))).toBe(true);
  }, 120_000);

  it('never reads a plugin section that is a link to somewhere else (F-5)', async () => {
    const a = computer('studio', 'a-id');
    await installFixture(a.paneDir);
    await a.host.state();
    const outside = tempDir();
    mkdirSync(path.join(outside, 'secret'), { recursive: true });
    writeFileSync(path.join(outside, 'secret', 'SKILL.md'), 'not for sync\n');
    symlinkSync(outside, path.join(agentFarmConfigRoot(a.paneDir), 'plugins', 'labtest', 'skills'));
    await expect(a.host.export('labtest')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
  }, 60_000);

  it('finds the newest save on any reachable computer before a Session starts on another (F-6)', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    const c = computer('travel', 'c-id');
    await installFixture(a.paneDir);
    await desktop(a, [b, c]).syncNow();
    c.clock.now = Date.now() + 60_000;
    await saveMarker(c, 'CHERRY');
    // A starts a Session on B: C has the newest save.
    await desktop(a, [b, c]).syncPlugin('labtest', 'machine-build');
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: CHERRY');
  }, 120_000);

  it('shows a computer whose save couldn\'t be fetched as failed, and syncs again when one declines an older save (F-8)', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    const c = computer('travel', 'c-id');
    await installFixture(a.paneDir);
    await desktop(a, [b, c]).syncNow();
    c.clock.now = Date.now() + 60_000;
    await saveMarker(c, 'NEWER');
    const broken: ProfileSyncPeer = { ...peer(c), invoke: async (channel, args, timeout) => {
      if (channel === PROFILE_SYNC_CHANNELS.export) throw new Error('connection reset');
      return peer(c).invoke(channel, args, timeout);
    } };
    const sync = new ProfileSyncCoordinator({ local: a.host, peers: () => [peer(b), broken], machine: () => a.id });
    const status = await sync.syncNow();
    expect(status.computers.find(entry => entry.name === 'travel')).toMatchObject({ state: 'failed', waiting: ['labtest'] });

    // B saves while A's newer save is on its way: B keeps its own, and A syncs again to fetch it.
    a.clock.now = Date.now() + 120_000;
    await saveMarker(a, 'FROMA');
    const racing: ProfileSyncPeer = { ...peer(b), invoke: async (channel, args, timeout) => {
      if (channel === PROFILE_SYNC_CHANNELS.apply) { b.clock.now = a.clock.now + 60_000; await saveMarker(b, 'FROMB'); }
      return peer(b).invoke(channel, args, timeout);
    } };
    const again = new ProfileSyncCoordinator({ local: a.host, peers: () => [racing], machine: () => a.id });
    await again.syncNow();
    await vi.waitFor(() => expect(readFileSync(WRITER(a.paneDir), 'utf8')).toContain('Marker: FROMB'), { timeout: 15_000, interval: 250 });
    again.stop();
    sync.stop();
  }, 120_000);

  it('carries only override files with an override name of 64 KiB or less, and refuses a pack with any other', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    await setDisplay(a, 'labtest/writer', { title: 'Scribe' });
    const folder = OVERRIDES(a.paneDir, 'labtest');
    writeFileSync(path.join(folder, 'Other.json'), '{}\n');
    writeFileSync(path.join(folder, 'notes.txt'), 'not an override\n');
    writeFileSync(path.join(folder, 'huge.svg'), Buffer.alloc(64 * 1024 + 1, 0x20));
    symlinkSync(path.join(folder, 'writer.json'), path.join(folder, 'linked.json'));
    await a.host.recordChange();
    await desktop(a, [b]).syncNow();
    expect(readFileSync(path.join(OVERRIDES(b.paneDir, 'labtest'), 'writer.json'), 'utf8')).toContain('Scribe');
    for (const name of ['Other.json', 'notes.txt', 'huge.svg', 'linked.json']) expect(existsSync(path.join(OVERRIDES(b.paneDir, 'labtest'), name))).toBe(false);

    // A pack made to carry a file with another name is refused, with nothing changed.
    const c = computer('travel', 'c-id');
    await installFixture(c.paneDir, 'labtest', 'ORIGINAL');
    const exported = await a.host.export('labtest');
    const transferId = exported.transferId ?? '';
    const packFile = a.host.packFile(transferId);
    const pack = decodeBoundary(JSON.parse(readFileSync(packFile, 'utf8')), boundary.object({ files: boundary.record(boundary.string), record: profileSyncRecordSchema }));
    const files = Object.fromEntries(Object.entries(pack.files).map(([file, content]) => [file, Buffer.from(content, 'base64')]));
    const overrides = { '../escape.json': Buffer.from('{}') };
    const record = { ...pack.record, savedAt: Date.now() + 3_600_000, hash: packHash('saved', files, overrides) };
    writeFileSync(packFile, JSON.stringify({ ...pack, plugin: 'labtest', record, overrides: { '../escape.json': overrides['../escape.json'].toString('base64') } }));
    const sender = peer(c);
    const sent = await sendFile({ write: async write => decodeBoundary(await sender.invoke(PROFILE_SYNC_CHANNELS.write, [write], 1000), writeResultSchema) }, transferId, 'pack.json', packFile);
    await expect(c.host.apply({ plugin: 'labtest', record, transferId, pack: sent })).rejects.toMatchObject({ code: 'PROFILE_SYNC_DAMAGED' });
    expect(readFileSync(WRITER(c.paneDir), 'utf8')).toContain('Marker: ORIGINAL');
    expect(existsSync(path.join(agentFarmConfigRoot(c.paneDir), 'profile-overrides'))).toBe(false);
  }, 120_000);

  it('never reads or writes a display overrides folder that is a link (F-5)', async () => {
    const a = computer('studio', 'a-id');
    await installFixture(a.paneDir);
    await a.host.state();
    const outside = tempDir();
    writeFileSync(path.join(outside, 'writer.json'), '{"title":"secret"}\n');
    mkdirSync(path.join(agentFarmConfigRoot(a.paneDir), 'profile-overrides'), { recursive: true });
    symlinkSync(outside, OVERRIDES(a.paneDir, 'labtest'));
    await expect(a.host.export('labtest')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
  }, 60_000);

  it('refuses to send or take a pack larger than profiles sync (F-10)', async () => {
    const a = computer('studio', 'a-id', tempDir(), { maxPackBytes: 200 });
    await installFixture(a.paneDir);
    await expect(a.host.export('labtest')).rejects.toMatchObject({ code: 'PROFILE_SYNC_TOO_LARGE' });
    const b = computer('build', 'b-id', tempDir(), { maxPackBytes: 1000 });
    await expect(b.host.write({ moveId: 'transfer-1234', path: 'pack.json', offset: 0, content: '', last: { bytes: 5000, sha256: 'x' } })).rejects.toMatchObject({ code: 'PROFILE_SYNC_TOO_LARGE' });
    // A pack that says it is small but unpacks large is stopped while it unpacks.
    const bomb = gzipSync(Buffer.alloc(100_000)).toString('base64');
    await expect(b.host.write({ moveId: 'transfer-5678', path: 'pack.json', offset: 0, content: bomb, last: { bytes: 500, sha256: 'x' } })).rejects.toMatchObject({ code: 'ERR_MOVE_PACKAGE_DAMAGED' });
  }, 60_000);
});

describe('profile sync: the Profiles switch (D-474)', () => {
  it('syncs nothing while the switch is off, and starts as soon as it is on', async () => {
    const a = computer('studio', 'a-id');
    const b = computer('build', 'b-id');
    await installFixture(a.paneDir);
    let on = false;
    const sync = new ProfileSyncCoordinator({ local: a.host, peers: () => [peer(b)], machine: () => a.id, enabled: () => on });
    await sync.syncNow();
    sync.request();
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(existsSync(WRITER(b.paneDir))).toBe(false);
    expect(existsSync(path.join(agentFarmConfigRoot(a.paneDir), 'sync.json'))).toBe(false);
    on = true;
    await sync.syncNow();
    expect(readFileSync(WRITER(b.paneDir), 'utf8')).toContain('Marker: APPLE');
    sync.stop();
  }, 60_000);

  it('shows a computer whose Profiles switch is off as off, and sends it nothing', async () => {
    const a = computer('studio', 'a-id');
    await installFixture(a.paneDir);
    const off: ProfileSyncPeer = { key: 'off', name: 'old-mac', invoke: async () => { throw Object.assign(new Error('Profiles is off on this computer.'), { code: PROFILE_SYNC_OFF_CODE }); } };
    const status = await new ProfileSyncCoordinator({ local: a.host, peers: () => [off], machine: () => a.id }).syncNow();
    expect(status.computers).toEqual([{ key: 'off', id: '', name: 'old-mac', state: 'off', waiting: [], error: 'Profiles is off on old-mac. Turn it on there to sync.' }]);
  }, 60_000);
});
