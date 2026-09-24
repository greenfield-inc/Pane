import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { ensureFastGitConfig, forceRemoveWorktree } from '../gitPerformanceConfig';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const hasFsmonitorDaemon = git(tmpdir(), 'version', '--build-options').includes('fsmonitor--daemon');

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pane-git-config-'));
  directories.push(directory);
  return directory;
}

function repository(): string {
  const cwd = temporaryDirectory();
  git(cwd, 'init', '-q');
  return cwd;
}

function localConfig(cwd: string, key: string): string | undefined {
  try {
    return git(cwd, 'config', '--local', '--get', key);
  } catch {
    return undefined;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ensureFastGitConfig', () => {
  it('turns on the fast status settings in a repository without them', async () => {
    const cwd = repository();

    await ensureFastGitConfig(cwd, new CommandRunner({ path: cwd }));

    expect(localConfig(cwd, 'feature.manyFiles')).toBe('true');
    expect(localConfig(cwd, 'core.fsmonitor')).toBe(hasFsmonitorDaemon ? 'true' : undefined);
  });

  it('keeps values the user set in the repository or in global config', async () => {
    const globalConfig = join(temporaryDirectory(), 'gitconfig');
    writeFileSync(globalConfig, '[core]\n\tfsmonitor = false\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    const cwd = repository();
    git(cwd, 'config', 'feature.manyFiles', 'false');

    await ensureFastGitConfig(cwd, new CommandRunner({ path: cwd }));

    expect(localConfig(cwd, 'feature.manyFiles')).toBe('false');
    expect(localConfig(cwd, 'core.fsmonitor')).toBeUndefined();
  });
});

describe.skipIf(!hasFsmonitorDaemon)('forceRemoveWorktree', () => {
  it('removes a worktree whose fsmonitor daemon is running', async () => {
    const cwd = repository();
    git(cwd, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
    const worktree = join(temporaryDirectory(), 'worktree');
    git(cwd, 'worktree', 'add', '-q', worktree);
    git(worktree, 'fsmonitor--daemon', 'start');

    await forceRemoveWorktree(worktree, cwd, new CommandRunner({ path: cwd }));

    expect(existsSync(worktree)).toBe(false);
    expect(git(cwd, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
  });
});
