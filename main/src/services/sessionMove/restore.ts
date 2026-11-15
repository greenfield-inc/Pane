import { execFile } from 'child_process';
import { promisify } from 'util';
import { getShellPath } from '../../utils/shellPath';
import { applySnapshot } from './gitSnapshot';
import { pausedMarkOf } from '../../../../shared/types/panels';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import { getChatTabManager } from '../chatTabs';

const run = promisify(execFile);

/**
 * Restoring a Pane that moved away: the move kept its uncommitted work as `refs/pane/move/<id>`
 * in the repository. When the restored worktree is back on the commit that snapshot was taken
 * from, the work is reapplied and the ref goes. Anything else leaves the worktree as restored.
 */
export async function reapplyMoveSnapshot(worktreePath: string, paneId: string): Promise<boolean> {
  const git = async (args: string[]) => (await run('git', args, { cwd: worktreePath, env: { ...process.env, PATH: getShellPath() } })).stdout.trim();
  const ref = `refs/pane/move/${paneId}`;
  try {
    const snapshot = await git(['rev-parse', '--verify', '--quiet', ref]);
    if (!snapshot) return false;
    if (await git(['rev-parse', `${snapshot}^1`]) !== await git(['rev-parse', 'HEAD'])) return false;
    await applySnapshot(worktreePath, snapshot);
    await git(['update-ref', '-d', ref]);
    return true;
  } catch (error) {
    console.warn(`[SessionMove] Pane ${paneId}'s uncommitted work from before its move wasn't reapplied:`, error);
    return false;
  }
}

/**
 * Restore here, after a Session moved away: its tabs still carry the move's hold, which only the
 * move lifts. Lifts it without starting them; they start when opened, as any stopped tab does.
 */
export async function releaseMoveHolds(paneId: string): Promise<void> {
  for (const panel of panelManager.getPanelsForSession(paneId)) {
    if (pausedMarkOf(panel)?.by === 'move') await terminalPanelManager.clearPaused([panel.id]);
    else if (panel.type === 'chat') await getChatTabManager().clearMoveHold(panel.id);
  }
}
