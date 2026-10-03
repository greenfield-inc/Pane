import { splitNulSeparated } from './gitDiffParsers';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GitDiffManager,
  MAX_UNTRACKED_INLINE_FILES,
  untrackedFilePath,
} from './gitDiffManager';
import { CommandRunner } from '../utils/commandRunner';

/**
 * Untracked files are the one place where a name that came out of the
 * repository used to be handed to a shell. Git allows a great deal in a
 * filename — spaces, quotes, `$`, backticks, parentheses, a leading dash, even
 * a newline — and the previous code built `cat "<worktree>/<file>"` and
 * `wc -l "<worktree>/<file>"` by interpolation. Under bash the `$(…)` and the
 * backticks in such a name were executed.
 *
 * The listing had a second problem of its own: without `-z`, git delimits with
 * newlines and quotes anything non-ASCII into a C escape, so `täst.txt` came
 * back as the literal `"t\303\244st.txt"` and the file disappeared from both
 * the diff and the stats.
 */

/** Names git accepts. Some are illegal on Windows, so each is tried and checked. */
const HOSTILE_NAMES = [
  'plain.txt',
  'with space.txt',
  'täst.txt',
  'dollar$(echo pwned).txt',
  'back`echo pwned`.txt',
  'quote".txt',
  "single'.txt",
  'paren(1).txt',
  '-leading-dash.txt',
  'semi;colon&pipe|.txt',
  'new\nline.txt',
];

/** A runner that answers git for real, as a host project would. */
function realRunner(): CommandRunner {
  const runner = new CommandRunner({ path: '' });
  vi.spyOn(runner, 'execAsync').mockImplementation(async (command, cwd) => ({ stdout: run(command, cwd), stderr: '' }));
  return runner;
}

/** Run a `git …` command without a shell, so the test itself cannot be the bug. */
function run(command: string, cwd: string): string {
  if (!command.startsWith('git ')) return '';
  const args = command.slice(4).match(/"[^"]*"|\S+/g)?.map(a => a.replace(/^"|"$/g, '')) ?? [];
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

describe('untracked files with hostile names', () => {
  let repo: string;
  const created: string[] = [];

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pane-untracked-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

    // Two lines each, so the additions total is simply 2 per file.
    for (const name of HOSTILE_NAMES) {
      try {
        await writeFile(join(repo, name), 'first\nsecond\n', 'utf8');
        created.push(name);
      } catch {
        // NTFS rejects ", | and a newline in a name. Those cases run on CI.
      }
    }
    // Guard against the whole set silently failing to materialise.
    expect(created.length).toBeGreaterThan(4);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lists every one of them, unquoted and unescaped', async () => {
    const manager = new GitDiffManager();
    const result = await manager.captureWorkingDirectoryDiff(repo, realRunner());

    for (const name of created) {
      expect(result.changedFiles).toContain(name);
    }
    // The regression: git's C-style quoting of a non-ASCII name.
    expect(result.changedFiles.some(file => file.includes('\\303'))).toBe(false);
    expect(result.changedFiles.some(file => file.startsWith('"'))).toBe(false);
  });

  it('reads their content instead of executing what is in the name', async () => {
    const result = await new GitDiffManager().captureWorkingDirectoryDiff(repo, realRunner());

    for (const name of created) {
      expect(result.diff).toContain(`diff --git a/${name} b/${name}`);
    }
    // Every file contributed its two lines: nothing was skipped for want of a
    // readable path, and nothing came back as the output of a substituted
    // command. `pwned` is what the embedded commands would have printed.
    expect(result.diff).not.toContain('pwned\n+');
    expect(result.stats.additions).toBe(created.length * 2);
    expect(result.stats.filesChanged).toBe(created.length);
  });

  it('leaves no trace of a command having run', async () => {
    await new GitDiffManager().captureWorkingDirectoryDiff(repo, realRunner());

    // A substituted `echo pwned` in the path would have made cat/wc read (or
    // create) a different name. The directory is exactly what was written.
    const onDisk = await readdir(repo);
    for (const name of created) {
      expect(onDisk).toContain(name);
    }
    expect(onDisk.filter(entry => entry.includes('pwned') && !created.includes(entry))).toEqual([]);
  });

  it('counts a file in a subdirectory through the right path', async () => {
    await mkdir(join(repo, 'nested dir'), { recursive: true });
    await writeFile(join(repo, 'nested dir', 'deep $file.txt'), 'a\nb\nc\n', 'utf8');

    const result = await new GitDiffManager().captureWorkingDirectoryDiff(repo, realRunner());

    expect(result.changedFiles).toContain('nested dir/deep $file.txt');
    expect(result.diff).toContain('+c');

    await rm(join(repo, 'nested dir'), { recursive: true, force: true });
  });

  it('keeps tracked filenames intact at the changed-files boundary', async () => {
    const trackedName = 'tracked täst.txt';
    await writeFile(join(repo, trackedName), 'before\n', 'utf8');
    execFileSync('git', ['add', trackedName], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'add tracked path'], { cwd: repo });
    await writeFile(join(repo, trackedName), 'after\n', 'utf8');

    const result = await new GitDiffManager().captureWorkingDirectoryDiff(repo, realRunner());

    expect(result.changedFiles).toContain(trackedName);
    expect(result.changedFiles.some(file => file.includes('\\303'))).toBe(false);
  });
});

/**
 * The other half of the change this PR made: capturing a working tree must not
 * cost a child process per untracked file, which is what froze the app.
 */
describe('working-directory capture stays bounded and off the main thread', () => {
  let repo: string;
  const fileCount = 400;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pane-untracked-many-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

    await mkdir(join(repo, 'build'), { recursive: true });
    await Promise.all(
      Array.from({ length: fileCount }, (_, i) =>
        writeFile(join(repo, 'build', `res-${i}.flat`), 'one\ntwo\n', 'utf8'))
    );
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('spawns a fixed handful of commands regardless of how many files there are', async () => {
    const runner = realRunner();
    await new GitDiffManager().captureWorkingDirectoryDiff(repo, runner);

    const asyncCalls = vi.mocked(runner.execAsync).mock.calls;
    expect(asyncCalls.length).toBeLessThan(10);
    // Nothing that reads or measures a file goes through a command any more.
    expect(asyncCalls.some(([command]) => /^(cat|wc) /.test(command))).toBe(false);
    expect(asyncCalls.filter(([command]) => command.includes('ls-files')).length).toBe(1);
  }, 60_000);

  it('caps inlined content but still reports every file', async () => {
    const result = await new GitDiffManager().captureWorkingDirectoryDiff(repo, realRunner());

    const inlined = result.diff.match(/^diff --git /gm)?.length ?? 0;
    expect(inlined).toBeLessThanOrEqual(MAX_UNTRACKED_INLINE_FILES);
    expect(result.changedFiles).toHaveLength(fileCount);
    expect(result.stats.filesChanged).toBe(fileCount);
    // Counting is not capped: every file's two lines are in the total.
    expect(result.stats.additions).toBe(fileCount * 2);
  }, 60_000);

  it('awaits head resolution before starting the file-count work', async () => {
    const runner = realRunner();
    const execute = vi.mocked(runner.execAsync).getMockImplementation();
    if (!execute) throw new Error('Missing real runner fixture');
    let finishHead: ((value: { stdout: string; stderr: string }) => void) | undefined;
    const head = new Promise<{ stdout: string; stderr: string }>(resolve => { finishHead = resolve; });
    vi.mocked(runner.execAsync).mockImplementation(async (command, cwd, options) => (
      command.includes('rev-parse') ? head : execute(command, cwd, options)
    ));
    const pending = new GitDiffManager().captureWorkingDirectoryDiff(repo, runner);
    expect(vi.mocked(runner.execAsync).mock.calls.some(([command]) => command.includes('ls-files'))).toBe(false);
    if (!finishHead) throw new Error('Missing head completion');
    finishHead({ stdout: 'a'.repeat(40), stderr: '' });
    const result = await pending;
    expect(result.beforeHash).toBe('a'.repeat(40));
    expect(vi.mocked(runner.execAsync).mock.calls.filter(([command]) => command.includes('ls-files'))).toHaveLength(1);
  }, 60_000);

});

describe('splitNulSeparated', () => {
  it('keeps a name containing a newline in one piece', () => {
    expect(splitNulSeparated('a\nb.txt\0c.txt\0')).toEqual(['a\nb.txt', 'c.txt']);
  });

  it('keeps the spaces that are part of a name', () => {
    expect(splitNulSeparated(' leading.txt\0trailing .txt\0')).toEqual([' leading.txt', 'trailing .txt']);
  });

  it('is empty for empty output', () => {
    expect(splitNulSeparated('')).toEqual([]);
  });
});

describe('untrackedFilePath', () => {
  it('reaches a WSL worktree through the mount Windows can see', () => {
    const path = untrackedFilePath('/home/dev/project', 'src/new file.ts', {
      enabled: true,
      distribution: 'Ubuntu',
      linuxPath: '/home/dev/project',
    });

    expect(path).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\src\\new file.ts');
  });

  it('joins natively for a host project', () => {
    const path = untrackedFilePath(join('repo', 'wt'), 'src/new.ts', null);
    expect(path).toBe(join('repo', 'wt', 'src', 'new.ts'));
  });
});
