import { expect, it } from 'vitest';

import { ComposerCursor } from './composerCursor';

it('keeps delayed insertion and selection events in their original view', () => {
  const origin = new ComposerCursor();
  const active = new ComposerCursor();
  active.select({ start: 5, end: 13 });
  expect(origin.insert('send A', 'A clipboard').text).toBe('send A A clipboard ');
  origin.select({ start: 0, end: 2 });
  expect(active.insert('left selected right', 'B paste').text).toBe('left B paste right');
});

it('starts a reopened view at the end without reviving a previous selection', () => {
  const previous = new ComposerCursor();
  previous.select({ start: 5, end: 13 });
  const reopened = new ComposerCursor();
  previous.select({ start: 0, end: 4 });
  expect(reopened.insert('left selected right', 'paste').text).toBe('left selected right paste ');
});

it('advances consecutive inserts before a render and resets after clearing', () => {
  const cursor = new ComposerCursor();
  cursor.select({ start: 5, end: 10 });
  const first = cursor.insert('left right', 'first');
  expect(cursor.insert(first.text, 'second').text).toBe('left first second ');
  cursor.select(null);
  expect(cursor.insert('', 'new').text).toBe('new ');
});
