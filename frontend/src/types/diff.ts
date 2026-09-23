export interface ExecutionDiff {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  prompt_text?: string;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
  author?: string;
  comparison_branch?: string;
  history_source?: 'remote' | 'local' | 'branch';
  history_limit_reached?: boolean;
}

export interface CombinedDiffViewProps {
  sessionId: string;
  isGitOperationRunning?: boolean;
  isMainRepo?: boolean;
  isVisible?: boolean;
}
