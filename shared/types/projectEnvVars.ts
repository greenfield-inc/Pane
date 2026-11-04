/**
 * Per-project environment variables. Pane sets them in every terminal, agent and
 * setup/run/archive script it starts for a Pane of that project.
 *
 * A variable is plain text, a reference to an existing macOS keychain item, or a
 * reference to a Pane secret (`<project>/<NAME>`, see docs/PANE_SECRETS.md). Values
 * of the last two are read when a process starts and never stored with the project
 * or sent to the renderer.
 */

/** A stored variable as main and the renderer see it. Never carries a secret value. */
export type ProjectEnvVar =
  | { key: string; source: 'plain'; value: string }
  | { key: string; source: 'keychain'; service: string; account: string }
  | { key: string; source: 'secret'; project: string; name: string };

/**
 * What the renderer and `runpane repos update` send to save a variable. A `secret`
 * variable with a `value` creates or replaces that Pane secret first; main stores
 * the value in the secret store and drops it.
 */
export type ProjectEnvVarInput =
  | { key: string; source: 'plain'; value: string }
  | { key: string; source: 'keychain'; service: string; account: string }
  | { key: string; source: 'secret'; project: string; name: string; value?: string };

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables Pane always sets itself, so a project cannot define them. */
export function isReservedProjectEnvKey(key: string): boolean {
  return key === 'PATH' || key === 'WORKTREE_PATH' || key.startsWith('PANE_');
}

/** Why `key` cannot be used, or null when it can. */
export function projectEnvKeyProblem(key: string): string | null {
  if (!key) return 'Every variable needs a name.';
  if (!KEY_PATTERN.test(key)) return `"${key}" is not a valid variable name: use letters, digits and underscores, not starting with a digit.`;
  if (isReservedProjectEnvKey(key)) return `${key} is set by Pane itself (PATH, WORKTREE_PATH and PANE_* are reserved).`;
  return null;
}
