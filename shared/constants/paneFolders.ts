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

/** Folders Pane keeps in its data directory (`<pane-dir>`). */
/** `<pane-dir>/scratch/<pane-id>/`: scratch for Panes whose own folder archive keeps. */
export const PANE_DIR_SCRATCH_FOLDER = 'scratch';
/** `<pane-dir>/scratch/.archived/<pane-id>`: when a Pane was archived, outside the folders agents write. */
export const PANE_DIR_ARCHIVED_MARKERS_FOLDER = '.archived';
/** `<pane-dir>/agent-logs/`: agent logs kept from folders Pane deleted. */
export const PANE_DIR_AGENT_LOGS_FOLDER = 'agent-logs';

/** A Pane id as a single folder name. */
export function paneFolderName(paneId: string): string {
  const name = paneId.replace(/[^A-Za-z0-9._-]/gu, '_');
  // `.` and `..` name the parent folders; they never name a Pane's own.
  return name === '.' || name === '..' || name === '' ? `_${name}_` : name;
}
