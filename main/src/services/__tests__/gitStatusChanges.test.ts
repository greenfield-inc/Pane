import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandRunner } from '../../utils/commandRunner';
import { fastGetDiffStats } from '../gitPlumbingCommands';
import { GitFileWatcher } from '../gitFileWatcher';

const metadataEvents = vi.hoisted(() => ({ change: () => {} }));
vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('events');
  return { watch: () => {
    const source = Object.assign(new EventEmitter(), { close: async () => {} });
    metadataEvents.change = () => { source.emit('all', 'change', 'index'); };
    return source;
  } };
});

let repo: string;
let runner: CommandRunner;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pane-status-changes-'));
  runner = new CommandRunner({ path: repo });
  await runner.execFile('git', ['init', '--initial-branch=main'], repo);
  await runner.execFile('git', ['config', 'user.name', 'Test User'], repo);
  await runner.execFile('git', ['config', 'user.email', 'test@example.com'], repo);
  await runner.execFile('git', ['config', 'commit.gpgsign', 'false'], repo);
  await writeFile(join(repo, 'example.txt'), 'one\ntwo\nthree\n');
  await runner.execFile('git', ['add', '-A'], repo);
  await runner.execFile('git', ['commit', '-m', 'Initial content'], repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

it('counts staged and unstaged edits together without double counting a file', async () => {
  await writeFile(join(repo, 'example.txt'), 'one\ntwo\nthree\nfour\n');
  await runner.execFile('git', ['add', '-A'], repo);
  await writeFile(join(repo, 'example.txt'), 'two\nthree\nfour\nfive\n');
  expect(await fastGetDiffStats(repo)).toEqual({ additions: 2, deletions: 1, filesChanged: 1 });
  await runner.execFile('git', ['add', '-A'], repo);
  expect(await fastGetDiffStats(repo)).toEqual({ additions: 2, deletions: 1, filesChanged: 1 });
});


it('requests fresh status after a filesystem event makes the worktree clean', async () => {
  await writeFile(join(repo, 'example.txt'), 'dirty\n');
  const watcher = new GitFileWatcher(undefined, runner);
  const refreshes: string[] = [];
  watcher.on('needs-refresh', (sessionId: string) => refreshes.push(sessionId));
  try {
    await watcher.startWatching('session', repo);
    await runner.execFile('git', ['restore', 'example.txt'], repo);
    // Deliver the OS notification deterministically; Git commands still read the real repo.
    metadataEvents.change();
    await expect.poll(() => refreshes, { timeout: 4000 }).toContain('session');
  } finally {
    watcher.stopAll();
  }
}, 10000);
