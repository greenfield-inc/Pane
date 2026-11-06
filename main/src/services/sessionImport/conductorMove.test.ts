import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { moveWorkspaces, scanConductorMove, type MoveTarget } from './conductorMove';
import { registerHostPlacementCommands, type HostPlacementPort } from './hostPlace';
import type { ReaderContext } from './sources/types';

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '019a0000-0000-7000-8000-00000000000a';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

let root: string;
let macHome: string;
let hostHome: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-move-')));
  macHome = path.join(root, 'mac');
  hostHome = path.join(root, 'host');
  fs.mkdirSync(hostHome, { recursive: true });
  // The shared remote, standing in for GitHub; its name is the repository's name.
  origin = path.join(root, 'remote', 'app.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '--quiet', origin, seed);
  write(path.join(seed, 'README.md'), 'hello\n');
  write(path.join(seed, '.gitignore'), '.setup-ran\n');
  write(path.join(seed, '.conductor', 'settings.toml'), '[scripts]\nsetup = "echo \\"$CONDUCTOR_ROOT_PATH\\" > .setup-ran"\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'first');
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A Conductor workspace: its own clone of the remote on a branch. */
function workspace(name: string, branch: string): string {
  const folder = path.join(macHome, 'conductor', 'workspaces', 'app', name);
  git(root, 'clone', '--quiet', origin, folder);
  git(folder, 'switch', '--quiet', '-c', branch);
  return folder;
}

function writeConductorDb(rows: Array<{ key: string; name: string; branch: string; folder: string }>, sessions: Array<{ id: string; workspace: string; agent: string; claudeId?: string; title: string }>): void {
  const file = path.join(macHome, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE workspaces (local_id TEXT PRIMARY KEY, directory_name TEXT, branch TEXT, workspace_path TEXT, state TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, claude_session_id TEXT, title TEXT, status TEXT, updated_at TEXT);
  `);
  for (const row of rows) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, \'ready\')').run(row.key, row.name, row.branch, row.folder);
  for (const session of sessions) {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, \'idle\', \'2026-10-26 09:00:00\')').run(session.id, session.workspace, session.agent, session.claudeId ?? null, session.title);
  }
  db.close();
}

function claudeTranscriptPath(home: string, folder: string): string {
  return path.join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/gu, '-'), `${CLAUDE_ID}.jsonl`);
}

function codexRolloutPath(home: string): string {
  return path.join(home, '.codex', 'sessions', '2026', '10', '25', `rollout-2026-10-25T09-00-00-${CODEX_ID}.jsonl`);
}

function macContext(): ReaderContext {
  return {
    env: { HOME: macHome },
    home: macHome,
    platform: 'darwin',
    now: Date.parse('2026-10-26T12:00:00Z'),
    sinceMs: 0,
    tempDir: root,
    isPidAlive: () => false,
    processCommands: async () => [],
  };
}

/** The machine's Pane: real git, uploads and placement; the Pane's own Panes and tabs are recorded. */
function fakeHost() {
  const registry = new PaneCommandRegistry();
  const repos: Array<{ id: number; path: string }> = [];
  const panes = new Map<string, string>();
  const tabs: Array<{ paneId: string; agent: string; resume?: string; checkout: string }> = [];
  const port: Omit<HostPlacementPort, 'uploadedFile' | 'onStep'> = {
    home: hostHome,
    machineName: 'cloud-box',
    stores: { claudeConfigDir: path.join(hostHome, '.claude'), codexHome: path.join(hostHome, '.codex') },
    paneDir: path.join(hostHome, '.pane'),
    repos: () => repos,
    async cloneRepo(url, destDir) {
      const clone = path.join(destDir, 'app');
      git(destDir, 'clone', '--quiet', url, clone);
      return clone;
    },
    async addRepo(repoRoot) {
      const known = repos.find(repo => repo.path === repoRoot);
      if (known) return known.id;
      repos.push({ id: repos.length + 1, path: repoRoot });
      return repos.length;
    },
    paneForCheckout: checkout => (panes.has(checkout) ? { paneId: panes.get(checkout) ?? '', name: path.basename(checkout) } : undefined),
    async adopt(_repoId, checkout, _name, agent, resume) {
      const paneId = `pane-${panes.size + 1}`;
      panes.set(checkout, paneId);
      tabs.push({ paneId, agent, resume, checkout });
      return { paneId, panelId: `panel-${tabs.length}` };
    },
    async adoptWithoutChat(_repoId, checkout) {
      const paneId = `pane-${panes.size + 1}`;
      panes.set(checkout, paneId);
      tabs.push({ paneId, agent: 'claude', checkout });
      return { paneId };
    },
    async addTab(paneId, agent, resume) {
      tabs.push({ paneId, agent, resume, checkout: [...panes].find(([, id]) => id === paneId)?.[0] ?? '' });
      return { panelId: `panel-${tabs.length}` };
    },
    storedResumeId: panelId => tabs[Number(panelId.slice('panel-'.length)) - 1]?.resume,
    waitReady: async () => ({ state: 'ready' }),
    closeTab: async () => undefined,
    rollbackPane: async () => undefined,
  };
  fs.mkdirSync(port.paneDir, { recursive: true });
  registerHostPlacementCommands(registry, path.join(hostHome, '.pane', 'uploads'), port);
  const target: MoveTarget = {
    label: 'cloud-box',
    // Through JSON, as the remote connection carries every request.
    invoke: async (channel, args) => JSON.parse(JSON.stringify(await registry.invoke(channel, JSON.parse(JSON.stringify(args))) ?? null)),
  };
  return { target, tabs };
}

async function move(target: MoveTarget) {
  const scan = await scanConductorMove(macContext());
  return moveWorkspaces({ workspaces: [...scan.workspaces.values()], target, machineName: 'macbook', paneDir: path.join(macHome, '.pane'), env: { HOME: macHome }, tempDir: root });
}

// Real git on both sides, and the Mac polls each placement once a second.
const MOVE_TIMEOUT_MS = 30_000;

describe('moving Conductor workspaces to another machine', () => {
  it('lands each workspace as a Pane with its unpushed commit, uncommitted files and chats, and a second run adds nothing', async () => {
    const warsaw = workspace('warsaw', 'me/warsaw');
    write(path.join(warsaw, 'feature.txt'), 'committed but not pushed\n');
    git(warsaw, 'add', 'feature.txt');
    git(warsaw, 'commit', '--quiet', '-m', 'unpushed work');
    write(path.join(warsaw, 'README.md'), 'hello\nchanged, not committed\n');
    write(path.join(warsaw, 'notes.txt'), 'new and untracked\n');
    git(warsaw, 'add', 'README.md');
    const tokyo = workspace('tokyo', 'me/tokyo');
    git(tokyo, 'push', '--quiet', '-u', 'origin', 'me/tokyo');
    write(claudeTranscriptPath(macHome, warsaw), '{"type":"user","message":"remember PELICAN"}\n');
    // Claude's live-session folder, empty: no Claude process runs these chats now.
    fs.mkdirSync(path.join(macHome, '.claude', 'sessions'), { recursive: true });
    write(codexRolloutPath(macHome), `${JSON.stringify({ timestamp: '2026-10-25T09:00:00.000Z', type: 'session_meta', payload: { id: CODEX_ID, cwd: tokyo, source: 'exec', originator: 'codex_sdk_ts' } })}\n`);
    writeConductorDb(
      [{ key: 'ws-1', name: 'warsaw', branch: 'me/warsaw', folder: warsaw }, { key: 'ws-2', name: 'tokyo', branch: 'me/tokyo', folder: tokyo }],
      [{ id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_ID, title: 'Fix checkout' }, { id: 's-2', workspace: 'ws-2', agent: 'codex', title: 'Port the API' }],
    );
    const macHead = git(warsaw, 'rev-parse', 'HEAD');
    const macStatus = git(warsaw, 'status', '--porcelain');
    const host = fakeHost();

    const result = await move(host.target);

    expect(result.results.map(entry => [entry.name, entry.outcome, entry.reason])).toEqual([['warsaw', 'moved', undefined], ['tokyo', 'moved', undefined]]);
    const hostWarsaw = path.join(hostHome, 'pane', 'workspaces', 'app', 'warsaw');
    expect(result.results[0].worktreePath).toBe(hostWarsaw);
    expect(git(hostWarsaw, 'rev-parse', 'HEAD')).toBe(macHead);
    expect(git(hostWarsaw, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('me/warsaw');
    expect(fs.readFileSync(path.join(hostWarsaw, 'feature.txt'), 'utf8')).toBe('committed but not pushed\n');
    expect(fs.readFileSync(path.join(hostWarsaw, 'README.md'), 'utf8')).toBe('hello\nchanged, not committed\n');
    expect(fs.readFileSync(path.join(hostWarsaw, 'notes.txt'), 'utf8')).toBe('new and untracked\n');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: hostWarsaw, encoding: 'utf8' }).trimEnd().split('\n').sort()).toEqual([' M README.md', '?? notes.txt']);
    // The setup script from .conductor/settings.toml ran once, in the new worktree, with Conductor's variables.
    expect(fs.readFileSync(path.join(hostWarsaw, '.setup-ran'), 'utf8')).toBe(`${path.join(hostHome, 'pane', 'repos', 'app')}\n`);
    expect(result.results[0].setup).toEqual({ source: '.conductor/settings.toml', ok: true });
    // Chats are copied into the machine's own stores and resumed by their ids.
    expect(fs.readFileSync(claudeTranscriptPath(hostHome, warsaw), 'utf8')).toBe('{"type":"user","message":"remember PELICAN"}\n');
    expect(fs.existsSync(codexRolloutPath(hostHome))).toBe(true);
    expect(host.tabs.map(tab => [tab.checkout, tab.agent, tab.resume])).toEqual([
      [hostWarsaw, 'claude', CLAUDE_ID],
      [path.join(hostHome, 'pane', 'workspaces', 'app', 'tokyo'), 'codex', CODEX_ID],
    ]);
    // The Mac is as it was: same commit, same staged and unstaged files, no refs left behind.
    expect(git(warsaw, 'rev-parse', 'HEAD')).toBe(macHead);
    expect(git(warsaw, 'status', '--porcelain')).toBe(macStatus);
    expect(git(warsaw, 'for-each-ref', 'refs/pane-import')).toBe('');

    const again = await move(host.target);

    expect(again.results.map(entry => [entry.name, entry.outcome])).toEqual([['warsaw', 'already there'], ['tokyo', 'already there']]);
    expect(host.tabs).toHaveLength(2);
  }, MOVE_TIMEOUT_MS);

  it('sends the whole branch when the machine lacks commits the Mac thinks the remote has', async () => {
    const folder = workspace('lisbon', 'me/lisbon');
    write(path.join(folder, 'base.txt'), 'on a branch the remote later deleted\n');
    git(folder, 'add', 'base.txt');
    git(folder, 'commit', '--quiet', '-m', 'base');
    git(folder, 'push', '--quiet', 'origin', 'HEAD:refs/heads/old-base');
    git(origin, 'branch', '-D', 'old-base');
    write(path.join(folder, 'top.txt'), 'unpushed\n');
    git(folder, 'add', 'top.txt');
    git(folder, 'commit', '--quiet', '-m', 'top');
    writeConductorDb([{ key: 'ws-1', name: 'lisbon', branch: 'me/lisbon', folder }], []);
    const host = fakeHost();

    const result = await move(host.target);

    expect(result.results.map(entry => [entry.outcome, entry.reason])).toEqual([['moved', undefined]]);
    const placed = path.join(hostHome, 'pane', 'workspaces', 'app', 'lisbon');
    expect(git(placed, 'rev-parse', 'HEAD')).toBe(git(folder, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(placed, 'base.txt'), 'utf8')).toBe('on a branch the remote later deleted\n');
    // A workspace with no chats still becomes a Pane, with an agent tab that isn't started.
    expect(host.tabs.map(tab => [tab.checkout, tab.resume])).toEqual([[placed, undefined]]);
  }, MOVE_TIMEOUT_MS);
});
