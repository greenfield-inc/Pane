import { describe, it, expect, vi } from 'vitest';
import {
  GitDiffManager,
  parseNumstatZ,
  parseNameStatusZ,
  parseUntrackedPathsZ,
  mergeFileChanges,
} from './gitDiffManager';
import { WORKING_TREE_REF } from '../../../shared/types/git';
import { CommandRunner } from '../utils/commandRunner';

const COMMIT_HASH = 'a'.repeat(40);
const MERGE_HASH = 'b'.repeat(40);
const LARGE_COMMIT_HASH = 'c'.repeat(40);

/**
 * Builds a CommandRunner stub whose awaited `execFile` dispatches on a substring of the
 * command, so each test only has to describe the outputs it cares about.
 */
function stubRunner(responses: Array<[match: string, output: string]>): CommandRunner {
  const runner = new CommandRunner({ path: '/repo' });
  vi.spyOn(runner, 'execFile').mockImplementation(async (executable, args) => {
    const command = [executable, ...args].join(' ');
    for (const [match, output] of responses) {
      if (command.includes(match)) return { stdout: output, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  return runner;
}

describe('parseNumstatZ', () => {
  it('parses plain add/modify/delete records', () => {
    const raw = '10\t2\tsrc/a.ts\0' + '0\t7\tsrc/b.ts\0' + '3\t0\tREADME.md\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'src/a.ts', path: 'src/a.ts', additions: 10, deletions: 2, isBinary: false },
      { oldPath: 'src/b.ts', path: 'src/b.ts', additions: 0, deletions: 7, isBinary: false },
      { oldPath: 'README.md', path: 'README.md', additions: 3, deletions: 0, isBinary: false },
    ]);
  });

  it('parses a rename record with its two trailing path tokens', () => {
    const raw = '1\t1\t\0old/name.ts\0new/name.ts\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'old/name.ts', path: 'new/name.ts', additions: 1, deletions: 1, isBinary: false },
    ]);
  });

  it('marks binary files with null counts', () => {
    const raw = '-\t-\tassets/logo.png\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'assets/logo.png', path: 'assets/logo.png', additions: null, deletions: null, isBinary: true },
    ]);
  });

  it('keeps paths containing spaces, quotes and tabs intact', () => {
    const raw = '2\t0\tsrc/my "odd"\tname.ts\0';
    expect(parseNumstatZ(raw)).toEqual([
      { oldPath: 'src/my "odd"\tname.ts', path: 'src/my "odd"\tname.ts', additions: 2, deletions: 0, isBinary: false },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses single-path statuses', () => {
    const raw = 'M\0src/a.ts\0' + 'A\0src/new.ts\0' + 'D\0src/gone.ts\0';
    expect(parseNameStatusZ(raw)).toEqual([
      { oldPath: 'src/a.ts', path: 'src/a.ts', status: 'modified' },
      { oldPath: 'src/new.ts', path: 'src/new.ts', status: 'added' },
      { oldPath: 'src/gone.ts', path: 'src/gone.ts', status: 'deleted' },
    ]);
  });

  it('parses renames with two paths', () => {
    const raw = 'R100\0old/name.ts\0new/name.ts\0';
    expect(parseNameStatusZ(raw)).toEqual([
      { oldPath: 'old/name.ts', path: 'new/name.ts', status: 'renamed' },
    ]);
  });

  it('maps unknown status letters to "unknown"', () => {
    expect(parseNameStatusZ('X\0weird.ts\0')).toEqual([
      { oldPath: 'weird.ts', path: 'weird.ts', status: 'unknown' },
    ]);
  });
});

describe('parseUntrackedPathsZ', () => {
  it('returns only untracked entries and skips rename originals', () => {
    // Porcelain v1 with -z packs `XY path` into one token; renames add a
    // second token holding the original path.
    const raw = ' M tracked.ts\0' + 'R  renamed-new.ts\0renamed-old.ts\0' + '?? brand-new.ts\0';
    expect(parseUntrackedPathsZ(raw)).toEqual(['brand-new.ts']);
  });

  it('handles empty output', () => {
    expect(parseUntrackedPathsZ('')).toEqual([]);
  });
});

describe('mergeFileChanges', () => {
  it('takes counts from numstat and the change kind from name-status', () => {
    const numstat = parseNumstatZ('1\t1\t\0old.ts\0new.ts\0');
    const nameStatus = parseNameStatusZ('R95\0old.ts\0new.ts\0');
    expect(mergeFileChanges(numstat, nameStatus)).toEqual([
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        isBinary: false,
      },
    ]);
  });

  it('falls back to "modified" when name-status has no matching path', () => {
    const merged = mergeFileChanges(parseNumstatZ('4\t1\tsrc/a.ts\0'), []);
    expect(merged[0].status).toBe('modified');
  });
});

describe('GitDiffManager.getCommitFileChanges', async () => {
  it('lists files for a normal commit', async () => {
    const runner = stubRunner([
      ['rev-list', `${COMMIT_HASH} parent1\n`],
      ['--numstat', '10\t2\tsrc/a.ts\0'],
      ['--name-status', 'M\0src/a.ts\0'],
    ]);

    const result = await new GitDiffManager().getCommitFileChanges('/repo', COMMIT_HASH, runner);

    expect(result.ref).toBe(COMMIT_HASH);
    expect(result.isMergeAgainstFirstParent).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 });
  });

  it('flags merge commits and diffs them against the first parent', async () => {
    const runner = stubRunner([
      ['rev-list', `${MERGE_HASH} parent1 parent2\n`],
      ['--numstat', '1\t0\tsrc/a.ts\0'],
      ['--name-status', 'M\0src/a.ts\0'],
    ]);

    const result = await new GitDiffManager().getCommitFileChanges('/repo', MERGE_HASH, runner);

    expect(result.isMergeAgainstFirstParent).toBe(true);
    const commands = vi.mocked(runner.execFile).mock.calls.map(call => [call[0], ...call[1]].join(' '));
    expect(commands.some(cmd => cmd.includes('--numstat') && cmd.includes('--first-parent'))).toBe(true);
  });

  it('truncates commits above the per-commit cap', async () => {
    const numstat = Array.from({ length: 600 }, (_, i) => `1\t0\tfile${i}.ts\0`).join('');
    const runner = stubRunner([
      ['rev-list', `${LARGE_COMMIT_HASH} parent1\n`],
      ['--numstat', numstat],
      ['--name-status', ''],
    ]);

    const result = await new GitDiffManager().getCommitFileChanges('/repo', LARGE_COMMIT_HASH, runner);

    expect(result.totalFiles).toBe(600);
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('includes untracked files without counts for the working tree', async () => {
    const runner = stubRunner([
      ['git diff --numstat', '3\t1\ttracked.ts\0'],
      ['git diff --name-status', 'M\0tracked.ts\0'],
      ['status --porcelain', '?? untracked.ts\0'],
    ]);

    const result = await new GitDiffManager().getCommitFileChanges('/repo', WORKING_TREE_REF, runner);

    expect(result.ref).toBe(WORKING_TREE_REF);
    expect(result.files).toHaveLength(2);
    expect(result.files[1]).toMatchObject({
      path: 'untracked.ts',
      status: 'added',
      additions: null,
      deletions: null,
    });
  });

  it('returns an empty result instead of throwing on git failure', async () => {
    const runner = stubRunner([]);
    vi.mocked(runner.execFile).mockImplementation(async () => {
      throw new Error('fatal: bad revision');
    });

    const result = await new GitDiffManager().getCommitFileChanges('/repo', COMMIT_HASH, runner);

    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
  });
  it('rejects a shell-like ref before running a command', async () => {
    const runner = stubRunner([]);

    const result = await new GitDiffManager().getCommitFileChanges('/repo', 'HEAD; touch /tmp/pwned', runner);

    expect(result.files).toEqual([]);
    expect(runner.execFile).not.toHaveBeenCalled();
  });
});
