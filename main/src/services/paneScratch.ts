import fs from 'fs/promises';
import path from 'path';
import { PANE_SCRATCH_FOLDER } from '../../../shared/constants/paneFolders';
import { PaneError } from '../../../shared/paneError';
import { getAppDirectory } from '../utils/appDirectory';
import { ownsRemovableWorktree } from '../utils/owns-removable-worktree';
import { databaseService } from './database';
import { folderUsage, worktreePaneFolder } from './worktreePaneFolder';
import { expiresAt } from './archiveRetention';
import type { RunpanePaneScratch } from '../../../shared/types/runpaneOrchestration';

/** `<pane-dir>/scratch/<pane-id>/`: scratch for a Pane whose folder archive keeps (a Session, a main-repo or adopted Pane). */
function appScratchDirectory(paneId: string): string {
  return path.join(getAppDirectory(), 'scratch', paneId.replace(/[^A-Za-z0-9._-]/gu, '_'));
}

/**
 * The folder Pane exports as `$PANE_SCRATCH_DIR` to a Pane's tabs, created on
 * first use: `<worktree>/.pane/scratch/` when archiving the Pane deletes its
 * worktree, otherwise `<pane-dir>/scratch/<pane-id>/`, which
 * `removePaneScratch` deletes on archive. A Session's tabs pass the Session's
 * own Pane. Undefined only when neither can be created.
 */
export async function paneScratchDirectory(paneId: string): Promise<string | undefined> {
  const pane = databaseService.getSession(paneId);
  try {
    if (ownsRemovableWorktree(pane) && pane.worktree_path) {
      const folder = await worktreePaneFolder(pane.worktree_path, PANE_SCRATCH_FOLDER, candidate => new PaneError(
        'ERR_SCRATCH_STORAGE_SYMLINK',
        `PANE_SCRATCH_DIR is not set for this tab: ${candidate} is a symbolic link.`,
        'Replace the symbolic link with a directory, then open a new tab.',
      ));
      if (folder) return folder.directory;
    }
    const directory = appScratchDirectory(paneId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  } catch (error) {
    // A tab always starts; it only goes without a scratch folder.
    console.warn(`[PaneScratch] ${paneId}:`, error);
    return undefined;
  }
}

/**
 * The scratch folder a Pane has on disk and its size, for the archive dry run;
 * undefined when it has none. A folder under the Pane directory carries the
 * date archive retention deletes it.
 */
export async function paneScratchUsage(paneId: string, worktreePath: string | undefined, retentionDays: number, now: Date = new Date()): Promise<RunpanePaneScratch | undefined> {
  const inWorktree = worktreePath ? await folderUsage(path.join(worktreePath, ...PANE_SCRATCH_FOLDER.split('/'))) : undefined;
  if (inWorktree) return inWorktree;
  const kept = await folderUsage(appScratchDirectory(paneId));
  return kept && { ...kept, deletedAt: expiresAt(now, retentionDays).toISOString() };
}
