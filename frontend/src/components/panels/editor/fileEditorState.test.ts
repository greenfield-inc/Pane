import { describe, expect, it } from 'vitest';
import { fileEditorReducer, initialFileEditorState, type FileEditorState } from './fileEditorState';

const file = { name: 'a.ts', path: 'src/a.ts', isDirectory: false };
const image = { name: 'logo.png', path: 'assets/logo.png', isDirectory: false };

function loading(): FileEditorState {
  return fileEditorReducer({ ...initialFileEditorState, error: 'old', gitStatus: 'modified' }, { type: 'load-start' });
}

describe('fileEditorReducer', () => {
  it('load-start clears the previous error and git badge while loading', () => {
    expect(loading()).toMatchObject({ loading: true, error: null, gitStatus: 'clean' });
  });

  it('load-text selects the file with clean content and resets to edit mode', () => {
    const before = { ...loading(), viewMode: 'preview' as const };
    const next = fileEditorReducer(before, { type: 'load-text', file, content: 'hello' });
    expect(next).toMatchObject({
      selectedFile: file,
      fileContent: 'hello',
      originalContent: 'hello',
      viewMode: 'edit',
      loading: false,
      error: null,
    });
  });

  it('load-preview keeps the file selected read-only with no text', () => {
    const next = fileEditorReducer(loading(), { type: 'load-preview', previewKind: 'image', file: image });
    expect(next).toMatchObject({ selectedFile: image, fileContent: '', originalContent: '', loading: false, error: null });
  });

  it('a failed binary read still selects the file so the header shows the error', () => {
    const next = fileEditorReducer(loading(), { type: 'load-preview', previewKind: 'image', file: image, error: 'boom' });
    expect(next).toMatchObject({ selectedFile: image, error: 'boom', loading: false });
  });

  it('a failed text read reports the error without changing the selected file', () => {
    const before = fileEditorReducer(loading(), { type: 'load-text', file, content: 'x' });
    const next = fileEditorReducer(fileEditorReducer(before, { type: 'load-start' }), { type: 'load-failed', message: 'nope' });
    expect(next).toMatchObject({ selectedFile: file, fileContent: 'x', error: 'nope', loading: false });
  });

  it('edit changes the content only; saved rebaselines the original', () => {
    const opened = fileEditorReducer(loading(), { type: 'load-text', file, content: 'a' });
    const edited = fileEditorReducer(opened, { type: 'edit', content: 'ab' });
    expect(edited).toMatchObject({ fileContent: 'ab', originalContent: 'a' });
    const saved = fileEditorReducer(edited, { type: 'saved', content: 'ab' });
    expect(saved).toMatchObject({ fileContent: 'ab', originalContent: 'ab' });
  });

  it('error, git-status and view-mode are independent fields', () => {
    let state = fileEditorReducer(loading(), { type: 'load-text', file, content: 'a' });
    state = fileEditorReducer(state, { type: 'error', message: 'save failed' });
    state = fileEditorReducer(state, { type: 'git-status', status: 'untracked' });
    state = fileEditorReducer(state, { type: 'view-mode', mode: 'preview' });
    expect(state).toMatchObject({ error: 'save failed', gitStatus: 'untracked', viewMode: 'preview', fileContent: 'a' });
    expect(fileEditorReducer(state, { type: 'error', message: null }).error).toBeNull();
  });
});
