import { describe, expect, it } from 'vitest';

import { decodeFileText, decodeFolder, fileViewer, formatSize, highlightLines, languageOf, pathCrumbs } from './files';

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

  it('reads a file of unknown size as text, which the computer refuses when binary', () => {
    expect(fileViewer('notes.txt', undefined)).toBe('code');
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
