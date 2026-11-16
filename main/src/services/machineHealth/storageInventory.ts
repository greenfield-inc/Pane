import { readdir, stat } from 'fs/promises';
import * as path from 'path';
import type { DiskBuckets, PaneDiskUsage, ReclaimItem, StorageInventory } from '../../../../shared/types/machineHealth';
import { agentTempFolderName, classifyPaneDataFile, replacedUpdates, type UpdateRecord } from './reclaimRules';
import { measureSizes, type SizeRequest, type SizeResult } from './sizeWalker';

const DAY = 86_400_000;
/** Unmatched agent temp is offered once nothing in it changed for this long. */
const AGENT_TEMP_IDLE_MS = 2 * DAY;

export interface InventoryPane {
  id: string;
  name: string;
  worktreePath: string | null;
  projectPath: string;
  /** The branch Pane made for it (its worktree name). */
  branch: string;
  archived: boolean;
  /** Every terminal tab is paused. */
  paused: boolean;
  /** Last time Pane's record changed; for an archived Pane, about when it was archived. */
  updatedAt: number;
  /** The main checkout: never a worktree Pane created. */
  isMainRepo: boolean;
  /** Pane created the worktree; false for one it adopted, which is the person's and never offered. */
  ownedByPane: boolean;
}

export interface OtherToolPath {
  path: string;
  owner: string;
  howToFree: string;
}

export interface InventoryDeps {
  now: () => number;
  paneDir: string;
  panes: () => InventoryPane[];
  /** Each project's worktree folder. */
  worktreeRoots: () => string[];
  agentTempRoots: () => string[];
  /** The installed app, whose `.before-<update id>` copies sit beside it. */
  installPath: () => string | null;
  /** When the database last opened with no migration error, or null when never recorded. */
  cleanOpenAt: () => number | null;
  /** Panes whose archive cleanup job is still queued or running. */
  archiveJobsInFlight: () => ReadonlySet<string>;
  readUpdates: () => Promise<UpdateRecord[]>;
  listGitWorktrees: (projectPath: string) => Promise<Array<{ path: string; branch?: string }>>;
  ignoredDirs: (worktreePath: string) => Promise<string[]>;
  /** Working directories of every running process. */
  processCwds: () => Promise<string[]>;
  otherTools: () => Promise<OtherToolPath[]>;
  appScratchDir: (paneId: string) => string;
  measure?: (requests: readonly SizeRequest[]) => Promise<SizeResult[]>;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * Lists every reclaimable item with its owner, tier and logical size, and each
 * open Pane's disk split. Walks run in a worker thread; everything else is
 * Pane's own records, git and directory listings.
 */
export async function scanStorage(deps: InventoryDeps): Promise<StorageInventory> {
  const started = deps.now();
  const now = started;
  const measure = deps.measure ?? measureSizes;
  const panes = deps.panes();
  const withWorktree = panes.flatMap(pane => (pane.worktreePath ? [{ ...pane, worktreePath: pane.worktreePath }] : []));
  const open = withWorktree.filter(pane => !pane.archived && !pane.isMainRepo);
  const cwds = await deps.processCwds();
  const busy = (folder: string) => cwds.some(cwd => inside(cwd, folder));
  const items: ReclaimItem[] = [];
  const requests: SizeRequest[] = [];
  const pending: Array<{ request: SizeRequest; done: (size: SizeResult) => void }> = [];
  const size = (request: SizeRequest, done: (result: SizeResult) => void) => {
    requests.push(request);
    pending.push({ request, done });
  };
  const addItem = (item: Omit<ReclaimItem, 'id' | 'sizeBytes' | 'modifiedAt'>) => size({ path: item.path }, result => {
    if (result.exists && result.totalBytes > 0) items.push({ ...item, id: `${item.kind}:${item.path}`, sizeBytes: result.totalBytes, modifiedAt: result.newestMs });
  });

  // Open Panes: worktree split, Pane's own scratch folder.
  const usage = new Map<string, PaneDiskUsage>();
  const scratchTotals = { inWorktrees: 0, inPaneData: 0 };
  for (const pane of open) {
    const { worktreePath } = pane;
    const entry: PaneDiskUsage = { sessionId: pane.id, name: pane.name, worktreePath, worktreeBytes: 0, dependencyBytes: 0, buildOutputBytes: 0, scratchBytes: 0, agentTempBytes: 0 };
    usage.set(pane.id, entry);
    const ignoredDirs = await deps.ignoredDirs(worktreePath).catch(() => []);
    size({ path: worktreePath, ignoredDirs }, result => {
      entry.worktreeBytes += result.totalBytes;
      entry.dependencyBytes += result.dependencyBytes;
      entry.buildOutputBytes += result.buildOutputBytes;
      entry.scratchBytes += result.scratchBytes;
      scratchTotals.inWorktrees += result.scratchBytes;
    });
    size({ path: deps.appScratchDir(pane.id) }, result => {
      entry.scratchBytes += result.totalBytes;
      scratchTotals.inPaneData += result.totalBytes;
    });
    if (pane.paused) {
      for (const scratch of [path.join(worktreePath, '.pane', 'scratch'), deps.appScratchDir(pane.id)]) {
        if (!busy(scratch)) addItem({ kind: 'paused-scratch', tier: 2, path: scratch, sessionId: pane.id, reason: `Scratch and QA files of ${pane.name}, which is paused.` });
      }
    }
  }

  // Agent temp: folders named after a Pane's worktree, and loose items.
  // Two Panes can map to one name (a reused path, or `a/b-c` and `a-b/c`): an open Pane always wins, so a live
  // Pane's temp folder is never offered as an archived Pane's.
  const byTempName = new Map<string, InventoryPane>();
  for (const pane of withWorktree) {
    const name = agentTempFolderName(pane.worktreePath);
    const current = byTempName.get(name);
    if (!current || (current.archived && !pane.archived)) byTempName.set(name, pane);
  }
  const agentTempTotal = { bytes: 0 };
  for (const root of deps.agentTempRoots()) {
    for (const name of await listDir(root)) {
      const full = path.join(root, name);
      const owner = byTempName.get(name);
      const openOwner = owner && usage.get(owner.id);
      size({ path: full }, result => {
        if (!result.exists || result.totalBytes === 0) return;
        agentTempTotal.bytes += result.totalBytes;
        if (openOwner) {
          openOwner.agentTempBytes += result.totalBytes;
          return;
        }
        if (busy(full)) return;
        const gone = owner?.archived;
        const idle = now - result.newestMs >= AGENT_TEMP_IDLE_MS;
        if (!gone && !idle) return;
        items.push({
          id: `agent-temp:${full}`, kind: 'agent-temp', tier: 2, path: full, sizeBytes: result.totalBytes, modifiedAt: result.newestMs,
          sessionId: owner?.id ?? null,
          reason: gone ? `Agent temp files of ${owner.name}, which is archived.` : 'Agent temp files nobody touched for 2 days.',
        });
      });
    }
  }

  // Folders under each project's worktree root that no open Pane uses.
  const openPaths = new Set(open.map(pane => path.resolve(pane.worktreePath)));
  // An adopted worktree is the person's: archive keeps it on purpose, so it is never offered here.
  const archivedByPath = new Map(withWorktree.filter(pane => pane.archived && pane.ownedByPane).map(pane => [path.resolve(pane.worktreePath), pane]));
  const inFlight = deps.archiveJobsInFlight();
  const gitWorktrees = new Map<string, Array<{ path: string; branch?: string }>>();
  for (const projectPath of new Set(panes.map(pane => pane.projectPath))) {
    gitWorktrees.set(projectPath, await deps.listGitWorktrees(projectPath).catch(() => []));
  }
  // Pane Chat and Session folders live in Pane's data folder; only project worktree folders are scanned here.
  const paneDir = path.resolve(deps.paneDir);
  for (const root of new Set(deps.worktreeRoots().map(root => path.resolve(root)).filter(root => !inside(root, paneDir)))) {
    for (const name of await listDir(root)) {
      const full = path.join(root, name);
      if (openPaths.has(full) || name.startsWith('_reserve-') || name.startsWith('.')) continue;
      let folder;
      try {
        folder = await stat(full);
      } catch {
        continue;
      }
      if (!folder.isDirectory()) continue;
      const archived = archivedByPath.get(full);
      if (archived && inFlight.has(archived.id)) continue;
      if (archived) {
        const listed = gitWorktrees.get(archived.projectPath)?.find(entry => path.resolve(entry.path) === full);
        const born = folder.birthtimeMs || folder.ctimeMs;
        if (listed?.branch === archived.branch && born <= archived.updatedAt) {
          addItem({ kind: 'archived-pane-folder', tier: 2, path: full, sessionId: archived.id, reason: `Left at the path of ${archived.name}, which is archived. Its branch stays.` });
          continue;
        }
      }
      addItem({
        kind: 'foreign-worktree', tier: 3, path: full, sessionId: null,
        reason: archived ? `At the path of archived ${archived.name}, but git does not show it as that Pane's worktree.` : 'A worktree or folder Pane did not create.',
        howToFree: `git worktree remove "${full}"`,
      });
    }
  }

  // Pane's data folder: replaced update copies and top-level files.
  const replaced = new Set(replacedUpdates(await deps.readUpdates()));
  for (const id of replaced) {
    addItem({ kind: 'update-snapshot', tier: 1, path: path.join(deps.paneDir, 'updates', id), sessionId: null, reason: 'The rollback copy of an update a newer update replaced.' });
  }
  const installPath = deps.installPath();
  if (installPath) {
    const prefix = `${path.basename(installPath)}.before-`;
    for (const name of await listDir(path.dirname(installPath))) {
      if (name.startsWith(prefix) && replaced.has(name.slice(prefix.length))) {
        addItem({ kind: 'update-snapshot', tier: 1, path: path.join(path.dirname(installPath), name), sessionId: null, reason: 'The previous app copy of an update a newer update replaced.' });
      }
    }
  }
  const cleanOpenAt = deps.cleanOpenAt();
  for (const name of await listDir(deps.paneDir)) {
    const full = path.join(deps.paneDir, name);
    let file;
    try {
      file = await stat(full);
    } catch {
      continue;
    }
    if (!file.isFile()) continue;
    const kind = classifyPaneDataFile(name, file.mtimeMs, now, cleanOpenAt);
    if (kind === 'migration-backup') addItem({ kind, tier: 1, path: full, sessionId: null, reason: 'A database backup from a migration more than 30 days ago; the database has opened cleanly since.' });
    if (kind === 'foreign') addItem({ kind: 'foreign-pane-data', tier: 3, path: full, sessionId: null, reason: 'A database copy in Pane\'s data folder that Pane did not write.', howToFree: `Delete ${full} once you no longer need it.` });
  }

  // Other tools' data: shown only.
  for (const tool of await deps.otherTools()) {
    addItem({ kind: 'other-tool-data', tier: 3, path: tool.path, sessionId: null, reason: tool.owner, howToFree: tool.howToFree });
  }

  const paneData = { bytes: 0 };
  size({ path: deps.paneDir }, result => { paneData.bytes = result.totalBytes; });

  const results = await measure(requests);
  results.forEach((result, index) => pending[index].done(result));

  const paneUsage = [...usage.values()];
  const buckets: DiskBuckets = {
    paneWorktrees: paneUsage.reduce((sum, pane) => sum + pane.worktreeBytes - pane.dependencyBytes, 0) - scratchTotals.inWorktrees
      + items.filter(item => item.kind === 'foreign-worktree' || item.kind === 'archived-pane-folder').reduce((sum, item) => sum + item.sizeBytes, 0),
    dependencies: paneUsage.reduce((sum, pane) => sum + pane.dependencyBytes, 0),
    qaAndScratch: paneUsage.reduce((sum, pane) => sum + pane.scratchBytes, 0),
    agentTemp: agentTempTotal.bytes,
    paneData: paneData.bytes - scratchTotals.inPaneData,
  };
  items.sort((a, b) => a.tier - b.tier || b.sizeBytes - a.sizeBytes);
  return { scannedAt: now, durationMs: deps.now() - started, items, panes: paneUsage.sort((a, b) => b.worktreeBytes - a.worktreeBytes), buckets };
}
