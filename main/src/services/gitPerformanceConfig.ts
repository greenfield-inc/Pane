import type { CommandRunner } from '../utils/commandRunner';
import { escapeShellArg } from '../utils/shellEscape';

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
 * v4; `core.fsmonitor` uses Git's built-in file watcher daemon. The keys go in
 * the repository's local config, which all of its worktrees share, and only
 * when no config scope sets them already, so explicit user config always wins.
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
  const keys = ['feature.manyFiles'];
  if (await hasFsmonitorDaemon(commandRunner, repoPath)) keys.push('core.fsmonitor');
  const existing = await Promise.all(keys.map(key =>
    commandRunner.execFile('git', ['config', '--get', key], repoPath, { silent: true, okExitCodes: [1] })));
  for (const [index, key] of keys.entries()) {
    if (existing[index].exitCode === 1) {
      await commandRunner.execFile('git', ['config', '--local', key, 'true'], repoPath, { silent: true });
    }
  }
}

/**
 * Stops the worktree's fsmonitor daemon so removing the worktree leaves no
 * daemon behind and, on Windows, nothing holds the directory open.
 */
async function stopFsmonitorDaemon(worktreePath: string, commandRunner: CommandRunner): Promise<void> {
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
  await commandRunner.execAsync(`git worktree remove --force ${escapeShellArg(worktreePath)}`, projectPath, options);
}
