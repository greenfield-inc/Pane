import { describe, expect, it } from 'vitest';
import { emptyProjectEnvRow, projectEnvInputsFrom, projectEnvRowProblem, projectEnvRowsFrom, secretProjectFor } from './projectEnvRows';

describe('Project Settings environment variable rows', () => {
  it('keeps using a saved Pane secret unless the user types a new value', () => {
    const rows = projectEnvRowsFrom([
      { key: 'UIVERIFY_API_KEY', source: 'secret', project: 'qa', name: 'UIVERIFY' },
      { key: 'SHARED', source: 'keychain', service: 'conductor', account: 'uiverify' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    expect(projectEnvInputsFrom(rows, 'bloom-mono')).toEqual([
      { key: 'UIVERIFY_API_KEY', source: 'secret', project: 'qa', name: 'UIVERIFY' },
      { key: 'SHARED', source: 'keychain', service: 'conductor', account: 'uiverify' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    const replaced = rows.map(row => row.key === 'UIVERIFY_API_KEY' ? { ...row, secretStored: false, secretValue: 'new' } : row);
    expect(projectEnvInputsFrom(replaced, 'bloom-mono')[0]).toEqual({ key: 'UIVERIFY_API_KEY', source: 'secret', project: 'qa', name: 'UIVERIFY', value: 'new' });
  });

  it("names a new Pane secret after the repo and the variable unless the user picks another", () => {
    const row = { ...emptyProjectEnvRow(), key: 'STRIPE_KEY', source: 'secret' as const, secretValue: 'sk_test' };
    expect(projectEnvInputsFrom([row], 'bloom-mono')).toEqual([{ key: 'STRIPE_KEY', source: 'secret', project: 'bloom-mono', name: 'STRIPE_KEY', value: 'sk_test' }]);
    expect(projectEnvInputsFrom([{ ...row, secretProject: 'stripe', secretName: 'STRIPE_SECRET_KEY' }], 'bloom-mono')[0])
      .toMatchObject({ project: 'stripe', name: 'STRIPE_SECRET_KEY' });
  });

  it('turns a repo name into a valid secret project', () => {
    expect(secretProjectFor('bloom-mono')).toBe('bloom-mono');
    expect(secretProjectFor('My App (fork)')).toBe('My-App-fork');
    expect(secretProjectFor('x'.repeat(80))).toBe('x'.repeat(64));
    expect(secretProjectFor('日本')).toBe('project');
  });

  it('explains rows that cannot be saved', () => {
    const named = (key: string) => ({ ...emptyProjectEnvRow(), key });

    expect(projectEnvRowProblem(named('PANE_PORT'), [])).toMatch(/set by Pane itself/);
    expect(projectEnvRowProblem(named('A'), [named('A')])).toBe('A is defined twice.');
    expect(projectEnvRowProblem({ ...named('A'), source: 'keychain', service: 'svc' }, [])).toMatch(/service and an account/);
    expect(projectEnvRowProblem({ ...named('A'), source: 'secret', secretProject: 'has space' }, [])).toMatch(/not a valid secret project/);
    expect(projectEnvRowProblem({ ...named('A'), source: 'secret', secretName: '1BAD' }, [])).toMatch(/not a valid variable name/);
    expect(projectEnvRowProblem({ ...named('A'), source: 'secret' }, [])).toBeNull();
    expect(projectEnvRowProblem(named('A'), [])).toBeNull();
  });
});
