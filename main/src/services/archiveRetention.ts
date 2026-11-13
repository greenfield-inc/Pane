import fs from 'fs/promises';
import path from 'path';
import { CONFIGURED_AGENT_IDS, agentConfig } from '../../../shared/agents';
import { getAppDirectory } from '../utils/appDirectory';
import { archiveErrorCode } from './archiveCleanupFilesystem';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Written into an archived Pane's `<pane-dir>/scratch/<pane-id>/` with the archive time. */
const ARCHIVED_MARKER = '.pane-archived-at';
/** Folders a log search never enters: dependencies and git internals hold no agent logs. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

/** `<pane-dir>/agent-logs/`: agent logs Pane kept from folders it deleted. Usage & Limits reads it; Pane never deletes it. */
export function agentLogsDirectory(): string {
  return path.join(getAppDirectory(), 'agent-logs');
}

/** `<pane-dir>/scratch/`, which holds `<pane-id>/` scratch for Panes whose own folder archive keeps. */
function appScratchRoot(): string {
  return path.join(getAppDirectory(), 'scratch');
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
 * `folder`. Finds them by each agent's `transcriptDirs`. Never follows a link,
 * so the agents' own folders in the person's home are never touched.
 */
export async function preserveAgentLogs(folder: string, ownerId: string): Promise<string[]> {
  const layouts = CONFIGURED_AGENT_IDS.flatMap(agent => (agentConfig(agent)?.transcriptDirs ?? []).map(dir => ({ agent, dir })));
  const moved: string[] = [];
  const owner = ownerId.replace(/[^A-Za-z0-9._-]/gu, '_');
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

/** Keep the agent logs inside `folder`, then delete it with everything in it. */
export async function deleteKeepingAgentLogs(folder: string, ownerId: string): Promise<void> {
  if (!(await isRealDirectory(folder))) return;
  const moved = await preserveAgentLogs(folder, ownerId);
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 3 });
  console.log(`[ArchiveRetention] deleted ${folder}${moved.length > 0 ? `; kept agent logs from ${moved.join(', ')}` : ''}`);
}

/** Record when an archived Pane's `<pane-dir>/scratch/<pane-id>/` was archived; expiry counts from it. */
export async function markScratchArchived(paneId: string, now: Date = new Date()): Promise<void> {
  const folder = path.join(appScratchRoot(), paneId);
  if (!(await isRealDirectory(folder))) return;
  await fs.writeFile(path.join(folder, ARCHIVED_MARKER), now.toISOString());
}

/** When an archived folder expires, from its archive time. */
export function expiresAt(archivedAt: Date, retentionDays: number): Date {
  return new Date(archivedAt.getTime() + retentionDays * DAY_MS);
}

export interface ExpiryInput {
  now: Date;
  retentionDays: number;
  /** Archived Sessions: their folder, their own Pane's id, and when they were archived. */
  archivedSessions: ReadonlyArray<{ folder: string; paneId: string; archivedAt: Date }>;
  /** Whether a Pane is archived or gone; a restored Pane keeps its scratch. */
  paneIsArchivedOrGone(paneId: string): boolean;
}

/**
 * Delete what has been archived longer than the retention period, keeping its
 * agent logs: archived Sessions' folders and scratch, and archived Panes'
 * `<pane-dir>/scratch/<pane-id>/`. Returns the folders deleted.
 */
export async function expireArchivedFolders(input: ExpiryInput): Promise<string[]> {
  const deleted: string[] = [];
  const expired = (archivedAt: Date) => expiresAt(archivedAt, input.retentionDays) <= input.now;
  const sessionPanes = new Set<string>();
  for (const session of input.archivedSessions) {
    sessionPanes.add(session.paneId);
    if (!expired(session.archivedAt)) continue;
    for (const folder of [session.folder, path.join(appScratchRoot(), session.paneId)]) {
      if (!(await isRealDirectory(folder))) continue;
      await deleteKeepingAgentLogs(folder, session.paneId);
      deleted.push(folder);
    }
  }
  const entries = await fs.readdir(appScratchRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || sessionPanes.has(entry.name)) continue;
    const folder = path.join(appScratchRoot(), entry.name);
    const marker = await fs.readFile(path.join(folder, ARCHIVED_MARKER), 'utf8').catch(() => undefined);
    const archivedAt = marker === undefined ? undefined : new Date(marker.trim());
    if (!archivedAt || Number.isNaN(archivedAt.getTime()) || !expired(archivedAt)) continue;
    if (!input.paneIsArchivedOrGone(entry.name)) continue;
    await deleteKeepingAgentLogs(folder, entry.name);
    deleted.push(folder);
  }
  return deleted;
}
