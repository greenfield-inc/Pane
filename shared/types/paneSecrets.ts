/**
 * Pane secrets: named values any agent on the person's hosts can use through
 * `runpane secrets exec`, addressed as `<project>/<NAME>`. Every saved host keeps
 * a copy; values live only in the host's OS store, never in config.json.
 */
import { projectEnvKeyProblem } from './projectEnvVars';

/** A secret as lists show it. Never carries a value. */
export interface PaneSecretSummary {
  project: string;
  name: string;
  /** ISO time it was last set, on the host where that happened. */
  updatedAt: string;
  /** Name of the host where it was last set. */
  machine: string;
}

/** Where this host keeps secret values. */
export interface PaneSecretStorage {
  kind: 'keychain' | 'file';
  /** False only for the file store on a host without an OS keyring: values sit in a 0600 file as plain text. */
  encrypted: boolean;
}

const PROJECT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Why `project` cannot name a secret project, or null when it can. */
export function paneSecretProjectProblem(project: string): string | null {
  if (!project) return 'A secret needs a project.';
  if (!PROJECT_PATTERN.test(project)) return `"${project}" is not a valid secret project: use up to 64 letters, digits, ".", "_" or "-".`;
  return null;
}

/** Why `name` cannot name a secret, or null when it can. Secrets follow environment-variable rules so `exec` injects them as-is. */
export function paneSecretNameProblem(name: string): string | null {
  return projectEnvKeyProblem(name);
}

/** The address `<project>/<NAME>`, used as the sync and index key. */
export function paneSecretKey(project: string, name: string): string {
  return `${project}/${name}`;
}

export function parsePaneSecretKey(key: string): { project: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const project = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return paneSecretProjectProblem(project) || paneSecretNameProblem(name) ? null : { project, name };
}
