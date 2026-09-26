/**
 * At-a-glance agent status types.
 *
 * The main process detects a raw {@link AgentState} per agent pane from its live
 * terminal screen + OSC title. The renderer maps that to an
 * {@link AgentDisplayStatus} for the sidebar, session list, and pane tabs, where
 * a finished-but-unseen pane reads as `done` and a finished-and-seen pane as
 * `idle`.
 */

/** Raw state derived by the detection engine in the main process. */
export type AgentState = 'blocked' | 'working' | 'idle' | 'unknown';

/** Status rendered in the UI. `done` = idle & not yet seen by the user. */
export type AgentDisplayStatus = 'blocked' | 'working' | 'done' | 'idle' | 'unknown';

/** Snapshot fed to the detection engine for a single pane. */
export interface AgentDetectionInput {
  /** Plain-text of the terminal's visible viewport (bottom of buffer). */
  screen: string;
  /** Current OSC window/icon title, or empty string when unavailable. */
  oscTitle: string;
  /** Current OSC progress payload (e.g. `4;0`), or empty string. */
  oscProgress: string;
}

/** Result of evaluating a manifest against an {@link AgentDetectionInput}. */
export interface AgentDetectionResult {
  state: AgentState;
  /** The matched screen visibly shows live chrome needing human input. */
  visibleBlocker: boolean;
  /** The matched screen visibly shows live working chrome. */
  visibleWorking: boolean;
  /** The matched chrome reliably indicates idle; excludes composers also visible during work. */
  visibleIdle: boolean;
  /**
   * The matched screen is an agent-owned viewer (transcript/history) rather than
   * the live prompt state — callers should hold the previously known state.
   */
  skipStateUpdate: boolean;
  /** Id of the winning rule, or null when the idle fallback was used. */
  matchedRuleId: string | null;
}

/** Payload of the `panel:agentStatus` IPC event. */
export interface PanelAgentStatusEvent {
  panelId: string;
  sessionId: string;
  state: AgentState;
  /** Winning rule id or a short reason string, for debugging. */
  reason: string | null;
}
