import { describe, expect, it } from 'vitest';
import { emptyProjectEnvRow, projectEnvInputsFrom, projectEnvRowProblem, projectEnvRowsFrom } from './projectEnvRows';

describe('Project Settings environment variable rows', () => {
  it('keeps a saved Pane keychain item unless the user types a new secret', () => {
    const rows = projectEnvRowsFrom([
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: '2:UIVERIFY_API_KEY', managed: true },
      { key: 'SHARED', source: 'keychain', service: 'conductor', account: 'uiverify', managed: false },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    expect(rows.map(row => row.keychainMode)).toEqual(['stored', 'reference', 'secret']);
    expect(projectEnvInputsFrom(rows)).toEqual([
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: '2:UIVERIFY_API_KEY' },
      { key: 'SHARED', source: 'keychain', service: 'conductor', account: 'uiverify' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    const replaced = rows.map(row => row.key === 'UIVERIFY_API_KEY' ? { ...row, keychainMode: 'secret' as const, secret: 'new' } : row);
    expect(projectEnvInputsFrom(replaced)[0]).toEqual({ key: 'UIVERIFY_API_KEY', source: 'keychain', secret: 'new' });
  });

  it('explains rows that cannot be saved', () => {
    const named = (key: string) => ({ ...emptyProjectEnvRow(), key });

    expect(projectEnvRowProblem(named('PANE_PORT'), [])).toMatch(/set by Pane itself/);
    expect(projectEnvRowProblem(named('A'), [named('A')])).toBe('A is defined twice.');
    expect(projectEnvRowProblem({ ...named('A'), source: 'keychain', keychainMode: 'secret' }, [])).toBe('Type the secret value for A.');
    expect(projectEnvRowProblem({ ...named('A'), source: 'keychain', keychainMode: 'reference', service: 'svc' }, [])).toMatch(/service and an account/);
    expect(projectEnvRowProblem(named('A'), [])).toBeNull();
  });
});
