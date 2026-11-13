import fs from 'fs/promises';
import path from 'path';
import { CONFIGURED_AGENT_IDS, agentConfig } from '../../../shared/agents';
import { DAY_MS } from '../../../shared/constants/archiveRetention';
import {
  PANE_DIR_AGENT_LOGS_FOLDER,
  PANE_DIR_ARCHIVED_MARKERS_FOLDER,
  PANE_DIR_SCRATCH_FOLDER,
  paneFolderName,
} from '../../../shared/constants/paneFolders';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getAppDirectory } from '../utils/appDirectory';
import { archiveErrorCode } from './archiveCleanupFilesystem';
import { isConfinedFolder } from './worktreePaneFolder';

/** Folders a log search never enters: dependencies and git internals hold no agent logs. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

/** `<pane-dir>/agent-logs/`: agent logs Pane kept from folders it deleted. Usage & Limits reads it; Pane never deletes it. */
export function agentLogsDirectory(): string {
  return path.join(getAppDirectory(), PANE_DIR_AGENT_LOGS_FOLDER);
}

/** `<pane-dir>/scratch/`, which holds `<pane-id>/` scratch for Panes whose own folder archive keeps. */
export function appScratchRoot(): string {
  return path.join(getAppDirectory(), PANE_DIR_SCRATCH_FOLDER);
}

/** `<pane-dir>/scratch/<pane-id>/`. */
export function appScratchDirectory(paneId: string): string {
  return path.join(appScratchRoot(), paneFolderName(paneId));
}

function markersDirectory(): string {
  return path.join(appScratchRoot(), PANE_DIR_ARCHIVED_MARKERS_FOLDER);
}

function markerPath(paneId: string): string {
  return path.join(markersDirectory(), paneFolderName(paneId));
}

async function isRealDirectory(target: string): Promise<boolean> {
  return (await fs.lstat(target).catch(() => undefined))?.isDirectory() === true;
}

/** Whether every component of `relative` below `base` is a real directory, never a link out of the folder. */
async function isRealPathBelow(base: string, relative: string): Promise<boolean> {
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!(await isRealDirectory(current))) return false;
  }
  return true;
}

async function moveDirectory(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    // Another volume: copy, then remove the source.
    if (archiveErrorCode(error) !== 'EXDEV') throw error;
    await fs.cp(source, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * Move every agent log folder inside `folder` (an agent run with its home or
 * config inside it, for example an isolated QA instance) to
 * `<pane-dir>/agent-logs/<agent>/<owner-id>/<layout>/<n>/`, before Pane deletes
 * `folder`. Finds them by each agent's `transcriptDirs`. `folder` must be a
 * confined folder below the Pane-owned `root` (`isConfinedFolder`); otherwise
 * nothing is read or moved. The walk never follows a link, so the agents' own
 * folders in the person's home are never touched. Throws when a move fails, so
 * the caller deletes nothing.
 */
export async function preserveAgentLogs(root: string, folder: string, ownerId: string): Promise<string[]> {
  if (!(await isConfinedFolder(root, folder))) {
    if (await fs.lstat(folder).then(() => true, () => false)) {
      console.warn(`[ArchiveRetention] ${folder} is a link or leads outside ${root}; its contents are not Pane's, so no agent logs were moved from it.`);
    }
    return [];
  }
  const layouts = CONFIGURED_AGENT_IDS.flatMap(agent => (agentConfig(agent)?.transcriptDirs ?? []).map(dir => ({ agent, dir })));
  const moved: string[] = [];
  const owner = paneFolderName(ownerId);
  const pending = [folder];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const skip = new Set<string>();
    for (const { agent, dir } of layouts) {
      if (!(await isRealPathBelow(current, dir))) continue;
      const source = path.join(current, ...dir.split('/'));
      // `.cursor/chats` lands in `cursor/<owner>/cursor-chats/<n>`, keeping which store it came from.
      const agentRoot = path.join(agentLogsDirectory(), agent, owner, dir.replace(/^\./u, '').replace(/[^A-Za-z0-9._-]+/gu, '-'));
      let index = 0;
      while (await fs.lstat(path.join(agentRoot, String(index))).then(() => true, () => false)) index += 1;
      await moveDirectory(source, path.join(agentRoot, String(index)));
      moved.push(source);
      skip.add(dir.split('/')[0]);
    }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name) && !skip.has(entry.name)) pending.push(path.join(current, entry.name));
    }
  }
  return moved;
}

/** Keep the agent logs inside the confined `folder` below `root`, then delete it with everything in it. A link is only unlinked. */
export async function deleteKeepingAgentLogs(root: string, folder: string, ownerId: string): Promise<void> {
  const stat = await fs.lstat(folder).catch(() => undefined);
  if (!stat) return;
  if (!(await isConfinedFolder(root, folder))) {
    // A link (or a folder reached through one) is not Pane's: remove the entry, never what it points at.
    if (stat.isSymbolicLink()) await fs.unlink(folder);
    console.warn(`[ArchiveRetention] left ${folder} alone: it leads outside ${root}.`);
    return;
  }
  const moved = await preserveAgentLogs(root, folder, ownerId);
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 3 });
  console.log(`[ArchiveRetention] deleted ${folder}${moved.length > 0 ? `; kept agent logs from ${moved.join(', ')}` : ''}`);
}

/**
 * Record when a Pane was archived (`at`), in `<pane-dir>/scratch/.archived/<pane-id>`,
 * outside the folders agents write. Expiry deletes its `<pane-dir>/scratch/<pane-id>/`
 * the retention period later. A permanently deleted Pane passes the epoch, so its
 * scratch goes at the next pass.
 */
export async function markScratchArchived(paneId: string, at: Date = new Date()): Promise<void> {
  await fs.mkdir(markersDirectory(), { recursive: true });
  await fs.rm(markerPath(paneId), { recursive: true, force: true });
  await fs.writeFile(markerPath(paneId), JSON.stringify({ paneId, archivedAt: at.toISOString() }), { flag: 'wx' });
}

/** Forget a Pane's archive time, when it is restored. */
export async function clearScratchArchived(paneId: string): Promise<void> {
  await fs.rm(markerPath(paneId), { recursive: true, force: true });
}

const markerSchema = boundary.object({ paneId: boundary.nonEmptyString, archivedAt: boundary.string });

/** A marker file's Pane id and archive time; undefined unless it is a plain file with a valid time. */
async function readMarker(file: string): Promise<{ paneId: string; archivedAt: Date } | undefined> {
  if (!(await fs.lstat(file).catch(() => undefined))?.isFile()) return undefined;
  try {
    const marker = decodeBoundary(JSON.parse(await fs.readFile(file, 'utf8')), markerSchema);
    const archivedAt = new Date(marker.archivedAt);
    return Number.isNaN(archivedAt.getTime()) ? undefined : { paneId: marker.paneId, archivedAt };
  } catch {
    return undefined;
  }
}

/** When an archived folder expires, from its archive time. */
export function expiresAt(archivedAt: Date, retentionDays: number): Date {
  return new Date(archivedAt.getTime() + retentionDays * DAY_MS);
}

export interface ExpiryInput {
  now: Date;
  retentionDays: number;
  /** Archived Sessions at the start of the pass: id, folder, their own Pane's id, and when they were archived. */
  archivedSessions: ReadonlyArray<{ id: string; folder: string; paneId: string; archivedAt: Date }>;
  /** Whether a Session is still archived now; checked again right before each delete. */
  sessionIsArchived(sessionId: string): boolean;
  /** Whether a Pane is archived or gone now; checked again right before each delete. */
  paneIsArchivedOrGone(paneId: string): boolean;
}

/**
 * Delete what has been archived longer than the retention period, keeping its
 * agent logs: archived Sessions' folders and scratch, and archived Panes'
 * `<pane-dir>/scratch/<pane-id>/`. An archive time in the future is skipped (a
 * clock set back); a clock set forward cannot be told from real time passing.
 * One folder that cannot be deleted is logged and skipped. Returns the folders deleted.
 */
export async function expireArchivedFolders(input: ExpiryInput): Promise<string[]> {
  const deleted: string[] = [];
  const due = (archivedAt: Date) => archivedAt <= input.now && expiresAt(archivedAt, input.retentionDays) <= input.now;
  const remove = async (root: string, folder: string, ownerId: string, stillArchived: () => boolean): Promise<void> => {
    try {
      if (!(await fs.lstat(folder).then(() => true, () => false)) || !stillArchived()) return;
      await deleteKeepingAgentLogs(root, folder, ownerId);
      deleted.push(folder);
    } catch (error) {
      console.warn(`[ArchiveRetention] could not delete ${folder}; trying again at the next pass:`, error);
    }
  };
  const sessionPanes = new Set<string>();
  for (const session of input.archivedSessions) {
    sessionPanes.add(session.paneId);
    if (!due(session.archivedAt)) continue;
    const stillArchived = () => input.sessionIsArchived(session.id);
    await remove(path.dirname(session.folder), session.folder, session.paneId, stillArchived);
    await remove(appScratchRoot(), appScratchDirectory(session.paneId), session.paneId, stillArchived);
  }
  const markers = await fs.readdir(markersDirectory(), { withFileTypes: true }).catch(() => []);
  for (const entry of markers) {
    const file = path.join(markersDirectory(), entry.name);
    const marker = await readMarker(file);
    if (!marker || sessionPanes.has(marker.paneId) || !due(marker.archivedAt)) continue;
    const stillArchived = () => input.paneIsArchivedOrGone(marker.paneId);
    if (!stillArchived()) continue;
    await remove(appScratchRoot(), appScratchDirectory(marker.paneId), marker.paneId, stillArchived);
    if (!(await fs.lstat(appScratchDirectory(marker.paneId)).then(() => true, () => false))) {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
  return deleted;
}
