import type { OrchestrationSessionRecord, OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';

/**
 * Folds a newer list entry into an open Session's full record. The list sends summaries (T-127),
 * which leave out the profile and activity log, so the open record keeps its own until a full one
 * arrives; a full record (an older host's list, or an update's answer) replaces them.
 */
export function withNewerSummary(open: OrchestrationSessionRecord, newer: OrchestrationSessionSummary): OrchestrationSessionRecord {
  return { ...open, ...newer };
}

/** The newer of two full records of one Session, for forms that show its profile. */
export function newestFullRecord(open: OrchestrationSessionRecord, other: OrchestrationSessionRecord | undefined): OrchestrationSessionRecord {
  return other && other.id === open.id && other.revision > open.revision ? other : open;
}
