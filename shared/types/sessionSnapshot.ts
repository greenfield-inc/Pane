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

/** What the desktop already holds of one Session's chat: the conversation, how many of its messages, and as of which change. */
export interface SessionSnapshotHeld {
  generation: number;
  /** Messages it holds, counted from the conversation's first: it has messages [.., count). */
  count: number;
  /** The transcript `revision` of what it holds. */
  revision: number;
}

export interface SessionSnapshotsRequest {
  /** The `revision` of the last answer; absent asks for every snapshot. */
  since?: number;
  /** The `epoch` of the last answer: `since` and `held` count only when it is this host's current run. */
  epoch?: string;
  /** Per Session id, what the desktop holds, so only messages after it are sent. */
  held?: Record<string, SessionSnapshotHeld>;
}

export interface SessionSnapshot {
  sessionId: string;
  /** Rises on any change to what this snapshot holds. */
  revision: number;
  /** The Session as a summary list sends it, without its launch settings (no activity log, profile, launch command, custom resume or opening prompt). */
  session: OrchestrationSessionSummary;
  /**
   * The Session's chat tab as the desktop draws it, read without starting it. Its transcript holds
   * at most the newest 30 messages, from `start` on: only those added or changed since what `held`
   * said the desktop has (earlier ones a tool call updated included). Any string over 4 KB outside a
   * message's own text is left out (`SessionSnapshotOmittedData`).
   */
  chat: ChatTabView;
  /**
   * True when the host can't read this chat's messages yet: it restarted, the chat's agent hasn't run
   * since, and no window was saved beside the tab (`recent.json`), so `chat.transcript` is absent and `chat.messageCount` is 0 without meaning the chat is
   * empty. The desktop keeps the messages it holds until a snapshot with a transcript arrives.
   */
  transcriptUnknown?: true;
  /** The Session's chat and terminal tabs as a read-only viewer sees them: names, kinds and the few state fields a tab shows; never a screen, launch input or file. */
  tabs: ToolPanel[];
  /** Its stored split layout, or null. */
  layout: SessionPanelLayout | null;
}

/**
 * What stands in, in place, for any string over 4 KB outside a message's own text (an image's
 * `data`, a `data:` URI, a resource's `blob` or `text`, a tool's input or output): the key it was
 * under (an array position for an array entry) and its length. The full read fills it in once shown.
 */
export interface SessionSnapshotOmittedData {
  omitted: { field: string; length: number };
}

export interface SessionSnapshotsResult {
  /** Send this as `since` next time. */
  revision: number;
  /** This host's current run; send it back with `since`. */
  epoch: string;
  /** Every Session that has a snapshot now; the desktop drops any other it kept. */
  sessionIds: string[];
  /** The snapshots newer than `since`. */
  snapshots: SessionSnapshot[];
}

export interface SessionSnapshotChanged {
  sessionId: string;
  revision: number;
}
