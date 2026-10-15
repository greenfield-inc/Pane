/**
 * Per-project environment variables. Pane sets them in every terminal, agent and
 * setup/run/archive script it starts for a Pane of that project.
 *
 * A keychain variable holds only a reference (service + account) to a macOS
 * keychain generic-password item; its value is read when a process starts and is
 * never stored by Pane or sent to the renderer.
 */

/** A stored variable as main and the renderer see it. Never carries a secret value. */
export type ProjectEnvVar =
  | { key: string; source: 'plain'; value: string }
  | {
      key: string;
      source: 'keychain';
      service: string;
      account: string;
      /** True when Pane created the item from a typed secret, so Pane deletes it when no variable uses it. */
      managed: boolean;
    };

/**
 * What the renderer sends to save a variable. A keychain variable either references
 * an existing item (`service` + `account`) or carries a new `secret`, which main
 * writes to Pane's own keychain item and drops.
 */
export type ProjectEnvVarInput =
  | { key: string; source: 'plain'; value: string }
  | { key: string; source: 'keychain'; service: string; account: string }
  | { key: string; source: 'keychain'; secret: string };

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
