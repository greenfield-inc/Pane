import { describe, it, expect, afterEach, vi } from 'vitest';
import { worktreeFileSyncService } from '../worktreeFileSyncService';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES, type WorktreeFileSyncEntry } from '../../../../shared/types/worktreeFileSync';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRunner } from '../../utils/commandRunner';
import type { ProjectEnvironment } from '../../utils/pathResolver';

type MockCommandRunner = CommandRunner & { execAsync: ReturnType<typeof vi.fn> };

function commandRunnerWith(
  execAsync: ReturnType<typeof vi.fn>,
): MockCommandRunner {
  // SAFETY: WorktreeFileSyncService only invokes execAsync in these scenarios;
  // each fixture supplies that method with the real result shape.
  return { execAsync } as MockCommandRunner;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mock CommandRunner whose execAsync routes on command prefix.
 *
 * `findOutput`    – what `find ...` / `dir /s /b` returns (newline-separated paths)
 * `existingDests` – set of destination paths that should appear to exist
 *                   (so the copy is skipped for those)
 * `cpCommands`    – array populated with each `cp` / `copy` / `robocopy` command
 *                   string executed during the run
 */
function makeMockCommandRunner(
  findOutput: string,
  existingDests: ReadonlySet<string>,
  cpCommands: string[],
): MockCommandRunner {
  const execAsync = vi.fn().mockImplementation((cmd: string, _cwd: string) => {
    if (cmd.startsWith('find ') || cmd.startsWith('dir /') || cmd.startsWith('sh -c ')) {
      return Promise.resolve({ stdout: findOutput, stderr: '' });
    }
    if (cmd.startsWith('test -e ')) {
      // Extract the quoted path from `test -e "..."`
      const match = /^test -e "(.+)"$/.exec(cmd);
      const testedPath = match ? match[1] : '';
      if (existingDests.has(testedPath)) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('not exists'));
    }
    if (cmd.startsWith('test -f ')) {
      // Matched config/env paths are files; dependency/tool folders are directories.
      const match = /^test -f "(.+)"$/.exec(cmd);
      const testedPath = match ? match[1] : '';
      const isFile = !testedPath.endsWith('node_modules') && !testedPath.endsWith('/bin');
      if (isFile) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('not a file'));
    }
    if (cmd.startsWith('mkdir ')) {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (
      cmd.startsWith('cp ') ||
      cmd.startsWith('copy ') ||
      cmd.startsWith('robocopy ')
    ) {
      cpCommands.push(cmd);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });

  return commandRunnerWith(execAsync);
}

function isMatchCommand(cmd: string): boolean {
  return cmd.startsWith('find ') || cmd.startsWith('dir /') || cmd.startsWith('sh -c ');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const envEntry: WorktreeFileSyncEntry = {
  id: 'env',
  path: '.env*',
  enabled: true,
  recursive: true,
};
const nodeModulesEntry: WorktreeFileSyncEntry = {
  id: 'node_modules',
  path: 'node_modules',
  enabled: true,
  recursive: true,
};
const claudeEntry: WorktreeFileSyncEntry = {
  id: 'claude',
  path: '.claude',
  enabled: true,
  recursive: false,
};
const codexEntry: WorktreeFileSyncEntry = {
  id: 'codex',
  path: '.codex',
  enabled: true,
  recursive: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worktreeFileSyncService', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the .cursor entry in the default sync list so Cursor rules reach worktrees', () => {
    expect(DEFAULT_WORKTREE_FILE_SYNC_ENTRIES).toContainEqual(
      { id: 'cursor', path: '.cursor', enabled: true, recursive: false },
    );
  });

  // -------------------------------------------------------------------------
  // WSL environment
  //
  // These tests verify that the service produces correct POSIX destination
  // paths for nested files when environment is 'wsl'.
  //
  // NOTE ON THE BUG: On a Windows host, `path.relative` returns backslash
  // paths (e.g. `apps\api\.env`). The fix uses `path.posix.relative` for WSL
  // so the relative path always uses forward slashes. However, on Linux (the
  // test host) `path.posix` and `path` share the same implementation, so we
  // cannot simulate the Windows bug via a spy without infinite recursion.
  //
  // These tests instead verify the end-to-end behaviour: that the correct
  // POSIX cp commands are generated for nested paths when environment='wsl'.
  // -------------------------------------------------------------------------

  describe('WSL environment', () => {
    const environment: ProjectEnvironment = 'wsl';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('copies a nested .env.example with the correct POSIX destination path', async () => {
      const findOutput = `/home/user/repo/apps/api/.env.example`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/apps/api/.env.example" "/home/user/worktree/apps/api/.env.example"',
      );
    });

    it('copies multiple nested .env files across different sub-packages', async () => {
      const findOutput = [
        '/home/user/repo/apps/api/.env.example',
        '/home/user/repo/apps/web/.env.local',
        '/home/user/repo/.env',
      ].join('\n');
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(3);
      expect(cpCommands).toContain(
        'cp "/home/user/repo/apps/api/.env.example" "/home/user/worktree/apps/api/.env.example"',
      );
      expect(cpCommands).toContain(
        'cp "/home/user/repo/apps/web/.env.local" "/home/user/worktree/apps/web/.env.local"',
      );
      expect(cpCommands).toContain(
        'cp "/home/user/repo/.env" "/home/user/worktree/.env"',
      );
    });

    it('copies a deeply nested .env.local file', async () => {
      const findOutput = `/home/user/repo/packages/app/config/.env.local`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/packages/app/config/.env.local" "/home/user/worktree/packages/app/config/.env.local"',
      );
    });

    it('copies nested node_modules directories with correct POSIX destination paths', async () => {
      const findOutput = [
        '/home/user/repo/node_modules',
        '/home/user/repo/packages/app/node_modules',
      ].join('\n');
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry],
      );

      expect(cpCommands).toHaveLength(2);
      expect(cpCommands).toContain(
        'cp -rp "/home/user/repo/node_modules" "/home/user/worktree/node_modules"',
      );
      expect(cpCommands).toContain(
        'cp -rp "/home/user/repo/packages/app/node_modules" "/home/user/worktree/packages/app/node_modules"',
      );
    });

    it('skips copying when destination already exists', async () => {
      const findOutput = `/home/user/repo/apps/api/.env.example`;
      const cpCommands: string[] = [];
      const existingDests = new Set([
        '/home/user/worktree/apps/api/.env.example',
      ]);
      const runner = makeMockCommandRunner(findOutput, existingDests, cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });

    it('handles empty find results gracefully without throwing', async () => {
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner('', new Set(), cpCommands);

      await expect(
        worktreeFileSyncService.syncWorktree(
          mainRepoPath,
          worktreePath,
          runner,
          environment,
          [envEntry],
        ),
      ).resolves.not.toThrow();

      expect(cpCommands).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Linux environment
  // -------------------------------------------------------------------------

  describe('Linux environment', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('copies a nested .env file using native POSIX paths', async () => {
      const findOutput = `/home/user/repo/apps/api/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/apps/api/.env" "/home/user/worktree/apps/api/.env"',
      );
    });

    it('copies a root-level .env file on Linux', async () => {
      const findOutput = `/home/user/repo/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/.env" "/home/user/worktree/.env"',
      );
    });

    it('prunes generated worktrees directories before recursive discovery', async () => {
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner('/home/user/repo/.env', new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      const matchCall = runner.execAsync.mock.calls.find((call) => isMatchCommand(String(call[0])));
      expect(matchCall).toBeDefined();
      expect(String(matchCall?.[0])).toContain('-type d -name worktrees');
      expect(String(matchCall?.[0])).toContain('-prune -o -print');
    });
  });

  // -------------------------------------------------------------------------
  // macOS environment
  // -------------------------------------------------------------------------

  describe('macOS environment', () => {
    const environment: ProjectEnvironment = 'macos';
    const mainRepoPath = '/Users/user/repo';
    const worktreePath = '/Users/user/worktree';

    it('copies a nested .env file on macOS', async () => {
      const findOutput = `/Users/user/repo/apps/api/.env`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      // Files use plain cp on all POSIX platforms
      expect(cpCommands[0]).toBe(
        'cp "/Users/user/repo/apps/api/.env" "/Users/user/worktree/apps/api/.env"',
      );
    });

    it('copies a nested node_modules directory using macOS APFS clone command', async () => {
      const findOutput = `/Users/user/repo/packages/lib/node_modules`;
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp -c -R "/Users/user/repo/packages/lib/node_modules" "/Users/user/worktree/packages/lib/node_modules"',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Root-level (non-recursive) entries
  // -------------------------------------------------------------------------

  describe('root-level non-recursive entries', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    function makeRootDirectoryRunner(rootPath: string, copyCommands: string[]): CommandRunner {
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.startsWith('test -e ')) {
          return cmd.includes(`/repo/${rootPath}`)
            ? Promise.resolve({ stdout: '', stderr: '' })
            : Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('test -f ')) {
          return Promise.reject(new Error('not a file'));
        }
        if (cmd.includes('for item in')) {
          copyCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      return commandRunnerWith(execAsync);
    }

    it.skipIf(process.platform === 'win32')('copies .claude contents, dotfiles included, without nested worktrees', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-file-sync-'));
      tempRoots.push(root);
      const repo = path.join(root, 'repo');
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
      fs.mkdirSync(path.join(repo, '.claude', 'worktrees', 'other'), { recursive: true });
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"a":1}');
      fs.writeFileSync(path.join(repo, '.claude', '.hidden'), 'h');
      fs.writeFileSync(path.join(repo, '.claude', 'commands', 'go.md'), 'go');
      const shellEnvironment: ProjectEnvironment = process.platform === 'darwin' ? 'macos' : 'linux';

      const result = await worktreeFileSyncService.syncWorktree(
        repo,
        worktree,
        new CommandRunner({ path: repo }),
        shellEnvironment,
        [claudeEntry],
      );

      expect(result.failures).toEqual([]);
      const copied = path.join(worktree, '.claude');
      expect(fs.readFileSync(path.join(copied, 'settings.local.json'), 'utf8')).toBe('{"a":1}');
      expect(fs.readFileSync(path.join(copied, '.hidden'), 'utf8')).toBe('h');
      expect(fs.readFileSync(path.join(copied, 'commands', 'go.md'), 'utf8')).toBe('go');
      expect(fs.existsSync(path.join(copied, 'worktrees'))).toBe(false);
    });

    it('applies the generated worktrees exclusion to other agent config roots', async () => {
      const copyCommands: string[] = [];
      const runner = makeRootDirectoryRunner('.codex', copyCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [codexEntry],
      );

      expect(copyCommands).toHaveLength(1);
      expect(copyCommands[0]).toContain('/home/user/repo/.codex');
      expect(copyCommands[0]).toContain('case "$base" in worktrees) continue ;; esac');
    });

    it('applies the generated worktrees exclusion to custom config roots', async () => {
      const copyCommands: string[] = [];
      const runner = makeRootDirectoryRunner('.agent', copyCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [{
          id: 'agent',
          path: '.agent',
          enabled: true,
          recursive: false,
        }],
      );

      expect(copyCommands).toHaveLength(1);
      expect(copyCommands[0]).toContain('/home/user/repo/.agent');
      expect(copyCommands[0]).toContain('case "$base" in worktrees) continue ;; esac');
    });

    it('honors an explicit nested worktrees entry', async () => {
      const cpCommands: string[] = [];

      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'test -e "/home/user/repo/.agent/worktrees"') {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd === 'test -e "/home/user/worktree/.agent/worktrees"') {
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('test -f ')) {
          return Promise.reject(new Error('not a file'));
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.includes('for item in') || cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const runner = commandRunnerWith(execAsync);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [{
          id: 'agent-worktrees',
          path: '.agent/worktrees',
          enabled: true,
          recursive: true,
        }],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toBe(
        'cp -rp "/home/user/repo/.agent/worktrees" "/home/user/worktree/.agent/worktrees"',
      );
    });

    it('skips root-level entry when destination already exists', async () => {
      const cpCommands: string[] = [];

      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.startsWith('test -e ')) {
          // Both source and dest exist
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const runner = commandRunnerWith(execAsync);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [claudeEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Glob entries
  // -------------------------------------------------------------------------

  describe('glob entries', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('expands a custom ./venv/* entry and preserves the venv-relative destination paths', async () => {
      const findOutput = [
        '/home/user/repo/venv/bin',
        '/home/user/repo/venv/bin/python',
        '/home/user/repo/venv/pyvenv.cfg',
      ].join('\n');
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(findOutput, new Set(), cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [{
          id: 'venv',
          path: './venv/*',
          enabled: true,
          recursive: false,
        }],
      );

      expect(cpCommands).toHaveLength(2);
      expect(cpCommands).toContain(
        'cp -rp "/home/user/repo/venv/bin" "/home/user/worktree/venv/bin"',
      );
      expect(cpCommands).toContain(
        'cp "/home/user/repo/venv/pyvenv.cfg" "/home/user/worktree/venv/pyvenv.cfg"',
      );
    });

    it('rejects entries that escape the repository root', async () => {
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner('', new Set(), cpCommands);

      const result = await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [{
          id: 'escape',
          path: '../.env',
          enabled: true,
          recursive: false,
        }],
      );

      expect(cpCommands).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].path).toBe('../.env');
      expect(result.failures[0].reason).toContain('repo-relative');
    });
  });

  // -------------------------------------------------------------------------
  // Entry ordering: small/critical entries before heavyweight directories
  // -------------------------------------------------------------------------

  describe('entry ordering', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    function makeOrderingRunner(cpCommands: string[]): CommandRunner {
      let matchCallCount = 0;
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (isMatchCommand(cmd)) {
          matchCallCount += 1;
          if (matchCallCount === 2) {
            return Promise.resolve({ stdout: '/home/user/repo/node_modules', stderr: '' });
          }
          return Promise.resolve({ stdout: '/home/user/repo/.env', stderr: '' });
        }
        if (cmd.startsWith('test -e ')) {
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('test -f ')) {
          return cmd.includes('node_modules')
            ? Promise.reject(new Error('not a file'))
            : Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.includes('for item in') || cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });
      return commandRunnerWith(execAsync);
    }

    it('copies .env entries before node_modules even when node_modules is listed first', async () => {
      const cpCommands: string[] = [];
      const runner = makeOrderingRunner(cpCommands);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry, envEntry],
      );

      expect(cpCommands).toHaveLength(2);
      expect(cpCommands[0]).toBe(
        'cp "/home/user/repo/.env" "/home/user/worktree/.env"',
      );
      expect(cpCommands[1]).toBe(
        'cp -rp "/home/user/repo/node_modules" "/home/user/worktree/node_modules"',
      );
    });

    it('keeps non-heavyweight entries in config order', async () => {
      const cpCommands: string[] = [];
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (isMatchCommand(cmd)) {
          return Promise.resolve({ stdout: '/home/user/repo/.env', stderr: '' });
        }
        if (cmd === 'test -e "/home/user/repo/.claude"') {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('test -e ')) {
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('test -f ')) {
          return cmd.includes('.claude')
            ? Promise.reject(new Error('not a file'))
            : Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.includes('for item in') || cmd.startsWith('cp ')) {
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });
      const runner = commandRunnerWith(execAsync);

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry, claudeEntry],
      );

      expect(cpCommands).toHaveLength(2);
      expect(cpCommands[0]).toContain('.env');
      expect(cpCommands[1]).toContain('.claude');
    });
  });

  // -------------------------------------------------------------------------
  // Copy timeout
  // -------------------------------------------------------------------------

  describe('copy timeout', () => {
    it('passes a generous per-call timeout to copy commands', async () => {
      const cpCommands: string[] = [];
      const runner = makeMockCommandRunner(
        '/home/user/repo/node_modules',
        new Set(),
        cpCommands,
      );

      await worktreeFileSyncService.syncWorktree(
        '/home/user/repo',
        '/home/user/worktree',
        runner,
        'linux',
        [nodeModulesEntry],
      );

      const cpCall = runner.execAsync.mock.calls.find((call) => String(call[0]).startsWith('cp '));
      expect(cpCall).toBeDefined();
      expect(cpCall?.[2]).toMatchObject({ timeout: 600_000 });
    });
  });

  // -------------------------------------------------------------------------
  // Result summary: install command and failures
  // -------------------------------------------------------------------------

  describe('sync result', () => {
    const environment: ProjectEnvironment = 'linux';
    const mainRepoPath = '/home/user/repo';
    const worktreePath = '/home/user/worktree';

    it('returns the detected install command and no failures on success', async () => {
      const cpCommands: string[] = [];
      const existingDests = new Set(['/home/user/repo/pnpm-lock.yaml']);
      const runner = makeMockCommandRunner(
        '/home/user/repo/.env',
        existingDests,
        cpCommands,
      );

      const result = await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(result.installCommand).toBe('pnpm install');
      expect(result.failures).toHaveLength(0);
    });

    it('reports per-match copy failures without aborting the sync', async () => {
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (isMatchCommand(cmd)) {
          return Promise.resolve({ stdout: '/home/user/repo/node_modules', stderr: '' });
        }
        if (cmd.startsWith('test -e ')) {
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('cp ')) {
          return Promise.reject(new Error('cp blew up'));
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });
      const runner = commandRunnerWith(execAsync);

      const result = await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [nodeModulesEntry],
      );

      expect(result.installCommand).toBeNull();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].path).toBe('node_modules');
      expect(result.failures[0].reason).toContain('cp blew up');
    });

    it('continues to later entries after an earlier entry fails', async () => {
      const cpCommands: string[] = [];
      let matchCallCount = 0;
      const execAsync = vi.fn().mockImplementation((cmd: string) => {
        if (isMatchCommand(cmd)) {
          matchCallCount += 1;
          if (matchCallCount === 2) {
            return Promise.resolve({ stdout: '/home/user/repo/node_modules', stderr: '' });
          }
          return Promise.resolve({ stdout: '/home/user/repo/.env', stderr: '' });
        }
        if (cmd.startsWith('test -e ')) {
          return Promise.reject(new Error('not exists'));
        }
        if (cmd.startsWith('mkdir ')) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (cmd.startsWith('cp ')) {
          if (cmd.includes('.env')) {
            return Promise.reject(new Error('env copy failed'));
          }
          cpCommands.push(cmd);
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });
      const runner = commandRunnerWith(execAsync);

      const result = await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [envEntry, nodeModulesEntry],
      );

      expect(cpCommands).toHaveLength(1);
      expect(cpCommands[0]).toContain('node_modules');
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].path).toBe('.env');
      expect(result.failures[0].reason).toContain('env copy failed');
    });
  });

  // -------------------------------------------------------------------------
  // Disabled entries
  // -------------------------------------------------------------------------

  describe('disabled entries', () => {
    it('skips disabled entries entirely', async () => {
      const environment: ProjectEnvironment = 'linux';
      const mainRepoPath = '/home/user/repo';
      const worktreePath = '/home/user/worktree';
      const cpCommands: string[] = [];

      const disabledEntry: WorktreeFileSyncEntry = {
        ...envEntry,
        enabled: false,
      };

      const runner = makeMockCommandRunner(
        '/home/user/repo/.env',
        new Set(),
        cpCommands,
      );

      await worktreeFileSyncService.syncWorktree(
        mainRepoPath,
        worktreePath,
        runner,
        environment,
        [disabledEntry],
      );

      expect(cpCommands).toHaveLength(0);
    });
  });
});
