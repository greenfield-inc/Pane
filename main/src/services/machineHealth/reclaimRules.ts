/** Rules that decide which of Pane's own files are leftovers. Pure: callers read the disk. */
import { PANEL_BUFFER_BACKUP_NAME } from '../../database/panelBufferMigration';

const DAY = 86_400_000;
/** user_preferences key: when the database last opened at startup with no migration error (epoch ms). */
export const DB_CLEAN_OPEN_PREFERENCE = 'machine_health_db_clean_open_at';
/** A migration backup is kept this long after it was written. */
const MIGRATION_BACKUP_DAYS = 30;

/** Claude Code names a session's temp folder after its working directory, with every non-alphanumeric character as `-`. */
export function agentTempFolderName(workingDirectory: string): string {
  return workingDirectory.replace(/[^a-zA-Z0-9]/gu, '-');
}

const LIVE_DATABASE = /^sessions\.db(?:-wal|-shm|-journal)?$/u;

/**
 * A top-level file in Pane's data folder:
 * - `migration-backup`: Pane's own pre-migration copy, 30 days old, with a clean database open recorded after it.
 * - `foreign`: a database copy Pane never writes (repair agents make these); shown, never deleted.
 * - `keep`: everything else.
 */
export function classifyPaneDataFile(name: string, modifiedAt: number, now: number, cleanOpenAt: number | null): 'migration-backup' | 'foreign' | 'keep' {
  if (PANEL_BUFFER_BACKUP_NAME.test(name)) {
    const oldEnough = now - modifiedAt >= MIGRATION_BACKUP_DAYS * DAY;
    return oldEnough && cleanOpenAt !== null && cleanOpenAt > modifiedAt ? 'migration-backup' : 'keep';
  }
  if (LIVE_DATABASE.test(name) || name.endsWith('.before-import')) return 'keep';
  if (/\.db(?:[.-].*)?$/u.test(name) || name.startsWith('sessions.db')) return 'foreign';
  return 'keep';
}

/**
 * A path inside a WSL distro as Windows sees it (\\wsl.localhost\<distro>\… or \\wsl$\…). Pane cannot list
 * the working folders of the Linux processes there, so anything under one counts as in use.
 */
export function isWslPath(folder: string): boolean {
  return /^\\\\wsl(?:\.localhost|\$)\\/iu.test(folder);
}
