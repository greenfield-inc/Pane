import type { OrchestrationSessionRecord, OrchestrationSessionSummary, OrchestrationSessionUpdateInput } from '../../../shared/types/orchestrationSession';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';

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

/** The form to show after a failed save, and the message to show with it. */
export interface SessionSettingsRetry {
  form: SessionSettingsForm;
  message: string;
}

/** What the Session settings form edits. */
export interface SessionSettingsValues {
  launchCommand: string;
  customResume: CustomCommandResume | null;
  profile: string;
}

/**
 * The Session settings form, made once when the dialog opens (review F-3). It keeps the record it
 * was filled from, so a save is checked against that record even when a newer one reaches the
 * dialog while it is open; after a refusal it starts again from the record the dialog has then.
 */
export class SessionSettingsForm {
  readonly values: SessionSettingsValues;

  constructor(private readonly prefill: OrchestrationSessionRecord) {
    this.values = {
      launchCommand: prefill.launchCommand ?? '',
      customResume: prefill.customResume ?? null,
      profile: prefill.profile ?? DEFAULT_SESSION_PROFILE,
    };
  }

  /** The revision of the record the form was filled from. */
  get revision(): number {
    return this.prefill.revision;
  }

  saveInput(values: SessionSettingsValues): OrchestrationSessionUpdateInput {
    return settingsSave(this.prefill, values);
  }

  /** The form to show after a save failed with `message`, and what to tell the person. */
  afterFailure(message: string, current: OrchestrationSessionRecord): SessionSettingsRetry {
    if (!REVISION_REFUSAL.test(message)) return { form: this, message };
    return {
      form: new SessionSettingsForm(current),
      message: 'These settings changed on another device. The form now shows the current ones: check them and save again.',
    };
  }
}

/** The host's refusal of a save checked against an older revision (`OrchestrationSessionManager.update`). */
const REVISION_REFUSAL = /changed; expected revision \d+, found \d+/;
