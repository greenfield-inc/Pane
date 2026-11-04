import crypto from 'crypto';
import * as path from 'path';
import type { PathResolver } from '../utils/pathResolver';
import type { CommandRunner } from '../utils/commandRunner';
import { forceRemoveWorktree } from './gitPerformanceConfig';
import { withArchiveRepositoryLock } from './archiveRepositoryLock';
import { archivePathKey } from './archiveCleanupFilesystem';
import { refreshWorktreeBase } from './worktreeBaseRefresh';

interface ReserveWorktree {
  reserveName: string;
  reservePath: string;
  branchName: string;
  projectPath: string;
  baseRef: string;
  baseCommit: string; // the commit the reserve is checked out at — a claim compares the base ref against it
  createdAt: number;
}

/**
 * WorktreePoolManager pre-creates reserve worktrees per project so session
 * creation is near-instant. It is a singleton service. A reserve is made from
 * a freshly fetched base (refreshWorktreeBase) and is only handed out while
 * the base ref still points at the commit it was made from. The pool never
 * fails a create: the create path's capped base refresh is its only wait, and
 * a missing or outdated reserve means a normal `git worktree add` instead.
 */
class WorktreePoolManager {
  /** Map key: "<projectPath>::<baseRef>" */
  private reserves = new Map<string, ReserveWorktree>();
  /** Replenishments still running after the create that started them returned. */
  private replenishing = new Set<Promise<void>>();

  private static readonly STALE_MS = 1_800_000; // 30 minutes

  // ---------------------------------------------------------------------------
  // Path helpers (inlined — do NOT call WorktreeManager's private methods)
  // ---------------------------------------------------------------------------

  private resolveBaseDir(projectPath: string, worktreeFolder: string | undefined, pathResolver: PathResolver): string {
    if (worktreeFolder && (worktreeFolder.startsWith('/') || worktreeFolder.includes(':'))) {
      return worktreeFolder;
    }
    return pathResolver.join(projectPath, worktreeFolder || 'worktrees');
  }

  private reserveKey(projectPath: string, baseRef: string): string {
    return `${projectPath}::${baseRef}`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  hasReserve(projectPath: string, baseRef: string): boolean {
    return this.reserves.has(this.reserveKey(projectPath, baseRef));
  }

  /**
   * Makes a reserve without the caller waiting for it. Its git commands keep
   * running in the project after the create returns; `idle()` waits for them.
   */
  replenishInBackground(
    projectPath: string,
    baseRef: string,
    worktreeFolder: string | undefined,
    pathResolver: PathResolver,
    commandRunner: CommandRunner
  ): void {
    const work = this.createReserve(projectPath, baseRef, worktreeFolder, pathResolver, commandRunner).catch(err => {
      console.warn('[WorktreePool] Background reserve replenishment failed:', err);
    });
    this.replenishing.add(work);
    void work.finally(() => this.replenishing.delete(work));
  }

  /**
   * Resolves once no background replenishment is running. A process still
   * running git inside a project keeps Windows from deleting that folder.
   */
  async idle(): Promise<void> {
    while (this.replenishing.size > 0) await Promise.all(this.replenishing);
  }

  /**
   * Create a single pre-warmed worktree in the background.
   * Errors are caught and logged; callers should fire-and-forget.
   * The base is refreshed before the repository lock is taken, so a slow
   * fetch never blocks other repository work.
   */
  async createReserve(
    projectPath: string,
    baseRef: string,
    worktreeFolder: string | undefined,
    pathResolver: PathResolver,
    commandRunner: CommandRunner
  ): Promise<void> {
    if (this.reserves.has(this.reserveKey(projectPath, baseRef))) {
      return;
    }
    await refreshWorktreeBase(projectPath, baseRef, commandRunner);
    return withArchiveRepositoryLock(projectPath, commandRunner, () =>
      this.createReserveUnderLock(projectPath, baseRef, worktreeFolder, pathResolver, commandRunner));
  }

  private async createReserveUnderLock(
    projectPath: string,
    baseRef: string,
    worktreeFolder: string | undefined,
    pathResolver: PathResolver,
    commandRunner: CommandRunner
  ): Promise<void> {
    const key = this.reserveKey(projectPath, baseRef);
    // Don't create duplicate reserves for the same key
    if (this.reserves.has(key)) {
      return;
    }

    const hex = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    const reserveName = `_reserve-${hex}`;
    const branchName = `_reserve/${hex}`;
    const baseDir = this.resolveBaseDir(projectPath, worktreeFolder, pathResolver);
    const reservePath = pathResolver.join(baseDir, reserveName);

    // Resolve the base once and add the worktree at that commit, so the
    // recorded commit is the reserve's own HEAD even if the ref moves meanwhile.
    let baseCommit: string;
    try {
      const { stdout } = await commandRunner.execFile(
        'git', ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
        projectPath,
        { timeout: 10000 }
      );
      baseCommit = stdout.trim();
      await commandRunner.execFile(
        'git', ['worktree', 'add', '-b', branchName, '--no-track', '--', reservePath, baseCommit],
        projectPath,
        { timeout: 60000 }
      );
    } catch (error) {
      console.warn('[WorktreePool] Failed to create reserve worktree:', error);
      return;
    }

    const reserve: ReserveWorktree = {
      reserveName,
      reservePath,
      branchName,
      projectPath,
      baseRef,
      baseCommit,
      createdAt: Date.now(),
    };
    this.reserves.set(key, reserve);
    console.log(`[WorktreePool] Reserve created: ${reserveName} (branch: ${branchName})`);
  }

  /**
   * Attempt to claim a pre-created reserve worktree by renaming it to the
   * target name. Returns null if no usable reserve exists. The caller holds
   * the repository queue while checking its target reservation and claiming.
   */
  async claimReserve(
    projectPath: string,
    baseRef: string,
    targetName: string,
    targetBranch: string,
    worktreeFolder: string | undefined,
    pathResolver: PathResolver,
    commandRunner: CommandRunner
  ): Promise<{ worktreePath: string } | null> {
    const key = this.reserveKey(projectPath, baseRef);
    const reserve = this.reserves.get(key);
    if (!reserve) {
      return null;
    }

    // Check staleness
    if (Date.now() - reserve.createdAt > WorktreePoolManager.STALE_MS) {
      console.log(`[WorktreePool] Reserve ${reserve.reserveName} is stale — discarding`);
      this.reserves.delete(key);
      await this.removeReserve(reserve, projectPath, commandRunner);
      return null;
    }

    // Check that the base ref hasn't advanced since the reserve was created
    try {
      const { stdout: currentHead } = await commandRunner.execFile(
        'git', ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
        projectPath,
        { timeout: 10000 }
      );
      if (currentHead.trim() !== reserve.baseCommit) {
        console.log(`[WorktreePool] Reserve ${reserve.reserveName} base has advanced — discarding`);
        this.reserves.delete(key);
        await this.removeReserve(reserve, projectPath, commandRunner);
        return null;
      }
    } catch {
      // If we can't verify, discard to be safe
      this.reserves.delete(key);
      await this.removeReserve(reserve, projectPath, commandRunner);
      return null;
    }

    // Remove from map immediately so nothing else claims this reserve
    this.reserves.delete(key);

    const baseDir = this.resolveBaseDir(projectPath, worktreeFolder, pathResolver);
    const targetPath = pathResolver.join(baseDir, targetName);

    try {
      await commandRunner.execFile('git', ['check-ref-format', '--branch', targetBranch], projectPath);

      // Rename the worktree directory
      await commandRunner.execFile(
        'git', ['worktree', 'move', '--', reserve.reservePath, targetPath],
        projectPath,
        { timeout: 30000 }
      );

      // Rename the branch
      await commandRunner.execFile(
        'git', ['branch', '-m', '--', reserve.branchName, targetBranch],
        projectPath,
        { timeout: 15000 }
      );
    } catch (error) {
      console.warn('[WorktreePool] Worktree move failed (Git < 2.29?), falling back:', error);
      // Clean up the orphaned reserve and signal fallback
      await this.removeReserve(reserve, projectPath, commandRunner);
      return null;
    }

    console.log(`[WorktreePool] Reserve ${reserve.reserveName} claimed as ${targetName}`);

    // Replenish the pool in the background
    this.replenishInBackground(projectPath, baseRef, worktreeFolder, pathResolver, commandRunner);

    return { worktreePath: targetPath };
  }

  /**
   * Remove a reserve worktree — errors are caught and logged.
   */
  private async removeReserve(
    reserve: ReserveWorktree,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<void> {
    try {
      await forceRemoveWorktree(reserve.reservePath, projectPath, commandRunner, { timeout: 30000 });
    } catch (error) {
      console.warn(`[WorktreePool] Failed to remove reserve worktree ${reserve.reservePath}:`, error);
    }

    try {
      await commandRunner.execFile(
        'git', ['branch', '-D', '--', reserve.branchName],
        projectPath,
        { timeout: 15000 }
      );
    } catch (error) {
      console.warn(`[WorktreePool] Failed to delete reserve branch ${reserve.branchName}:`, error);
    }

    // Remove from the in-memory map (in case it wasn't removed before calling this)
    const key = this.reserveKey(projectPath, reserve.baseRef);
    this.reserves.delete(key);
  }

  /**
   * Scan the git worktree list for any leftover _reserve-* worktrees and
   * branches from a previous run and remove them.
   */
  async cleanupOrphanedReserves(projectPath: string, commandRunner: CommandRunner): Promise<void> {
    return withArchiveRepositoryLock(projectPath, commandRunner, () => this.cleanupOrphanedReservesUnderLock(projectPath, commandRunner));
  }

  private async cleanupOrphanedReservesUnderLock(projectPath: string, commandRunner: CommandRunner): Promise<void> {
    let worktreeListOutput: string;
    try {
      const { stdout } = await commandRunner.execFile(
        'git', ['worktree', 'list', '--porcelain'],
        projectPath,
        { timeout: 30000 }
      );
      worktreeListOutput = stdout;
    } catch (error) {
      console.warn('[WorktreePool] Failed to list worktrees during cleanup:', error);
      return;
    }

    // Parse porcelain output: lines starting with "worktree " give the path
    // Exclude paths that belong to currently-tracked (just-created) reserves
    const activeReservePaths = new Set([...this.reserves.values()].map(r => archivePathKey(r.reservePath)));
    const orphanPaths: string[] = [];
    for (const line of worktreeListOutput.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wtPath = line.substring('worktree '.length).trim();
        const dirName = path.basename(wtPath);
        if (/^_reserve-[0-9a-f]{8}$/.test(dirName) && !activeReservePaths.has(archivePathKey(wtPath))) {
          orphanPaths.push(wtPath);
        }
      }
    }

    for (const wtPath of orphanPaths) {
      console.log(`[WorktreePool] Removing orphaned reserve worktree: ${wtPath}`);
      try {
        await forceRemoveWorktree(wtPath, projectPath, commandRunner, { timeout: 30000 });
      } catch (error) {
        console.warn(`[WorktreePool] Failed to remove orphaned worktree ${wtPath}:`, error);
      }
    }

    // Clean up orphaned reserve branches
    let branchListOutput: string;
    try {
      const { stdout } = await commandRunner.execFile(
        'git', ['branch', '-l'],
        projectPath,
        { timeout: 15000 }
      );
      branchListOutput = stdout;
    } catch (error) {
      console.warn('[WorktreePool] Failed to list branches during cleanup:', error);
      return;
    }

    // Exclude branches that belong to currently-tracked (just-created) reserves
    const activeBranches = new Set([...this.reserves.values()].map(r => r.branchName));
    const orphanBranches = branchListOutput
      .split('\n')
      .map(line => line.replace(/^[*+]?\s*/, '').trim())
      .filter(branch => branch.startsWith('_reserve/') && !activeBranches.has(branch));

    for (const branch of orphanBranches) {
      console.log(`[WorktreePool] Removing orphaned reserve branch: ${branch}`);
      try {
        await commandRunner.execFile(
          'git', ['branch', '-D', '--', branch],
          projectPath,
          { timeout: 15000 }
        );
      } catch (error) {
        console.warn(`[WorktreePool] Failed to delete orphaned branch ${branch}:`, error);
      }
    }
  }
}

export const worktreePoolManager = new WorktreePoolManager();
