export interface Project {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  /**
   * Optional multi-line shell script (newline-delimited commands) that Pane executes
   * inside the session's worktree *before* the worktree directory is deleted during
   * session archiving.
   *
   * Resolution priority (first match wins):
   *   1. This DB field — set by the user in Project Settings, overrides config files.
   *   2. `detectProjectConfig()` → `archive` field from pane.json / conductor.json.
   *   3. `null` — no archive script runs, worktree is removed immediately.
   *
   * The script is split on newlines and each non-empty line is executed individually
   * by `SessionManager.runArchiveScript`, which uses the project's `CommandRunner`
   * for correct WSL path handling.
   */
  archive_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  default_permission_mode?: "approve" | "ignore";
  open_ide_command?: string | null;
  display_order?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
}

export interface ProjectRunCommand {
  id: number;
  project_id: number;
  command: string;
  display_name?: string;
  order_index: number;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  project_id: number;
  parent_folder_id?: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  name: string;
  initial_prompt: string;
  worktree_name: string;
  worktree_path: string;
  status: "pending" | "running" | "stopped" | "completed" | "failed" | "interrupted";
  status_message?: string;
  created_at: string;
  updated_at: string;
  last_output?: string;
  exit_code?: number;
  pid?: number;
  archived?: boolean;
  last_viewed_at?: string;
  project_id?: number | null;
  folder_id?: string;
  claude_session_id?: string;
  permission_mode?: "approve" | "ignore";
  run_started_at?: string;
  is_main_repo?: boolean;
  worktree_ownership?: WorktreeOwnership;
  display_order?: number;
  is_favorite?: boolean;
  favorite_pinned_at?: string | null;
  tool_type?: "claude" | "none";
  base_commit?: string;
  base_branch?: string;
  skip_continue_next?: boolean;
  pr_renamed?: boolean;
  is_hidden?: boolean;
  commit_mode?: 'disabled' | 'checkpoint' | 'prompt';
  /** Set by `runpane panes handoff --park`; cleared by `runpane panes receive` on this runtime. */
  handed_off_at?: string | null;
}

export interface SessionOutput {
  id: number;
  session_id: string;
  type: "stdout" | "stderr" | "system" | "json" | "error";
  data: string;
  timestamp: string;
  panel_id?: string;
}

export interface ConversationMessage {
  id: number;
  session_id: string;
  message_type: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface CreateSessionData {
  id: string;
  name: string;
  initial_prompt: string;
  worktree_name: string;
  worktree_path: string;
  project_id?: number | null;
  folder_id?: string;
  permission_mode?: "approve" | "ignore";
  is_main_repo?: boolean;
  worktree_ownership?: WorktreeOwnership;
  display_order?: number;
  tool_type?: "claude" | "none";
  base_commit?: string;
  base_branch?: string;
  is_favorite?: boolean;
  favorite_pinned_at?: string;
  is_hidden?: boolean;
  commit_mode?: 'disabled' | 'checkpoint' | 'prompt';
}

type WorktreeOwnership = "pane" | "external";

export interface UpdateSessionData {
  name?: string;
  status?: Session["status"];
  status_message?: string;
  last_output?: string;
  exit_code?: number;
  pid?: number;
  folder_id?: string | null;
  claude_session_id?: string;
  run_started_at?: string;
  is_favorite?: boolean;
  favorite_pinned_at?: string | null;
  skip_continue_next?: boolean;
  pr_renamed?: boolean;
  worktree_path?: string;
  handed_off_at?: string | null;
}

export interface PromptMarker {
  id: number;
  session_id: string;
  prompt_text: string;
  output_index: number;
  output_line?: number;
  timestamp: string;
  completion_timestamp?: string;
}

export interface ExecutionDiff {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[]; // JSON array of changed file paths
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
  comparison_branch?: string;
  history_source?: "remote" | "local" | "branch";
  history_limit_reached?: boolean;
}

export interface CreateExecutionDiffData {
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}

export interface CreatePanelExecutionDiffData {
  panel_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}
