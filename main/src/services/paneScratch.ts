import { PANE_SCRATCH_FOLDER } from '../../../shared/constants/paneFolders';
import { PaneError } from '../../../shared/paneError';
import { ownsRemovableWorktree } from '../utils/owns-removable-worktree';
import { databaseService } from './database';
import { worktreePaneFolder } from './worktreePaneFolder';

/**
 * The folder Pane exports as `$PANE_SCRATCH_DIR` to a Pane's tabs, created on
 * first use: `<worktree>/.pane/scratch/` when archiving the Pane deletes its
 * worktree. Undefined when Pane has no folder it will clean up for that Pane.
 */
export async function paneScratchDirectory(paneId: string): Promise<string | undefined> {
  const pane = databaseService.getSession(paneId);
  if (!ownsRemovableWorktree(pane) || !pane.worktree_path) return undefined;
  try {
    const folder = await worktreePaneFolder(pane.worktree_path, PANE_SCRATCH_FOLDER, candidate => new PaneError(
      'ERR_SCRATCH_STORAGE_SYMLINK',
      `PANE_SCRATCH_DIR is not set for this tab: ${candidate} is a symbolic link.`,
      'Replace the symbolic link with a directory, then open a new tab.',
    ));
    return folder?.directory;
  } catch (error) {
    // A tab always starts; it only goes without a scratch folder.
    console.warn(`[PaneScratch] ${paneId}:`, error);
    return undefined;
  }
}

