import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorStateWriter } from './editorStateWriter';

describe('editor state writer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes a newly dirty editor at once, so a close never sees it as clean', () => {
    const write = vi.fn();
    const writer = createEditorStateWriter(write, 500);

    writer.update('panel', 'session', { isDirty: true });

    expect(write).toHaveBeenCalledWith('panel', 'session', { isDirty: true });
  });

  it('debounces a tab that is already dirty, so typing writes once per wait rather than per keystroke', () => {
    const write = vi.fn();
    const writer = createEditorStateWriter(write, 500);

    writer.update('panel', 'session', { isDirty: true });
    writer.update('panel', 'session', { isDirty: true });
    writer.update('panel', 'session', { isDirty: true, cursorPosition: { line: 2, column: 4 } });
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('panel', 'session', { isDirty: true, cursorPosition: { line: 2, column: 4 } });

    // Saved and written clean, then edited again: the tab turns dirty once more and is written at once.
    writer.update('panel', 'session', { isDirty: false });
    vi.advanceTimersByTime(500);
    writer.update('panel', 'session', { isDirty: true });
    expect(write).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenLastCalledWith('panel', 'session', { isDirty: true });
  });

  it('keeps a pending dirty flag when a cursor or scroll update follows it', () => {
    const write = vi.fn();
    const writer = createEditorStateWriter(write, 500);

    writer.update('panel', 'session', { isDirty: false });
    writer.update('panel', 'session', { cursorPosition: { line: 3, column: 1 } });
    vi.advanceTimersByTime(500);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('panel', 'session', { isDirty: false, cursorPosition: { line: 3, column: 1 } });
  });

  it('debounces everything else and flushes it on demand', () => {
    const write = vi.fn();
    const writer = createEditorStateWriter(write, 500);

    writer.update('panel', 'session', { scrollPosition: 10 });
    writer.update('panel', 'session', { scrollPosition: 20 });
    expect(write).not.toHaveBeenCalled();
    writer.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('panel', 'session', { scrollPosition: 20 });
  });

  it('drops queued state when cancelled', () => {
    const write = vi.fn();
    const writer = createEditorStateWriter(write, 500);

    writer.update('panel', 'session', { scrollPosition: 10 });
    writer.cancel();
    vi.advanceTimersByTime(500);

    expect(write).not.toHaveBeenCalled();
  });
});
