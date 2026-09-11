import type { JsonObject } from '../../../shared/validation/boundaryDecoder';

// Claude message content types
interface TextContent {
  type: 'text';
  text: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: JsonObject;
}

interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type MessageContent = TextContent | ToolUseContent | ToolResultContent;

// Tool definition interface
interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: JsonObject;
}

// MCP server definition interface  
interface McpServerDefinition {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

// JSON message structure from Claude
export interface ClaudeJsonMessage {
  id?: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'result' | 'thinking';
  role?: 'user' | 'assistant' | 'system';
  content?: string | MessageContent[];
  message?: {
    content?: string | MessageContent[];
  };
  timestamp: string;
  name?: string;
  input?: JsonObject;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  session_id?: string;
  text?: string;
  subtype?: string;
  cwd?: string;
  model?: string;
  tools?: ToolDefinition[];
  mcp_servers?: McpServerDefinition[];
  permissionMode?: string;
  summary?: string;
  error?: string;
  details?: string;
  raw_output?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  cost_usd?: number;
  thinking?: string;
}

export interface Session {
  id: string;
  name: string;
  worktreePath: string;
  prompt: string;
  status: 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error';
  statusMessage?: string;
  pid?: number;
  createdAt: string;
  lastActivity?: string;
  output: string[];
  jsonMessages: ClaudeJsonMessage[];
  error?: string;
  isRunning?: boolean;
  lastViewedAt?: string;
  projectId?: number;
  folderId?: string;
  permissionMode?: 'approve' | 'ignore';
  runStartedAt?: string;
  isMainRepo?: boolean;
  worktreeOwnership?: 'pane' | 'external';
  displayOrder?: number;
  isFavorite?: boolean;
  favoritePinnedAt?: string;
  toolType?: 'claude' | 'none';
  archived?: boolean;
  isHidden?: boolean;
  gitStatus?: GitStatus;
  baseCommit?: string;
  baseBranch?: string;
  /** ISO timestamp set by `runpane panes handoff --park`; absent when the pane is active here. */
  handedOffAt?: string;
  activateOnCreate?: boolean;
  createDefaultTerminalOnCreate?: boolean;
}

export interface GitStatus {
  state: 'clean' | 'modified' | 'untracked' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'unknown';
  ahead?: number;
  behind?: number;
  additions?: number; // Uncommitted additions
  deletions?: number; // Uncommitted deletions
  filesChanged?: number; // Uncommitted files changed
  lastChecked?: string;
  // Enhanced status information
  isReadyToMerge?: boolean; // True when ahead of base branch with no uncommitted changes and not diverged (not behind)
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  // Allow tracking multiple states for better clarity
  secondaryStates?: Array<'modified' | 'untracked' | 'ahead' | 'behind'>;
  // Commit statistics (for all commits ahead of main)
  commitAdditions?: number;
  commitDeletions?: number;
  commitFilesChanged?: number;
  // Total commits in branch (not just ahead of main)
  totalCommits?: number;
  // PR information (fetched lazily from GitHub)
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string; // 'OPEN' | 'MERGED' | 'CLOSED'
  prBody?: string;
}

export interface CreateSessionRequest {
  prompt: string;
  worktreeTemplate?: string;
  count?: number;
  permissionMode?: 'approve' | 'ignore';
  projectId?: number;
  folderId?: string;
  isMainRepo?: boolean;
  baseBranch?: string;
  startPinned?: boolean;
  toolType?: 'claude' | 'none';
  claudeConfig?: {
    model?: string;
    permissionMode?: 'approve' | 'ignore';
    ultrathink?: boolean;
  };
}

export interface SessionOutput {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: string | ClaudeJsonMessage;
  timestamp: string;
  panelId?: string;
}

export interface GitCommands {
  rebaseCommands: string[];
  squashCommands: string[];
  mergeCommands: string[];
  comparisonBaseBranch?: string;
  originBranch?: string;
  currentBranch?: string;
  getPullCommand?: () => string;
  getPushCommand?: () => string;
  getRebaseFromMainCommand?: () => string;
  getSquashAndRebaseToMainCommand?: () => string;
}

export interface GitErrorDetails {
  title: string;
  message: string;
  command?: string;
  commands?: string[];
  output: string;
  workingDirectory?: string;
  projectPath?: string;
  isRebaseConflict?: boolean;
  hasConflicts?: boolean;
  conflictingFiles?: string[];
  conflictingCommits?: {
    ours: string[];
    theirs: string[];
  };
}

// Import Folder from the proper types file
import type { Folder } from './folder';

export type ContextMenuPayload = Session | Folder;

// Version update info interface
export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  downloadUrl?: string;
}

export interface VersionUpdateInfo extends VersionInfo {
  version: string;
  mandatory?: boolean;
}

// Attachment types for Claude Code config
export interface AttachedImage {
  id: string;
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

export interface AttachedText {
  id: string;
  name: string;
  content: string;
  size: number;
  path?: string;
}
