import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { appBackupPath } from './updateArtifacts';
import { readUpdateJournal, updateEnded, updateLockReleasable } from './updateOperation';
import { compareVersions } from './version';

/** One operation under `<pane-dir>/updates`, as the retention rules see it. */
export interface UpdateRecord {
  id: string;
  /** The journal's phase: `complete`, `needs-attention`, `failed`, or a step still running. */
  phase: string;
  updatedAt: number;
  /** The release it installed or was asked for (`latest` until it resolved one). */
  version: string;
  /** The Pane version running when it started, or null for a CLI-only update. */
  fromVersion: string | null;
  /** Its install step finished. */
  installed: boolean;
}

const fromVersionSchema = boundary.object({ host: boundary.nullable(boundary.object({ version: boundary.string })) });

function readFromVersion(directory: string): string | null {
  try {
    return decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8')), fromVersionSchema).host?.version ?? null;
  } catch {
    return null;
  }
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
      records.push({
        id, phase: journal.phase, updatedAt: Date.parse(journal.updatedAt), version: journal.version,
        fromVersion: readFromVersion(path.join(root, id)), installed: journal.completed.includes('install'),
      });
    } catch {
      // Not an update folder, or one still being written.
    }
  }
  return records;
}

const ENDED = new Set(['complete', 'needs-attention', 'failed']);

/**
 * The running Pane is newer than anything this ended update left behind: the
 * release it installed, or, when it never installed, the release it started
 * from. Pane got there another way, such as the built-in updater, which keeps
 * no journal and so never counts as a newer completed update.
 */
function movedPast(update: UpdateRecord, runningVersion: string): boolean {
  if (!ENDED.has(update.phase)) return false;
  if (compareVersions(runningVersion, update.version) > 0) return true;
  return !update.installed && update.fromVersion !== null && compareVersions(runningVersion, update.fromVersion) > 0;
}

/**
 * Update folders a newer update has replaced: every update last written
 * before the newest completed one, whatever its outcome, and, given the
 * running Pane's version, every ended update it has moved past. The newest
 * completed update and anything after it stay unless the running Pane is
 * newer than what it installed, so rollback and a running update keep their
 * copies.
 */
export function replacedUpdates(updates: readonly UpdateRecord[], runningVersion: string | null = null): string[] {
  const newestComplete = Math.max(-Infinity, ...updates.filter(update => update.phase === 'complete').map(update => update.updatedAt));
  return updates.filter(update => update.updatedAt < newestComplete || (runningVersion !== null && movedPast(update, runningVersion))).map(update => update.id);
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
