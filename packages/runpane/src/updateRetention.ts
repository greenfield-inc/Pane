import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { appBackupPath } from './updateArtifacts';
import { readUpdateJournal, updateEnded, updateLockReleasable } from './updateOperation';

/** One operation under `<pane-dir>/updates`, as the retention rules see it. */
export interface UpdateRecord {
  id: string;
  /** The journal's phase: `complete`, `needs-attention`, `failed`, or a step still running. */
  phase: string;
  updatedAt: number;
}

/** Updates recorded under `<paneDir>/updates`; a folder with no readable journal is left out, so it is never removed. */
export function readUpdateRecords(paneDir: string): UpdateRecord[] {
  const root = path.join(paneDir, 'updates');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const records: UpdateRecord[] = [];
  for (const id of names) {
    try {
      const journal = readUpdateJournal(path.join(root, id, 'status.json'));
      records.push({ id, phase: journal.phase, updatedAt: Date.parse(journal.updatedAt) });
    } catch {
      // Not an update folder, or one still being written.
    }
  }
  return records;
}

/**
 * Update folders a newer completed update has replaced: every update last
 * written before the newest completed one, whatever its outcome. The newest
 * completed update and anything after it stay, so rollback and a running
 * update keep their copies.
 */
export function replacedUpdates(updates: readonly UpdateRecord[]): string[] {
  const newestComplete = Math.max(-Infinity, ...updates.filter(update => update.phase === 'complete').map(update => update.updatedAt));
  return updates.filter(update => update.updatedAt < newestComplete).map(update => update.id);
}

const stagedAppSchema = boundary.object({ app: boundary.nullable(boundary.object({ installPath: boundary.string, backupPath: boundary.string })) });

/** The previous app copy an operation kept beside the installation, when its staged manifest names one Pane would have made. */
function previousAppCopy(directory: string, id: string): string | null {
  try {
    const app = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'staged.json'), 'utf8')), stagedAppSchema).app;
    return app && app.backupPath === appBackupPath(app.installPath, id) ? app.backupPath : null;
  } catch {
    return null;
  }
}

export interface UpdatePrune {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Run by the helper once its update completes. Removes the folder (journal,
 * staged downloads, snapshot) and the previous app copy of every earlier
 * operation `replacedUpdates` names, so a failed update's snapshot does not
 * stay forever. The completed update keeps its own copies for rollback. An
 * operation that has not ended, or that may still have an installer child
 * (`updateLockReleasable` false), is left for `runpane machine cleanup`.
 */
export function pruneReplacedUpdates(paneDir: string): UpdatePrune {
  const result: UpdatePrune = { removed: [], failed: [] };
  const remove = (target: string) => {
    if (!fs.existsSync(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      result.removed.push(target);
    } catch (error) {
      result.failed.push({ path: target, error: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const id of replacedUpdates(readUpdateRecords(paneDir))) {
    const directory = path.join(paneDir, 'updates', id);
    let journal;
    try {
      journal = readUpdateJournal(path.join(directory, 'status.json'));
    } catch {
      continue;
    }
    if (!updateEnded(journal) || !updateLockReleasable(journal)) continue;
    const previous = previousAppCopy(directory, id);
    // The app copy first: its path is read from this folder, so a retry still finds it.
    if (previous) remove(previous);
    if (!previous || !fs.existsSync(previous)) remove(directory);
  }
  return result;
}
