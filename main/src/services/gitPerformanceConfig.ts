import type { CommandRunner } from '../utils/commandRunner';
import { compareVersions } from './agentChat/adapterSetup';

/** The first Pane release that no longer writes `core.fsmonitor=true`. */
const FIRST_VERSION_WITHOUT_FSMONITOR = '2.4.216';

const configuredRepositories = new Map<string, Promise<void>>();
const fsmonitorSupport = new Map<string, Promise<boolean>>();

/** Whether this Git build has the built-in fsmonitor daemon (macOS and Windows builds do). */
async function hasFsmonitorDaemon(commandRunner: CommandRunner, cwd: string): Promise<boolean> {
  // Native git and each WSL distribution can be different Git builds.
  const key = commandRunner.wslContext?.distribution ?? '';
  let supported = fsmonitorSupport.get(key);
  if (!supported) {
    supported = commandRunner.execFile('git', ['version', '--build-options'], cwd, { silent: true })
      .then(({ stdout }) => stdout.includes('fsmonitor--daemon'));
    fsmonitorSupport.set(key, supported);
  }
  try {
    return await supported;
  } catch {
    // e.g. cwd is gone; ask again next time.
    fsmonitorSupport.delete(key);
    return false;
  }
}

/**
 * Speeds up the `git status`, diff and untracked-file scans Pane runs for
 * every worktree. `feature.manyFiles` turns on the untracked cache and index
 * v4. It goes in the repository's local config, which all of its worktrees
 * share, and only when no config scope sets it already, so explicit user
 * config always wins.
 */
export function ensureFastGitConfig(repoPath: string, commandRunner: CommandRunner): Promise<void> {
  let pending = configuredRepositories.get(repoPath);
  if (!pending) {
    pending = applyFastGitConfig(repoPath, commandRunner).catch(error => {
      // Retry on the next call, e.g. once `git init` has run.
      configuredRepositories.delete(repoPath);
      console.warn(`[GitPerformanceConfig] Could not configure ${repoPath}:`, error);
    });
    configuredRepositories.set(repoPath, pending);
  }
  return pending;
}

async function applyFastGitConfig(repoPath: string, commandRunner: CommandRunner): Promise<void> {
  const { exitCode } = await commandRunner.execFile('git', ['config', '--get', 'feature.manyFiles'], repoPath, { silent: true, okExitCodes: [1] });
  if (exitCode === 1) {
    await commandRunner.execFile('git', ['config', '--local', 'feature.manyFiles', 'true'], repoPath, { silent: true });
  }
}

/**
 * Pane releases before FIRST_VERSION_WITHOUT_FSMONITOR wrote
 * `core.fsmonitor=true` into each project's local config, and Git then keeps a
 * daemon running in every worktree. On the first launch after upgrading from
 * one of them, remove that exact value and stop the daemons in the repository's
 * worktrees. Other values and other config scopes stay as they are.
 */
export async function removePaneFsmonitorConfig(
  lastVersion: string | null,
  repositories: Array<{ path: string; commandRunner: CommandRunner }>,
): Promise<void> {
  if (!lastVersion || compareVersions(lastVersion, FIRST_VERSION_WITHOUT_FSMONITOR) >= 0) return;
  console.log(`[GitPerformanceConfig] Removing core.fsmonitor that Pane ${lastVersion} wrote, in ${repositories.length} repositories`);
  let removed = 0;
  for (const { path, commandRunner } of repositories) {
    try {
      if (await removeLocalFsmonitor(path, commandRunner)) removed++;
    } catch (error) {
      console.warn(`[GitPerformanceConfig] Skipped ${path}:`, error);
    }
  }
  console.log(`[GitPerformanceConfig] Removed core.fsmonitor from ${removed} of ${repositories.length} repositories`);
}

async function removeLocalFsmonitor(repoPath: string, commandRunner: CommandRunner): Promise<boolean> {
  const { stdout, exitCode } = await commandRunner.execFile(
    'git', ['config', '--local', '--get-all', 'core.fsmonitor'], repoPath, { silent: true, okExitCodes: [1] });
  if (exitCode === 1 || stdout.trim() !== 'true') return false;
  await commandRunner.execFile('git', ['config', '--local', '--unset', 'core.fsmonitor'], repoPath, { silent: true });
  const { stdout: list } = await commandRunner.execFile('git', ['worktree', 'list', '--porcelain'], repoPath, { silent: true });
  const worktrees = list.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
  for (const worktree of worktrees) await stopFsmonitorDaemon(worktree, commandRunner);
  return true;
}

/**
 * Stops the worktree's fsmonitor daemon so removing the worktree leaves no
 * daemon behind and, on Windows, nothing holds the directory open.
 */
export async function stopFsmonitorDaemon(worktreePath: string, commandRunner: CommandRunner): Promise<void> {
  if (!await hasFsmonitorDaemon(commandRunner, worktreePath)) return;
  try {
    await commandRunner.execFile('git', ['fsmonitor--daemon', 'stop'], worktreePath, { silent: true, timeout: 10000 });
  } catch {
    // No daemon is running or the worktree is already gone.
  }
}

/** `git worktree remove --force`, after stopping the worktree's fsmonitor daemon. */
export async function forceRemoveWorktree(
  worktreePath: string,
  projectPath: string,
  commandRunner: CommandRunner,
  options?: { timeout?: number },
): Promise<void> {
  await stopFsmonitorDaemon(worktreePath, commandRunner);
  await commandRunner.execFile('git', ['worktree', 'remove', '--force', '--', worktreePath], projectPath, options);
}
