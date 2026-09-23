import { describe, expect, it } from 'vitest';
import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import { buildChangesRows, navigateList, typeAhead } from './changesListModel';

const file = (path: string): ChangedFileSummary => ({ path, kind: 'modified', additions: 1, deletions: 1, isBinary: false });

describe('changes list model', () => {
  it('sorts by path and splits root-level files into an empty dir', () => {
    const rows = buildChangesRows([file('z.ts'), file('a/b/c.ts'), file('x/c.ts')]);

    expect(rows.map(row => row.id)).toEqual(['a/b/c.ts', 'x/c.ts', 'z.ts']);
    expect(rows.map(row => row.dir)).toEqual(['a/b/', 'x/', '']);
    expect(rows.map(row => row.name)).toEqual(['c.ts', 'c.ts', 'z.ts']);
  });

  it('keeps the original summary, including previousPath on renames', () => {
    const renamed: ChangedFileSummary = { path: 'a/new.ts', kind: 'renamed', additions: 2, deletions: 0, isBinary: false, previousPath: 'a/old.ts' };
    const rows = buildChangesRows([renamed]);

    expect(rows[0].file).toBe(renamed);
    expect(rows[0].file.previousPath).toBe('a/old.ts');
  });

  it('clamps navigation at both ends and ignores unknown keys', () => {
    const rows = buildChangesRows([file('a.ts'), file('b.ts'), file('c.ts')]);

    expect(navigateList(rows, 0, 'ArrowDown')).toBe(1);
    expect(navigateList(rows, rows.length - 1, 'ArrowDown')).toBe(rows.length - 1);
    expect(navigateList(rows, 0, 'ArrowUp')).toBe(0);
    expect(navigateList(rows, 2, 'Home')).toBe(0);
    expect(navigateList(rows, 0, 'End')).toBe(rows.length - 1);
    expect(navigateList(rows, 1, 'ArrowRight')).toBe(1);
    expect(navigateList([], 0, 'ArrowDown')).toBe(0);
  });

  it('wraps type-ahead around and stays put when nothing matches', () => {
    const rows = buildChangesRows([file('a/one.ts'), file('b/two.ts')]);

    expect(typeAhead(rows, rows.length - 1, 'o')).toBe(0);
    expect(typeAhead(rows, 0, 't')).toBe(1);
    expect(typeAhead(rows, 1, 'zz')).toBe(1);
    expect(typeAhead(rows, 1, '')).toBe(1);
  });
});
