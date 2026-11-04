/**
 * Lets an action elsewhere in the app leave Settings first, through Settings'
 * own guard for unsaved edits: the action runs only once Settings has closed,
 * and not at all if the person chooses to stay.
 */
type SettingsExit = (then: () => void) => void;

let exit: SettingsExit | null = null;

/** Settings registers how it closes while it is open. */
export function registerSettingsExit(next: SettingsExit): () => void {
  exit = next;
  return () => {
    if (exit === next) exit = null;
  };
}

/** Runs `action` now, or after Settings closes when it is open. */
export function afterLeavingSettings(action: () => void): void {
  if (exit) exit(action);
  else action();
}
