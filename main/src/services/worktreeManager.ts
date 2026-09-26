import { mkdir } from 'fs/promises';
import { withLock } from '../utils/mutex';
import type { ConfigManager } from './configManager';
import type { AnalyticsManager } from './analyticsManager';
import { PathResolver } from '../utils/pathResolver';
import { CommandRunner } from '../utils/commandRunner';
import { getGitAttributionEnv } from '../utils/attribution';
import { worktreePoolManager } from './worktreePoolManager';
import { ensureFastGitConfig, forceRemoveWorktree } from './gitPerformanceConfig';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

type WorktreeAuditSource = 'session-delete' | 'project-delete' | 'create-cleanup';

interface WorktreeEntry {
  path: string;
  branch?: string;
}

export interface WorktreeAuditContext {
  source: WorktreeAuditSource;
  sessionId?: string;
  projectId?: number;
}

interface WorktreeAuditDetails {
  source?: WorktreeAuditSource;
  sessionId?: string;
  projectId?: number;
  projectPath?: string;
  worktreeName?: string;
  worktreePath?: string;
  reason?: string;
}

function formatWorktreeAuditDetails(details: WorktreeAuditDetails): string {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ');
}

function logWorktreeAudit(phase: string, details: WorktreeAuditDetails): void {
  console.log(`[WorktreeAudit] ${phase} ${formatWorktreeAuditDetails(details)}`);
}

const commandErrorSchema = boundary.object({
  message: boundary.optional(boundary.string),
  stderr: boundary.optional(boundary.string),
  stdout: boundary.optional(boundary.string),
});

class GitOperationError extends Error {
  gitCommand?: string;
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: { message?: string; stderr?: string; stdout?: string };
}

// Interface for raw commit data
interface RawCommitData {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}

/**
 * Detects baseBranch and baseCommit for a project directory from git.
 * Optionally checks out a specified branch first.
 */
export async function detectGitBase(
  projectPath: string,
  commandRunner: CommandRunner,
  baseBranch?: string,
  checkout?: boolean
): Promise<{ baseBranch: string | undefined; baseCommit: string | undefined }> {
  let actualBaseBranch: string | undefined;
  let baseCommit: string | undefined;

  if (baseBranch) {
    actualBaseBranch = baseBranch;
    if (checkout) {
      // Determine if baseBranch is a remote ref by checking against actual git remotes
      let isRemoteBranch = false;
      let remotePrefix = '';
      try {
        const { stdout } = await commandRunner.execFile('git', ['remote'], projectPath);
        const remotes = stdout.trim().split('\n').filter(Boolean);
        for (const remote of remotes) {
          if (baseBranch.startsWith(`${remote}/`)) {
            isRemoteBranch = true;
            remotePrefix = `${remote}/`;
            break;
          }
        }
      } catch {
        // If we can't list remotes, fall back to treating it as a local branch
      }

      const branchName = isRemoteBranch ? baseBranch.slice(remotePrefix.length) : baseBranch;
      await commandRunner.execFile('git', ['check-ref-format', '--branch', branchName], projectPath);
      try {
        await commandRunner.execFile('git', ['checkout', branchName], projectPath);
      } catch {
        // Local branch may not exist yet — create it tracking the remote
        if (isRemoteBranch) {
          await commandRunner.execFile(
            'git', ['checkout', '-b', branchName, '--track', baseBranch],
            projectPath
          );
        } else {
          throw new Error(`Failed to checkout branch '${branchName}'`);
        }
      }
    }
  } else {
    // Detect current branch's remote tracking ref
    try {
      const localBranch = (await commandRunner.execFile('git', ['branch', '--show-current'], projectPath)).stdout.trim();
      if (localBranch) {
        const remoteRef = `origin/${localBranch}`;
        try {
          await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', remoteRef], projectPath);
          actualBaseBranch = remoteRef;
        } catch {
          // No remote tracking branch — leave undefined
        }
      }
    } catch {
      // Leave undefined if git commands fail
    }
  }

  try {
    const commitRef = actualBaseBranch || 'HEAD';
    baseCommit = (await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', commitRef], projectPath)).stdout.trim();
  } catch {
    // Leave undefined if git commands fail
  }

  return { baseBranch: actualBaseBranch, baseCommit };
}

/**
 * Resolve a stable integration ref when callers do not choose a base branch.
 * The project checkout may be on an unrelated feature branch, so HEAD is only
 * safe as a final fallback for repositories without a conventional base ref.
 */
export async function resolveDefaultWorktreeBase(
  projectPath: string,
  commandRunner: CommandRunner,
): Promise<string> {
  try {
    const { stdout } = await commandRunner.execFile(
      'git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      projectPath,
    );
    const remoteDefault = stdout.trim();
    if (remoteDefault) {
      await commandRunner.execFile(
        'git', ['rev-parse', '--verify', '--end-of-options', `${remoteDefault}^{commit}`],
        projectPath,
      );
      return remoteDefault;
    }
  } catch {
    // Fall through to common remote and local integration branches.
  }

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await commandRunner.execFile(
        'git', ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`],
        projectPath,
      );
      return candidate;
    } catch {
      // Try the next conventional integration ref.
    }
  }

  return 'HEAD';
}

export class WorktreeManager {
  private projectsCache: Map<string, { baseDir: string }> = new Map();

  constructor(
    private configManager?: ConfigManager,
    private analyticsManager?: AnalyticsManager
  ) {
    // No longer initialized with a single repo path
  }

  private getProjectPaths(projectPath: string, worktreeFolder: string | undefined, pathResolver: PathResolver) {
    const cacheKey = `${projectPath}:${worktreeFolder || 'worktrees'}`;
    if (!this.projectsCache.has(cacheKey)) {
      const folderName = worktreeFolder || 'worktrees';
      let baseDir: string;

      // Check if worktreeFolder is an absolute path
      if (worktreeFolder && (worktreeFolder.startsWith('/') || worktreeFolder.includes(':'))) {
        baseDir = worktreeFolder;
      } else {
        baseDir = pathResolver.join(projectPath, folderName);
      }

      this.projectsCache.set(cacheKey, { baseDir });
    }
    return this.projectsCache.get(cacheKey)!;
  }

  async initializeProject(projectPath: string, worktreeFolder: string | undefined, pathResolver: PathResolver, commandRunner: CommandRunner): Promise<void> {
    const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder, pathResolver);
    void ensureFastGitConfig(projectPath, commandRunner);
    try {
      await mkdir(pathResolver.toFileSystem(baseDir), { recursive: true });
    } catch (error) {
      console.error('Failed to create worktrees directory:', error);
    }
  }

  getWorktreePath(projectPath: string, name: string, worktreeFolder: string | undefined, pathResolver: PathResolver): string {
    return pathResolver.join(this.getProjectPaths(projectPath, worktreeFolder, pathResolver).baseDir, name);
  }

  async createWorktree(projectPath: string, name: string, branch: string | undefined, baseBranch: string | undefined, worktreeFolder: string | undefined, pathResolver: PathResolver, commandRunner: CommandRunner): Promise<{ worktreePath: string; baseCommit: string; baseBranch: string }> {
    return await withLock(`worktree-create-${projectPath}-${name}`, async () => {

      const worktreePath = this.getWorktreePath(projectPath, name, worktreeFolder, pathResolver);
      const branchName = branch || name;
    

    try {
      // First check if this is a git repository
      try {
        await commandRunner.execFile('git', ['rev-parse', '--is-inside-work-tree'], projectPath);
      } catch {
        // Initialize git repository
        await commandRunner.execFile('git', ['init'], projectPath);
      }

      // Clean up any existing worktree directory first
      try {
        // Use cross-platform approach without shell redirection
        try {
          logWorktreeAudit('remove_requested', {
            source: 'create-cleanup',
            projectPath,
            worktreeName: name,
            worktreePath,
          });
          logWorktreeAudit('remove_started', {
            source: 'create-cleanup',
            projectPath,
            worktreeName: name,
            worktreePath,
          });
          await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
          logWorktreeAudit('remove_succeeded', {
            source: 'create-cleanup',
            projectPath,
            worktreeName: name,
            worktreePath,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logWorktreeAudit('remove_skipped', {
            source: 'create-cleanup',
            projectPath,
            worktreeName: name,
            worktreePath,
            reason: errorMessage,
          });
          // Ignore cleanup errors
        }
      } catch {
        // Ignore cleanup errors
      }

      // Check if the repository has any commits
      try {
        await commandRunner.execFile('git', ['rev-parse', 'HEAD'], projectPath);
      } catch {
        // Repository has no commits yet, create initial commit
        // Use cross-platform approach without shell operators
        try {
          await commandRunner.execFile('git', ['add', '-A'], projectPath);
        } catch {
          // Ignore add errors (no files to add)
        }
        await commandRunner.execFile('git', ['commit', '-m', 'Initial commit', '--allow-empty'], projectPath, { env: getGitAttributionEnv(this.configManager?.getConfig()) });
      }

      await ensureFastGitConfig(projectPath, commandRunner);

      // Check if branch already exists
      let branchExists = false;
      try {
        await commandRunner.execFile('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], projectPath);
        branchExists = true;
      } catch {
        // Branch doesn't exist, will create it
      }

      // Capture the base commit before creating worktree
      let baseCommit: string;
      let actualBaseBranch: string;

      if (branchExists) {
        // Use existing branch
        await commandRunner.execFile('git', ['worktree', 'add', '--', worktreePath, branchName], projectPath, { timeout: 60000 });

        // Get the commit this branch is based on
        baseCommit = (await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', branchName], projectPath)).stdout.trim();
        actualBaseBranch = branchName;
      } else {
        // Create new branch from specified base branch (or current HEAD if not specified)
        const baseRef = baseBranch || 'HEAD';
        actualBaseBranch = baseBranch || 'HEAD';

        // Verify that the base branch exists if specified
        if (baseBranch) {
          try {
            // Use git rev-parse which works for both local and remote refs
            await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', baseBranch], projectPath);
          } catch {
            throw new Error(`Base branch '${baseBranch}' does not exist`);
          }
        }

        // Capture the base commit before creating the worktree
        baseCommit = (await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', baseRef], projectPath)).stdout.trim();

        // A workspace branch must not inherit the base branch's upstream.
        await commandRunner.execFile('git', ['worktree', 'add', '-b', branchName, '--no-track', '--', worktreePath, baseRef], projectPath, { timeout: 60000 });
      }
      
      console.log(`[WorktreeManager] Worktree created successfully at: ${worktreePath}`);

      // Track worktree creation
      if (this.analyticsManager) {
        this.analyticsManager.track('git_worktree_created', {
          branch_existed: branchExists
        });
      }

      return { worktreePath, baseCommit, baseBranch: actualBaseBranch };
      } catch (error) {
        console.error(`[WorktreeManager] Failed to create worktree:`, error);
        throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /**
   * Resolves the working directory for a session. When useWorktree is true, creates
   * an isolated git worktree. When false, uses the project directory directly and
   * optionally checks out the specified branch.
   */
  async resolveWorkingDirectory(
    projectPath: string,
    worktreeName: string,
    baseBranch: string | undefined,
    useWorktree: boolean,
    worktreeFolder: string | undefined,
    pathResolver: PathResolver,
    commandRunner: CommandRunner
  ): Promise<{ worktreePath: string; baseCommit: string | undefined; baseBranch: string | undefined }> {
    if (useWorktree) {
      const effectiveBase = baseBranch || await resolveDefaultWorktreeBase(projectPath, commandRunner);

      // Try claiming a pre-created reserve worktree for instant creation
      try {
        const branchName = worktreeName; // worktreeName is used as both dir name and branch name
        const claimed = await worktreePoolManager.claimReserve(
          projectPath,
          effectiveBase,
          worktreeName,
          branchName,
          worktreeFolder,
          pathResolver,
          commandRunner
        );
        if (claimed) {
          // Detect base commit from the claimed worktree
          const { baseCommit } = await detectGitBase(claimed.worktreePath, commandRunner);
          return { worktreePath: claimed.worktreePath, baseCommit, baseBranch: effectiveBase };
        }
      } catch (error) {
        console.warn('[WorktreeManager] Pool claim failed, falling back to fresh worktree:', error);
      }

      // Fall back to standard worktree creation
      const result = await this.createWorktree(projectPath, worktreeName, undefined, effectiveBase, worktreeFolder, pathResolver, commandRunner);

      // Trigger background replenishment after successful creation
      worktreePoolManager.createReserve(projectPath, effectiveBase, worktreeFolder, pathResolver, commandRunner).catch(err => {
        console.warn('[WorktreeManager] Background reserve creation failed:', err);
      });

      return result;
    }

    // Run directly in the project directory
    const { baseBranch: detectedBranch, baseCommit } = await detectGitBase(projectPath, commandRunner, baseBranch, true);
    return { worktreePath: projectPath, baseCommit, baseBranch: detectedBranch };
  }

  async removeWorktree(projectPath: string, name: string, worktreeFolder: string | undefined, sessionCreatedAt: Date | undefined, pathResolver: PathResolver, commandRunner: CommandRunner, auditContext?: WorktreeAuditContext): Promise<void> {
    return await withLock(`worktree-remove-${projectPath}-${name}`, async () => {
      const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder, pathResolver);
      const worktreePath = pathResolver.join(baseDir, name);
      const auditDetails = {
        source: auditContext?.source,
        sessionId: auditContext?.sessionId,
        projectId: auditContext?.projectId,
        projectPath,
        worktreeName: name,
        worktreePath,
      };

      try {
        logWorktreeAudit('remove_started', auditDetails);
        await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
        logWorktreeAudit('remove_succeeded', auditDetails);

        // Track worktree cleanup
        if (this.analyticsManager && sessionCreatedAt) {
          const sessionAgeDays = Math.floor((Date.now() - sessionCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
          this.analyticsManager.track('git_worktree_cleaned', {
            session_age_days: sessionAgeDays
          });
        }
      } catch (error: unknown) {
        const err = decodeBoundary(error, commandErrorSchema);
        const errorMessage = err.stderr || err.stdout || err.message || String(err);

        // If the worktree is not found, that's okay - it might have been manually deleted
        if (errorMessage.includes('is not a working tree') ||
            errorMessage.includes('does not exist') ||
            errorMessage.includes('No such file or directory')) {
          logWorktreeAudit('remove_skipped', {
            ...auditDetails,
            reason: errorMessage,
          });
          return;
        }

        logWorktreeAudit('remove_failed', {
          ...auditDetails,
          reason: errorMessage,
        });

        // For other errors, still throw
        throw new Error(`Failed to remove worktree: ${errorMessage}`);
      }
    });
  }

  async listWorktrees(projectPath: string, commandRunner: CommandRunner): Promise<WorktreeEntry[]> {
    try {
      const { stdout } = await commandRunner.execAsync(`git worktree list --porcelain`, projectPath);
      
      const worktrees: WorktreeEntry[] = [];
      const lines = stdout.split('\n');
      
      let currentWorktree: Partial<WorktreeEntry> = {};
      
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (currentWorktree.path) {
            worktrees.push({ ...currentWorktree, path: currentWorktree.path });
          }
          currentWorktree = { path: line.substring(9) };
        } else if (line.startsWith('branch ')) {
          currentWorktree.branch = line.substring(7).replace('refs/heads/', '');
        }
      }
      
      if (currentWorktree.path) {
        worktrees.push({ ...currentWorktree, path: currentWorktree.path });
      }
      
      return worktrees;
    } catch (error) {
      throw new Error(`Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listBranches(projectPath: string, commandRunner: CommandRunner): Promise<Array<{ name: string; isCurrent: boolean; hasWorktree: boolean; isRemote: boolean }>> {
    try {
      // Fetch latest from all remotes (silent, catch errors)
      try {
        await commandRunner.execAsync(`git fetch --all --prune`, projectPath, { timeout: 30000 });
      } catch {
        // Ignore fetch errors - user may be offline
      }

      // Get all local branches
      const { stdout: localOutput } = await commandRunner.execAsync(`git branch`, projectPath);

      // Get remote branches
      let remoteOutput = '';
      try {
        const result = await commandRunner.execAsync(`git branch -r`, projectPath);
        remoteOutput = result.stdout;
      } catch {
        // Ignore remote branch errors - repo may not have remotes
      }

      // Get all worktrees to identify which branches have worktrees
      const worktrees = await this.listWorktrees(projectPath, commandRunner);
      const worktreeBranches = new Set(worktrees.flatMap(w => w.branch ? [w.branch] : []));

      // Parse local branches
      const localBranches: Array<{ name: string; isCurrent: boolean; hasWorktree: boolean; isRemote: boolean }> = [];
      const localLines = localOutput.split('\n').filter(line => line.trim());

      for (const line of localLines) {
        const isCurrent = line.startsWith('*');
        // Remove leading *, +, and spaces. The + indicates uncommitted changes
        const name = line.replace(/^[*+]?\s*[+]?\s*/, '').trim();
        if (name) {
          localBranches.push({
            name,
            isCurrent,
            hasWorktree: worktreeBranches.has(name),
            isRemote: false
          });
        }
      }

      // Parse remote branches
      const remoteBranches: Array<{ name: string; isCurrent: boolean; hasWorktree: boolean; isRemote: boolean }> = remoteOutput
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.includes('HEAD ->')) // Filter out "HEAD -> origin/main"
        .map(name => ({
          name,
          isCurrent: false,
          hasWorktree: false, // Remote branches never have worktrees directly
          isRemote: true
        }));

      // Sort: remotes first (alphabetically), then locals (worktrees first, then alphabetically)
      return [
        ...remoteBranches.sort((a, b) => a.name.localeCompare(b.name)),
        ...localBranches.sort((a, b) => {
          if (a.hasWorktree !== b.hasWorktree) return a.hasWorktree ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
      ];
    } catch (error) {
      console.error(`[WorktreeManager] Error listing branches:`, error);
      return [];
    }
  }

  /**
   * Return the ref a session's diff/status should be compared against.
   *
   * Source of truth: session.baseBranch — the ref the user picked at creation.
   * For legacy worktree sessions where baseBranch is null/empty/the literal
   * "HEAD", prefer the recorded fork commit, then the remote default branch.
   * The project root may currently be on an unrelated feature branch, which
   * would produce incorrect diffs.
   * Main-repo sessions preserve the current-branch origin fallback.
   *
   * The returned ref is a raw branch name (`main`, `my-feature`), remote ref
   * (`origin/main`, `origin/staging`), or recorded commit SHA. Pass it directly
   * to git diff / git log / git rev-list. DO NOT prepend `origin/`.
   *
   * Use this for READ operations (diff, log, rev-list, status). For WRITE
   * operations that need to `git checkout` the integration target (squash/
   * merge to main), use getSessionLocalBaseBranch instead — checking out a
   * remote ref like `origin/main` puts the project repo in detached HEAD.
   */
  async getSessionComparisonBranch(
    session: { baseBranch?: string; baseCommit?: string; isMainRepo?: boolean; worktreePath?: string },
    ctx: { project: { path: string }; commandRunner: CommandRunner },
  ): Promise<string> {
    // Treat the literal "HEAD" placeholder as missing — createWorktree
    // stores it when the user doesn't pick a base branch, and using it as
    // a comparison ref collapses every diff to HEAD..HEAD (empty).
    if (session.baseBranch && session.baseBranch !== 'HEAD') {
      // Guard against the degenerate case where the stored base IS the
      // worktree's own branch. This happens for sessions created on an
      // EXISTING branch (createWorktree's branchExists path stores the
      // branch name as actualBaseBranch). Comparing the branch to itself
      // makes ${base}..HEAD empty and write ops try to merge into the
      // checked-out branch. Fall through to legacy behavior in that case.
      if (session.worktreePath) {
        try {
          const { stdout } = await ctx.commandRunner.execAsync(
            'git branch --show-current',
            session.worktreePath,
          );
          if (stdout.trim() !== session.baseBranch) {
            return session.baseBranch; // user-chosen, stable, the right answer
          }
          // Falls through to the legacy fallback path below.
        } catch {
          // Worktree query failed — trust the stored value, it's the best we have.
          return session.baseBranch;
        }
      } else {
        return session.baseBranch;
      }
    }

    // Legacy sessions still record the commit they started from. Prefer that
    // immutable boundary over a branch ref that may be behind local commits
    // which existed before Pane created the worktree.
    if (!session.isMainRepo && session.baseCommit) {
      return session.baseCommit;
    }

    if (!session.isMainRepo && session.worktreePath) {
      try {
        const { stdout } = await ctx.commandRunner.execAsync(
          'git symbolic-ref --quiet --short refs/remotes/origin/HEAD',
          session.worktreePath,
        );
        const remoteDefaultBranch = stdout.trim();
        if (remoteDefaultBranch) {
          return remoteDefaultBranch;
        }
      } catch {
        // Fall through for repositories without an origin/HEAD symbolic ref.
      }
    }

    // Legacy / unspecified / degenerate fallback path.
    const fallback = await this.getProjectMainBranch(ctx.project.path, ctx.commandRunner);

    if (session.isMainRepo && session.worktreePath) {
      // Preserve existing isMainRepo behavior: prefer origin/<branch> if present.
      const origin = await this.getOriginBranch(session.worktreePath, fallback, ctx.commandRunner);
      return origin || fallback;
    }

    return fallback;
  }

  /**
   * Return the LOCAL branch name to use as the integration target for write
   * operations (squash-and-merge to main, merge to main). Unlike
   * getSessionComparisonBranch, this strips a remote prefix when present so
   * the result can be safely passed to `git checkout` in the project repo
   * without producing detached HEAD.
   *
   * - `origin/main`     → `main`
   * - `origin/staging`  → `staging`
   * - `my-feature`      → `my-feature`
   * - `HEAD` / null     → falls back to project root's current branch
   *
   * If the local branch does not yet exist, the caller is responsible for
   * creating it (e.g. via `git checkout -b name --track origin/name`). Today
   * the write handlers run `git checkout <name>` which will DWIM-create a
   * tracking branch from origin/<name> when one exists.
   */
  async getSessionLocalBaseBranch(
    session: { baseBranch?: string; baseCommit?: string; isMainRepo?: boolean; worktreePath?: string },
    ctx: { project: { path: string }; commandRunner: CommandRunner },
  ): Promise<string> {
    // Do not reuse the read fallback here: it may intentionally resolve to a
    // remote ref or immutable commit. Writes must always target a local branch.
    let ref = session.baseBranch && session.baseBranch !== 'HEAD'
      ? session.baseBranch
      : await this.getProjectMainBranch(ctx.project.path, ctx.commandRunner);

    // Existing-branch panes can store their own checked-out branch as the base.
    // Merging that branch into itself is invalid, so use the project checkout's
    // integration branch just as we do for legacy HEAD sessions.
    if (session.worktreePath && session.baseBranch && session.baseBranch !== 'HEAD') {
      try {
        const { stdout } = await ctx.commandRunner.execAsync(
          'git branch --show-current',
          session.worktreePath,
        );
        if (stdout.trim() === session.baseBranch) {
          ref = await this.getProjectMainBranch(ctx.project.path, ctx.commandRunner);
        }
      } catch {
        // If the worktree cannot be inspected, trust the explicitly stored base.
      }
    }

    // Strip any known remote prefix. Cross-check against `git remote` so we
    // don't mangle a local branch that legitimately has a slash in its name.
    try {
      const { stdout } = await ctx.commandRunner.execAsync('git remote', ctx.project.path);
      const remotes = stdout.trim().split('\n').filter(Boolean);
      for (const remote of remotes) {
        const prefix = `${remote}/`;
        if (ref.startsWith(prefix)) {
          return ref.slice(prefix.length);
        }
      }
    } catch {
      // If we can't list remotes, fall through and treat as local.
    }

    return ref;
  }

  async getProjectMainBranch(projectPath: string, commandRunner: CommandRunner): Promise<string> {

    try {
      // ONLY check the current branch in the project root directory
      const currentBranchResult = await commandRunner.execAsync(`git branch --show-current`, projectPath);
      const currentBranch = currentBranchResult.stdout.trim();
      
      if (currentBranch) {
        return currentBranch;
      }
      
      // Throw error if we're in detached HEAD state
      throw new Error(`Cannot determine main branch: repository at ${projectPath} is in detached HEAD state`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('detached HEAD')) {
        throw error;
      }
      throw new Error(`Failed to get main branch for project at ${projectPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async hasChangesToRebase(worktreePath: string, mainBranch: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      // Check if main branch has commits that the current branch doesn't have
      // Use cross-platform approach
      let stdout = '0';
      try {
        const result = await commandRunner.execFile('git', ['rev-list', '--count', `HEAD..${mainBranch}`, '--'], worktreePath);
        stdout = result.stdout;
      } catch {
        // Error checking, assume no changes
        stdout = '0';
      }
      const commitCount = parseInt(stdout.trim());
      return commitCount > 0;
    } catch (error) {
      console.error(`[WorktreeManager] Error checking for changes to rebase:`, error);
      return false;
    }
  }

  async checkForRebaseConflicts(worktreePath: string, mainBranch: string, commandRunner: CommandRunner): Promise<{
    hasConflicts: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
    canAutoMerge?: boolean;
  }> {
    try {

      // First check if there are any changes to rebase
      const hasChanges = await this.hasChangesToRebase(worktreePath, mainBranch, commandRunner);
      if (!hasChanges) {
        return { hasConflicts: false, canAutoMerge: true };
      }

      // Get the merge base
      const { stdout: mergeBase } = await commandRunner.execAsync(
        `git merge-base HEAD ${mainBranch}`,
        worktreePath
      );
      const base = mergeBase.trim();

      // Try a dry-run merge to detect conflicts
      // We use merge-tree to check for conflicts without modifying the working tree
      try {
        const { stdout: mergeTreeOutput } = await commandRunner.execAsync(
          `git merge-tree ${base} HEAD ${mainBranch}`,
          worktreePath
        );

        // Parse merge-tree output for conflicts
        const conflictMarkers = mergeTreeOutput.match(/<<<<<<< /g);
        const hasConflicts = conflictMarkers && conflictMarkers.length > 0;

        if (hasConflicts) {
          // Get list of files that would conflict
          const { stdout: diffOutput } = await commandRunner.execAsync(
            `git diff --name-only ${base}...HEAD`,
            worktreePath
          );
          const ourFiles = diffOutput.trim().split('\n').filter(f => f);

          const { stdout: theirDiffOutput } = await commandRunner.execAsync(
            `git diff --name-only ${base}...${mainBranch}`,
            worktreePath
          );
          const theirFiles = theirDiffOutput.trim().split('\n').filter(f => f);

          // Find files modified in both branches
          const conflictingFiles = ourFiles.filter(f => theirFiles.includes(f));

          // Get commit info for better error reporting
          const { stdout: ourCommits } = await commandRunner.execAsync(
            `git log --oneline ${base}..HEAD`,
            worktreePath
          );
          const { stdout: theirCommits } = await commandRunner.execAsync(
            `git log --oneline ${base}..${mainBranch}`,
            worktreePath
          );

          console.log(`[WorktreeManager] Found conflicts in files: ${conflictingFiles.join(', ')}`);

          return {
            hasConflicts: true,
            conflictingFiles,
            conflictingCommits: {
              ours: ourCommits.trim().split('\n').filter(c => c),
              theirs: theirCommits.trim().split('\n').filter(c => c)
            },
            canAutoMerge: false
          };
        }

        return { hasConflicts: false, canAutoMerge: true };

      } catch {
        // If merge-tree is not available (older git), fall back to checking modified files
        console.log(`[WorktreeManager] merge-tree not available, using fallback conflict detection`);

        // Get files changed in both branches
        const { stdout: diffOutput } = await commandRunner.execAsync(
          `git diff --name-only ${base}...HEAD`,
          worktreePath
        );
        const ourFiles = diffOutput.trim().split('\n').filter(f => f);

        const { stdout: theirDiffOutput } = await commandRunner.execAsync(
          `git diff --name-only ${base}...${mainBranch}`,
          worktreePath
        );
        const theirFiles = theirDiffOutput.trim().split('\n').filter(f => f);

        // Find files modified in both branches (potential conflicts)
        const conflictingFiles = ourFiles.filter(f => theirFiles.includes(f));

        if (conflictingFiles.length > 0) {
          // Get commit info
          const { stdout: ourCommits } = await commandRunner.execAsync(
            `git log --oneline ${base}..HEAD`,
            worktreePath
          );
          const { stdout: theirCommits } = await commandRunner.execAsync(
            `git log --oneline ${base}..${mainBranch}`,
            worktreePath
          );

          console.log(`[WorktreeManager] Potential conflicts in files: ${conflictingFiles.join(', ')}`);

          return {
            hasConflicts: true,
            conflictingFiles,
            conflictingCommits: {
              ours: ourCommits.trim().split('\n').filter(c => c),
              theirs: theirCommits.trim().split('\n').filter(c => c)
            },
            canAutoMerge: false
          };
        }

        return { hasConflicts: false, canAutoMerge: true };
      }
    } catch (error: unknown) {
      console.error(`[WorktreeManager] Error checking for rebase conflicts:`, error);
      // On error, return unknown status
      return {
        hasConflicts: false,
        canAutoMerge: false
      };
    }
  }

  async rebaseMainIntoWorktree(worktreePath: string, mainBranch: string, commandRunner: CommandRunner): Promise<void> {
    return await withLock(`git-rebase-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';
      const startTime = Date.now();
      let conflictOccurred = false;

      try {
        // Rebase the current worktree branch onto local main branch
        const command = `git rebase ${mainBranch}`;
        executedCommands.push(`${command} (in ${worktreePath})`);
        const rebaseResult = await commandRunner.execAsync(command, worktreePath, { timeout: 120000 });
        lastOutput = rebaseResult.stdout || rebaseResult.stderr || '';

        // Track successful rebase
        if (this.analyticsManager) {
          const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
          this.analyticsManager.track('git_rebase_executed', {
            success: true,
            duration_seconds: durationSeconds,
            conflict_occurred: false
          });
        }
      } catch (error: unknown) {
        const err = decodeBoundary(error, commandErrorSchema);
        console.error(`[WorktreeManager] Failed to rebase ${mainBranch} into worktree:`, err);

        // Check if conflict occurred
        const errorOutput = err.stderr || err.stdout || err.message || '';
        conflictOccurred = errorOutput.includes('CONFLICT');

        // Track failed rebase
        if (this.analyticsManager) {
          const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
          this.analyticsManager.track('git_rebase_executed', {
            success: false,
            duration_seconds: durationSeconds,
            conflict_occurred: conflictOccurred
          });

          // Track operation failure
          const errorCategory = conflictOccurred ? 'conflict' : 'unknown';
          this.analyticsManager.track('git_operation_failed', {
            operation_type: 'rebase_from_main',
            error_category: errorCategory
          });
        }

        // Create detailed error with git command output
        const gitError = new GitOperationError(`Failed to rebase ${mainBranch} into worktree`);
        gitError.gitCommand = executedCommands.join(' && ');
        gitError.gitOutput = err.stderr || err.stdout || lastOutput || err.message || '';
        gitError.workingDirectory = worktreePath;
        gitError.originalError = err;

        throw gitError;
      }
    });
  }

  async abortRebase(worktreePath: string, commandRunner: CommandRunner): Promise<void> {
    try {
      // Check if we're in the middle of a rebase
      const statusCommand = `git status --porcelain=v1`;
      await commandRunner.execAsync(statusCommand, worktreePath);

      // Abort the rebase
      const command = `git rebase --abort`;
      const { stderr } = await commandRunner.execAsync(command, worktreePath);

      if (stderr && !stderr.includes('No rebase in progress')) {
        throw new Error(`Failed to abort rebase: ${stderr}`);
      }
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      console.error(`[WorktreeManager] Error aborting rebase:`, err);
      throw new Error(`Failed to abort rebase: ${err.message}`);
    }
  }

  async squashAndMergeWorktreeToMain(projectPath: string, worktreePath: string, mainBranch: string, commitMessage: string, commandRunner: CommandRunner): Promise<void> {
    return await withLock(`git-squash-merge-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';
      const startTime = Date.now();

      try {
        console.log(`[WorktreeManager] Squashing and merging worktree to ${mainBranch}: ${worktreePath}`);

        // Get current branch name in worktree
        let command = `git branch --show-current`;
        executedCommands.push(`git branch --show-current (in ${worktreePath})`);
        const { stdout: currentBranch, stderr: stderr1 } = await commandRunner.execAsync(command, worktreePath);
        lastOutput = currentBranch || stderr1 || '';
        const branchName = currentBranch.trim();

        // Get the base commit (where the worktree branch diverged from main)
        command = `git merge-base ${mainBranch} HEAD`;
        executedCommands.push(`git merge-base ${mainBranch} HEAD (in ${worktreePath})`);
        const { stdout: baseCommit, stderr: stderr2 } = await commandRunner.execAsync(command, worktreePath);
        lastOutput = baseCommit || stderr2 || '';
        const base = baseCommit.trim();

        // Check if there are any changes to squash
        command = `git log --oneline ${base}..HEAD`;
        const { stdout: commits, stderr: stderr3 } = await commandRunner.execAsync(command, worktreePath);
        lastOutput = commits || stderr3 || '';
        if (!commits.trim()) {
          throw new Error(`No commits to squash. The branch is already up to date with ${mainBranch}.`);
        }

        // SAFETY CHECK 1: Rebase worktree onto main FIRST before squashing
        command = `git rebase ${mainBranch}`;
        executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`);
        try {
          const rebaseWorktreeResult = await commandRunner.execAsync(command, worktreePath, { timeout: 120000 });
          lastOutput = rebaseWorktreeResult.stdout || rebaseWorktreeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully rebased worktree onto ${mainBranch} before squashing`);
        } catch (error: unknown) {
          const err = decodeBoundary(error, commandErrorSchema);
          // If rebase fails, abort it in the worktree
          try {
            await commandRunner.execAsync(`git rebase --abort`, worktreePath);
          } catch {
            // Ignore abort errors
          }

          throw new Error(
            `Failed to rebase worktree onto ${mainBranch} before squashing. Conflicts must be resolved first.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        // Now squash all commits since base into one
        command = `git reset --soft ${base}`;
        executedCommands.push(`git reset --soft ${base} (in ${worktreePath})`);
        const resetResult = await commandRunner.execAsync(command, worktreePath);
        lastOutput = resetResult.stdout || resetResult.stderr || '';

        // Get config to check if Pane footer is enabled (default: true)
        const config = this.configManager?.getConfig();
        const enableCommitFooter = config?.enableCommitFooter !== false;

        // Add Pane footer if enabled
        const fullMessage = enableCommitFooter ? `${commitMessage}

Co-Authored-By: Pane <runpane@users.noreply.github.com>` : commitMessage;

        // Properly escape commit message for cross-platform compatibility
        const escapedMessage = fullMessage.replace(/"/g, '\\"');
        command = `git commit -m "${escapedMessage}"`;
        executedCommands.push(`git commit -m "..." (in ${worktreePath})`);
        const commitResult = await commandRunner.execAsync(command, worktreePath, { env: getGitAttributionEnv(config) });
        lastOutput = commitResult.stdout || commitResult.stderr || '';

        // Switch to main branch in the main repository
        command = `git checkout ${mainBranch}`;
        executedCommands.push(`git checkout ${mainBranch} (in ${projectPath})`);
        const checkoutResult = await commandRunner.execAsync(command, projectPath);
        lastOutput = checkoutResult.stdout || checkoutResult.stderr || '';

        // SAFETY CHECK 2: Use --ff-only merge to prevent history rewriting
        // This will fail if local main has diverged from the worktree branch
        command = `git merge --ff-only ${branchName}`;
        executedCommands.push(`git merge --ff-only ${branchName} (in ${projectPath})`);
        try {
          const mergeResult = await commandRunner.execAsync(command, projectPath);
          lastOutput = mergeResult.stdout || mergeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully fast-forwarded ${mainBranch} to ${branchName}`);
        } catch (error: unknown) {
          const err = decodeBoundary(error, commandErrorSchema);
          throw new Error(
            `Failed to fast-forward ${mainBranch} to ${branchName}.\n\n` +
            `This usually means ${mainBranch} has commits that ${branchName} doesn't have.\n` +
            `You may need to rebase the worktree onto ${mainBranch} first, or reset ${mainBranch} to match origin.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        console.log(`[WorktreeManager] Successfully squashed and merged worktree to ${mainBranch}`);

        // Track successful squash and merge
        if (this.analyticsManager) {
          const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
          // Get commit count from the commits variable (already fetched earlier)
          const commitCount = commits.trim().split('\n').filter(Boolean).length;
          const commitCountCategory = this.analyticsManager.categorizeNumber(commitCount, [1, 3, 5, 10, 25]);

          this.analyticsManager.track('git_squash_executed', {
            success: true,
            duration_seconds: durationSeconds,
            commit_count_category: commitCountCategory
          });
        }
      } catch (error: unknown) {
        const err = decodeBoundary(error, commandErrorSchema);
        console.error(`[WorktreeManager] Failed to squash and merge worktree to ${mainBranch}:`, err);

        // Track failed squash
        if (this.analyticsManager) {
          const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
          const errorOutput = err.stderr || err.stdout || err.message || '';
          const errorCategory = errorOutput.includes('CONFLICT') ? 'conflict' :
                                errorOutput.includes('merge') ? 'merge_failed' :
                                errorOutput.includes('rebase') ? 'rebase_failed' : 'unknown';

          this.analyticsManager.track('git_squash_executed', {
            success: false,
            duration_seconds: durationSeconds,
            commit_count_category: '0-1' // Unknown on failure
          });

          this.analyticsManager.track('git_operation_failed', {
            operation_type: 'squash_and_merge',
            error_category: errorCategory
          });
        }

        // Create detailed error with git command output
        const gitError = new GitOperationError(`Failed to squash and merge worktree to ${mainBranch}`);
        gitError.gitCommands = executedCommands;
        // Prioritize actual error messages over lastOutput (which may contain unrelated data like commit counts)
        gitError.gitOutput = err.stderr || err.stdout || err.message || lastOutput || '';
        gitError.workingDirectory = worktreePath;
        gitError.projectPath = projectPath;
        gitError.originalError = err;

        throw gitError;
      }
    });
  }

  async mergeWorktreeToMain(projectPath: string, worktreePath: string, mainBranch: string, commandRunner: CommandRunner): Promise<void> {
    return await withLock(`git-merge-worktree-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';

      try {
        console.log(`[WorktreeManager] Merging worktree to ${mainBranch} (without squashing): ${worktreePath}`);

        // Get current branch name in worktree
        let command = `git branch --show-current`;
        executedCommands.push(`git branch --show-current (in ${worktreePath})`);
        const { stdout: currentBranch, stderr: stderr1 } = await commandRunner.execAsync(command, worktreePath);
        lastOutput = currentBranch || stderr1 || '';
        const branchName = currentBranch.trim();

        // Check if there are any changes to merge
        command = `git log --oneline ${mainBranch}..HEAD`;
        const { stdout: commits, stderr: stderr2 } = await commandRunner.execAsync(command, worktreePath);
        lastOutput = commits || stderr2 || '';
        if (!commits.trim()) {
          throw new Error(`No commits to merge. The branch is already up to date with ${mainBranch}.`);
        }

        // SAFETY CHECK 1: Rebase worktree onto main FIRST (resolves conflicts in worktree, not main)
        command = `git rebase ${mainBranch}`;
        executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`);
        try {
          const rebaseWorktreeResult = await commandRunner.execAsync(command, worktreePath, { timeout: 120000 });
          lastOutput = rebaseWorktreeResult.stdout || rebaseWorktreeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully rebased worktree onto ${mainBranch}`);
        } catch (error: unknown) {
          const err = decodeBoundary(error, commandErrorSchema);
          // If rebase fails, abort it in the worktree
          try {
            await commandRunner.execAsync(`git rebase --abort`, worktreePath);
          } catch {
            // Ignore abort errors
          }

          throw new Error(
            `Failed to rebase worktree onto ${mainBranch}. Conflicts must be resolved first.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        // Switch to main branch in the main repository
        command = `git checkout ${mainBranch}`;
        executedCommands.push(`git checkout ${mainBranch} (in ${projectPath})`);
        const checkoutResult = await commandRunner.execAsync(command, projectPath);
        lastOutput = checkoutResult.stdout || checkoutResult.stderr || '';

        // SAFETY CHECK 2: Use --ff-only merge to prevent history rewriting
        // This will fail if local main has diverged from the worktree branch
        command = `git merge --ff-only ${branchName}`;
        executedCommands.push(`git merge --ff-only ${branchName} (in ${projectPath})`);
        try {
          const mergeResult = await commandRunner.execAsync(command, projectPath);
          lastOutput = mergeResult.stdout || mergeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully fast-forwarded ${mainBranch} to ${branchName}`);
        } catch (error: unknown) {
          const err = decodeBoundary(error, commandErrorSchema);
          throw new Error(
            `Failed to fast-forward ${mainBranch} to ${branchName}.\n\n` +
            `This usually means ${mainBranch} has commits that ${branchName} doesn't have.\n` +
            `You may need to rebase the worktree onto ${mainBranch} first, or reset ${mainBranch} to match origin.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        console.log(`[WorktreeManager] Successfully merged worktree to ${mainBranch} (without squashing)`);
      } catch (error: unknown) {
        const err = decodeBoundary(error, commandErrorSchema);
        console.error(`[WorktreeManager] Failed to merge worktree to ${mainBranch}:`, err);

        // Create detailed error with git command output
        const gitError = new GitOperationError(`Failed to merge worktree to ${mainBranch}`);
        gitError.gitCommands = executedCommands;
        // Prioritize actual error messages over lastOutput (which may contain unrelated data like commit counts)
        gitError.gitOutput = err.stderr || err.stdout || err.message || lastOutput || '';
        gitError.workingDirectory = worktreePath;
        gitError.projectPath = projectPath;
        gitError.originalError = err;

        throw gitError;
      }
    });
  }

  generateRebaseCommands(mainBranch: string): string[] {
    return [
      `git rebase ${mainBranch}`
    ];
  }

  generateSquashCommands(mainBranch: string, branchName: string): string[] {
    return [
      `# In worktree: Rebase onto ${mainBranch} to get latest changes`,
      `git rebase ${mainBranch}`,
      `# In worktree: Squash all commits into one`,
      `git reset --soft $(git merge-base ${mainBranch} HEAD)`,
      `git commit -m "Your commit message"`,
      `# In main repo: Switch to ${mainBranch}`,
      `git checkout ${mainBranch}`,
      `# In main repo: Merge the worktree branch`,
      `git merge --ff-only ${branchName}`
    ];
  }

  generateMergeCommands(mainBranch: string, branchName: string): string[] {
    return [
      `# In worktree: Rebase onto ${mainBranch} to get latest changes`,
      `git rebase ${mainBranch}`,
      `# In main repo: Switch to ${mainBranch}`,
      `git checkout ${mainBranch}`,
      `# In main repo: Merge the worktree branch`,
      `git merge --ff-only ${branchName}`
    ];
  }

  async gitPull(worktreePath: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      const { stdout, stderr } = await commandRunner.execAsync('git pull', worktreePath, { timeout: 60000 });
      const output = stdout || stderr || 'Pull completed successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git pull failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async gitPush(worktreePath: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      // Check if branch has an upstream configured
      let hasUpstream = false;
      try {
        await commandRunner.execAsync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', worktreePath);
        hasUpstream = true;
      } catch {
        // No upstream configured
        hasUpstream = false;
      }

      // Use -u to set upstream on first push, otherwise regular push
      const pushCommand = hasUpstream ? 'git push' : 'git push -u origin HEAD';
      const { stdout, stderr } = await commandRunner.execAsync(pushCommand, worktreePath, { timeout: 60000 });
      const output = stdout || stderr || 'Push completed successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git push failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async gitFetch(worktreePath: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      const { stdout, stderr } = await commandRunner.execAsync('git fetch --all', worktreePath, { timeout: 30000 });
      const output = stdout || stderr || 'Fetch completed successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git fetch failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async gitStash(worktreePath: string, message: string | undefined, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      const stashMessage = message || 'pane stash';
      const escapedMessage = stashMessage.replace(/"/g, '\\"');
      const { stdout, stderr } = await commandRunner.execAsync(`git stash push -m "${escapedMessage}"`, worktreePath);
      const output = stdout || stderr || 'Changes stashed successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git stash failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async gitStashPop(worktreePath: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      const { stdout, stderr } = await commandRunner.execAsync('git stash pop', worktreePath);
      const output = stdout || stderr || 'Stash applied successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git stash pop failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async hasStash(worktreePath: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      const { stdout } = await commandRunner.execAsync('git stash list', worktreePath);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async gitSoftReset(worktreePath: string, mainBranch: string, commandRunner: CommandRunner): Promise<{ output: string; previousCommitMessage: string }> {
    // Live safety check — count commits ahead of main branch
    const { stdout: aheadOutput } = await commandRunner.execFile(
      'git', ['log', '--oneline', 'HEAD', `^${mainBranch}`, '--'],
      worktreePath,
      { timeout: 30000 }
    );
    const aheadCount = aheadOutput.trim().split('\n').filter(Boolean).length;
    if (aheadCount === 0) {
      throw new Error('No commits to undo — already at base branch');
    }

    // Capture current HEAD commit message before resetting
    const { stdout: commitMessage } = await commandRunner.execFile(
      'git', ['log', '-1', '--pretty=%B'],
      worktreePath,
      { timeout: 10000 }
    );

    // Perform soft reset
    const { stdout: output } = await commandRunner.execFile(
      'git', ['reset', '--soft', 'HEAD~1'],
      worktreePath,
      { timeout: 30000 }
    );

    return {
      output: output.trim(),
      previousCommitMessage: commitMessage.trim()
    };
  }

  async setUpstream(worktreePath: string, remoteBranch: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      const { stdout, stderr } = await commandRunner.execFile('git', ['branch', `--set-upstream-to=${remoteBranch}`], worktreePath);
      const output = stdout || stderr || `Tracking set to ${remoteBranch}`;
      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Failed to set upstream');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async getUpstream(worktreePath: string, commandRunner: CommandRunner): Promise<string | null> {
    try {
      const { stdout } = await commandRunner.execAsync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', worktreePath);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getRemoteBranches(worktreePath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      const { stdout } = await commandRunner.execAsync('git branch -r', worktreePath);
      return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.includes('HEAD ->'));
    } catch {
      return [];
    }
  }

  async gitStageAllAndCommit(worktreePath: string, message: string, commandRunner: CommandRunner): Promise<{ output: string }> {
    try {
      // Stage all changes including untracked files
      await commandRunner.execAsync('git add -A', worktreePath);

      // Commit with message
      const escapedMessage = message.replace(/"/g, '\\"');
      const { stdout, stderr } = await commandRunner.execAsync(`git commit -m "${escapedMessage}"`, worktreePath, { env: getGitAttributionEnv(this.configManager?.getConfig()) });
      const output = stdout || stderr || 'Committed successfully';

      return { output };
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Git commit failed');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async getLastCommits(worktreePath: string, count: number, commandRunner: CommandRunner): Promise<RawCommitData[]> {
    try {
      const { stdout } = await commandRunner.execAsync(
        `git log -${count} --pretty=format:"%H|%s|%ai|%an" --shortstat`,
        worktreePath
      );

      const commits: RawCommitData[] = [];
      const lines = stdout.split('\n');
      let i = 0;

      while (i < lines.length) {
        const commitLine = lines[i];
        if (!commitLine || !commitLine.includes('|')) {
          i++;
          continue;
        }

        const parts = commitLine.split('|');
        const hash = parts.shift() || '';
        const author = (parts.pop() || '').trim();
        const date = (parts.pop() || '').trim();
        const message = parts.join('|');

        const commit: RawCommitData = {
          hash: hash.trim(),
          message: message.trim(),
          date,
          author: author || 'Unknown'
        };

        if (i + 1 < lines.length && lines[i + 1].trim()) {
          const statsLine = lines[i + 1].trim();
          const statsMatch = statsLine.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);

          if (statsMatch) {
            commit.filesChanged = parseInt(statsMatch[1]) || 0;
            commit.additions = parseInt(statsMatch[2]) || 0;
            commit.deletions = parseInt(statsMatch[3]) || 0;
            i++;
          }
        }

        commits.push(commit);
        i++;
      }

      return commits;
    } catch (error: unknown) {
      const err = decodeBoundary(error, commandErrorSchema);
      const gitError = new GitOperationError(err.message || 'Failed to get commits');
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async getOriginBranch(worktreePath: string, branch: string, commandRunner: CommandRunner): Promise<string | null> {
    try {
      await commandRunner.execFile('git', ['rev-parse', '--verify', '--end-of-options', `origin/${branch}`], worktreePath);
      return `origin/${branch}`;
    } catch {
      return null;
    }
  }
}
