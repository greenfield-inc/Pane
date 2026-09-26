import type { ProjectEnvironment } from './panels';

export interface Project {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  /**
   * Optional multi-line shell script that runs inside a session's worktree before
   * the worktree is deleted during session archiving.  When null Pane falls back to
   * the `archive` field from `detectProjectConfig` (pane.json / conductor.json).
   * Populated from the DB `projects.archive_script` column.
   */
  archive_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  open_ide_command?: string | null;
  displayOrder?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
  environment?: ProjectEnvironment;
}

export interface CreateProjectRequest {
  name: string;
  path: string;
  systemPrompt?: string;
  runScript?: string;
  buildScript?: string;
  openIdeCommand?: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
}

export interface UpdateProjectRequest {
  name?: string;
  path?: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  /**
   * User-supplied archive script override sent to `projects:update` IPC.
   * Pass `null` to clear the override and revert to config-file detection.
   * See `Project.archive_script` for the full resolution chain.
   */
  archive_script?: string | null;
  active?: boolean;
  open_ide_command?: string | null;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
}
