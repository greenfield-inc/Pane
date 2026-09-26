import type { JsonObject } from '../validation/boundaryDecoder';

/** Wire dates are strings; the main-process alias retains Date instances. */
export interface Session<Timestamp = string, Message = ClaudeJsonMessage> {
  id: string;
  name: string;
  worktreePath: string;
  prompt: string;
  status: 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error';
  statusMessage?: string;
  pid?: number;
  createdAt: Timestamp;
  lastActivity?: Timestamp;
  output: string[];
  jsonMessages: Message[];
  error?: string;
  isRunning?: boolean;
  lastViewedAt?: string;
  permissionMode?: 'approve' | 'ignore';
  runStartedAt?: string;
  isMainRepo?: boolean;
  worktreeOwnership?: 'pane' | 'external';
  displayOrder?: number;
  projectId?: number;
  folderId?: string;
  isFavorite?: boolean;
  favoritePinnedAt?: string;
  model?: string;
  toolType?: 'claude' | 'none';
  archived?: boolean;
  isHidden?: boolean;
  gitStatus?: GitStatus;
  baseCommit?: string;
  baseBranch?: string;
  pr_renamed?: boolean;
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
  prIsDraft?: boolean;
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
  model?: string;
  toolType?: 'claude' | 'none';
  claudeConfig?: {
    model?: string;
    permissionMode?: 'approve' | 'ignore';
    ultrathink?: boolean;
  };
}

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

export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

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
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'result' | 'thinking' | 'session';
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
  data?: JsonObject;
}

export interface SessionOutput<Timestamp = string, Data = string | ClaudeJsonMessage> {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: Data;
  timestamp: Timestamp;
  panelId?: string;
}
