import {
  projectEnvKeyProblem,
  type ProjectEnvVar,
  type ProjectEnvVarInput,
} from '../../../shared/types/projectEnvVars';
import { paneSecretNameProblem, paneSecretProjectProblem } from '../../../shared/types/paneSecrets';

/**
 * One editable row in Project Settings → Environment Variables.
 * - `plain`: `value` is the variable's text.
 * - `secret`: the Pane secret `secretProject/secretName`. Empty fields fall back to the
 *   repo's secret project and the variable's own name. A typed `secretValue` creates or
 *   replaces that secret on save; left empty, the row uses the saved one.
 *   `secretStored` marks a saved row, shown masked until Replace.
 * - `keychain`: an existing macOS keychain item named by `service` and `account`.
 */
export interface ProjectEnvRow {
  id: string;
  key: string;
  source: 'plain' | 'secret' | 'keychain';
  value: string;
  secretProject: string;
  secretName: string;
  secretValue: string;
  secretStored: boolean;
  service: string;
  account: string;
}

let nextRowId = 0;
function rowId(): string {
  nextRowId += 1;
  return `env-row-${nextRowId}`;
}

export function emptyProjectEnvRow(): ProjectEnvRow {
  return { id: rowId(), key: '', source: 'plain', value: '', secretProject: '', secretName: '', secretValue: '', secretStored: false, service: '', account: '' };
}

/** A repo name as a secret project: letters, digits, ".", "_" and "-", up to 64. */
export function secretProjectFor(repoName: string): string {
  const project = repoName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return project || 'project';
}

/** The Pane secret a row points at, with its defaults filled in. */
export function rowSecretAddress(row: ProjectEnvRow, defaultProject: string) {
  return { project: row.secretProject.trim() || defaultProject, name: row.secretName.trim() || row.key.trim() };
}

export function projectEnvRowsFrom(variables: readonly ProjectEnvVar[]): ProjectEnvRow[] {
  return variables.map((variable): ProjectEnvRow => {
    const row = { ...emptyProjectEnvRow(), key: variable.key };
    if (variable.source === 'plain') return { ...row, value: variable.value };
    if (variable.source === 'secret') return { ...row, source: 'secret', secretProject: variable.project, secretName: variable.name, secretStored: true };
    return { ...row, source: 'keychain', service: variable.service, account: variable.account };
  });
}

/** Why this row cannot be saved, or null. `others` are the rows before it, to catch duplicates. */
export function projectEnvRowProblem(row: ProjectEnvRow, others: readonly ProjectEnvRow[]): string | null {
  const key = row.key.trim();
  const keyProblem = projectEnvKeyProblem(key);
  if (keyProblem) return keyProblem;
  if (others.some(other => other.key.trim() === key)) return `${key} is defined twice.`;
  if (row.source === 'secret') {
    const project = row.secretProject.trim();
    const name = row.secretName.trim();
    return (project && paneSecretProjectProblem(project)) || (name && paneSecretNameProblem(name)) || null;
  }
  if (row.source === 'keychain' && (!row.service.trim() || !row.account.trim())) {
    return `${key} needs both a keychain service and an account.`;
  }
  return null;
}

/** What Project Settings sends to main on save. */
export function projectEnvInputsFrom(rows: readonly ProjectEnvRow[], defaultProject: string): ProjectEnvVarInput[] {
  return rows.map((row): ProjectEnvVarInput => {
    const key = row.key.trim();
    if (row.source === 'plain') return { key, source: 'plain', value: row.value };
    if (row.source === 'secret') {
      const address = rowSecretAddress(row, defaultProject);
      return row.secretValue ? { key, source: 'secret', ...address, value: row.secretValue } : { key, source: 'secret', ...address };
    }
    return { key, source: 'keychain', service: row.service.trim(), account: row.account.trim() };
  });
}
