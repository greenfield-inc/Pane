import { describe, expect, it } from 'vitest';
import { explorerOpenAction } from './htmlFile';

describe('explorerOpenAction', () => {
  const click = { clickCount: 1, doubleClick: false };

  it('previews HTML on a click under the Preview setting', () => {
    expect(explorerOpenAction('site/index.html', 'preview', click)).toBe('preview');
    expect(explorerOpenAction('legacy.HTM', 'preview', { clickCount: 0, doubleClick: false })).toBe('preview');
  });

  it('opens one tab per double-click: the second click and the dblclick add nothing', () => {
    const gesture = [click, { clickCount: 2, doubleClick: false }, { clickCount: 2, doubleClick: true }];
    expect(gesture.map(step => explorerOpenAction('index.html', 'preview', step))).toEqual(['preview', 'none', 'none']);
  });

  it('opens editable source under the Edit source setting', () => {
    expect(explorerOpenAction('index.html', 'source', click)).toBe('editor');
    expect(explorerOpenAction('index.html', 'source', { clickCount: 2, doubleClick: true })).toBe('editor');
  });

  it('leaves other files in the editor', () => {
    expect(explorerOpenAction('app.ts', 'preview', click)).toBe('editor');
  });
});
