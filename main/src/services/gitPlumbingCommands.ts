import { commandExecutor } from '../utils/commandExecutor';
import * as fs from 'fs';
import { WSLContext, linuxToUNCPath } from '../utils/wslUtils';
import { escapeShellArg } from '../utils/shellEscape';

/**
 * Optimized git commands using plumbing (low-level) commands
 * These are generally faster than porcelain commands like `git status`
 */

export interface GitIndexStatus {
  hasModified: boolean;
  hasStaged: boolean;
  hasUntracked: boolean;
  hasConflicts: boolean;
}

export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

export interface GitCommitSummary {
  sha: string;
  subject: string;
}

export interface GitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/**
 * Check the directory exists before attempting git operations.
 * This prevents ENOENT errors when worktrees have been deleted (e.g., /tmp cleanup).
 * WSL paths are not visible to Windows fs APIs directly, so check via the UNC mount.
 */
async function directoryExists(cwd: string, wslContext?: WSLContext | null): Promise<boolean> {
  const fsPath = wslContext ? linuxToUNCPath(cwd, wslContext.distribution) : cwd;
  try {
    await fs.promises.access(fsPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fast check if working directory has any changes using git plumbing commands
 * Much faster than running full `git status --porcelain`
 */
export async function fastCheckWorkingDirectory(cwd: string, wslContext?: WSLContext | null): Promise<GitIndexStatus> {
  const result: GitIndexStatus = {
    hasModified: false,
    hasStaged: false,
    hasUntracked: false,
    hasConflicts: false
  };

  if (!await directoryExists(cwd, wslContext)) {
    // Directory doesn't exist - return safe defaults
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }

  try {
    // 1. Refresh the index first (very fast, updates git's cache)
    try {
      await commandExecutor.execAsync('git update-index --refresh --ignore-submodules', { cwd, silent: true }, wslContext);
    } catch {
      // Some files may have been modified, that's ok
    }

    // 2. Check for unstaged changes (modified files in working directory)
    try {
      await commandExecutor.execAsync('git diff-files --quiet --ignore-submodules', { cwd, silent: true }, wslContext);
    } catch {
      result.hasModified = true;
    }

    // 3. Check for staged changes (in index)
    try {
      await commandExecutor.execAsync('git diff-index --cached --quiet HEAD --ignore-submodules', { cwd, silent: true }, wslContext);
    } catch {
      result.hasStaged = true;
    }

    // 4. Check for untracked files (more efficient than ls-files for just checking existence)
    const untrackedCheck = (await commandExecutor.execAsync(
      'git ls-files --others --exclude-standard --directory --no-empty-directory',
      { cwd },
      wslContext
    )).stdout.trim();

    if (untrackedCheck) {
      result.hasUntracked = true;
    }

    // 5. Check for merge conflicts
    const conflictCheck = (await commandExecutor.execAsync('git diff --name-only --diff-filter=U', { cwd }, wslContext)).stdout.trim();

    if (conflictCheck) {
      result.hasConflicts = true;
    }

    return result;
  } catch {
    // If any unexpected error, return safe defaults
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }
}

/**
 * Get count of commits ahead/behind using rev-list (faster than rev-parse)
 */
export async function fastGetAheadBehind(cwd: string, baseBranch: string, wslContext?: WSLContext | null): Promise<GitAheadBehind> {
  if (!await directoryExists(cwd, wslContext)) {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { ahead: 0, behind: 0 };
  }

  try {
    const result = (await commandExecutor.execAsync(`git rev-list --left-right --count ${baseBranch}...HEAD`, { cwd }, wslContext)).stdout.trim();

    const [behind, ahead] = result.split('\t').map(n => parseInt(n, 10));
    return {
      ahead: ahead || 0,
      behind: behind || 0
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export async function listCommitsAhead(
  cwd: string,
  baseBranch: string,
  wslContext?: WSLContext | null,
): Promise<GitCommitSummary[]> {
  if (!await directoryExists(cwd, wslContext)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  const range = escapeShellArg(`${baseBranch}..HEAD`);
  const format = escapeShellArg('%H%x00%s');
  const output = (await commandExecutor.execAsync(
    `git log --format=${format} -z ${range}`,
    { cwd, silent: true },
    wslContext,
  )).stdout;
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const commits: GitCommitSummary[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const sha = fields[index];
    const subject = fields[index + 1];
    if (!sha || subject === undefined) {
      throw new Error(`Could not parse commit evidence for ${baseBranch}`);
    }
    commits.push({ sha, subject });
  }
  return commits;
}

/**
 * Get statistics about changes (additions/deletions) efficiently
 */
export async function fastGetDiffStats(cwd: string, wslContext?: WSLContext | null): Promise<GitDiffStats> {
  if (!await directoryExists(cwd, wslContext)) {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }

  try {
    // Use numstat for machine-readable output (faster to parse)
    const result = (await commandExecutor.execAsync('git diff --numstat HEAD', { cwd }, wslContext)).stdout.trim();

    if (!result) {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }

    const lines = result.split('\n');
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const [added, deleted] = line.split('\t');
      if (added !== '-') additions += parseInt(added, 10);
      if (deleted !== '-') deletions += parseInt(deleted, 10);
    }

    return {
      additions,
      deletions,
      filesChanged: lines.length
    };
  } catch {
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }
}
