import { describe, expect, it } from 'vitest';

import { decodeFileText, decodeFolder, decodeSearch, fileViewer, folderRows, formatSize, highlightLines, languageOf, parentOf, pathCrumbs, posixPath } from './files';

describe('decodeFolder', () => {
  it('reads the computer’s folder list', () => {
    const response = { success: true, files: [{ name: 'src', path: 'src', isDirectory: true }, { name: 'a.ts', path: 'a.ts', isDirectory: false, size: 12, modified: '2026-10-30' }] };
    expect(decodeFolder(response)).toEqual([
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'a.ts', path: 'a.ts', isDirectory: false, size: 12 },
    ]);
  });

  it('throws the computer’s reason when it refuses', () => {
    expect(() => decodeFolder({ success: false, error: 'Cannot list files for archived session' })).toThrow('Cannot list files for archived session');
  });
});

describe('Windows paths', () => {
  it('reads a Windows computer’s folder list and search matches with `/`, so folders and parents line up', () => {
    const [entry] = decodeFolder({ success: true, files: [{ name: 'file.ts', path: 'src\\checkout\\file.ts', isDirectory: false, size: 12 }] });
    expect(entry.path).toBe('src/checkout/file.ts');
    expect(parentOf(entry.path)).toBe('src/checkout');
    expect(pathCrumbs('acme-web', parentOf(entry.path)).map(crumb => crumb.path)).toEqual(['', 'src', 'src/checkout']);
    expect(decodeSearch({ success: true, files: [{ path: 'src\\checkout\\file.ts', isDirectory: false }] })).toEqual([
      { name: 'file.ts', path: 'src/checkout/file.ts', isDirectory: false },
    ]);
  });

  it('reads an Editor tab’s Windows path the same way', () => {
    expect(posixPath('src\\checkout\\file.ts')).toBe('src/checkout/file.ts');
    expect(posixPath('src/checkout/file.ts')).toBe('src/checkout/file.ts');
  });
});

describe('decodeFileText', () => {
  it('returns the text, or marks a binary file', () => {
    expect(decodeFileText({ success: true, content: 'hi' })).toEqual({ kind: 'text', content: 'hi' });
    expect(decodeFileText({ success: false, binary: true, error: 'Binary files cannot be edited as text' })).toEqual({ kind: 'binary' });
    expect(() => decodeFileText({ success: false, error: 'File path is outside worktree' })).toThrow('File path is outside worktree');
  });
});

describe('fileViewer', () => {
  it('reads code and Markdown as text, and images as pictures', () => {
    expect(fileViewer('src/submitOrder.ts', 5_000)).toBe('code');
    expect(fileViewer('README.md', 4_000)).toBe('markdown');
    expect(fileViewer('public/logo.png', 200_000)).toBe('image');
  });

  it('keeps files over 1 MB and binaries other than images on the computer', () => {
    expect(fileViewer('dist/app.min.js', 3_400_000)).toBe('stays');
    expect(fileViewer('release.zip', 10)).toBe('stays');
    expect(fileViewer('docs/spec.pdf', 10)).toBe('stays');
    expect(fileViewer('photo.png', 9_000_000)).toBe('stays');
  });

  it('reads nothing while a text file or image has no known size, since it could be any size', () => {
    expect(fileViewer('notes.txt', undefined)).toBe('unsized');
    expect(fileViewer('README.md', undefined)).toBe('unsized');
    expect(fileViewer('public/logo.png', undefined)).toBe('unsized');
    expect(fileViewer('release.zip', undefined)).toBe('stays');
  });
});

describe('formatSize', () => {
  it('rounds the way the Explorer rows show it', () => {
    expect(formatSize(400)).toBe('0.4 KB');
    expect(formatSize(41)).toBe('0.1 KB');
    expect(formatSize(2_048)).toBe('2 KB');
    expect(formatSize(3_565_158)).toBe('3.4 MB');
  });
});

describe('pathCrumbs', () => {
  it('names the worktree, then each folder with the path that opens it', () => {
    expect(pathCrumbs('acme-web', 'src/checkout')).toEqual([
      { name: 'acme-web', path: '' },
      { name: 'src', path: 'src' },
      { name: 'checkout', path: 'src/checkout' },
    ]);
    expect(pathCrumbs('acme-web', '')).toEqual([{ name: 'acme-web', path: '' }]);
  });
});

describe('languageOf', () => {
  it('names the language for the footer and the highlighter', () => {
    expect(languageOf('src/a.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(languageOf('Makefile')).toEqual({ id: null, label: 'Text' });
  });
});

describe('highlightLines', () => {
  it('splits highlighted code into lines of tokens, a scope on each highlighted one', () => {
    expect(highlightLines('const a = 1;\n// done', 'typescript')).toEqual([
      [{ text: 'const', scope: 'keyword' }, { text: ' a = ' }, { text: '1', scope: 'number' }, { text: ';' }],
      [{ text: '// done', scope: 'comment' }],
    ]);
  });

  it('keeps plain text as one token per line', () => {
    expect(highlightLines('a < b\n\nc', null)).toEqual([[{ text: 'a < b' }], [], [{ text: 'c' }]]);
  });
});

describe('folderRows', () => {
  const src = { name: 'src', path: 'src', isDirectory: true };
  const readme = { name: 'README.md', path: 'README.md', isDirectory: false, size: 10 };
  const change = (path: string, kind: 'modified' | 'deleted') => ({ path, kind, additions: 1, deletions: 0, isBinary: false });

  it('lists the branch’s changes first at the worktree’s top, each as its own row, then all files', () => {
    const rows = folderRows([src, readme], [change('src/a.ts', 'modified'), change('old.ts', 'deleted')], { atTop: true, searching: false });
    expect(rows.map(row => row.kind === 'label' ? row.text : row.kind === 'changed' ? `changed:${row.file.path}` : `entry:${row.entry.path}`)).toEqual([
      'Changed on this branch · 2', 'changed:src/a.ts', 'changed:old.ts', 'All files', 'entry:src', 'entry:README.md',
    ]);
  });

  it('still lists the changes when the folder is empty, as when its last file was deleted', () => {
    const rows = folderRows([], [change('old.ts', 'deleted')], { atTop: true, searching: false });
    expect(rows.map(row => row.kind)).toEqual(['label', 'changed']);
  });

  it('lists only the entries inside a folder or while searching', () => {
    expect(folderRows([readme], [change('README.md', 'modified')], { atTop: false, searching: false }).map(row => row.kind)).toEqual(['entry']);
    expect(folderRows([readme], [change('README.md', 'modified')], { atTop: true, searching: true }).map(row => row.kind)).toEqual(['entry']);
    expect(folderRows([], [], { atTop: true, searching: false })).toEqual([]);
  });
});
