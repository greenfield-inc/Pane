import type { AgentState } from './agentStatus';

/**
 * Types for Mission Control — a live overview of every agent pane across all
 * sessions and projects at once.
 *
 * An "agent" here is a terminal panel with `customState.isCliPanel === true`;
 * Pane has no dedicated agent panel type.
 */

export type MissionControlAgentType = 'claude' | 'codex';

export interface MissionControlAgentPanel {
  panelId: string;
  sessionId: string;
  sessionName: string;
  projectId: number | null;
  projectName: string;
  /** Absolute worktree path, used for the "by worktree" grouping. */
  worktreePath: string | null;
  /** Worktree/branch name — often the session's real identity in a project. */
  worktreeName: string | null;
  panelTitle: string;
  agentType: MissionControlAgentType | null;
  /** True when the panel refuses deletion, as Pane Chat's does. */
  isPermanent: boolean;
  /** True when a PTY for this panel is alive in the main process right now. */
  isLive: boolean;
}

export interface MissionControlSnapshot {
  panelId: string;
  /** ANSI-stripped text, at most `maxLines` trailing lines. */
  text: string;
  lastActivityAt: string | null;
  /**
   * Live PTY dimensions, when the terminal is running. A live tile must size
   * its terminal to exactly these — agent TUIs use absolute cursor
   * positioning, so a mismatched width wraps every line and scrolls forever.
   */
  cols: number | null;
  rows: number | null;
}

export interface MissionControlSnapshotRequest {
  panelIds: string[];
  /** Trailing lines per tile. Defaults to 16. */
  maxLines?: number;
}

export interface MissionControlSnapshotResult {
  snapshots: MissionControlSnapshot[];
}

/**
 * Reading N emulators costs CPU per panel, so the batch is capped to keep a
 * single poll well under the refresh interval.
 */
export const MAX_MISSION_CONTROL_SNAPSHOT_PANELS = 64;
export const MAX_MISSION_CONTROL_SNAPSHOT_LINES = 120;
export const DEFAULT_MISSION_CONTROL_SNAPSHOT_LINES = 16;

/**
 * Scope for the viewer ids Mission Control registers with
 * `terminalPanelManager.setVisibility`. Both processes read it from here: the
 * renderer mints `<prefix>:<uuid>` and the main process sweeps stale viewers by
 * the same prefix. `visibilityViewerMatchesPrefix` appends its own separator, so
 * this value carries no trailing colon.
 */
export const MISSION_CONTROL_VIEWER_PREFIX = 'missionControl';

// --- Client-side view options ---

export type MissionControlGrouping = 'project' | 'status' | 'agent' | 'none';
/** Tiles per row. Lower density = larger tiles with more visible lines. */
export type MissionControlDensity = 1 | 2 | 3 | 4;

export interface MissionControlTileModel extends MissionControlAgentPanel {
  agentState: AgentState;
  snapshot: MissionControlSnapshot | null;
}

export interface MissionControlGroup {
  key: string;
  label: string;
  tiles: MissionControlTileModel[];
}
