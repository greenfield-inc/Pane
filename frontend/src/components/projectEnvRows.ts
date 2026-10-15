import {
  projectEnvKeyProblem,
  type ProjectEnvVar,
  type ProjectEnvVarInput,
} from '../../../shared/types/projectEnvVars';

/**
 * One editable row in Project Settings → Environment Variables.
 * - `plain`: `value` is the variable's text.
 * - `keychain` + `stored`: keep the saved item (`service`/`account`); its value is never shown.
 * - `keychain` + `secret`: Pane stores `secret` in its own keychain item on save.
 * - `keychain` + `reference`: use an existing item named by `service` and `account`.
 */
export interface ProjectEnvRow {
  id: string;
  key: string;
  source: 'plain' | 'keychain';
  value: string;
  keychainMode: 'stored' | 'secret' | 'reference';
  secret: string;
  service: string;
  account: string;
}

let nextRowId = 0;
function rowId(): string {
  nextRowId += 1;
  return `env-row-${nextRowId}`;
}

export function emptyProjectEnvRow(): ProjectEnvRow {
  return { id: rowId(), key: '', source: 'plain', value: '', keychainMode: 'secret', secret: '', service: '', account: '' };
}

export function projectEnvRowsFrom(variables: readonly ProjectEnvVar[]): ProjectEnvRow[] {
  return variables.map(variable => variable.source === 'plain'
    ? { ...emptyProjectEnvRow(), key: variable.key, value: variable.value }
    : {
        ...emptyProjectEnvRow(),
        key: variable.key,
        source: 'keychain',
        keychainMode: variable.managed ? 'stored' : 'reference',
        service: variable.service,
        account: variable.account,
      });
}

/** Why this row cannot be saved, or null. `others` are the rows before it, to catch duplicates. */
export function projectEnvRowProblem(row: ProjectEnvRow, others: readonly ProjectEnvRow[]): string | null {
  const key = row.key.trim();
  const keyProblem = projectEnvKeyProblem(key);
  if (keyProblem) return keyProblem;
  if (others.some(other => other.key.trim() === key)) return `${key} is defined twice.`;
  if (row.source === 'keychain' && row.keychainMode === 'secret' && !row.secret) return `Type the secret value for ${key}.`;
  if (row.source === 'keychain' && row.keychainMode === 'reference' && (!row.service.trim() || !row.account.trim())) {
    return `${key} needs both a keychain service and an account.`;
  }
  return null;
}

/** What Project Settings sends to main on save. */
export function projectEnvInputsFrom(rows: readonly ProjectEnvRow[]): ProjectEnvVarInput[] {
  return rows.map((row): ProjectEnvVarInput => {
    const key = row.key.trim();
    if (row.source === 'plain') return { key, source: 'plain', value: row.value };
    if (row.keychainMode === 'secret') return { key, source: 'keychain', secret: row.secret };
    return { key, source: 'keychain', service: row.service.trim(), account: row.account.trim() };
  });
}
