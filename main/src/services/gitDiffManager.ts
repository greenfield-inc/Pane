import type { Logger } from '../utils/logger';
import type { AnalyticsManager } from './analyticsManager';
import { CommandRunner } from '../utils/commandRunner';
import type { ExecFileAsyncOptions, ExecFileResult } from '../utils/commandExecutor';
import * as fs from 'fs/promises';
import { isAbsolute } from 'path';
import type {
  DiffManifest,
  DiffRequestErrorCode,
  DiffScope,
  FileDiffRequest,
  FileDiffResult,
} from '../../../shared/types/gitDiff';
import {
  mergeSummaries,
  parseNameStatusZ,
  parseNumstatZ,
  parseUnmergedFilesZ,
  resolveScope,
  type ScopeResolutionDependencies,
} from './gitDiffScope';
import type { GitDiffResult, GitDiffStats } from '../../../shared/types/diff';

export type { GitDiffResult, GitDiffStats } from '../../../shared/types/diff';

export interface GitCommit {
  hash: string;
  message: string;
  date: Date;
  author: string;
  stats: GitDiffStats;
}

export interface GitGraphCommit {
  hash: string;
  parents: string[];
  branch: string;
  message: string;
  committerDate: string;
  author: string;
  authorEmail?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

export class DiffRequestError extends Error {
  constructor(public readonly code: DiffRequestErrorCode, message: string) {
    super(message);
  }
}

export interface GitDiffDependencies {
  comparisonBase(): Promise<string>;
}

const DEFAULT_DIFF_MAX_BUFFER = 50 * 1024 * 1024;

export class GitDiffManager {
  constructor(
    private logger?: Logger,
    private analyticsManager?: AnalyticsManager,
    private readonly maxDiffBuffer = DEFAULT_DIFF_MAX_BUFFER,
  ) {}

  private scopeDependencies(
    worktreePath: string,
    runner: CommandRunner,
    deps: GitDiffDependencies,
  ): ScopeResolutionDependencies {
    const env = { LC_ALL: 'C' };
    return {
      comparisonBase: deps.comparisonBase,
      revParse: async ref => {
        try {
          const result = await runner.execFile('git', ['rev-parse', '--verify', '--end-of-options', ref], worktreePath, { env, silent: true });
          return result.stdout.trim();
        } catch {
          throw new DiffRequestError('unknown-commit', `Unknown commit: ${ref}`);
        }
      },
      parents: async hash => {
        const result = await runner.execFile('git', ['rev-list', '--parents', '-n', '1', hash], worktreePath, { env, silent: true });
        return result.stdout.trim().split(/\s+/).slice(1);
      },
      emptyTree: async () => {
        const result = await runner.execFile('git', ['hash-object', '-t', 'tree', '/dev/null'], worktreePath, { env, silent: true });
        return result.stdout.trim();
      },
      mergeBase: async (ref, target) => {
        const result = await runner.execFile('git', ['merge-base', '--end-of-options', ref, target], worktreePath, { env, silent: true, okExitCodes: [1] });
        return result.exitCode === 0 ? result.stdout.trim() : null;
      },
    };
  }

  async getDiffManifest(
    worktreePath: string,
    scope: DiffScope,
    runner: CommandRunner,
    deps: GitDiffDependencies,
  ): Promise<DiffManifest> {
    const resolved = await resolveScope(scope, this.scopeDependencies(worktreePath, runner, deps));
    const baseHash = resolved.base.hash;
    if (!baseHash) throw new DiffRequestError('git-error', 'Diff base did not resolve to a commit');
    const range = resolved.target.kind === 'working-tree'
      ? [baseHash]
      : [baseHash, resolved.target.hash ?? ''];
    const env = { LC_ALL: 'C' };
    const [names, stats, untracked, unmerged] = await Promise.all([
      runner.execFile('git', ['diff', '-z', '-M', '--name-status', ...range, '--'], worktreePath, { env, silent: true }),
      runner.execFile('git', ['diff', '-z', '-M', '--numstat', ...range, '--'], worktreePath, { env, silent: true }),
      resolved.target.kind === 'working-tree'
        ? runner.execFile('git', ['ls-files', '-z', '--others', '--exclude-standard'], worktreePath, { env, silent: true })
        : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      resolved.target.kind === 'working-tree'
        ? runner.execFile('git', ['ls-files', '-z', '--unmerged'], worktreePath, { env, silent: true })
        : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    ]);
    const files = mergeSummaries(
      [
        ...parseNameStatusZ(names.stdout),
        ...parseUnmergedFilesZ(unmerged.stdout).map(path => ({ status: 'U', path })),
      ],
      parseNumstatZ(stats.stdout),
      untracked.stdout.split('\0').filter(Boolean),
    );
    return {
      scope,
      files,
      resolvedBase: resolved.base,
      resolvedTarget: resolved.target,
      stats: {
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        filesChanged: files.length,
      },
    };
  }

  async getFileDiff(
    worktreePath: string,
    scope: DiffScope,
    request: FileDiffRequest,
    runner: CommandRunner,
    deps: GitDiffDependencies,
  ): Promise<FileDiffResult> {
    this.validateDiffPath(request.path);
    if (request.previousPath) this.validateDiffPath(request.previousPath);
    try {
      const info = await fs.lstat(`${worktreePath}/${request.path}`);
      if (info.isDirectory()) throw new DiffRequestError('invalid-path', 'Diff path cannot be a directory');
    } catch (error) {
      if (error instanceof DiffRequestError) throw error;
      // Missing paths are valid for deleted files and stale selections.
    }
    const resolved = await resolveScope(scope, this.scopeDependencies(worktreePath, runner, deps));
    const baseHash = resolved.base.hash;
    if (!baseHash) throw new DiffRequestError('git-error', 'Diff base did not resolve to a commit');
    const range = resolved.target.kind === 'working-tree'
      ? [baseHash]
      : [baseHash, resolved.target.hash ?? ''];
    const options = { env: { LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' }, silent: true, maxBuffer: this.maxDiffBuffer };
    let validatedPreviousPath: string | undefined;
    let validatedNamesOutput: string | undefined;
    if (request.previousPath) {
      const candidatePaths = [request.path, request.previousPath];
      const candidateNames = await runner.execFile(
        'git',
        ['diff', '-z', '-M', '--name-status', ...range, '--', ...candidatePaths],
        worktreePath,
        options,
      );
      const isActualSource = parseNameStatusZ(candidateNames.stdout).some(record =>
        (record.status.startsWith('R') || record.status.startsWith('C'))
        && record.path === request.path
        && record.previousPath === request.previousPath,
      );
      if (isActualSource) {
        validatedPreviousPath = request.previousPath;
        validatedNamesOutput = candidateNames.stdout;
      }
    }
    const paths = validatedPreviousPath ? [request.path, validatedPreviousPath] : [request.path];
    let patch = (await this.executePatch(
      runner,
      ['diff', '-M', '--no-color', ...range, '--', ...paths],
      worktreePath,
      options,
    )).stdout;

    const [names, stats] = await Promise.all([
      validatedNamesOutput === undefined
        ? runner.execFile('git', ['diff', '-z', '-M', '--name-status', ...range, '--', ...paths], worktreePath, options)
        : Promise.resolve({ stdout: validatedNamesOutput, stderr: '', exitCode: 0 }),
      runner.execFile('git', ['diff', '-z', '-M', '--numstat', ...range, '--', ...paths], worktreePath, options),
    ]);
    let files = mergeSummaries(parseNameStatusZ(names.stdout), parseNumstatZ(stats.stdout), []);

    if (!patch && files.length === 0 && resolved.target.kind === 'working-tree') {
      const listed = await runner.execFile('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', request.path], worktreePath, options);
      const isUntracked = listed.stdout.split('\0').includes(request.path);
      if (isUntracked) {
        const untrackedResult = await this.executePatch(
          runner,
          ['diff', '--no-index', '--no-color', '--', '/dev/null', request.path],
          worktreePath,
          { ...options, okExitCodes: [0, 1] },
        );
        if (untrackedResult.stdout.startsWith('diff --git')) {
          patch = untrackedResult.stdout;
          files = [{ path: request.path, kind: 'added', additions: null, deletions: null, isBinary: patch.includes('Binary files') }];
        } else {
          try {
            const info = await fs.lstat(`${worktreePath}/${request.path}`);
            if (info.isDirectory()) throw new DiffRequestError('invalid-path', 'Diff path cannot be a directory');
          } catch (error) {
            if (error instanceof DiffRequestError) throw error;
            return { file: { path: request.path, kind: 'added', additions: null, deletions: null, isBinary: false }, patch: '', status: 'no-longer-changed' };
          }
          throw new DiffRequestError('git-error', untrackedResult.stderr || 'Unable to diff untracked file');
        }
      }
    }

    const file = files.find(item => item.path === request.path) ?? {
      path: request.path,
      previousPath: validatedPreviousPath,
      kind: 'modified' as const,
      additions: null,
      deletions: null,
      isBinary: false,
    };
    return { file, patch, status: patch || files.length > 0 ? 'changed' : 'no-longer-changed' };
  }

  private validateDiffPath(path: string): void {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new DiffRequestError('invalid-path', 'Diff path must be repository-relative');
    }
  }

  private async executePatch(
    runner: CommandRunner,
    args: readonly string[],
    worktreePath: string,
    options: ExecFileAsyncOptions,
  ): Promise<ExecFileResult> {
    try {
      return await runner.execFile('git', args, worktreePath, options);
    } catch (cause: unknown) {
      // SAFETY: CommandExecutor preserves Node's string overflow code on execFile errors.
      const error = cause as { code?: string };
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new DiffRequestError('diff-too-large', 'File diff exceeds the configured size limit');
      }
      throw cause;
    }
  }

  /**
   * Capture git diff for a worktree directory
   */
  async captureWorkingDirectoryDiff(worktreePath: string, commandRunner: CommandRunner): Promise<GitDiffResult> {
    try {
      console.log(`captureWorkingDirectoryDiff called for: ${worktreePath}`);
      this.logger?.verbose(`Capturing git diff in ${worktreePath}`);

      // Get current commit hash
      const beforeHash = await this.getCurrentCommitHash(worktreePath, commandRunner);

      // Get diff of working directory vs HEAD
      const diff = await this.getGitDiffString(worktreePath, commandRunner);
      console.log(`Captured diff length: ${diff.length}`);

      // Get changed files
      const changedFiles = await this.getChangedFiles(worktreePath, commandRunner);

      // Get diff stats
      const stats = await this.getDiffStats(worktreePath, commandRunner);

      this.logger?.verbose(`Captured diff: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}`);
      console.log(`Diff stats:`, stats);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash,
        afterHash: undefined // No after hash for working directory changes
      };
    } catch (error) {
      this.logger?.error(`Failed to capture git diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Capture git diff between two commits or between commit and working directory
   */
  async captureCommitDiff(worktreePath: string, fromCommit: string, toCommit: string | undefined, commandRunner: CommandRunner): Promise<GitDiffResult> {
    try {
      const to = toCommit || 'HEAD';
      this.logger?.verbose(`Capturing git diff in ${worktreePath} from ${fromCommit} to ${to}`);

      // Get diff between commits
      const diff = await this.getGitCommitDiff(worktreePath, fromCommit, to, commandRunner);

      // Get changed files between commits
      const changedFiles = await this.getChangedFilesBetweenCommits(worktreePath, fromCommit, to, commandRunner);

      // Get diff stats between commits
      const stats = await this.getCommitDiffStats(worktreePath, fromCommit, to, commandRunner);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: fromCommit,
        afterHash: to === 'HEAD' ? await this.getCurrentCommitHash(worktreePath, commandRunner) : to
      };
    } catch (error) {
      this.logger?.error(`Failed to capture commit diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get git commit history for a worktree (only commits unique to this branch)
   */
  async getCommitHistory(worktreePath: string, limit: number, comparisonBranch: string, commandRunner: CommandRunner): Promise<GitCommit[]> {
    try {
      // Get commit log with stats for commits in HEAD not in the comparison branch.
      // Two-dot range: commits reachable from HEAD but not from comparisonBranch.
      const logFormat = '%H|%s|%ai|%an';
      const gitCommand = `git log --format="${logFormat}" --numstat -n ${limit} ${comparisonBranch}..HEAD --`;

      console.log(`[GitDiffManager] Getting commit history for worktree: ${worktreePath}`);
      console.log(`[GitDiffManager] Comparison branch: ${comparisonBranch}`);
      console.log(`[GitDiffManager] Git command: ${gitCommand}`);

      const logOutput = (await commandRunner.execAsync(gitCommand, worktreePath)).stdout;
      console.log(`[GitDiffManager] Git log output length: ${logOutput.length} characters`);

      const commits: GitCommit[] = [];
      const lines = logOutput.trim().split('\n');
      console.log(`[GitDiffManager] Total lines to parse: ${lines.length}`);
      
      let currentCommit: GitCommit | null = null;
      let statsLines: string[] = [];

      for (const line of lines) {
        if (line.includes('|')) {
          // Process previous commit's stats if any
          if (currentCommit && statsLines.length > 0) {
            const stats = this.parseNumstatOutput(statsLines);
            currentCommit.stats = stats;
          }

          // Start new commit
          const [hash, message, date, author] = line.split('|');
          
          // Validate and parse the date
          let parsedDate: Date;
          try {
            parsedDate = new Date(date);
            // Check if the date is valid
            if (isNaN(parsedDate.getTime())) {
              throw new Error('Invalid date');
            }
          } catch {
            // Fall back to current date if parsing fails
            parsedDate = new Date();
            this.logger?.warn(`Invalid date format in git log: "${date}". Using current date as fallback.`);
          }
          
          currentCommit = {
            hash,
            message,
            date: parsedDate,
            author,
            stats: { additions: 0, deletions: 0, filesChanged: 0 }
          };
          commits.push(currentCommit);
          statsLines = [];
        } else if (line.trim() && currentCommit) {
          // Collect stat lines
          statsLines.push(line);
        }
      }

      // Process last commit's stats
      if (currentCommit && statsLines.length > 0) {
        const stats = this.parseNumstatOutput(statsLines);
        currentCommit.stats = stats;
      }

      console.log(`[GitDiffManager] Found ${commits.length} commits unique to this branch`);
      if (commits.length === 0) {
        console.log(`[GitDiffManager] No unique commits found. This could mean:`);
        console.log(`[GitDiffManager]   - The branch is up-to-date with ${comparisonBranch}`);
        console.log(`[GitDiffManager]   - The branch has been rebased onto ${comparisonBranch}`);
        console.log(`[GitDiffManager]   - The ${comparisonBranch} branch doesn't exist in this worktree`);
      }

      return commits;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger?.error('Failed to get commit history', error instanceof Error ? error : undefined);
      console.error(`[GitDiffManager] Error getting commit history: ${errorMessage}`);
      console.error(`[GitDiffManager] Full error:`, error);
      
      // If it's a git command error, throw it so the caller can handle it appropriately
      if (errorMessage.includes('fatal:') || errorMessage.includes('error:')) {
        console.error(`[GitDiffManager] Git command failed. This might happen if the ${comparisonBranch} branch doesn't exist.`);
        throw new Error(`Git error: ${errorMessage}`);
      }
      
      // For other errors, return empty array as fallback
      return [];
    }
  }

  /**
   * Get git commit history for the graph visualization (lightweight, no stats)
   */
  async getGraphCommitHistory(
    worktreePath: string,
    branch: string,
    limit: number = 50,
    comparisonBranch: string = 'main',
    commandRunner: CommandRunner
  ): Promise<GitGraphCommit[]> {
    try {
      // Use %x00 (NUL) as field delimiter since commit messages can contain pipes
      // Use %x01 as record delimiter to separate commits (--shortstat adds extra lines)
      const logFormat = '%x01%h%x00%p%x00%s%x00%ai%x00%an%x00%ae';
      const gitCommand = `git log --format="${logFormat}" --shortstat -n ${limit} ${comparisonBranch}..HEAD --`;

      const logOutput = (await commandRunner.execAsync(gitCommand, worktreePath)).stdout;

      if (!logOutput.trim()) {
        return [];
      }

      // Split by record delimiter, each record has the commit line + optional shortstat line
      return logOutput.split('\x01').filter(Boolean).map(record => {
        const lines = record.trim().split('\n').filter(Boolean);
        const [hash, parentStr, message, date, author, email] = lines[0].split('\x00');

        const commit: GitGraphCommit = {
          hash,
          parents: parentStr ? parentStr.split(' ').filter(Boolean) : [],
          branch,
          message,
          committerDate: date,
          author,
          authorEmail: email
        };

        // Parse shortstat line if present (e.g. " 3 files changed, 10 insertions(+), 2 deletions(-)")
        if (lines.length > 1) {
          const statsMatch = lines[lines.length - 1].match(
            /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
          );
          if (statsMatch) {
            commit.filesChanged = parseInt(statsMatch[1]) || 0;
            commit.additions = parseInt(statsMatch[2]) || 0;
            commit.deletions = parseInt(statsMatch[3]) || 0;
          }
        }

        return commit;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger?.error('Failed to get graph commit history', error instanceof Error ? error : undefined);

      if (errorMessage.includes('fatal:') || errorMessage.includes('error:')) {
        throw new Error(`Git error: ${errorMessage}`);
      }

      return [];
    }
  }

  /**
   * Parse numstat output to get diff statistics
   */
  private parseNumstatOutput(lines: string[]): GitDiffStats {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        
        if (!isNaN(added) && !isNaN(deleted)) {
          additions += added;
          deletions += deleted;
          filesChanged++;
        }
      }
    }

    return { additions, deletions, filesChanged };
  }

  /**
   * Get diff for a specific commit
   */
  async getCommitDiff(worktreePath: string, commitHash: string, commandRunner: CommandRunner): Promise<GitDiffResult> {
    try {
      const diff = (await commandRunner.execAsync(`git show --format= ${commitHash}`, worktreePath)).stdout;

      const stats = await this.getCommitStats(worktreePath, commitHash, commandRunner);
      const changedFiles = await this.getCommitChangedFiles(worktreePath, commitHash, commandRunner);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: `${commitHash}~1`,
        afterHash: commitHash
      };
    } catch (error) {
      this.logger?.error(`Failed to get commit diff for ${commitHash}`, error instanceof Error ? error : undefined);
      return {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: []
      };
    }
  }

  /**
   * Get stats for a specific commit
   */
  private async getCommitStats(worktreePath: string, commitHash: string, commandRunner: CommandRunner): Promise<GitDiffStats> {
    try {
      const fullOutput = (await commandRunner.execAsync(`git show --stat --format= ${commitHash}`, worktreePath)).stdout;
      // Get the last line manually instead of using tail
      const lines = fullOutput.trim().split('\n');
      const statsOutput = lines[lines.length - 1];
      return this.parseDiffStats(statsOutput);
    } catch {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  /**
   * Get changed files for a specific commit
   */
  private async getCommitChangedFiles(worktreePath: string, commitHash: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      const output = (await commandRunner.execAsync(`git show --name-only --format= ${commitHash}`, worktreePath)).stdout;
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
  async getCurrentCommitHash(worktreePath: string, commandRunner: CommandRunner): Promise<string> {
    try {
      return (await commandRunner.execAsync('git rev-parse HEAD', worktreePath)).stdout.trim();
    } catch {
      this.logger?.warn(`Could not get current commit hash in ${worktreePath}`);
      return '';
    }
  }

  async getGitDiff(worktreePath: string, commandRunner: CommandRunner): Promise<GitDiffResult> {
    const result = await this.captureWorkingDirectoryDiff(worktreePath, commandRunner);

    // Track git diff viewed
    if (this.analyticsManager) {
      const fileCountCategory = this.analyticsManager.categorizeNumber(result.stats.filesChanged, [1, 5, 10, 25, 50]);
      const hasUncommitted = await this.hasChanges(worktreePath, commandRunner);

      this.analyticsManager.track('git_diff_viewed', {
        file_count_category: fileCountCategory,
        has_uncommitted: hasUncommitted
      });
    }

    return result;
  }

  private async getGitDiffString(worktreePath: string, commandRunner: CommandRunner): Promise<string> {
    try {
      // First check if we're in a valid git repository
      try {
        await commandRunner.execAsync('git rev-parse --git-dir', worktreePath);
      } catch {
        console.error(`Not a git repository: ${worktreePath}`);
        return '';
      }

      // Check git status to see what files have changes
      const status = (await commandRunner.execAsync('git status --porcelain', worktreePath)).stdout;
      console.log(`Git status in ${worktreePath}:`, status || '(no changes)');

      // Get diff of both staged and unstaged changes against HEAD
      // Using 'git diff HEAD' to include both staged and unstaged changes
      let diff = (await commandRunner.execAsync('git diff HEAD', worktreePath)).stdout;
      console.log(`Git diff in ${worktreePath}: ${diff.length} characters`);

      // Get untracked files and create diff-like output for them
      const untrackedFiles = await this.getUntrackedFiles(worktreePath, commandRunner);
      if (untrackedFiles.length > 0) {
        console.log(`Found ${untrackedFiles.length} untracked files`);
        const untrackedDiff = await this.createDiffForUntrackedFiles(worktreePath, untrackedFiles, commandRunner);
        if (untrackedDiff) {
          diff = diff ? diff + '\n' + untrackedDiff : untrackedDiff;
        }
      }
      
      return diff;
    } catch (error) {
      this.logger?.warn(`Could not get git diff in ${worktreePath}`, error instanceof Error ? error : undefined);
      console.error(`Error getting git diff:`, error);
      return '';
    }
  }

  private async getGitCommitDiff(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): Promise<string> {
    try {
      return (await commandRunner.execAsync(`git diff ${fromCommit}..${toCommit}`, worktreePath)).stdout;
    } catch {
      this.logger?.warn(`Could not get git commit diff in ${worktreePath}`);
      return '';
    }
  }

  private async getChangedFiles(worktreePath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      // Get tracked changed files
      const trackedOutput = (await commandRunner.execAsync('git diff --name-only HEAD', worktreePath)).stdout;
      const trackedFiles = trackedOutput.trim().split('\n').filter((f: string) => f.length > 0);

      // Get untracked files
      const untrackedFiles = await this.getUntrackedFiles(worktreePath, commandRunner);
      
      // Combine both lists
      return [...trackedFiles, ...untrackedFiles];
    } catch {
      this.logger?.warn(`Could not get changed files in ${worktreePath}`);
      return [];
    }
  }

  private async getChangedFilesBetweenCommits(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      const output = (await commandRunner.execAsync(`git diff --name-only ${fromCommit}..${toCommit}`, worktreePath)).stdout;
      return output.trim().split('\n').filter((f: string) => f.length > 0);
    } catch {
      this.logger?.warn(`Could not get changed files between commits in ${worktreePath}`);
      return [];
    }
  }

  private async getDiffStats(worktreePath: string, commandRunner: CommandRunner): Promise<GitDiffStats> {
    try {
      const output = (await commandRunner.execAsync('git diff --stat HEAD', worktreePath)).stdout;

      const trackedStats = this.parseDiffStats(output);

      // Add stats for untracked files
      const untrackedFiles = await this.getUntrackedFiles(worktreePath, commandRunner);
      if (untrackedFiles.length > 0) {
        let untrackedAdditions = 0;
        for (const file of untrackedFiles) {
          // Skip invalid filenames
          if (!file || file.trim().length === 0) {
            continue;
          }

          try {
            const cleanFile = file.trim();
            const filePath = `${worktreePath}/${cleanFile}`;
            const lines = (await commandRunner.execAsync(`wc -l < "${filePath}"`, worktreePath)).stdout;
            untrackedAdditions += parseInt(lines.trim()) || 0;
          } catch {
            // Skip files that can't be counted
          }
        }
        
        return {
          additions: trackedStats.additions + untrackedAdditions,
          deletions: trackedStats.deletions,
          filesChanged: trackedStats.filesChanged + untrackedFiles.length
        };
      }
      
      return trackedStats;
    } catch {
      this.logger?.warn(`Could not get diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  private async getCommitDiffStats(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): Promise<GitDiffStats> {
    try {
      const output = (await commandRunner.execAsync(`git diff --stat ${fromCommit}..${toCommit}`, worktreePath)).stdout;
      
      return this.parseDiffStats(output);
    } catch {
      this.logger?.warn(`Could not get commit diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  parseDiffStats(statsOutput: string): GitDiffStats {
    const lines = statsOutput.trim().split('\n');
    const summaryLine = lines[lines.length - 1];
    
    // Parse summary line like: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const fileMatch = summaryLine.match(/(\d+) files? changed/);
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/);
    
    return {
      filesChanged: fileMatch ? parseInt(fileMatch[1]) : 0,
      additions: addMatch ? parseInt(addMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0
    };
  }

  /**
   * Check if there are any changes in the working directory
   */
  async hasChanges(worktreePath: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      const output = (await commandRunner.execAsync('git status --porcelain', worktreePath)).stdout;
      return output.trim().length > 0;
    } catch {
      this.logger?.warn(`Could not check git status in ${worktreePath}`);
      return false;
    }
  }

  /**
   * Get list of untracked files
   */
  private async getUntrackedFiles(worktreePath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      const output = (await commandRunner.execAsync('git ls-files --others --exclude-standard', worktreePath)).stdout;
      
      // Handle empty output case
      if (!output || output.trim().length === 0) {
        return [];
      }
      
      return output.trim().split('\n').filter((f: string) => f && f.trim().length > 0);
    } catch {
      this.logger?.warn(`Could not get untracked files in ${worktreePath}`);
      return [];
    }
  }

  /**
   * Create diff-like output for untracked files
   */
  private async createDiffForUntrackedFiles(worktreePath: string, untrackedFiles: string[], commandRunner: CommandRunner): Promise<string> {
    let diffOutput = '';
    
    for (const file of untrackedFiles) {
      // Skip invalid filenames
      if (!file || file.trim().length === 0) {
        continue;
      }
      
      try {
        const cleanFile = file.trim();
        const filePath = `${worktreePath}/${cleanFile}`;
        const fileContent = (await commandRunner.execAsync(`cat "${filePath}"`, worktreePath, { maxBuffer: 1024 * 1024 })).stdout;
        
        // Create a diff-like format for the new file
        diffOutput += `diff --git a/${cleanFile} b/${cleanFile}\n`;
        diffOutput += `new file mode 100644\n`;
        diffOutput += `index 0000000..0000000\n`;
        diffOutput += `--- /dev/null\n`;
        diffOutput += `+++ b/${cleanFile}\n`;
        
        // Add the file content with '+' prefix for each line
        const lines = fileContent.split('\n');
        if (lines.length > 0) {
          diffOutput += `@@ -0,0 +1,${lines.length} @@\n`;
          for (const line of lines) {
            diffOutput += `+${line}\n`;
          }
        }
      } catch (error) {
        // Skip files that can't be read (binary files, etc.)
        const cleanFile = file.trim();
        this.logger?.verbose(`Could not read untracked file ${cleanFile}: ${error}`);
      }
    }
    
    return diffOutput;
  }
}
