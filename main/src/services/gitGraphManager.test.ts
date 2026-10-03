import { describe, it, expect } from 'vitest';
import {
  GitGraphManager,
  type GitGraphCommandRunner,
  isPlainRefName,
  isPlainRemoteName,
  parseGraphLog,
  parseForEachRef,
  resolveRemoteScope,
} from './gitGraphManager';
import { GRAPH_REMOTE_ALL, GRAPH_REMOTE_NONE } from '../../../shared/types/gitGraph';

const REC = '\x01';
const F = '\x00';

function logRecord(fields: string[]): string {
  return REC + fields.join(F);
}

interface StubRunner extends GitGraphCommandRunner {
  commands: string[];
}

function stubRunner(responses: Array<[match: string, output: string | Error]>): StubRunner {
  const commands: string[] = [];
  const execAsync = async (command: string) => {
    commands.push(command);
    for (const [match, output] of responses) {
      if (command.includes(match)) {
        if (output instanceof Error) throw output;
        return { stdout: output, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  };
  return { execAsync, commands };
}

const noWorktrees = async () => [];

/** Every command the stub runner was asked to execute, in order. */
function execCommands(runner: StubRunner): string[] {
  return runner.commands;
}

describe('parseGraphLog', () => {
  it('parses commits with parents and metadata', () => {
    const raw =
      logRecord(['aaa111', 'aaa111'.slice(0, 7), 'bbb222 ccc333', 'merge branches', '2026-01-02T10:00:00Z', 'Ada', 'ada@example.com']) +
      logRecord(['bbb222', 'bbb222'.slice(0, 7), '', 'root', '2026-01-01T10:00:00Z', 'Ada', 'ada@example.com']);

    const nodes = parseGraphLog(raw);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      hash: 'aaa111',
      parents: ['bbb222', 'ccc333'],
      subject: 'merge branches',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
    });
    expect(nodes[1].parents).toEqual([]);
  });

  it('survives a record separator appearing inside a subject', () => {
    // A literal \x01 in the message would otherwise split one commit in two;
    // records with no usable hash are dropped rather than corrupting the graph.
    const raw = logRecord(['aaa111', 'aaa111', '', `weird${REC}subject`, '2026-01-01T00:00:00Z', 'Ada', 'a@b.c']);
    const nodes = parseGraphLog(raw);
    expect(nodes[0].hash).toBe('aaa111');
  });

  it('returns an empty array for empty output', () => {
    expect(parseGraphLog('')).toEqual([]);
    expect(parseGraphLog('   \n ')).toEqual([]);
  });
});

describe('parseForEachRef', () => {
  it('classifies heads, remotes and tags and marks the current branch', () => {
    const raw = [
      ['commit', 'refs/heads/main', 'aaa', ''].join(F),
      ['commit', 'refs/heads/feature', 'bbb', ''].join(F),
      ['commit', 'refs/remotes/origin/main', 'aaa', ''].join(F),
      ['tag', 'refs/tags/v1.0.0', 'tagobj', 'ccc'].join(F),
    ].join('\n');

    const refs = parseForEachRef(raw, 'main');

    expect(refs).toEqual([
      { kind: 'localBranch', name: 'main', hash: 'aaa', isCurrent: true },
      { kind: 'localBranch', name: 'feature', hash: 'bbb', isCurrent: false },
      { kind: 'remoteBranch', name: 'origin/main', hash: 'aaa', isCurrent: false },
      // Annotated tag peels to the commit in %(*objectname), not the tag object.
      { kind: 'tag', name: 'v1.0.0', hash: 'ccc', isCurrent: false },
    ]);
  });

  it('skips origin/HEAD, which is a symbolic alias', () => {
    const raw = ['commit', 'refs/remotes/origin/HEAD', 'aaa', ''].join(F);
    expect(parseForEachRef(raw, null)).toEqual([]);
  });
});

describe('GitGraphManager.getRepoGraph', () => {
  it('builds a graph and attaches refs to their commits', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ['commit', 'refs/heads/main', 'aaa', ''].join(F)],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, noWorktrees);

    expect(graph.currentBranch).toBe('main');
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].refs).toEqual([
      { kind: 'localBranch', name: 'main', hash: 'aaa', isCurrent: true },
    ]);
    expect(graph.truncated).toBe(false);
  });

  it('reports a detached HEAD as its own ref', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', new Error('fatal: ref HEAD is not a symbolic ref')],
      ['for-each-ref', ''],
      ['rev-parse HEAD', 'aaa\n'],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, noWorktrees);

    expect(graph.currentBranch).toBeNull();
    expect(graph.refs).toContainEqual({ kind: 'head', name: 'HEAD', hash: 'aaa', isCurrent: true });
  });

  it('flags truncation when more commits exist than the limit', async () => {
    const log = Array.from({ length: 4 }, (_, i) =>
      logRecord([`h${i}`, `h${i}`, '', `c${i}`, '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])
    ).join('');
    const runner = stubRunner([
      ['git log', log],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', { limit: 3 }, runner, noWorktrees);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.truncated).toBe(true);
    expect(graph.limit).toBe(3);
  });

  it('returns an empty graph with a notice for a repo with no commits', async () => {
    const runner = stubRunner([
      ['git log', new Error('fatal: your current branch does not have any commits yet')],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, noWorktrees);

    expect(graph.nodes).toEqual([]);
    expect(graph.notice).toMatch(/no commits/i);
  });

  it('returns an empty graph with a notice for a non-repository path', async () => {
    const runner = stubRunner([
      ['git log', new Error('fatal: not a git repository (or any of the parent directories): .git')],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/tmp/plain-dir', {}, runner, noWorktrees);

    expect(graph.nodes).toEqual([]);
    expect(graph.notice).toMatch(/not a git repository/i);
  });

  it('still returns the graph when worktree resolution fails', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, async () => {
      throw new Error('worktree list failed');
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.paneWorktrees).toEqual([]);
  });

  it('omits remote refs entirely for the local-only scope', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
      ['git remote', 'origin\nupstream\n'],
    ]);

    await new GitGraphManager().getRepoGraph(
      '/repo',
      { remoteScope: GRAPH_REMOTE_NONE },
      runner,
      noWorktrees
    );

    const commands = execCommands(runner);
    expect(commands.some(cmd => cmd.includes('git log') && cmd.includes('--branches --tags'))).toBe(true);
    expect(commands.some(cmd => cmd.includes('for-each-ref') && cmd.includes('refs/remotes'))).toBe(false);
  });

  /**
   * The reason this scoping exists: a fork's clone carries `origin` *and*
   * `upstream`, and `--all` graphed the other repository's branches alongside
   * this one's.
   */
  it('graphs only the chosen remote, not every remote in the clone', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
      ['git remote', 'origin\nupstream\n'],
    ]);

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, noWorktrees);

    expect(graph.remotes).toEqual(['origin', 'upstream']);
    expect(graph.remoteScope).toBe('origin');

    const commands = execCommands(runner);
    expect(commands.some(cmd => cmd.includes('git log') && cmd.includes('--glob=refs/remotes/origin'))).toBe(true);
    expect(commands.some(cmd => cmd.includes('git log') && cmd.includes('--all'))).toBe(false);
    expect(commands.some(cmd => cmd.includes('for-each-ref') && cmd.includes('refs/remotes/origin'))).toBe(true);
  });

  it('takes every remote only when asked', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
      ['git remote', 'origin\nupstream\n'],
    ]);

    const graph = await new GitGraphManager().getRepoGraph(
      '/repo',
      { remoteScope: GRAPH_REMOTE_ALL },
      runner,
      noWorktrees
    );

    expect(graph.remoteScope).toBe(GRAPH_REMOTE_ALL);
    expect(execCommands(runner).some(cmd => cmd.includes('git log') && cmd.includes('--all'))).toBe(true);
  });
});

describe('GitGraphManager focus and divergence', () => {
  it('narrows history to one ref when asked to focus it', async () => {
    const runner = stubRunner([
      ['rev-parse --verify', 'aaa\n'],
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
      ['git remote', 'origin\n'],
    ]);

    const graph = await new GitGraphManager().getRepoGraph(
      '/repo',
      { focusRef: 'feature/x' },
      runner,
      noWorktrees
    );

    expect(graph.focusRef).toBe('feature/x');
    const logCmd = execCommands(runner).find(cmd => cmd.includes('git log')) ?? '';
    expect(logCmd).toContain('git log feature/x');
    expect(logCmd).not.toContain('--branches');
  });

  it('ignores a well-formed focus ref that does not resolve in this repository', async () => {
    const runner = stubRunner([
      ['rev-parse --verify', new Error('unknown revision')],
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
    ]);

    const graph = await new GitGraphManager().getRepoGraph(
      '/repo',
      { focusRef: 'feature/from-another-repo' },
      runner,
      noWorktrees
    );

    expect(graph.focusRef).toBeUndefined();
    const logCmd = execCommands(runner).find(cmd => cmd.includes('git log')) ?? '';
    expect(logCmd).toContain('--branches --tags');
    expect(logCmd).not.toContain('feature/from-another-repo');
  });

  it('ignores a focus ref that could reach the shell', async () => {
    const runner = stubRunner([
      ['git log', logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c'])],
      ['symbolic-ref', 'main\n'],
      ['for-each-ref', ''],
      ['git remote', ''],
    ]);

    const graph = await new GitGraphManager().getRepoGraph(
      '/repo',
      { focusRef: 'main; rm -rf /' },
      runner,
      noWorktrees
    );

    expect(graph.focusRef).toBeUndefined();
    expect(execCommands(runner).some(cmd => cmd.includes('rm -rf'))).toBe(false);
  });

  it('falls back to the plain ref format when git has no ahead-behind', async () => {
    let attempt = 0;
    const exec = (command: string) => {
      if (command.includes('for-each-ref')) {
        attempt += 1;
        // git < 2.41 rejects the whole command rather than the one atom.
        if (command.includes('ahead-behind')) throw new Error("fatal: unknown field name: 'ahead-behind:HEAD'");
        return ['commit', 'refs/heads/main', 'aaa', ''].join(F);
      }
      if (command.includes('git log')) {
        return logRecord(['aaa', 'aaa', '', 'first', '2026-01-01T00:00:00Z', 'Ada', 'a@b.c']);
      }
      if (command.includes('symbolic-ref')) return 'main\n';
      return '';
    };
    const runner = { execAsync: async (command: string) => ({ stdout: exec(command), stderr: '' }) } satisfies GitGraphCommandRunner;

    const graph = await new GitGraphManager().getRepoGraph('/repo', {}, runner, noWorktrees);

    expect(attempt).toBe(2);
    expect(graph.refs).toHaveLength(1);
    expect(graph.refs[0].ahead).toBeUndefined();
  });
});

describe('parseForEachRef divergence', () => {
  it('reads ahead and behind counts when git reports them', () => {
    const raw = ['commit', 'refs/heads/feature', 'bbb', '', '3 1'].join(F);
    expect(parseForEachRef(raw, 'main')[0]).toMatchObject({ ahead: 3, behind: 1 });
  });

  it('leaves them absent when the field is empty', () => {
    const raw = ['commit', 'refs/heads/feature', 'bbb', '', ''].join(F);
    const ref = parseForEachRef(raw, 'main')[0];
    expect(ref.ahead).toBeUndefined();
    expect(ref.behind).toBeUndefined();
  });
});

describe('isPlainRefName', () => {
  it('accepts branch and remote-branch names', () => {
    expect(isPlainRefName('main')).toBe(true);
    expect(isPlainRefName('origin/main')).toBe(true);
    expect(isPlainRefName('feature/agent-api')).toBe(true);
    expect(isPlainRefName('v2.4.45')).toBe(true);
  });

  it('rejects options, ranges and shell metacharacters', () => {
    expect(isPlainRefName('--all')).toBe(false);
    expect(isPlainRefName('main..dev')).toBe(false);
    expect(isPlainRefName('main; echo hi')).toBe(false);
    expect(isPlainRefName('$(whoami)')).toBe(false);
  });
});

describe('resolveRemoteScope', () => {
  it('prefers origin — the remote a project was cloned from', () => {
    expect(resolveRemoteScope(undefined, ['upstream', 'origin'])).toBe('origin');
  });

  it('falls back to the first remote when there is no origin', () => {
    expect(resolveRemoteScope(undefined, ['fork', 'upstream'])).toBe('fork');
  });

  it('is local-only for a repository with no remotes', () => {
    expect(resolveRemoteScope(undefined, [])).toBe(GRAPH_REMOTE_NONE);
  });

  it('keeps the explicit sentinels', () => {
    expect(resolveRemoteScope(GRAPH_REMOTE_ALL, ['origin'])).toBe(GRAPH_REMOTE_ALL);
    expect(resolveRemoteScope(GRAPH_REMOTE_NONE, ['origin'])).toBe(GRAPH_REMOTE_NONE);
  });

  it('ignores a remote this repository does not have', () => {
    expect(resolveRemoteScope('ghost', ['origin'])).toBe('origin');
  });
});

describe('isPlainRemoteName', () => {
  it('accepts ordinary remote names', () => {
    expect(isPlainRemoteName('origin')).toBe(true);
    expect(isPlainRemoteName('my-fork.2')).toBe(true);
  });

  it('rejects anything that could reach the shell or a glob', () => {
    expect(isPlainRemoteName('a b')).toBe(false);
    expect(isPlainRemoteName('origin;rm -rf /')).toBe(false);
    expect(isPlainRemoteName('*')).toBe(false);
  });
});
