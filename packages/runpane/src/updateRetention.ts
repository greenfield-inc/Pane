import fs from 'node:fs';
import path from 'node:path';
import { readUpdateJournal } from './updateOperation';

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
