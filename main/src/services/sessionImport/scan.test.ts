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
      session({ sessionId: 'main-1' }),
      session({ sessionId: 'wt-1', folder: worktree }),
    ])]);

    const bySession = new Map(result.sessions.map(entry => [entry.sessionId, entry]));
    expect(bySession.get('main-1')).toMatchObject({ checkout: repo, repoRoot: repo, repoName: 'app', branch: 'main' });
    expect(bySession.get('wt-1')).toMatchObject({ checkout: worktree, repoRoot: repo, repoName: 'app', branch: 'feature' });
  });

  it('keeps one entry per session id, preferring the wrapper tool and its most cautious running signal', async () => {
    const { scan: result } = await scan([
      reader('claude', [session({ sessionId: 's1', title: 'raw title', running: 'unknown' })]),
      reader('conductor', [session({ source: 'conductor', sessionId: 's1', folder: worktree, running: 'no' })]),
    ]);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ source: 'conductor', checkout: worktree, title: 'raw title', running: 'unknown', preselected: false });
  });

  it('preselects the 3 most recent sessions per checkout from the last 7 days', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: 'a', lastActiveMs: NOW - 1 * HOUR }),
      session({ sessionId: 'b', lastActiveMs: NOW - 2 * HOUR }),
      session({ sessionId: 'c', lastActiveMs: NOW - 3 * HOUR }),
      session({ sessionId: 'd', lastActiveMs: NOW - 4 * HOUR }),
      session({ sessionId: 'old', lastActiveMs: NOW - 10 * DAY }),
      session({ sessionId: 'wt', folder: worktree, lastActiveMs: NOW - 5 * HOUR }),
      session({ sessionId: 'too-old', lastActiveMs: NOW - 31 * DAY }),
    ])]);

    const preselected = result.sessions.filter(entry => entry.preselected).map(entry => entry.sessionId);
    expect(preselected).toEqual(['a', 'b', 'c', 'wt']);
    expect(result.sessions.map(entry => entry.sessionId)).toEqual(['a', 'b', 'c', 'd', 'wt', 'old']);
  });

  it('says why a session cannot be brought in', async () => {
    const outside = path.join(root, 'loose');
    fs.mkdirSync(outside);
    const { scan: result } = await scan([reader('herdr', [
      session({ source: 'herdr', agent: 'amp', sessionId: 'amp-1' }),
      session({ source: 'herdr', sessionId: 'gone', folder: path.join(root, 'deleted') }),
      session({ source: 'herdr', sessionId: 'loose', folder: outside }),
      session({ source: 'herdr', sessionId: 'sub', folder: path.join(repo, 'src') }),
      session({ source: 'herdr', agent: 'codex', sessionId: 'codex-sub', folder: path.join(repo, 'src') }),
    ])]);

    const reasons = Object.fromEntries(result.sessions.map(entry => [entry.sessionId, entry.unavailable]));
    expect(reasons).toEqual({
      'amp-1': "Pane can't resume Amp yet",
      gone: 'folder no longer exists',
      loose: "folder isn't in a git repository",
      sub: "started in a subfolder; say 'migrate to Pane' in Pane Chat",
      'codex-sub': undefined,
    });
    expect(result.sessions.filter(entry => entry.preselected).map(entry => entry.sessionId)).toEqual(['codex-sub']);
  });

  it('marks sessions already in Pane and never preselects them or running ones', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: 'in-pane' }),
      session({ sessionId: 'live', running: 'yes' }),
    ])], ['claude:in-pane']);

    expect(result.sessions.map(entry => [entry.sessionId, entry.alreadyInPane, entry.preselected])).toEqual([
      ['in-pane', true, false],
      ['live', false, false],
    ]);
  });

  it('leaves out sessions in excluded folders, including checkouts under them', async () => {
    const { scan: result } = await scan([reader('claude', [
      session({ sessionId: 'kept' }),
      session({ sessionId: 'pane-worktree', folder: path.join(worktree) }),
    ])], [], [worktree]);

    expect(result.sessions.map(entry => entry.sessionId)).toEqual(['kept']);
  });

  it('reports a reader that throws as unreadable and keeps the others', async () => {
    const { scan: result } = await scan([
      { source: 'emdash', read: async () => { throw new Error('bad database'); } },
      reader('claude', [session({ sessionId: 'ok' })]),
    ]);

    expect(result.sources).toEqual([
      { source: 'emdash', status: 'unreadable', reason: 'bad database', version: undefined, storePaths: [] },
      { source: 'claude', status: 'ok', reason: undefined, version: undefined, storePaths: ['/store/claude'] },
    ]);
    expect(result.sessions.map(entry => entry.sessionId)).toEqual(['ok']);
  });
});
