import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../utils/commandRunner';

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each test fixture implements every dependency member reached by
  // its scenario; unexpected calls fail immediately.
  return implementation as Contract;
}
import { PathResolver } from '../../utils/pathResolver';
import { resolveDefaultWorktreeBase, WorktreeManager } from '../worktreeManager';
import { worktreePoolManager } from '../worktreePoolManager';

function commandRunner(
  execAsync: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>,
): CommandRunner {
  return partialMock<CommandRunner>({
    execAsync: vi.fn(execAsync),
    execFile: vi.fn(async (file, args, cwd) => ({ ...await execAsync([file, ...args].join(' '), cwd), exitCode: 0 })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDefaultWorktreeBase', () => {
  it('uses the remote default branch instead of the project checkout HEAD', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      if (command.includes('origin/main^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(resolveDefaultWorktreeBase('/repo', runner)).resolves.toBe('origin/main');
  });

  it('falls back when the remote default branch is dangling', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/deleted\n', stderr: '' };
      }
      if (command.includes('origin/main^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unknown ref: ${command}`);
    });

    await expect(resolveDefaultWorktreeBase('/repo', runner)).resolves.toBe('origin/main');
  });

  it('falls back to a conventional remote main ref when origin HEAD is unavailable', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) throw new Error('No remote HEAD');
      if (command.startsWith('git rev-parse --verify ') && command.includes('origin/main^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unknown ref: ${command}`);
    });

    await expect(resolveDefaultWorktreeBase('/repo', runner)).resolves.toBe('origin/main');
  });

  it('uses HEAD only when no conventional integration ref exists', async () => {
    const runner = commandRunner(async () => {
      throw new Error('Unknown ref');
    });

    await expect(resolveDefaultWorktreeBase('/repo', runner)).resolves.toBe('HEAD');
  });
});

describe('WorktreeManager.listWorktrees', () => {
  it('includes branch-backed and detached porcelain entries', async () => {
    const runner = commandRunner(async () => ({
      stdout: [
        'worktree /repo',
        'branch refs/heads/main',
        '',
        'worktree /repo/detached',
        'HEAD abc123',
        'detached',
        '',
      ].join('\n'),
      stderr: '',
    }));

    await expect(new WorktreeManager().listWorktrees('/repo', runner)).resolves.toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/repo/detached' },
    ]);
  });
});

describe('WorktreeManager.resolveWorkingDirectory', () => {
  it('persists the resolved default branch when claiming a reserve worktree', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      if (command.includes('origin/main^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      if (command === 'git branch --show-current' && cwd === '/repo/worktrees/pane') {
        return { stdout: 'pane\n', stderr: '' };
      }
      if (command === 'git rev-parse --verify --end-of-options origin/pane') {
        throw new Error('No remote pane branch');
      }
      if (command.startsWith('git rev-parse ') && command.includes('HEAD')) {
        return { stdout: 'base-commit\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.spyOn(worktreePoolManager, 'claimReserve').mockResolvedValue({ worktreePath: '/repo/worktrees/pane' });
    const manager = new WorktreeManager();

    const result = await manager.resolveWorkingDirectory(
      '/repo',
      'pane',
      undefined,
      true,
      undefined,
      new PathResolver({ path: '/repo' }),
      runner,
    );

    expect(worktreePoolManager.claimReserve).toHaveBeenCalledWith(
      '/repo',
      'origin/main',
      'pane',
      'pane',
      undefined,
      expect.anything(),
      runner,
    );
    expect(result).toEqual({
      worktreePath: '/repo/worktrees/pane',
      baseCommit: 'base-commit',
      baseBranch: 'origin/main',
    });
  });

  it('passes the resolved default branch to fresh worktree creation', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      if (command.includes('origin/main^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.spyOn(worktreePoolManager, 'claimReserve').mockResolvedValue(null);
    vi.spyOn(worktreePoolManager, 'createReserve').mockResolvedValue();
    const manager = new WorktreeManager();
    const createWorktree = vi.spyOn(manager, 'createWorktree').mockResolvedValue({
      worktreePath: '/repo/worktrees/pane',
      baseCommit: 'base-commit',
      baseBranch: 'origin/main',
    });

    const result = await manager.resolveWorkingDirectory(
      '/repo',
      'pane',
      undefined,
      true,
      undefined,
      new PathResolver({ path: '/repo' }),
      runner,
    );

    expect(createWorktree).toHaveBeenCalledWith(
      '/repo',
      'pane',
      undefined,
      'origin/main',
      undefined,
      expect.anything(),
      runner,
    );
    expect(result.baseBranch).toBe('origin/main');
  });

  function branchCheckingRunner(existingBranches: string[]): CommandRunner {
    return partialMock<CommandRunner>({
      execAsync: vi.fn(async (command: string) => {
        throw new Error(`Unexpected command: ${command}`);
      }),
      execFile: vi.fn(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'check-ref-format') {
          if (args[2].includes('..')) throw new Error('fatal: not a valid branch name');
          return { stdout: `${args[2]}\n`, stderr: '' };
        }
        if (args[0] === 'show-ref') {
          if (existingBranches.includes(args[3].slice('refs/heads/'.length))) return { stdout: '', stderr: '' };
          throw new Error('not found');
        }
        throw new Error(`Unexpected git ${args.join(' ')}`);
      }),
    });
  }

  it('claims a reserve under an explicitly requested branch name', async () => {
    const runner = branchCheckingRunner([]);
    vi.spyOn(worktreePoolManager, 'claimReserve').mockResolvedValue(null);
    vi.spyOn(worktreePoolManager, 'createReserve').mockResolvedValue();
    const manager = new WorktreeManager();
    const createWorktree = vi.spyOn(manager, 'createWorktree').mockResolvedValue({
      worktreePath: '/repo/worktrees/w5a',
      baseCommit: 'base-commit',
      baseBranch: 'release/foo',
    });

    await manager.resolveWorkingDirectory(
      '/repo', 'w5a', 'release/foo', true, undefined, new PathResolver({ path: '/repo' }), runner,
      { branchName: 'agents/w5a' },
    );

    expect(worktreePoolManager.claimReserve).toHaveBeenCalledWith(
      '/repo', 'release/foo', 'w5a', 'agents/w5a', undefined, expect.anything(), runner,
    );
    expect(createWorktree).toHaveBeenCalledWith(
      '/repo', 'w5a', 'agents/w5a', 'release/foo', undefined, expect.anything(), runner,
    );
  });

  it.each([
    ['agents/taken', "Branch 'agents/taken' already exists"],
    ['agents/bad..name', 'git check-ref-format --branch rejected it'],
    ['agents/$(touch x)', 'Invalid branch name'],
    ['-agents', 'Invalid branch name'],
  ])('rejects the requested branch %s before touching worktrees', async (branchName, message) => {
    const runner = branchCheckingRunner(['agents/taken']);
    const claimReserve = vi.spyOn(worktreePoolManager, 'claimReserve');
    const manager = new WorktreeManager();
    const createWorktree = vi.spyOn(manager, 'createWorktree');

    await expect(manager.resolveWorkingDirectory(
      '/repo', 'w5a', 'origin/main', true, undefined, new PathResolver({ path: '/repo' }), runner,
      { branchName },
    )).rejects.toThrow(message);
    expect(claimReserve).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('renames a claimed reserve branch to the exact requested name', async () => {
    const runner = commandRunner(async command => {
      if (command === 'git check-ref-format --branch agents/w5a') return { stdout: 'agents/w5a\n', stderr: '' };
      if (command === 'git fetch' || command.startsWith('git worktree add -b ')) return { stdout: '', stderr: '' };
      if (command === 'git rev-parse --verify --end-of-options origin/main') {
        return { stdout: 'base-commit\n', stderr: '' };
      }
      if (command.startsWith('git worktree move ') || command.startsWith('git branch -m ')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected command: ${command}`);
    });
    const pathResolver = partialMock<PathResolver>({ join: (...parts: string[]) => parts.join('/') });
    await worktreePoolManager.createReserve('/repo-claim', 'origin/main', undefined, pathResolver, runner);
    vi.spyOn(worktreePoolManager, 'createReserve').mockResolvedValue();

    const claimed = await worktreePoolManager.claimReserve(
      '/repo-claim', 'origin/main', 'w5a', 'agents/w5a', undefined, pathResolver, runner,
    );

    expect(claimed).toEqual({ worktreePath: '/repo-claim/worktrees/w5a' });
    const renameCall = vi.mocked(runner.execFile).mock.calls.find(([, args]) => args[0] === 'branch' && args[1] === '-m');
    expect(renameCall?.[0]).toBe('git');
    expect(renameCall?.[1]).toEqual(['branch', '-m', '--', expect.stringMatching(/^_reserve\/[0-9a-f]{8}$/), 'agents/w5a']);
  });
});

describe('WorktreeManager.getSessionComparisonBranch', () => {
  it('uses the recorded fork commit before a remote default branch for a legacy worktree', async () => {
    const runner = commandRunner(async command => {
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      {
        baseBranch: 'HEAD',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('pane-start-commit');
    expect(runner.execAsync).not.toHaveBeenCalled();
  });

  it('uses the remote default branch for a legacy worktree session', async () => {
    const runner = commandRunner(async command => {
      if (command.includes('symbolic-ref')) {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('origin/main');
  });

  it('falls back to the project branch when no remote default ref exists', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command.includes('symbolic-ref')) {
        throw new Error('No remote default');
      }
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'feature/local\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('feature/local');
  });

  it('preserves current-branch origin comparison for a main-repo session', async () => {
    const runner = commandRunner(async command => {
      if (command === 'git branch --show-current') {
        return { stdout: 'feature/local\n', stderr: '' };
      }
      if (command === 'git rev-parse --verify --end-of-options origin/feature/local') {
        return { stdout: 'abc123\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const comparisonBranch = await manager.getSessionComparisonBranch(
      { baseBranch: 'HEAD', isMainRepo: true, worktreePath: '/repo' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(comparisonBranch).toBe('origin/feature/local');
  });
});

describe('WorktreeManager.getSessionLocalBaseBranch', () => {
  it('keeps legacy write operations on the project checkout branch', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'release\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      {
        baseBranch: 'HEAD',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
    expect(runner.execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('symbolic-ref'),
      expect.any(String),
    );
  });

  it('strips the remote from an explicitly selected write target', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo/worktrees/pane') {
        return { stdout: 'pane-branch\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      { baseBranch: 'origin/release', worktreePath: '/repo/worktrees/pane' },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
  });

  it('uses the project branch when an existing-branch pane stored its own branch as the base', async () => {
    const runner = commandRunner(async (command, cwd) => {
      if (command === 'git branch --show-current' && cwd === '/repo/worktrees/pane') {
        return { stdout: 'pane-branch\n', stderr: '' };
      }
      if (command === 'git branch --show-current' && cwd === '/repo') {
        return { stdout: 'release\n', stderr: '' };
      }
      if (command === 'git remote' && cwd === '/repo') {
        return { stdout: 'origin\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = new WorktreeManager();

    const localBaseBranch = await manager.getSessionLocalBaseBranch(
      {
        baseBranch: 'pane-branch',
        baseCommit: 'pane-start-commit',
        worktreePath: '/repo/worktrees/pane',
      },
      { project: { path: '/repo' }, commandRunner: runner },
    );

    expect(localBaseBranch).toBe('release');
  });
});
