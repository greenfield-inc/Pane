import type { CustomCommandResume } from './customCommandResume';
import type { DiffScope } from './gitDiff';

/**
 * Panel and session types for Pane.
 * Note: "Sessions" are called "Panes" in the UI. Internally they remain
 * "sessions" in code, database, and IPC to avoid a massive refactor.
 */
export type ProjectEnvironment = 'wsl' | 'windows' | 'linux' | 'macos';

export interface ToolPanel {
  id: string;                    // Unique panel instance ID (uuid)
  sessionId: string;             // Associated session/worktree
  type: ToolPanelType;          // 'terminal' for now
  title: string;                 // Display title (e.g., "Terminal 1")
  state: ToolPanelState;         // Panel-specific state
  metadata: ToolPanelMetadata;   // Creation time, position, etc.
}

export type ToolPanelType = 'terminal' | 'diff' | 'explorer' | 'editor' | 'logs' | 'dashboard' | 'setup-tasks' | 'browser';

export interface ToolPanelState {
  isActive: boolean;
  isPinned?: boolean;
  hasBeenViewed?: boolean;       // Track if panel has ever been viewed
  customState?: TerminalPanelState | DiffPanelState | ExplorerPanelState | EditorPanelState | LogsPanelState | DashboardPanelState | SetupTasksPanelState | BrowserPanelState | object;
}

export interface TerminalPanelState {
  // Basic state (implemented in Phase 1-2)
  isInitialized?: boolean;       // Whether PTY process has been started
  cwd?: string;                  // Current working directory
  shellType?: string;            // bash, zsh, etc.
  initialCommand?: string;       // Command to run on terminal init (e.g., "claude --dangerously-skip-permissions")
  initialInput?: string;         // First input to send once the initial command is ready
  initialInputMode?: 'stdin' | 'argument'; // How initialInput is delivered to the initial command
  initialInputSubmitStrategy?: 'enter' | 'codex-ctrl-enter'; // How stdin initialInput should be submitted
  initialInputDeliveryVersion?: number; // Bumps when a feature changes delivery semantics
  initialInputSentAt?: string;   // Set after initialInput has been written once
  initialInputError?: string;    // Best-effort error if initialInput could not be written
  
  // Terminal bytes. On the way to the database these three keys are split out
  // of the state JSON into the bounded panel_buffers table; they only appear
  // here on the live terminal:getState path and in write patches.
  scrollbackBuffer?: string | string[];   // Full terminal output history (string for new format, array for legacy)
  alternateScreenBuffer?: string;         // Recent TUI/alternate-screen output, kept separate from shell scrollback
  isAlternateScreen?: boolean;            // Whether the live terminal is currently in alternate-screen/TUI mode
  serializedBuffer?: string;             // xterm.js serialized terminal state (includes full visual buffer)
  environmentVars?: Record<string, string>; // Modified env vars
  dimensions?: { cols: number; rows: number }; // Terminal size
  cursorPosition?: { x: number; y: number }; // Cursor location
  selectionText?: string;        // Any selected text
  lastActivityTime?: string;     // For "idle since" indicators
  
  // Advanced persistence options
  tmuxSessionId?: string;        // For true session persistence via tmux
  outputSizeLimit?: number;      // Max lines to persist (default: 10000)

  // Auto-resume state (for graceful shutdown/restart)
  wasInterrupted?: boolean;          // Whether this terminal was active when app shutdown occurred
  hasClaudeSessionId?: boolean;      // Whether --session-id was already passed to Claude (use --resume next time)
  agentType?: 'claude' | 'codex' | 'cursor'; // CLI agent type for panel-local resume behavior
  agentSessionId?: string;           // Agent-generated session ID for resuming conversations
  /** Stable orchestration identity for resumed Session terminals. */
  orchestrationSessionId?: string;
  customResume?: CustomCommandResume | null;
  customResumeStarted?: boolean;

  // CLI tool init state
  isCliPanel?: boolean;              // True if this terminal runs a CLI tool (claude/codex)
  isCliReady?: boolean;              // True after the CLI tool has started responding
}

export interface TerminalPanelOutputEvent {
  sessionId: string;
  panelId: string;
  output: string;
}

export interface TerminalSessionOutputEvent {
  sessionId: string;
  type: 'stdout' | 'stderr';
  data: string;
}

export type TerminalOutputEvent = TerminalPanelOutputEvent | TerminalSessionOutputEvent;

export interface DiffPanelState {
  lastRefresh?: string;            // Last time diff was refreshed
  currentDiff?: string;             // Cached diff content
  filesChanged?: number;            // Number of files changed
  insertions?: number;              // Lines added
  deletions?: number;               // Lines deleted
  isDiffStale?: boolean;            // Needs refresh indicator
  viewMode?: 'split' | 'unified';  // Diff view preference
  showWhitespace?: boolean;         // Show whitespace changes
  contextLines?: number;            // Lines of context
  commitSha?: string;               // Specific commit being viewed
}

// Panel status type - mirrors session status but at panel level
export type PanelStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error' | 'interrupted';

// Base interface for AI panel states (Claude, Codex, etc.)
export interface BaseAIPanelState {
  // Common state for all AI tools
  isInitialized?: boolean;       // Whether AI process has been started
  lastPrompt?: string;           // Last user prompt
  model?: string;                // Model being used
  lastActivityTime?: string;     // For "idle since" indicators
  lastInput?: string;            // Last input sent to the AI

  // Panel-level status tracking (independent per panel)
  panelStatus?: PanelStatus;     // Current panel execution status
  hasUnviewedContent?: boolean;  // Whether panel has content not yet viewed

  // Generic agent session ID for resume functionality (used by all AI agents)
  agentSessionId?: string;        // The AI agent's session ID for resuming conversations
}

export interface ExplorerPanelState {
  filePath?: string;              // Currently open file
  content?: string;               // File content (for unsaved changes)
  isDirty?: boolean;              // Has unsaved changes
  cursorPosition?: {              // Cursor location
    line: number;
    column: number;
  };
  scrollPosition?: number;        // Scroll position
  language?: string;              // File language for syntax highlighting
  readOnly?: boolean;             // Read-only mode
  fontSize?: number;              // Editor font size preference
  theme?: string;                 // Editor theme preference

  // File tree state
  expandedDirs?: string[];        // List of expanded directory paths
  fileTreeWidth?: number;         // Width of the file tree panel
  searchQuery?: string;           // Current search query in file tree
  showSearch?: boolean;           // Whether search is visible
}

/**
 * A center editor tab opened from the Files inspector, the Review panel or a
 * terminal link. Follows VS Code's preview semantics: a single click opens a
 * preview tab (italic title) that the next single-click re-targets; double-
 * clicking the file or the tab, or editing the file, pins it.
 */
/**
 * Which diff an editor tab shows. Mirrors the Review panel's two addressing
 * modes: a commit hash (`'index'` = uncommitted) or an execution range
 * (`[0]` = uncommitted, `[a, b]` = one commit, omitted = every commit).
 */
export type LegacyEditorDiffRef =
  | { kind: 'commit'; hash: string }
  | { kind: 'range'; executionIds?: number[] };

export type EditorDiffRef = { kind: 'scope'; scope: DiffScope; previousPath?: string };

export interface EditorPanelState {
  filePath: string;
  /** When set, the tab shows this file's diff instead of an editable file. */
  diff?: EditorDiffRef;
  isPreview?: boolean;
  isDirty?: boolean;
  cursorPosition?: { line: number; column: number };
  scrollPosition?: number;
}

export interface LogsPanelState {
  isRunning: boolean;             // Process currently running
  processId?: number;             // Active process PID
  command?: string;               // Command being executed
  startTime?: string;             // When process started
  endTime?: string;               // When process ended
  exitCode?: number;              // Process exit code
  outputBuffer?: string[];        // Recent output lines
  errorCount?: number;            // Number of errors detected
  warningCount?: number;          // Number of warnings detected
  lastActivityTime?: string;      // Last output received
}

export interface DashboardPanelState {
  lastRefresh?: string;           // Last time dashboard was refreshed
  filterType?: 'all' | 'stale' | 'changes' | 'pr'; // Current filter
  isRefreshing?: boolean;          // Whether dashboard is currently refreshing
  cachedData?: object;                // Cached dashboard data
}

export interface SetupTasksPanelState {
  lastCheck?: string;              // Last time tasks were checked
  tasksCompleted?: Record<string, boolean>; // Track which tasks are done
  dismissedTasks?: string[];       // Tasks the user has dismissed
}

export interface BrowserPanelState {
  currentUrl?: string;
  isPopup?: boolean;
}

export interface ToolPanelMetadata {
  createdAt: string;
  lastActiveAt: string;
  position: number;              // Tab order
  permanent?: boolean;           // Cannot be closed (for diff panel)
}

export interface CreatePanelRequest {
  id?: string;                    // Optional stable ID for managed singleton panels
  sessionId: string;
  type: ToolPanelType;
  title?: string;                // Optional custom title
  initialState?: TerminalPanelState | DiffPanelState | ExplorerPanelState | EditorPanelState | LogsPanelState | DashboardPanelState | SetupTasksPanelState | BrowserPanelState | { customState?: unknown };
  metadata?: Partial<ToolPanelMetadata>; // Optional metadata overrides
  activate?: boolean;            // Defaults to true; false creates the panel in the background.
}

export interface UpdatePanelRequest {
  panelId: string;
  updates: Partial<ToolPanel>;
}

// Type for resumable sessions after graceful shutdown
export interface ResumableSession {
  sessionId: string;
  sessionName: string;
  panels: Array<{
    panelId: string;
    panelType: 'terminal';
    resumeId: string;
  }>;
}

// Panel Event System Types
export interface PanelEvent {
  type: PanelEventType;
  source: {
    panelId: string;
    panelType: ToolPanelType | 'git';
    sessionId: string;
  };
  data: unknown;
  timestamp: string;
}

// ⚠️ IMPORTANT: Event Types Implementation Status
// ================================================
// For Phase 1-2, ONLY terminal events will be implemented.
// The full list below shows the FUTURE event system design to demonstrate
// how different panel types will communicate once migrated.
//
// IMPLEMENTED IN PHASE 1-2:
//   - terminal:command_executed
//   - terminal:exit  
//   - files:changed (emitted by terminal when file operations detected)
//
// NOT IMPLEMENTED (shown for future reference only):
//   - All claude:* events
//   - All diff:* events
//   - All git:* events

export type PanelEventType = 
  // Terminal panel events (✅ IMPLEMENTED IN PHASE 1-2)
  | 'terminal:command_executed'  // When a command is run in terminal
  | 'terminal:exit'              // When terminal process exits
  | 'files:changed'              // When terminal detects file system changes
  | 'diff:refreshed'             // When diff panel refreshes its content
  // Explorer panel events
  | 'explorer:file_saved'        // When a file is saved in explorer
  | 'explorer:file_changed'      // When file content changes in explorer
  // Logs panel events
  | 'process:started'            // When a script process starts
  | 'process:output'             // When process produces output
  | 'process:ended'              // When process exits
  // Git operation events
  | 'git:operation_started'      // When a git operation begins
  | 'git:operation_completed'    // When a git operation succeeds
  | 'git:operation_failed'        // When a git operation fails

export interface PanelEventSubscription {
  panelId: string;
  eventTypes: PanelEventType[];
  callback: (event: PanelEvent) => void;
}

export interface PanelCapabilities {
  canEmit: PanelEventType[];      // Events this panel type can produce
  canConsume: PanelEventType[];   // Events this panel type listens to
  requiresProcess?: boolean;       // Whether panel needs a background process
  singleton?: boolean;             // Only one instance allowed per session
  permanent?: boolean;             // Cannot be closed (for diff panel)
  canAppearInProjects?: boolean;  // Whether panel can appear in project view
  canAppearInWorktrees?: boolean; // Whether panel can appear in worktree sessions
}

interface PanelCapabilityRegistry {
  terminal: PanelCapabilities;
  diff: PanelCapabilities;
  explorer: PanelCapabilities;
  editor: PanelCapabilities;
  logs: PanelCapabilities;
  dashboard: PanelCapabilities;
  'setup-tasks': PanelCapabilities;
  browser: PanelCapabilities;
}

// Panel Registry - Currently only terminal is implemented
export const PANEL_CAPABILITIES: PanelCapabilityRegistry = {
  terminal: {
    canEmit: ['terminal:command_executed', 'terminal:exit', 'files:changed'],
    canConsume: [], // Terminal doesn't consume events in Phase 1-2
    requiresProcess: true,
    singleton: false,
    canAppearInProjects: true,       // Terminal can appear in projects
    canAppearInWorktrees: true       // Terminal can appear in worktrees
  },
  diff: {
    canEmit: ['diff:refreshed'],
    canConsume: ['files:changed', 'terminal:command_executed'],
    requiresProcess: false,           // No background process
    singleton: true,                  // Only one diff panel
    permanent: true,                  // Cannot be closed
    canAppearInProjects: false,       // Diff not available in projects (no worktree)
    canAppearInWorktrees: true        // Diff only in worktrees
  },
  explorer: {
    canEmit: ['explorer:file_saved', 'explorer:file_changed'],
    canConsume: ['files:changed'],  // React to file system changes
    requiresProcess: false,          // No background process needed
    singleton: false,                // Multiple explorers allowed
    canAppearInProjects: true,       // Explorer can appear in projects
    canAppearInWorktrees: true       // Explorer can appear in worktrees
  },
  editor: {
    canEmit: ['explorer:file_saved', 'explorer:file_changed'],
    canConsume: ['files:changed'],
    requiresProcess: false,
    singleton: false,                // One tab per open file
    canAppearInProjects: true,
    canAppearInWorktrees: true
  },
  logs: {
    canEmit: ['process:started', 'process:output', 'process:ended'],
    canConsume: [],                  // Logs doesn't listen to other panels
    requiresProcess: true,           // Manages script processes
    singleton: true,                 // ONLY ONE logs panel per session
    canAppearInProjects: true,       // Logs can appear in projects
    canAppearInWorktrees: true       // Logs can appear in worktrees
  },
  dashboard: {
    canEmit: [],                     // Dashboard doesn't emit events
    canConsume: ['files:changed'],   // Refresh on file changes
    requiresProcess: false,          // No background process
    singleton: true,                 // Only one dashboard panel
    permanent: true,                 // Cannot be closed (like diff panel)
    canAppearInProjects: true,       // Dashboard ONLY in projects
    canAppearInWorktrees: false      // Dashboard NOT in worktrees
  },
  'setup-tasks': {
    canEmit: [],                     // Setup tasks doesn't emit events
    canConsume: ['files:changed'],   // Refresh when files change (e.g., gitignore)
    requiresProcess: false,          // No background process
    singleton: true,                 // Only one setup tasks panel
    permanent: true,                 // Cannot be closed (like dashboard)
    canAppearInProjects: true,       // Setup tasks ONLY in projects
    canAppearInWorktrees: false      // Setup tasks NOT in worktrees
  },
  browser: {
    canEmit: [],
    canConsume: [],
    requiresProcess: false,
    singleton: false,
    permanent: false,                // NOT permanent in capabilities — auto-created default gets permanent via metadata
    canAppearInProjects: false,      // Browser panels only make sense in worktree sessions
    canAppearInWorktrees: true,
  }
};

// --- Layout tree types (split tab groups) ---

/** A leaf node: one tab group containing an ordered list of panel ids. */
export interface PanelGroupNode {
  type: 'group';
  /** Stable id; used as React key and Allotment.Pane key. */
  id: string;
  /** Ordered panel ids (layout order, not type-sorted). */
  panelIds: string[];
  /** Active (visible) panel within this group; null when group is empty. */
  activePanelId: string | null;
}

/** A branch node: children arranged in a row or column with sash-resizable sizes. */
export interface PanelSplitNode {
  type: 'split';
  /** Stable id; used as React key. */
  id: string;
  /** 'row' = children side-by-side horizontally; 'column' = stacked vertically. */
  direction: 'row' | 'column';
  /** Child nodes (groups or nested splits). Length >= 2. */
  children: PanelLayoutNode[];
  /** Proportional sizes parallel to children; sum is unconstrained (allotment normalizes). */
  sizes: number[];
}

/** Discriminated union for the recursive layout tree. */
export type PanelLayoutNode = PanelGroupNode | PanelSplitNode;

/** Top-level layout persisted per session as JSON in sessions.panel_layout. */
export interface SessionPanelLayout {
  version: 1;
  root: PanelLayoutNode;
  /** Id of the group that has keyboard focus. */
  focusedGroupId?: string;
  /** Id of the group that is zoomed (fills the stage); null/undefined when not zoomed. */
  zoomedGroupId?: string | null;
}
