import { DatabaseService } from '../database/database';
import { join } from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { ScrollbackRetentionService, RetentionSweepResult } from './scrollbackRetention';

// Create and export a singleton instance
const dbPath = join(getAppDirectory(), 'sessions.db');
export const databaseService = new DatabaseService(dbPath);

// Initialize the database schema and run migrations, including the one-time
// move of terminal bytes out of tool_panels.state (see panelBufferMigration).
databaseService.initialize();
export const startupPanelBufferMigration = databaseService.getPanelBufferMigration();

// Scrollback retention sweep. The daemon host runs it first thing at startup,
// before panelManager restores panels on demand: running it later (e.g. via a
// setTimeout in app.whenReady) would let the in-memory panel cache keep the
// stale scrollback for the whole first launch even after the DB is trimmed. It
// is not run at module load, because only the Pane that owns this data
// directory may delete from it (see daemon/instanceDuties). The result is
// logged once Logger is initialized.
export interface StartupRetentionSweep {
  readonly result: RetentionSweepResult | null;
  readonly error: Error | null;
}

export function runStartupRetentionSweep(): StartupRetentionSweep {
  try {
    return {
      result: new ScrollbackRetentionService(databaseService).runRetentionSweep(),
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
