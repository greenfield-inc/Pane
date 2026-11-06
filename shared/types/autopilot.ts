/**
 * Autopilot (experimental, D-43): one always-running agent above every Session. It is not a
 * Session (D-69): its data lives in <PANE_DIR>/autopilot/, one folder per run, with `current`
 * naming the active run. Its agent is a chat tab in a hidden, detached owner Pane whose
 * workspace is the run folder. Approvals stay the person's (D-66): the control plane refuses
 * every answer that comes from Autopilot's panel.
 */

/** Where Autopilot's agent is: not started (shows Start), running its walk, or paused. */
export type AutopilotAgentState = 'stopped' | 'running' | 'paused';

/** The single check every way Autopilot turns on or starts goes through (D-65). */
export interface AutopilotEntitlement {
  entitled: boolean;
  /** Set when not entitled: why, and the next step. */
  reason?: string;
  next?: string;
}

/**
 * One tab of a stack entry. The `item` tab is where the person answers (D-73); the others show a
 * document (an HTML or text file), the app (a URL), or a Session's overview.
 */
export type AutopilotTab =
  | { kind: 'item'; label: string; notifyId: string }
  | { kind: 'file'; label: string; path: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'session'; label: string; sessionId: string };

/** What a stack entry is about. References only (no copies of other Sessions' data). */
export type AutopilotStackRef =
  | { kind: 'item'; notifyId: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'session'; sessionId: string };

export interface AutopilotStackEntry {
  id: string;
  ref: AutopilotStackRef;
  title: string;
  /** The Session the entry is grouped under, when it has one. */
  sessionId?: string;
  sessionName?: string;
  /** The first tab is the entry's own (its approval, document, URL or Session). */
  tabs: AutopilotTab[];
  /** Autopilot's one-line note about it ("What the orchestrator says", why it is here). */
  note?: string;
  /** Epoch ms. */
  addedAt: number;
  /** The entry is about something Autopilot wrote or asked itself (its own approval or document). */
  byAutopilot?: boolean;
  /** Epoch ms when the entry was resolved (its item answered or expired, or the person dismissed it). */
  doneAt?: number;
}

/**
 * The stack (D-46, D-71): entries in the order Autopilot put them, one shown at a time. New
 * entries wait off-screen and never replace the one shown; when the shown entry is resolved, the
 * next waiting one comes up.
 */
export interface AutopilotStack {
  entries: AutopilotStackEntry[];
  shownId: string | null;
}

/** One Session in the walk bar. */
export interface AutopilotWalkSession {
  id: string;
  name: string;
  /** Items waiting on the person in this Session. */
  waiting: number;
}

/** The top-down walk (D-59): the Session Autopilot is on, and every Session with its count. */
export interface AutopilotWalk {
  sessionId?: string;
  sessions: AutopilotWalkSession[];
}

export interface AutopilotRunInfo {
  id: string;
  /** The run folder: AGENTS.md, docs/, stack.json, state.json and log. */
  folder: string;
  docsFolder: string;
  /** ISO time. */
  createdAt: string;
}

/** What every Autopilot surface renders. Main decides; the renderer only shows it. */
export interface AutopilotSnapshot {
  /** The experimental switch (Settings › Advanced › Experimental). */
  enabled: boolean;
  /** Autopilot runs as a chat tab, so it needs chat tabs on. */
  chatTabsEnabled: boolean;
  entitlement: AutopilotEntitlement;
  run: AutopilotRunInfo | null;
  /** Autopilot's chat tab, once the run has one. */
  panelId: string | null;
  ownerPaneId: string | null;
  state: AutopilotAgentState;
  /** Sentinel Mode (package 7, D-93): Autopilot keeps Sessions moving while the person is away. */
  sentinel: boolean;
  /** Epoch ms when Sentinel was turned on. */
  sentinelSince?: number;
  stack: AutopilotStack;
  walk: AutopilotWalk;
}

/**
 * The person's own instructions for Autopilot (D-196): a plain file they, the CLI and Settings
 * edit, applied after Pane's built-in rules and never over them.
 */
export interface AutopilotInstructionsView {
  /** The file's text, trimmed; '' when there are none. */
  text: string;
  /** `<PANE_DIR>/autopilot/instructions.md`, on the machine Autopilot runs on. */
  path: string;
  /** Pane's own instructions they add to (AGENTS.md, the Start line, the pane-autopilot skill), read-only. */
  builtIn: string;
  /** none: no text. applied: the running agent has these. next-start: the next Start applies them. */
  status: 'none' | 'applied' | 'next-start';
}

/** One waiting item, as `runpane autopilot waiting` lists it. */
export interface AutopilotWaitingItem {
  id: string;
  title: string;
  kind: 'approval' | 'question' | 'permission' | 'stuck';
  /** The Session it is filed under; absent: not in a Session. */
  sessionId?: string;
  sessionName?: string;
  /** Who asked: the agent and its Pane. */
  agent: string;
  pane: string;
  paneId?: string;
  panelId?: string;
  /** The asking tab is the Session's orchestrator. */
  orchestrator?: boolean;
  /** Written by Autopilot itself. */
  byAutopilot?: boolean;
  context?: string;
  choices?: string[];
  links: Array<{ label: string; path?: string; url?: string }>;
  /** Epoch ms. */
  createdAt: number;
  ageMs: number;
  machine: string;
  machineId: string;
  /** Already on the stack. */
  onStack: boolean;
}

/** `runpane autopilot stack push`: what to put on the stack. Exactly one of item, file, url or session. */
export interface AutopilotStackPushRequest {
  item?: string;
  file?: string;
  url?: string;
  session?: string;
  title?: string;
  note?: string;
  /** Extra tabs: files or URLs. */
  tabs?: Array<{ label?: string; path?: string; url?: string }>;
  /** Put it right after the entry on screen (jumping back up, D-59) instead of at the end. */
  next?: boolean;
}

/** A document tab's content: an HTML page loads from its file; anything else shows as text. */
export type AutopilotDocument =
  /** `html` is the page itself, only when asked for inline (the phone, which can't load the computer's file URL). */
  | { kind: 'html'; url: string; path: string; html?: string }
  | { kind: 'text'; text: string; path: string }
  | { kind: 'missing'; path: string; message: string };

/** The stack controls the person uses: ‹ › and ← →, a chip, or dismissing an entry. */
export type AutopilotStackCommand =
  | { type: 'step'; direction: 1 | -1 }
  | { type: 'show'; id: string }
  | { type: 'dismiss'; id: string };

/** Codes Autopilot's errors carry; the CLI and MCP print them with the next step. */
export type AutopilotErrorCode =
  | 'AUTOPILOT_OFF'
  | 'AUTOPILOT_NOT_ENTITLED'
  | 'AUTOPILOT_NEEDS_CHAT_TABS'
  | 'AUTOPILOT_CANNOT_ANSWER'
  | 'AUTOPILOT_PAUSED'
  | 'AUTOPILOT_NOT_STARTED'
  | 'AUTOPILOT_STACK_INVALID'
  | 'AUTOPILOT_ONLY';

/** Hidden owner Pane ids for Autopilot runs start with this. */
export const AUTOPILOT_OWNER_PANE_PREFIX = '__autopilot_owner_';
/** Autopilot chat tab panel ids start with this. */
export const AUTOPILOT_PANEL_PREFIX = '__autopilot_panel_';
/** The named watch cursor Autopilot always uses, so it never takes over an orchestrator's. */
export const AUTOPILOT_WATCH_CURSOR = 'autopilot';
