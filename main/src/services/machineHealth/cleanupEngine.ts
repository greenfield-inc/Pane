import { randomBytes } from 'crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import { PaneError } from '../../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { MachineHealthSettings, ReclaimItem, ReclaimKind, ReclaimTier, StorageInventory } from '../../../../shared/types/machineHealth';

/** Where a cleanup came from: a person in Resources or a card, the schedule, or an agent through runpane. */
type CleanupSource = 'ui' | 'card' | 'schedule' | 'cli';

export interface CleanupRequest {
  source: CleanupSource;
  /** Tiers this request may act on. Tier 3 is never acted on. */
  tiers: ReclaimTier[];
  /** Only these items (inventory ids). */
  ids?: string[];
  /** Only items of these kinds. */
  kinds?: ReclaimKind[];
}

interface CleanupEntry {
  id: string;
  kind: ReclaimKind;
  path: string;
  sizeBytes: number;
  reason?: string;
}

export interface CleanupRun {
  at: number;
  source: CleanupSource;
  removed: CleanupEntry[];
  skipped: CleanupEntry[];
  /** Measured from free space on the affected volumes, before and after; never below 0. */
  freedBytes: number;
}

export interface CleanupDeps {
  now: () => number;
  paneDir: string;
  /** The latest inventory; each item is re-checked with `recheck` before it is touched. */
  inventory: () => Promise<StorageInventory>;
  /** Why an item must not be touched now that the inventory may be old (gone, Pane restored, recently used), or null. */
  recheck: (item: ReclaimItem) => Promise<string | null>;
  /** Why the Pane must not be touched now (pinned, focused, agent busy, open card, uncommitted changes), or null. */
  protectionOf: (sessionId: string) => Promise<string | null>;
  processCwds: () => Promise<string[]>;
  freeBytes: (folder: string) => Promise<number>;
  settings: () => MachineHealthSettings | undefined;
  /** Drop git's records of worktree folders that are gone. */
  pruneWorktrees: (projectPath: string) => Promise<void>;
  log: (message: string) => void;
  /** Deletes a renamed target (default: recursive rm with retries). */
  remove?: (target: string) => Promise<void>;
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
const JOURNAL = 'machine-health-trash.json';
const HISTORY_LIMIT = 50;

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

async function removeTree(target: string): Promise<void> {
  // Windows can hold a just-closed handle briefly: retry EBUSY/EPERM as archive cleanup does.
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * The one way machine health deletes anything. Every request re-reads the
 * inventory and re-checks protections at execution time. Each target is first
 * renamed into a `.pane-trash` folder beside it (same volume, so the rename is
 * atomic and a crash leaves it either in place or in the trash), recorded in a
 * journal, then deleted; the next start finishes any recorded delete.
 */
export class CleanupEngine {
  private runs: CleanupRun[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CleanupDeps) {}

  history(): CleanupRun[] {
    return [...this.runs];
  }

  /** Runs one request after any running one; requests never interleave. */
  run(request: CleanupRequest): Promise<CleanupRun> {
    const next = this.chain.then(() => this.execute(request));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Finish deletes a crash interrupted: everything the journal lists. Runs in turn with cleanups, never beside one. */
  finishPendingDeletes(): Promise<void> {
    const next = this.chain.then(() => this.finishPending());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async finishPending(): Promise<void> {
    const pending = await this.readJournal();
    for (const target of pending) {
      try {
        await (this.deps.remove ?? removeTree)(target);
      } catch (error) {
        this.deps.log(`[MachineHealth] could not finish deleting ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.writeJournal([]);
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
    const cwds = await Promise.all((await this.deps.processCwds()).map(cwd => realpath(cwd).catch(() => cwd)));
    const protections = new Map<string, string | null>();
    const trashed: Array<{ item: ReclaimItem; trashPath: string }> = [];
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
      const itemPath = await realpath(item.path).catch(() => item.path);
      if (!reason && cwds.some(cwd => inside(cwd, itemPath))) reason = 'A running process is working in this folder.';
      if (!reason) reason = await this.deps.recheck(item);
      if (reason) {
        run.skipped.push({ ...entry, reason });
        continue;
      }
      const parent = path.dirname(item.path);
      const device = await stat(parent).then(info => info.dev, () => -1);
      if (!volumes.has(device)) volumes.set(device, { folder: parent, before: await this.deps.freeBytes(parent).catch(() => 0) });
      const trashPath = path.join(parent, TRASH_DIR, `${path.basename(item.path)}-${randomBytes(4).toString('hex')}`);
      try {
        await mkdir(path.dirname(trashPath), { recursive: true });
        // Journal first: a crash right after the rename still finds the target on the next start.
        await this.writeJournal([...await this.readJournal(), trashPath]);
        await rename(item.path, trashPath);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        run.skipped.push({ ...entry, reason: code === 'EBUSY' || code === 'EPERM' ? 'It is in use.' : `It could not be moved (${code ?? 'unknown error'}).` });
        await this.writeJournal((await this.readJournal()).filter(pending => pending !== trashPath));
        continue;
      }
      trashed.push({ item, trashPath });
      run.removed.push(entry);
    }

    for (const { trashPath } of trashed) {
      try {
        await (this.deps.remove ?? removeTree)(trashPath);
      } catch (error) {
        this.deps.log(`[MachineHealth] delete of ${trashPath} failed; it is retried on the next start: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      await this.writeJournal((await this.readJournal()).filter(pending => pending !== trashPath));
    }
    const projects = new Set(trashed.flatMap(({ item }) => (item.kind === 'archived-pane-folder' && item.projectPath ? [item.projectPath] : [])));
    for (const projectPath of projects) await this.deps.pruneWorktrees(projectPath).catch(() => undefined);

    for (const { folder, before } of volumes.values()) {
      run.freedBytes += Math.max(0, (await this.deps.freeBytes(folder).catch(() => before)) - before);
    }
    return this.record(run);
  }

  private record(run: CleanupRun): CleanupRun {
    if (run.removed.length > 0 || run.skipped.length > 0) {
      this.runs = [run, ...this.runs].slice(0, HISTORY_LIMIT);
      this.deps.log(`[MachineHealth] cleanup (${run.source}): removed ${run.removed.length}, skipped ${run.skipped.length}, freed ${run.freedBytes} bytes. `
        + run.removed.map(entry => `${entry.kind} ${entry.path}`).join('; '));
    }
    return run;
  }

  private async readJournal(): Promise<string[]> {
    try {
      const pending = decodeBoundary(JSON.parse(await readFile(path.join(this.deps.paneDir, JOURNAL), 'utf8')), boundary.array(boundary.string));
      // Only ever delete a name Pane gave inside a trash folder, whatever the file says: no `..`, no other folder.
      return pending.filter(entry => path.isAbsolute(entry) && path.normalize(entry) === entry
        && path.basename(path.dirname(entry)) === TRASH_DIR && /-[0-9a-f]{8}$/u.test(path.basename(entry)));
    } catch {
      return [];
    }
  }

  private async writeJournal(pending: string[]): Promise<void> {
    await mkdir(this.deps.paneDir, { recursive: true });
    // Write then rename, so a crash leaves the old journal or the new one, never half of one.
    const file = path.join(this.deps.paneDir, JOURNAL);
    await writeFile(`${file}.tmp`, JSON.stringify(pending));
    await rename(`${file}.tmp`, file);
  }
}
