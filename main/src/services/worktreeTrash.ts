import { promises as nodeFs } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { randomBytes } from 'crypto';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import { forceRemoveWorktree, stopFsmonitorDaemon } from './gitPerformanceConfig';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

// Worktrees contain physical files, including dependencies' .asar archives.
// Electron's patched fs treats those archives as directories and caches open
// handles, so recursive removal can lock its own input on Windows. Bypass ASAR
// interpretation for all worktree filesystem operations. Plain Node (including
// service tests) has no original-fs module and already uses physical semantics.
// SAFETY: Electron's built-in original-fs exposes the Node fs API unchanged.
const fs: typeof nodeFs = process.versions.electron
  ? (createRequire(__filename)('original-fs') as typeof import('fs')).promises
  : nodeFs;

/**
 * Once the worktree is removed, whether its files are fully deleted:
 * - `done`: the files are gone.
 * - `pending`: git no longer knows the worktree and its path is free, but its
 *   files are still being deleted from the trash in the background.
 */
export type WorktreeTrashDeletion = 'pending' | 'done';

const TRASH_DIRECTORY = 'pane-trash';
/** Small worktrees usually finish deleting within this window, so they report `removed`. */
const INLINE_DELETE_GRACE_MS = 1_500;
const GIT_TIMEOUT_MS = 30_000;
/**
 * How long to keep retrying a move or delete that something still has open.
 *
 * Windows refuses both while the directory is a live process's current working
 * directory, and releases it within a few milliseconds of that process exiting.
 * Archive already waits for the panel processes to exit, so this only has to
 * cover the tail: a stray child, or the gap before the OS drops the handle.
 */
const BUSY_RETRY_BUDGET_MS = 2_000;
const BUSY_RETRY_DELAY_MS = 25;
/** What Windows reports for a directory that is otherwise perfectly removable. */
const BUSY_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

const pendingDeletes = new Map<string, Promise<boolean>>();

/**
 * Removes a linked worktree without waiting for its files to be deleted.
 *
 * `git worktree remove` deletes every file before returning, which takes
 * minutes for a large `node_modules`. Instead, the directory is renamed into
 * `<git-common-dir>/pane-trash/`, which is on the same filesystem as the
 * repository and so is instant, then `git worktree prune` drops git's record
 * of it and the files are deleted in the background. The branch is kept.
 *
 * Falls back to `git worktree remove --force` when the rename cannot work:
 * WSL projects, a path that is not a linked worktree of this repository, or a
 * rename that keeps failing (a worktree on another filesystem, or open files
 * on Windows that outlast the retry budget).
 */
export async function removeWorktreeViaTrash(
  worktreePath: string,
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
  options: { label?: string; inlineGraceMs?: number; busyRetryMs?: number } = {},
): Promise<WorktreeTrashDeletion> {
  const trashRoot = await resolveTrashRoot(worktreePath, projectPath, pathResolver, commandRunner);
  if (!trashRoot) {
    await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
    return 'done';
  }

  await stopFsmonitorDaemon(worktreePath, commandRunner);
  const entryName = `${sanitizeTrashLabel(options.label ?? path.basename(worktreePath))}-${randomBytes(4).toString('hex')}`;
  const trashPath = path.join(trashRoot, entryName);
  const busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_BUDGET_MS;
  let trashed = true;
  try {
    await fs.mkdir(trashRoot, { recursive: true });
    await renameWhileBusy(worktreePath, trashPath, busyRetryMs);
  } catch (error) {
    console.warn(`[WorktreeTrash] rename_failed worktreePath=${JSON.stringify(worktreePath)} falling back to git worktree remove:`, error);
    trashed = await removeWithGit(worktreePath, projectPath, trashPath, commandRunner, busyRetryMs);
  }

  // Register before anything else awaits so a concurrent sweep skips this entry.
  const deletion = trashed ? deleteTrashEntry(trashPath) : Promise.resolve(true);
  try {
    await commandRunner.execFile('git', ['worktree', 'prune'], projectPath, { silent: true, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    // The worktree's directory is already gone, so git prunes the stale record on its next gc.
    console.warn(`[WorktreeTrash] prune_failed projectPath=${JSON.stringify(projectPath)}:`, error);
  }
  void sweepTrashRoot(trashRoot);

  const graceMs = options.inlineGraceMs ?? INLINE_DELETE_GRACE_MS;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    deletion,
    new Promise<boolean>(resolve => {
      graceTimer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  clearTimeout(graceTimer);
  return finished ? 'done' : 'pending';
}

/**
 * Deletes trash left behind by an earlier run, for example when Pane quit
 * while a background delete was still running.
 */
export async function sweepWorktreeTrash(
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
): Promise<void> {
  if (!supportsTrash(pathResolver, commandRunner)) return;
  try {
    const [commonDirectory] = await revParse(projectPath, ['--git-common-dir'], commandRunner);
    if (!commonDirectory) return;
    await sweepTrashRoot(path.join(commonDirectory, TRASH_DIRECTORY));
  } catch (error) {
    console.warn(`[WorktreeTrash] sweep_failed projectPath=${JSON.stringify(projectPath)}:`, error);
  }
}

/** Resolves once every background delete started so far has finished. For tests and shutdown. */
export async function waitForPendingWorktreeTrash(): Promise<void> {
  await Promise.all([...pendingDeletes.values()]);
}

/**
 * Moves the worktree into the trash, retrying for `budgetMs` while something
 * still has it open.
 *
 * The directory is held by a process whose exit we have already asked for and
 * waited on, so the retry covers only the tail of that teardown — a stray
 * child, or the moment before Windows drops the handle. Harmless elsewhere:
 * POSIX never reports a directory busy for being someone's cwd, so the first
 * attempt succeeds and the loop ends.
 */
async function renameWhileBusy(from: string, to: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    const failure = await fs.rename(from, to).then(() => undefined, (error: NodeJS.ErrnoException) => error);
    if (!failure) {
      if (attempt > 1) console.log(`[WorktreeTrash] rename_retry_succeeded from=${JSON.stringify(from)} attempts=${attempt}`);
      return;
    }
    if (!isBusyError(failure) || Date.now() >= deadline) throw failure;
    await delay(BUSY_RETRY_DELAY_MS);
  }
}

/**
 * Removes the worktree with git, for the cases the rename cannot handle: a
 * worktree on another filesystem, or one still held open past the retry budget.
 *
 * `git worktree remove --force` can delete every file inside the worktree and
 * then fail on the root directory, because a live process is sitting in it.
 * Recover that case by moving the leftover aside, or removing an empty root.
 * Git can also fail with files still present (for example, Windows long paths).
 * Never recursively delete that leftover in place: fs.rm retries can restart
 * child walks at every depth, with no cancellation or total retry deadline.
 * One busy descendant can hold the serial archive queue for minutes.
 * Only a successful rename makes recursive background deletion safe.
 *
 * Returns whether the leftover ended up at `trashPath`, so the caller deletes
 * it in the background like any other trashed worktree. Rethrows git's error
 * when the directory genuinely cannot be removed.
 */
async function removeWithGit(
  worktreePath: string,
  projectPath: string,
  trashPath: string,
  commandRunner: CommandRunner,
  busyRetryMs: number,
): Promise<boolean> {
  try {
    await forceRemoveWorktree(worktreePath, projectPath, commandRunner);
    return false;
  } catch (gitError) {
    // git removed the directory and failed on its own bookkeeping; the
    // caller's `git worktree prune` finishes that.
    if (!await exists(worktreePath)) return false;
    try {
      await renameWhileBusy(worktreePath, trashPath, busyRetryMs);
      console.warn(`[WorktreeTrash] git_remove_left_directory worktreePath=${JSON.stringify(worktreePath)} moved the leftover into the trash`);
      return true;
    } catch (renameError) {
      console.warn(`[WorktreeTrash] leftover_rename_failed worktreePath=${JSON.stringify(worktreePath)}:`, renameError);
    }
    await removeEmptyRootWhileBusy(worktreePath, busyRetryMs)
      .catch(error => console.warn(`[WorktreeTrash] leftover_delete_failed worktreePath=${JSON.stringify(worktreePath)}:`, error));
    if (await exists(worktreePath)) throw gitError;
    return false;
  }
}

async function removeEmptyRootWhileBusy(target: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      await fs.rmdir(target);
      return;
    } catch (error) {
      const failure = decodeOptionalBoundary(error, boundary.object({ code: boundary.string }));
      if (failure?.code === 'ENOENT') return;
      if (!failure || !BUSY_ERROR_CODES.has(failure.code) || Date.now() >= deadline) throw error;
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }
}

function isBusyError(error: NodeJS.ErrnoException): boolean {
  const code = decodeOptionalBoundary(error, boundary.object({ code: boundary.string }))?.code;
  return code !== undefined && BUSY_ERROR_CODES.has(code);
}

function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sweepTrashRoot(trashRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(trashRoot);
  } catch {
    return;
  }
  await Promise.all(entries.map(entry => deleteTrashEntry(path.join(trashRoot, entry))));
}

function deleteTrashEntry(trashPath: string): Promise<boolean> {
  const pending = pendingDeletes.get(trashPath);
  if (pending) return pending;
  const deletion = fs.rm(trashPath, { recursive: true, force: true, maxRetries: 3 })
    .then(() => true)
    .catch(error => {
      console.warn(`[WorktreeTrash] delete_failed trashPath=${JSON.stringify(trashPath)}:`, error);
      return false;
    })
    .finally(() => {
      pendingDeletes.delete(trashPath);
    });
  pendingDeletes.set(trashPath, deletion);
  return deletion;
}

/**
 * How `worktreePath` relates to the project's repository:
 * - `linked`: a linked worktree (`git worktree add`), which is safe to remove.
 * - `main`: the repository's main checkout.
 * - `foreign`: a checkout of a different repository.
 * - `unknown`: git could not answer, for example because the path is gone.
 */
export async function classifyWorktree(
  worktreePath: string,
  projectPath: string,
  commandRunner: CommandRunner,
): Promise<{ kind: 'linked'; commonDirectory: string; gitDirectory: string } | { kind: 'main' | 'foreign' | 'unknown' }> {
  try {
    const [projectCommon] = await revParse(projectPath, ['--git-common-dir'], commandRunner);
    const [worktreeGitDir, worktreeCommon] = await revParse(worktreePath, ['--git-dir', '--git-common-dir'], commandRunner);
    if (!projectCommon || !worktreeGitDir || !worktreeCommon) return { kind: 'unknown' };
    const [common, candidateCommon, candidateGitDir] = await Promise.all([
      fs.realpath(projectCommon),
      fs.realpath(worktreeCommon),
      fs.realpath(worktreeGitDir),
    ]);
    if (candidateCommon !== common) return { kind: 'foreign' };
    if (candidateGitDir === common) return { kind: 'main' };
    return { kind: 'linked', commonDirectory: common, gitDirectory: candidateGitDir };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The trash directory for a linked worktree of the project's repository, or
 * null when the fast path does not apply. The main checkout and a separate
 * clone are never moved, and neither is a locked worktree: `git worktree
 * prune` keeps its record, and `git worktree remove --force` refuses it too.
 */
async function resolveTrashRoot(
  worktreePath: string,
  projectPath: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
): Promise<string | null> {
  if (!supportsTrash(pathResolver, commandRunner)) return null;
  const worktree = await classifyWorktree(worktreePath, projectPath, commandRunner);
  if (worktree.kind !== 'linked') return null;
  const locked = await fs.access(path.join(worktree.gitDirectory, 'locked')).then(() => true, () => false);
  return locked ? null : path.join(worktree.commonDirectory, TRASH_DIRECTORY);
}

function supportsTrash(pathResolver: PathResolver, commandRunner: CommandRunner): boolean {
  // WSL paths are Linux paths that Node reaches through \\wsl$ shares; keep git's own removal there.
  return pathResolver.environment !== 'wsl' && !commandRunner.wslContext;
}

async function revParse(cwd: string, flags: readonly string[], commandRunner: CommandRunner): Promise<string[]> {
  const { stdout } = await commandRunner.execFile('git', ['rev-parse', ...flags], cwd, { silent: true, timeout: GIT_TIMEOUT_MS });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(value => path.resolve(cwd, value));
}

function sanitizeTrashLabel(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+/u, '').slice(0, 80);
  return sanitized || 'worktree';
}
