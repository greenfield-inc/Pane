import { describe, expect, it } from 'vitest';

import { changeBadge, decodeDiffResponse, DiffError, parsePatch, versusLabel } from './diff';

describe('parsePatch', () => {
  it('turns a unified patch into hunk, removed, added and unchanged rows, without the file headers', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -4,3 +4,3 @@ export function a() {',
      '-  return 1;',
      '+  return 2;',
      '   // done',
      '\\ No newline at end of file',
    ].join('\n');
    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -4,3 +4,3 @@ export function a() {' },
      { kind: 'removed', text: '-  return 1;' },
      { kind: 'added', text: '+  return 2;' },
      { kind: 'unchanged', text: '   // done' },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('keeps nothing for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('changeBadge', () => {
  it('uses git’s letters', () => {
    expect(changeBadge('modified')).toBe('M');
    expect(changeBadge('added')).toBe('A');
    expect(changeBadge('deleted')).toBe('D');
    expect(changeBadge('renamed')).toBe('R');
  });
});

describe('versusLabel', () => {
  it('names what the branch is compared with', () => {
    expect(versusLabel({ kind: 'comparison-base', ref: 'origin/main', hash: 'abc' })).toBe('vs main');
    expect(versusLabel({ kind: 'commit', hash: 'abcdef1234' })).toBe('vs abcdef1');
    expect(versusLabel({ kind: 'empty-tree' })).toBe('');
  });
});

describe('decodeDiffResponse', () => {
  it('returns the data, or throws the computer’s reason with its code', () => {
    expect(decodeDiffResponse({ success: true, data: { files: [] } })).toEqual({ files: [] });
    let thrown: unknown;
    try {
      decodeDiffResponse({ success: false, error: 'The diff is too large to show', code: 'diff-too-large' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiffError);
    expect(thrown).toMatchObject({ message: 'The diff is too large to show', code: 'diff-too-large' });
  });
});
