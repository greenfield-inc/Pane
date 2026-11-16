/** Rules that decide which of Pane's own files are leftovers. Pure: callers read the disk. */

const DAY = 86_400_000;
/** user_preferences key: when the database last opened at startup with no migration error (epoch ms). */
export const DB_CLEAN_OPEN_PREFERENCE = 'machine_health_db_clean_open_at';
/** A migration backup is kept this long after it was written. */
const MIGRATION_BACKUP_DAYS = 30;

export interface UpdateRecord {
  id: string;
  /** The journal's phase: `complete`, `needs-attention`, `failed`, or a step still running. */
  phase: string;
  updatedAt: number;
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

/** Claude Code names a session's temp folder after its working directory, with every non-alphanumeric character as `-`. */
export function agentTempFolderName(workingDirectory: string): string {
  return workingDirectory.replace(/[^a-zA-Z0-9]/gu, '-');
}

const MIGRATION_BACKUP = /^sessions\.db\.pre-panel-buffers-\d+\.bak$/u;
const LIVE_DATABASE = /^sessions\.db(?:-wal|-shm|-journal)?$/u;

/**
 * A top-level file in Pane's data folder:
 * - `migration-backup`: Pane's own pre-migration copy, 30 days old, with a clean database open recorded after it.
 * - `foreign`: a database copy Pane never writes (repair agents make these); shown, never deleted.
 * - `keep`: everything else.
 */
export function classifyPaneDataFile(name: string, modifiedAt: number, now: number, cleanOpenAt: number | null): 'migration-backup' | 'foreign' | 'keep' {
  if (MIGRATION_BACKUP.test(name)) {
    const oldEnough = now - modifiedAt >= MIGRATION_BACKUP_DAYS * DAY;
    return oldEnough && cleanOpenAt !== null && cleanOpenAt > modifiedAt ? 'migration-backup' : 'keep';
  }
  if (LIVE_DATABASE.test(name) || name.endsWith('.before-import')) return 'keep';
  if (/\.db(?:[.-].*)?$/u.test(name) || name.startsWith('sessions.db')) return 'foreign';
  return 'keep';
}
