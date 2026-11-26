import type { OrchestrationSessionRecord, OrchestrationSessionSummary, OrchestrationSessionUpdateInput } from '../../../shared/types/orchestrationSession';

/**
 * Folds a newer list entry into an open Session's full record. The list sends summaries (T-127),
 * which leave out the profile and activity log, so the open record keeps its own until a full one
 * arrives; a full record (an older host's list, or an update's answer) replaces them.
 */
export function withNewerSummary(open: OrchestrationSessionRecord, newer: OrchestrationSessionSummary): OrchestrationSessionRecord {
  const folded = { ...open, ...newer };
  if (!('profile' in newer) || !('activity' in newer)) detailRevisions.set(folded, detailRevisionOf(open));
  return folded;
}

/** Records whose profile and activity log are older than their revision: the revision those were read at. */
const detailRevisions = new WeakMap<OrchestrationSessionRecord, number>();

/** The revision a record's profile and activity log were read at. */
function detailRevisionOf(record: OrchestrationSessionRecord): number {
  return detailRevisions.get(record) ?? record.revision;
}

/**
 * The record a form that shows the profile starts from. The overview's record is always whole, so
 * it wins a tie: the open view can reach the same revision through a summary that kept its old
 * profile (review F-1).
 */
export function newestFullRecord(open: OrchestrationSessionRecord, other: OrchestrationSessionRecord | undefined): OrchestrationSessionRecord {
  return other && other.id === open.id && other.revision >= open.revision ? other : open;
}

/**
 * A settings save, checked against the revision the form's profile was read at: if the Session
 * changed since, the host refuses it rather than saving the form's older profile over a newer one.
 */
export function settingsSave(prefill: OrchestrationSessionRecord, input: OrchestrationSessionUpdateInput): OrchestrationSessionUpdateInput {
  return { ...input, expectedRevision: detailRevisionOf(prefill) };
}
