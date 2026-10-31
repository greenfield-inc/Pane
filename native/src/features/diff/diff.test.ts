import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { changeBadge, decodeDiffResponse, DiffError, INLINE_PATCH_ROWS, inlinePatch, parsePatch, refreshChanges, versusLabel } from './diff';

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

describe('refreshChanges', () => {
  it('rereads the change list and every open patch of the branch, but not a commit’s patch, which cannot change', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
    let version = 1;
    const reads: string[] = [];
    const watch = (name: string, key: unknown[]) => {
      const observer = new QueryObserver(queryClient, { queryKey: key, queryFn: () => { reads.push(`${name}@${version}`); return Promise.resolve(version); } });
      observer.subscribe(() => {});
      return observer;
    };
    const request = { path: 'src/a.ts' };
    const manifest = watch('manifest', ['studio-mac', 'sessions:get-diff-manifest', 'pane-1', { kind: 'session' }]);
    const branchPatch = watch('branch', ['studio-mac', 'sessions:get-file-diff', 'pane-1', { kind: 'session' }, request]);
    const commitPatch = watch('commit', ['studio-mac', 'sessions:get-file-diff', 'pane-1', { kind: 'commit', hash: 'abc1234' }, request]);
    const otherPane = watch('other', ['studio-mac', 'sessions:get-file-diff', 'pane-2', { kind: 'session' }, request]);
    await vi.waitFor(() => expect([manifest, branchPatch, commitPatch, otherPane].every(observer => observer.getCurrentResult().data === 1)).toBe(true));

    version = 2;
    await refreshChanges(queryClient, 'studio-mac', 'pane-1');
    expect(manifest.getCurrentResult().data).toBe(2);
    expect(branchPatch.getCurrentResult().data).toBe(2);
    expect(commitPatch.getCurrentResult().data).toBe(1);
    expect(otherPane.getCurrentResult().data).toBe(1);
  });
});

describe('inlinePatch', () => {
  it('shows a short patch whole inside the file list', () => {
    const rows = parsePatch('@@ -1 +1 @@\n-a\n+b\n');
    expect(inlinePatch(rows)).toEqual({ rows, hidden: 0 });
  });

  it('shows only the first rows of a long patch inline, and counts the rest for the full view', () => {
    const rows = parsePatch(['@@ -1,20000 +1,20000 @@', ...Array.from({ length: 20_000 }, (_, index) => `+line ${index}`)].join('\n'));
    const inline = inlinePatch(rows);
    expect(inline.rows).toHaveLength(INLINE_PATCH_ROWS);
    expect(inline.hidden).toBe(20_001 - INLINE_PATCH_ROWS);
  });
});
