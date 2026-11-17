import { lstat, readdir, realpath, stat } from 'fs/promises';
import * as path from 'path';
import type { DiskBuckets, PaneDiskUsage, ReclaimItem, StorageInventory } from '../../../../shared/types/machineHealth';
import { agentTempFolderName, classifyPaneDataFile, isWslPath } from './reclaimRules';
import { measureSizes, type SizeRequest, type SizeResult } from './sizeWalker';
import { PANE_SCRATCH_FOLDER } from '../../../../shared/constants/paneFolders';
import { appBackupPath } from '../../../../packages/runpane/src/updateArtifacts';
import { replacedUpdates, type UpdateRecord } from '../../../../packages/runpane/src/updateRetention';
import { RESERVE_WORKTREE_PREFIX } from '../worktreePoolManager';

const DAY = 86_400_000;
/** Unmatched agent temp is offered once nothing in it changed for this long. */
const AGENT_TEMP_IDLE_MS = 2 * DAY;

/** Paths are file-system paths (a WSL project's are converted for Node's fs). */
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
  /** Git's worktrees of the Pane's project, with file-system paths. */
  listGitWorktrees: (pane: InventoryPane) => Promise<Array<{ path: string; branch?: string }>>;
  /** Folders git ignores in the Pane's worktree. */
  ignoredDirs: (pane: InventoryPane) => Promise<string[]>;
  /** Working directories of every running process, or null when they could not be read. */
  processCwds: () => Promise<string[] | null>;
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
/** Resolves symlinks (macOS reports process cwds under /private/tmp, not /tmp). */
const real = (folder: string) => realpath(folder).catch(() => path.resolve(folder));

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
  const listedCwds = await deps.processCwds();
  const cwds = listedCwds && await Promise.all(listedCwds.map(real));
  /** Whether a process works in the folder; when the list could not be read, every folder counts as busy. */
  const busy = async (folder: string) => {
    if (!cwds || isWslPath(folder)) return true;
    const resolved = await real(folder);
    return cwds.some(cwd => inside(cwd, resolved));
  };
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
    const ignoredDirs = await deps.ignoredDirs(pane).catch(() => []);
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
      for (const scratch of [path.join(worktreePath, ...PANE_SCRATCH_FOLDER.split('/')), deps.appScratchDir(pane.id)]) {
        if (!await busy(scratch)) addItem({ kind: 'paused-scratch', tier: 2, path: scratch, sessionId: pane.id, reason: `Scratch and QA files of ${pane.name}, which is paused.` });
      }
    }
  }

  // Agent temp: folders named after a Pane's worktree, and loose items. A main-repo Pane counts as open here.
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
      if (name === '.pane-trash') continue;
      const full = path.join(root, name);
      const owner = byTempName.get(name);
      const ownerOpen = owner !== undefined && !owner.archived;
      const isBusy = !ownerOpen && await busy(full);
      size({ path: full }, result => {
        if (!result.exists || result.totalBytes === 0) return;
        agentTempTotal.bytes += result.totalBytes;
        if (ownerOpen) {
          const openUsage = usage.get(owner.id);
          if (openUsage) openUsage.agentTempBytes += result.totalBytes;
          return;
        }
        if (isBusy) return;
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
  const archivedByPath = new Map(withWorktree.filter(pane => pane.archived && pane.ownedByPane && !pane.isMainRepo).map(pane => [path.resolve(pane.worktreePath), pane]));
  const inFlight = deps.archiveJobsInFlight();
  const gitWorktrees = new Map<string, Array<{ path: string; branch?: string }>>();
  for (const pane of panes) {
    if (!gitWorktrees.has(pane.projectPath)) gitWorktrees.set(pane.projectPath, await deps.listGitWorktrees(pane).catch(() => []));
  }
  // Pane Chat and Session folders live in Pane's data folder; only project worktree folders are scanned here.
  const paneDir = path.resolve(deps.paneDir);
  for (const root of new Set(deps.worktreeRoots().map(root => path.resolve(root)).filter(root => !inside(root, paneDir)))) {
    for (const name of await listDir(root)) {
      const full = path.join(root, name);
      if (openPaths.has(full) || name.startsWith(RESERVE_WORKTREE_PREFIX) || name.startsWith('.')) continue;
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
          addItem({ kind: 'archived-pane-folder', tier: 2, path: full, sessionId: archived.id, projectPath: archived.projectPath, reason: `Left at the path of ${archived.name}, which is archived. Its branch stays.` });
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
    for (const id of replaced) {
      addItem({ kind: 'update-snapshot', tier: 1, path: appBackupPath(installPath, id), sessionId: null, reason: 'The previous app copy of an update a newer update replaced.' });
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

export interface RecheckDeps {
  now: () => number;
  /** Pane's records as they are now. */
  panes: () => InventoryPane[];
  listGitWorktrees: (pane: InventoryPane) => Promise<Array<{ path: string; branch?: string }>>;
  measure?: (requests: readonly SizeRequest[]) => Promise<SizeResult[]>;
}

/**
 * Re-checks one item just before cleanup acts on it, so a cached inventory is
 * never trusted: the target still exists, no Pane opened since uses it, its
 * Pane is still archived or paused when that was the reason, an archived
 * Pane's folder is still the worktree git made for it, and loose agent temp is
 * still untouched for 2 days.
 */
export async function recheckItem(item: ReclaimItem, deps: RecheckDeps): Promise<string | null> {
  if (item.kind === 'agent-temp' && !item.sessionId) {
    const [result] = await (deps.measure ?? measureSizes)([{ path: item.path }]);
    if (!result?.exists) return 'It is already gone.';
    if (deps.now() - result.newestMs < AGENT_TEMP_IDLE_MS) return 'Something in it changed in the last 2 days.';
  } else if (!(await lstat(item.path).then(() => true, () => false))) {
    return 'It is already gone.';
  }
  const panes = deps.panes();
  const owner = item.sessionId ? panes.find(pane => pane.id === item.sessionId) : undefined;
  const openPanes = panes.flatMap(pane => (!pane.archived && pane.worktreePath ? [pane.worktreePath] : []));
  switch (item.kind) {
    case 'agent-temp':
      if (item.sessionId && !owner?.archived) return 'Its Pane is no longer archived.';
      if (openPanes.some(worktreePath => agentTempFolderName(worktreePath) === path.basename(item.path))) return 'A Pane that is open now uses it.';
      return null;
    case 'paused-scratch':
      return owner?.paused ? null : 'Its Pane is no longer paused.';
    case 'archived-pane-folder': {
      if (!owner?.archived) return 'Its Pane is no longer archived.';
      const full = path.resolve(item.path);
      if (openPanes.some(worktreePath => path.resolve(worktreePath) === full)) return 'A Pane that is open now uses it.';
      let listed;
      try {
        listed = (await deps.listGitWorktrees(owner)).find(entry => path.resolve(entry.path) === full);
      } catch {
        return 'Pane could not check it with git.';
      }
      const folder = await stat(full).catch(() => undefined);
      const born = folder ? folder.birthtimeMs || folder.ctimeMs : Infinity;
      return listed?.branch === owner.branch && born <= owner.updatedAt ? null : 'Git no longer shows it as that archived Pane\'s worktree.';
    }
    default:
      return null;
  }
}
