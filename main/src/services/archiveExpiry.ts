import path from 'path';
import { ARCHIVE_EXPIRY_INTERVAL_MS, ARCHIVE_RETENTION_DAYS, isValidArchiveRetentionDays } from '../../../shared/constants/archiveRetention';
import { getRuntimeConfigManager } from '../core/runtime';
import type { AppConfig } from '../types/config';
import { getAppDirectory } from '../utils/appDirectory';
import { expireArchivedFolders } from './archiveRetention';
import { databaseService } from './database';
import { OrchestrationSessionStore } from './orchestrationSessionStore';
import { sessionWorkspacePath } from './sessionWorkspace';

/** Days archived folders are kept: the `archiveRetentionDays` setting, else ARCHIVE_RETENTION_DAYS. */
export function archiveRetentionDays(config: Pick<AppConfig, 'archiveRetentionDays'>): number {
  const days = config.archiveRetentionDays;
  return days !== undefined && isValidArchiveRetentionDays(days) ? days : ARCHIVE_RETENTION_DAYS;
}

/** One expiry pass over archived Sessions and archived Panes' scratch. */
async function runArchiveExpiry(now: Date = new Date()): Promise<string[]> {
  const store = new OrchestrationSessionStore(path.join(getAppDirectory(), 'orchestration-sessions.json'));
  const sessions = store.read().sessions;
  return expireArchivedFolders({
    now,
    retentionDays: archiveRetentionDays(getRuntimeConfigManager().getConfig()),
    archivedSessions: sessions
      .filter(session => session.archived === true)
      // No archive time (startup sets one) or an unreadable one: never due.
      .map(session => ({ id: session.id, folder: sessionWorkspacePath(session.id), paneId: session.internalSessionId, archivedAt: new Date(session.archivedAt ?? Number.NaN) })),
    // Read again right before each delete: a Session restored during the pass keeps its folder.
    sessionIsArchived: sessionId => store.read().sessions.find(session => session.id === sessionId)?.archived === true,
    paneIsArchivedOrGone: paneId => {
      const pane = databaseService.getSession(paneId);
      return !pane || Boolean(pane.archived);
    },
  });
}

/** Run expiry now and every six hours; returns a stop function. */
export function startArchiveExpiry(): () => void {
  const run = () => {
    void runArchiveExpiry().catch(error => console.warn('[ArchiveRetention] Expiry pass failed:', error));
  };
  run();
  const timer = setInterval(run, ARCHIVE_EXPIRY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
