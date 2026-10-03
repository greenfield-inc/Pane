/**
 * What to write into a fresh shell to run a command.
 *
 * Two writes, not one. A terminal that has just printed its prompt can lose the
 * first byte it is given: ConPTY switches input modes around the prompt, and a
 * resize arriving in the same moment makes it likelier. The symptom is a command
 * that runs with its first letter missing — `laude --resume …`, which fails as
 * "command not found" and reads as if Pane sent nonsense.
 *
 * The first write is therefore a byte that costs nothing either way: Ctrl-U
 * clears the input line, which at a fresh prompt is already empty. Whatever the
 * shell swallows, it is not part of the command.
 *
 * Kept in its own module so it can be unit-tested without dragging in the
 * database singleton that `terminalPanelManager` depends on.
 */

/** Ctrl-U — kill line. Harmless at an empty prompt in bash, zsh and PSReadLine. */
const INJECTION_PRIMER = '\x15';

/** Gap between the primer and the command, long enough to clear the window. */
export const INJECTION_PRIMER_DELAY_MS = 60;

export function injectionSequence(command: string): [primer: string, line: string] {
  return [INJECTION_PRIMER, `${command}\r`];
}
