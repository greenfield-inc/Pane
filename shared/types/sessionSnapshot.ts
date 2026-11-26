import type { ChatTabView } from './chatTab';
import type { OrchestrationSessionSummary } from './orchestrationSession';
import type { SessionPanelLayout, ToolPanel } from './panels';

/**
 * Host snapshots (T-116 PR 4): what another of the owner's machines keeps ahead of time so it can
 * show a chat Session at once. One per unarchived chat Session; see docs/SESSIONS.md.
 */

/** The read: `orchestration-sessions:snapshots`. */
export const SESSION_SNAPSHOTS_CHANNEL = 'orchestration-sessions:snapshots';
/** The notice on the event stream: `{ sessionId, revision }`, at most once a second per Session. */
export const SESSION_SNAPSHOT_CHANGED_CHANNEL = 'session-snapshot:changed';

/** Messages a snapshot carries: the newest 30 (D-3). */
export const SESSION_SNAPSHOT_MESSAGE_LIMIT = 30;

/** What the desktop already holds of one Session's chat: the conversation and how many of its messages. */
export interface SessionSnapshotHeld {
  generation: number;
  /** Messages it holds, counted from the conversation's first: it has messages [.., count). */
  count: number;
}

export interface SessionSnapshotsRequest {
  /** The `revision` of the last answer; absent asks for every snapshot. */
  since?: number;
  /** Per Session id, what the desktop holds, so only messages after it are sent. */
  held?: Record<string, SessionSnapshotHeld>;
}

export interface SessionSnapshot {
  sessionId: string;
  /** Rises on any change to what this snapshot holds. */
  revision: number;
  /** The Session as a summary list sends it (no activity log or profile). */
  session: OrchestrationSessionSummary;
  /**
   * The Session's chat tab as the desktop draws it, read without starting it. Its transcript holds
   * at most the newest 30 messages, from `start` on, and only those after what `held` said the
   * desktop has (the last held one again, since a streaming message grows in place). Large inline
   * attachment data is left out (`SessionSnapshotOmittedData`).
   */
  chat: ChatTabView;
  /** The Session's tabs, as `panels:list` returns them. */
  tabs: ToolPanel[];
  /** Its stored split layout, or null. */
  layout: SessionPanelLayout | null;
}

/**
 * What stands in for an attachment's inline bytes (an image's base64 `data`, a resource's `blob`)
 * over 4 KB: the field is removed and its length is given here. The full read fills it in once shown.
 */
export interface SessionSnapshotOmittedData {
  omitted: { field: 'data' | 'blob'; length: number };
}

export interface SessionSnapshotsResult {
  /** Send this as `since` next time. */
  revision: number;
  /** Every Session that has a snapshot now; the desktop drops any other it kept. */
  sessionIds: string[];
  /** The snapshots newer than `since`. */
  snapshots: SessionSnapshot[];
}

export interface SessionSnapshotChanged {
  sessionId: string;
  revision: number;
}
