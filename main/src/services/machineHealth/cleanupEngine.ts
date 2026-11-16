import { randomBytes } from 'crypto';
import { realpath, stat } from 'fs/promises';
import * as path from 'path';
import { PaneError } from '../../../../shared/paneError';
import type { CleanupEntry, CleanupRun, CleanupSource, MachineHealthSettings, ReclaimItem, ReclaimKind, ReclaimTier, StorageInventory } from '../../../../shared/types/machineHealth';
import { archiveErrorCode, archiveFs } from '../archiveCleanupFilesystem';
import { preserveAgentLogs } from '../archiveRetention';
import { deleteTrashEntry, renameWhileBusy, sweepTrashRoot } from '../worktreeTrash';
import { isWslPath } from './reclaimRules';

export interface CleanupRequest {
  source: CleanupSource;
  /** Tiers this request may act on. Tier 3 is never acted on. */
  tiers: ReclaimTier[];
  /** Only these items (inventory ids). */
  ids?: string[];
  /** Only items of these kinds. */
  kinds?: ReclaimKind[];
}

export interface CleanupDeps {
  now: () => number;
  /** The latest inventory; each item is re-checked with `recheck` before it is touched. */
  inventory: () => Promise<StorageInventory>;
  /** Why an item must not be touched now that the inventory may be old (gone, Pane restored, recently used), or null. */
  recheck: (item: ReclaimItem) => Promise<string | null>;
  /** Why the Pane must not be touched now (pinned, focused, agent busy, open card, uncommitted changes), or null. */
  protectionOf: (sessionId: string) => Promise<string | null>;
  /** Working directories of running processes, or null when Pane could not read them. */
  processCwds: () => Promise<string[] | null>;
  freeBytes: (folder: string) => Promise<number>;
  settings: () => MachineHealthSettings | undefined;
  /** Folders whose `.pane-trash` may hold what an earlier cleanup moved; the next start deletes it. Every item's folder is one of them. */
  trashParents: () => string[];
  /** Runs `move` for an archived Pane's leftover worktree under its repository's lock, then drops git's record of the folder. */
  moveWorktree: (item: ReclaimItem, move: () => Promise<void>) => Promise<void>;
  log: (message: string) => void;
  /** How long a run waits for its deletes before returning and finishing them in the background (default 20 s). */
  deleteGraceMs?: number;
}

/** The tier 2 kinds and the setting that lets a schedule run each without asking. */
function automaticSwitch(kind: ReclaimKind): keyof MachineHealthSettings | undefined {
  switch (kind) {
    case 'agent-temp': return 'autoClearAgentTemp';
    case 'paused-scratch': return 'autoClearPausedScratch';
    case 'archived-pane-folder': return 'autoClearArchivedFolders';
    default: return undefined;
  }
}

const TRASH_DIR = '.pane-trash';
const HISTORY_LIMIT = 50;
const DELETE_GRACE_MS = 20_000;
/** How long a move keeps retrying while Windows still holds the folder. */
const BUSY_RETRY_MS = 2_000;
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * The one way machine health deletes anything. Every request re-reads the
 * inventory and re-checks protections at execution time. Each target is first
 * renamed into a `.pane-trash` folder beside it (same volume, so the rename is
 * atomic and a crash leaves it either in place or in the trash), then deleted
 * in the background; each start deletes whatever its trash folders still hold.
 * Nothing is written before a move, so a full disk still frees space.
 */
export class CleanupEngine {
  private runs: CleanupRun[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CleanupDeps) {}

  history(): CleanupRun[] {
    return [...this.runs];
  }

  /** Records a run made outside the engine (archiving finished Panes, stopping processes) in the same history. */
  note(run: CleanupRun): CleanupRun {
    return this.record(run);
  }

  /** Runs one request after any running one; requests never interleave. */
  run(request: CleanupRequest): Promise<CleanupRun> {
    const next = this.chain.then(() => this.execute(request));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Deletes what earlier runs left in the trash (a crash, a quit, a failed delete). Runs in turn with cleanups, never beside one. */
  finishPendingDeletes(): Promise<void> {
    const next = this.chain.then(() => this.sweep());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async sweep(): Promise<void> {
    for (const parent of new Set(this.deps.trashParents())) {
      const trash = path.join(parent, TRASH_DIR);
      // lstat: a link named like the trash folder is not Pane's, so nothing behind it is deleted.
      if (!(await archiveFs.lstat(trash).catch(() => undefined))?.isDirectory()) continue;
      await sweepTrashRoot(trash);
      await archiveFs.rmdir(trash).catch(() => undefined);
    }
  }

  private async execute(request: CleanupRequest): Promise<CleanupRun> {
    const inventory = await this.deps.inventory();
    let items = inventory.items;
    if (request.ids) {
      const wanted = new Set(request.ids);
      items = items.filter(item => wanted.has(item.id));
    }
    if (request.kinds) {
      const kinds = new Set(request.kinds);
      items = items.filter(item => kinds.has(item.kind));
    }
    const named = request.ids !== undefined || request.kinds !== undefined;
    if (!named && request.source !== 'schedule') {
      throw new PaneError('ERR_MACHINE_CLEANUP_UNNAMED', 'A cleanup must name the items or kinds to remove. Nothing was deleted.', 'Pass the item ids or kinds, as `runpane machine cleanup --kind <kind>` does.');
    }
    const refused = items.find(item => item.tier === 3);
    if (named && refused) {
      throw new PaneError(
        'ERR_MACHINE_CLEANUP_NOT_PANES',
        `${refused.path} is not Pane's to delete (${refused.reason}). Nothing was deleted.`,
        refused.howToFree ?? 'Free it with the tool that made it.',
      );
    }
    const settings = this.deps.settings() ?? {};
    items = items.filter(item => item.tier !== 3 && request.tiers.includes(item.tier));
    if (request.source === 'schedule') {
      items = items.filter(item => {
        const automatic = automaticSwitch(item.kind);
        return item.tier === 1 || (automatic !== undefined && settings[automatic] === true);
      });
    }

    const run: CleanupRun = { at: this.deps.now(), source: request.source, removed: [], skipped: [], freedBytes: 0 };
    if (items.length === 0) return this.record(run);

    // Compare real paths: lsof reports /private/tmp where the item says /tmp.
    const listed = await this.deps.processCwds();
    const cwds = listed && await Promise.all(listed.map(cwd => realpath(cwd).catch(() => cwd)));
    const protections = new Map<string, string | null>();
    const trashed: string[] = [];
    /** Free bytes before, per device, read at a folder on that device. */
    const volumes = new Map<number, { folder: string; before: number }>();
    for (const item of items) {
      const entry: CleanupEntry = { id: item.id, kind: item.kind, path: item.path, sizeBytes: item.sizeBytes };
      let reason: string | null = null;
      // An archived Pane's leftover folder still gets the uncommitted-work check; agent temp belongs to no worktree.
      if (item.sessionId && item.kind !== 'agent-temp') {
        if (!protections.has(item.sessionId)) protections.set(item.sessionId, await this.deps.protectionOf(item.sessionId));
        reason = protections.get(item.sessionId) ?? null;
      }
      // A backup is a file: no process works in it.
      if (!reason && item.kind !== 'migration-backup') {
        const itemPath = await realpath(item.path).catch(() => item.path);
        if (cwds === null) reason = 'Pane could not check for running processes.';
        else if (isWslPath(item.path)) reason = 'Pane cannot check for running processes inside WSL.';
        else if (cwds.some(cwd => inside(cwd, itemPath))) reason = 'A running process is working in this folder.';
      }
      if (!reason) reason = await this.deps.recheck(item);
      if (!reason && item.sessionId && (item.kind === 'paused-scratch' || item.kind === 'archived-pane-folder')) {
        // Keep agent transcripts (an isolated QA home, for example) as archive does.
        reason = await preserveAgentLogs(path.dirname(item.path), item.path, item.sessionId)
          .then(() => null, error => `Pane could not keep its agent logs first (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (reason) {
        run.skipped.push({ ...entry, reason });
        continue;
      }
      const parent = path.dirname(item.path);
      const device = await stat(parent).then(info => info.dev, () => -1);
      if (!volumes.has(device)) volumes.set(device, { folder: parent, before: await this.deps.freeBytes(parent).catch(() => 0) });
      const trashPath = path.join(parent, TRASH_DIR, `${path.basename(item.path)}-${randomBytes(4).toString('hex')}`);
      let late: string | null = null;
      const move = async () => {
        // Checked again right before the move (inside the repository lock for a worktree): a Pane restored
        // during the log copy or the lock wait now owns this folder.
        late = item.kind === 'archived-pane-folder' ? await this.deps.recheck(item) : null;
        if (late) return;
        await archiveFs.mkdir(path.dirname(trashPath), { recursive: true });
        await renameWhileBusy(item.path, trashPath, BUSY_RETRY_MS);
      };
      try {
        await (item.kind === 'archived-pane-folder' ? this.deps.moveWorktree(item, move) : move());
        if (late) {
          run.skipped.push({ ...entry, reason: late });
          continue;
        }
      } catch (error) {
        const code = archiveErrorCode(error);
        run.skipped.push({ ...entry, reason: code && BUSY_CODES.has(code) ? 'It is in use.' : `It could not be moved (${code ?? (error instanceof Error ? error.message : String(error))}).` });
        continue;
      }
      trashed.push(trashPath);
      run.removed.push(entry);
    }

    if (trashed.length === 0) return this.record(run);
    run.deleting = true;
    const deleted = this.deleteTrashed(run, trashed, [...volumes.values()]);
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([deleted, new Promise(resolve => { grace = setTimeout(resolve, this.deps.deleteGraceMs ?? DELETE_GRACE_MS); })]);
    clearTimeout(grace);
    // Empty trash folders go in turn with cleanups, so none is removed while a run moves something into it.
    const removeEmptyTrash = () => Promise.all([...new Set(trashed.map(trashPath => path.dirname(trashPath)))]
      .map(folder => archiveFs.rmdir(folder).catch(() => undefined)));
    if (run.deleting) {
      void deleted.then(() => { this.chain = this.chain.then(removeEmptyTrash); });
    } else {
      await removeEmptyTrash();
    }
    return this.record(run);
  }

  /** Deletes what a run moved to the trash and measures the space freed; a delete that fails is retried on the next start. */
  private async deleteTrashed(run: CleanupRun, trashed: string[], volumes: Array<{ folder: string; before: number }>): Promise<void> {
    const results = await Promise.all(trashed.map(trashPath => deleteTrashEntry(trashPath)));
    const failed = trashed.filter((_, index) => !results[index]);
    if (failed.length > 0) this.deps.log(`[MachineHealth] could not delete ${failed.join(', ')}; the next start tries again.`);
    for (const { folder, before } of volumes) {
      run.freedBytes += Math.max(0, (await this.deps.freeBytes(folder).catch(() => before)) - before);
    }
    run.deleting = false;
    this.deps.log(`[MachineHealth] cleanup (${run.source}) finished deleting ${trashed.length - failed.length} of ${trashed.length}; freed ${run.freedBytes} bytes.`);
  }

  private record(run: CleanupRun): CleanupRun {
    if (run.removed.length > 0 || run.skipped.length > 0) {
      this.runs = [run, ...this.runs].slice(0, HISTORY_LIMIT);
      this.deps.log(`[MachineHealth] cleanup (${run.source}): removed ${run.removed.length}, skipped ${run.skipped.length}, ${run.deleting ? 'still deleting' : `freed ${run.freedBytes} bytes`}. `
        + run.removed.map(entry => `${entry.kind} ${entry.path}`).join('; '));
    }
    return run;
  }
}
