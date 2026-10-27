import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSessions, type ScanOptions } from './scan';
import type { FoundSession, ReaderContext } from './sources/types';
import type { SessionImportSource } from '../../../../shared/types/sessionImport';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let root: string;
let repo: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-import-scan-')));
  repo = path.join(root, 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  worktree = path.join(root, 'app-feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Session ids are UUIDs, as the agents write them; tests name them for readability. */
const ids = new Map<string, string>();
function id(label: string): string {
  const known = ids.get(label);
  if (known) return known;
  const fresh = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`;
  ids.set(label, fresh);
  return fresh;
}
function name(sessionId: string): string {
  return [...ids].find(([, value]) => value === sessionId)?.[0] ?? sessionId;
}

const context: ReaderContext = {
  env: {}, home: '/nowhere', platform: 'darwin', now: NOW, sinceMs: NOW - 30 * DAY, tempDir: os.tmpdir(),
  isPidAlive: () => false, processCommands: async () => [],
};

function session(overrides: Partial<FoundSession> & Pick<FoundSession, 'sessionId'>): FoundSession {
  return { source: 'claude', agent: 'claude', folder: repo, lastActiveMs: NOW - HOUR, running: 'no', ...overrides };
}

type SourceEntry = ScanOptions['readers'][number];

function reader(source: SessionImportSource, sessions: FoundSession[]): SourceEntry {
  return { source, read: async () => ({ source, status: 'ok', storePaths: [`/store/${source}`], sessions }) };
}

async function scan(readers: SourceEntry[], alreadyInPane: string[] = [], excludedRoots: string[] = []) {
  return scanSessions({ context, readers, alreadyInPane: new Set(alreadyInPane), excludedRoots });
}

describe('scanSessions', () => {
  it('works out checkout, repository and branch from git', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: id('main-1') }),
      session({ sessionId: id('wt-1'), folder: worktree }),
    ])]);

    const bySession = new Map(result.sessions.map(entry => [name(entry.sessionId), entry]));
    expect(bySession.get('main-1')).toMatchObject({ checkout: repo, repoRoot: repo, repoName: 'app', branch: 'main' });
    expect(bySession.get('wt-1')).toMatchObject({ checkout: worktree, repoRoot: repo, repoName: 'app', branch: 'feature' });
  });

  it('keeps one entry per session id, preferring the wrapper tool and its most cautious running signal', async () => {
    const { scan: result } = await scan([
      reader('claude', [session({ sessionId: id('s1'), title: 'raw title', running: 'unknown' })]),
      reader('conductor', [session({ source: 'conductor', sessionId: id('s1'), folder: worktree, running: 'no' })]),
    ]);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ source: 'conductor', checkout: worktree, title: 'raw title', running: 'unknown', preselected: false });
  });

  it('preselects the 3 most recent sessions per checkout from the last 7 days', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: id('a'), lastActiveMs: NOW - 1 * HOUR }),
      session({ sessionId: id('b'), lastActiveMs: NOW - 2 * HOUR }),
      session({ sessionId: id('c'), lastActiveMs: NOW - 3 * HOUR }),
      session({ sessionId: id('d'), lastActiveMs: NOW - 4 * HOUR }),
      session({ sessionId: id('old'), lastActiveMs: NOW - 10 * DAY }),
      session({ sessionId: id('wt'), folder: worktree, lastActiveMs: NOW - 5 * HOUR }),
      session({ sessionId: id('too-old'), lastActiveMs: NOW - 31 * DAY }),
    ])]);

    const preselected = result.sessions.filter(entry => entry.preselected).map(entry => name(entry.sessionId));
    expect(preselected).toEqual(['a', 'b', 'c', 'wt']);
    expect(result.sessions.map(entry => name(entry.sessionId))).toEqual(['a', 'b', 'c', 'd', 'wt', 'old']);
  });

  it('says why a session cannot be brought in', async () => {
    const outside = path.join(root, 'loose');
    fs.mkdirSync(outside);
    const { scan: result } = await scan([reader('herdr', [
      session({ source: 'herdr', agent: 'amp', sessionId: id('amp-1') }),
      session({ source: 'herdr', sessionId: id('gone'), folder: path.join(root, 'deleted') }),
      session({ source: 'herdr', sessionId: id('loose'), folder: outside }),
      session({ source: 'herdr', sessionId: id('sub'), folder: path.join(repo, 'src') }),
      session({ source: 'herdr', agent: 'codex', sessionId: id('codex-sub'), folder: path.join(repo, 'src') }),
    ])]);

    const reasons = Object.fromEntries(result.sessions.map(entry => [name(entry.sessionId), entry.unavailable]));
    expect(reasons).toEqual({
      'amp-1': "Pane can't resume Amp yet",
      gone: 'folder no longer exists',
      loose: "folder isn't in a git repository",
      sub: "started in a subfolder; say 'migrate to Pane' in Pane Chat",
      'codex-sub': undefined,
    });
    expect(result.sessions.filter(entry => entry.preselected).map(entry => name(entry.sessionId))).toEqual(['codex-sub']);
  });

  it('marks sessions already in Pane and never preselects them or running ones', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: id('in-pane') }),
      session({ sessionId: id('live'), running: 'yes' }),
    ])], [`claude:${id('in-pane')}`]);

    expect(result.sessions.map(entry => [name(entry.sessionId), entry.alreadyInPane, entry.preselected])).toEqual([
      ['in-pane', true, false],
      ['live', false, false],
    ]);
  });

  it('leaves out sessions in excluded folders, including checkouts under them', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: id('kept') }),
      session({ sessionId: id('pane-worktree'), folder: path.join(worktree) }),
    ])], [], [worktree]);

    expect(result.sessions.map(entry => name(entry.sessionId))).toEqual(['kept']);
  });

  it('reports a reader that throws as unreadable and keeps the others', async () => {
    const { scan: result } = await scan([
      { source: 'emdash', read: async () => { throw new Error('bad database'); } },
      reader('claude', [session({ sessionId: id('ok') })]),
    ]);

    expect(result.sources).toEqual([
      { source: 'emdash', status: 'unreadable', reason: 'bad database', version: undefined, storePaths: [] },
      { source: 'claude', status: 'ok', reason: undefined, version: undefined, storePaths: ['/store/claude'] },
    ]);
    expect(result.sessions.map(entry => name(entry.sessionId))).toEqual(['ok']);
  });

  it('makes other sessions in a checkout unavailable while one of its sessions runs outside Pane', async () => {
    const { scan: result } = await scan([
      reader('claude', [session({ sessionId: id('live-a'), running: 'yes' })]),
      reader('conductor', [session({ source: 'conductor', sessionId: id('idle-b') }), session({ source: 'conductor', sessionId: id('other-wt'), folder: worktree })]),
    ]);

    const byName = Object.fromEntries(result.sessions.map(entry => [name(entry.sessionId), [entry.unavailable, entry.preselected]]));
    expect(byName).toEqual({
      'live-a': [undefined, false],
      'idle-b': ['another session is running in this checkout in Claude Code', false],
      'other-wt': [undefined, true],
    });
  });

  it('refuses session ids that are not in the shape the agent writes', async () => {
    const { scan: result } = await scan([reader('herdr', [
      session({ source: 'herdr', agent: 'codex', sessionId: '$(Set-Variable -Name probe -Value expanded)' }),
      session({ source: 'herdr', agent: 'opencode', sessionId: 'ses_Abc123' }),
    ])]);

    expect(result.sessions.map(entry => [entry.sessionId, entry.unavailable])).toEqual([
      ['$(Set-Variable -Name probe -Value expanded)', "its session id isn't one Codex would write"],
      ['ses_Abc123', undefined],
    ]);
  });

  it('blocks a checkout whose live session is too old to list, unless Pane already runs that session', async () => {
    const busyReader = (busy: Array<{ folder: string; agent: string; sessionId?: string }>) => ({
      source: 'claude' as const,
      read: async () => ({ source: 'claude' as const, status: 'ok' as const, storePaths: [], sessions: [session({ sessionId: id('recent-b') })], busy }),
    });

    const blocked = await scan([busyReader([{ folder: repo, agent: 'claude', sessionId: id('old-live-a') }])]);
    const inPane = await scan([busyReader([{ folder: repo, agent: 'claude', sessionId: id('old-live-a') }])], [`claude:${id('old-live-a')}`]);

    expect(blocked.scan.sessions.map(entry => [name(entry.sessionId), entry.unavailable, entry.preselected])).toEqual([
      ['recent-b', 'another session is running in this checkout in Claude Code', false],
    ]);
    expect(inPane.scan.sessions.map(entry => [name(entry.sessionId), entry.unavailable, entry.preselected])).toEqual([
      ['recent-b', undefined, true],
    ]);
  });
});
