/**
 * Folders Pane keeps inside a Pane's git worktree, relative to its top, in
 * POSIX form. Each is hidden from git by a line in the repository's
 * `info/exclude`, never a committed `.gitignore`, and goes with the worktree
 * when the Pane is archived.
 */
/** Prompt files an agent reads (`--as-file-pointer`). */
export const PANE_PROMPTS_FOLDER = '.pane/prompts';
/** `$PANE_SCRATCH_DIR`: an agent's temporary files, clones, captures and downloads. */
export const PANE_SCRATCH_FOLDER = '.pane/scratch';
