interface WorktreeSession {
  worktree_name?: string | null;
  project_id?: number | null;
  is_main_repo?: boolean | number | null;
  worktree_ownership?: 'pane' | 'external' | null;
}

export function ownsRemovableWorktree(
  session: WorktreeSession | undefined,
): session is WorktreeSession & { worktree_name: string; project_id: number } {
  return Boolean(session?.worktree_name && session.project_id
    && !session.is_main_repo && session.worktree_ownership !== 'external');
}
