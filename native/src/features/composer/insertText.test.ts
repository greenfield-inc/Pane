import { describe, expect, it } from 'vitest';

import { insertAtSelection } from './insertText';

describe('insertAtSelection', () => {
  it('puts a path at the cursor with a space on each side', () => {
    expect(insertAtSelection('look at  please', { start: 8, end: 8 }, '/tmp/a.png'))
      .toEqual({ text: 'look at /tmp/a.png please', cursor: 19 });
  });

  it('adds the missing spaces around words', () => {
    expect(insertAtSelection('see:done', { start: 4, end: 4 }, '/tmp/a.png'))
      .toEqual({ text: 'see: /tmp/a.png done', cursor: 16 });
  });

  it('replaces a selection', () => {
    expect(insertAtSelection('fix THIS now', { start: 4, end: 8 }, 'that'))
      .toEqual({ text: 'fix that now', cursor: 9 });
  });

  it('starts an empty draft without a leading space and leaves one after', () => {
    expect(insertAtSelection('', { start: 0, end: 0 }, '/tmp/a.png'))
      .toEqual({ text: '/tmp/a.png ', cursor: 11 });
  });

  it('appends at the end when the selection is unknown', () => {
    expect(insertAtSelection('hello', null, 'world'))
      .toEqual({ text: 'hello world ', cursor: 12 });
  });
});
