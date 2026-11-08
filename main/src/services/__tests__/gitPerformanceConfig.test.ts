import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { ensureFastGitConfig, forceRemoveWorktree, removePaneFsmonitorConfig } from '../gitPerformanceConfig';

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

function useGlobalConfig(contents: string): string {
  const globalConfig = join(temporaryDirectory(), 'gitconfig');
  writeFileSync(globalConfig, contents);
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  return globalConfig;
}

function daemonStatus(cwd: string): string {
  // `status` exits 1 when no daemon is watching, so read stdout either way.
  return spawnSync('git', ['fsmonitor--daemon', 'status'], { cwd, encoding: 'utf8' }).stdout;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ensureFastGitConfig', () => {
  it('turns on feature.manyFiles and leaves core.fsmonitor unset', async () => {
    const cwd = repository();

    await ensureFastGitConfig(cwd, new CommandRunner({ path: cwd }));

    expect(localConfig(cwd, 'feature.manyFiles')).toBe('true');
    expect(localConfig(cwd, 'core.fsmonitor')).toBeUndefined();
  });

  it('keeps a value the user set in the repository', async () => {
    const cwd = repository();
    git(cwd, 'config', 'feature.manyFiles', 'false');

    await ensureFastGitConfig(cwd, new CommandRunner({ path: cwd }));

    expect(localConfig(cwd, 'feature.manyFiles')).toBe('false');
  });

  it('writes nothing when global config sets the key', async () => {
    useGlobalConfig('[feature]\n\tmanyFiles = false\n');
    const cwd = repository();

    await ensureFastGitConfig(cwd, new CommandRunner({ path: cwd }));

    expect(localConfig(cwd, 'feature.manyFiles')).toBeUndefined();
  });
});

describe('removePaneFsmonitorConfig', () => {
  it('removes the local core.fsmonitor=true after an upgrade from a version that wrote it', async () => {
    const globalConfig = useGlobalConfig('[core]\n\tfsmonitor = true\n');
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', 'true');

    await removePaneFsmonitorConfig('2.4.215', [{ path: cwd, commandRunner: new CommandRunner({ path: cwd }) }]);

    expect(localConfig(cwd, 'core.fsmonitor')).toBeUndefined();
    expect(readFileSync(globalConfig, 'utf8')).toBe('[core]\n\tfsmonitor = true\n');
  });

  it('cleans up after an upgrade from a canary build that wrote it', async () => {
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', 'true');

    await removePaneFsmonitorConfig('2.4.210-canary.202610310113.d8d9742.32.1', [{ path: cwd, commandRunner: new CommandRunner({ path: cwd }) }]);

    expect(localConfig(cwd, 'core.fsmonitor')).toBeUndefined();
  });

  it('keeps a local core.fsmonitor value Pane did not write', async () => {
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', '/usr/local/bin/watchman-hook');

    await removePaneFsmonitorConfig('2.4.215', [{ path: cwd, commandRunner: new CommandRunner({ path: cwd }) }]);

    expect(localConfig(cwd, 'core.fsmonitor')).toBe('/usr/local/bin/watchman-hook');
  });

  it.each([['2.4.216'], ['2.4.216-canary.202611090101.abc1234.40.1'], ['2.5.0'], [null]])('does nothing when the last recorded version is %s', async lastVersion => {
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', 'true');

    await removePaneFsmonitorConfig(lastVersion, [{ path: cwd, commandRunner: new CommandRunner({ path: cwd }) }]);

    expect(localConfig(cwd, 'core.fsmonitor')).toBe('true');
  });

  it('skips a project whose repository is missing and cleans the rest', async () => {
    const missing = join(temporaryDirectory(), 'gone');
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', 'true');

    await removePaneFsmonitorConfig('2.4.215', [
      { path: missing, commandRunner: new CommandRunner({ path: missing }) },
      { path: cwd, commandRunner: new CommandRunner({ path: cwd }) },
    ]);

    expect(localConfig(cwd, 'core.fsmonitor')).toBeUndefined();
  });

  it.skipIf(!hasFsmonitorDaemon)('stops the fsmonitor daemon in the main checkout and every worktree', async () => {
    const cwd = repository();
    git(cwd, 'config', '--local', 'core.fsmonitor', 'true');
    git(cwd, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
    const worktrees = [join(temporaryDirectory(), 'one'), join(temporaryDirectory(), 'two')];
    for (const worktree of worktrees) git(cwd, 'worktree', 'add', '-q', '--detach', worktree);
    // With core.fsmonitor=true, any index read starts the checkout's daemon.
    for (const checkout of [cwd, ...worktrees]) git(checkout, 'status', '--porcelain');
    for (const checkout of [cwd, ...worktrees]) expect(daemonStatus(checkout)).toContain('is watching');

    await removePaneFsmonitorConfig('2.4.215', [{ path: cwd, commandRunner: new CommandRunner({ path: cwd }) }]);

    for (const checkout of [cwd, ...worktrees]) expect(daemonStatus(checkout)).toContain('not watching');
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
