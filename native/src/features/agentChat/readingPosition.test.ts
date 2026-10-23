import { expect, it } from 'vitest';
import { captureReadingPosition, resolveReadingPosition } from './readingPosition';

const layout = (scroll = 1076) => ({ data: [{ id: 'first' }, { id: 'reading' }, { id: 'last' }], start: 1, scroll, scrollLength: 500, contentLength: 3000, positionAtIndex: () => 1000, sizeAtIndex: () => 400 });

it('restores the same partially visible message when prefix heights and message order change', () => {
  const saved = captureReadingPosition('conversation', layout(), true)!;
  expect(saved.anchor).toEqual({ messageId: 'reading', withinItemOffset: 60, fallbackIndex: 1 });
  const restored = resolveReadingPosition(saved, 'conversation', [{ id: 'new' }, { id: 'first' }, { id: 'reading' }, { id: 'last' }]);
  expect(restored).toEqual({ atBottom: false, index: { index: 2, viewPosition: 0, viewOffset: -60 } });
  // Re-estimated prefix is now600 instead of1000; keep60 units inside the row.
  expect(600 + 16 - restored.index!.viewOffset).toBe(676);
});

it('preserves leading padding and explicitly top-aligns a last-item history anchor', () => {
  const saved = captureReadingPosition('conversation', layout(1000), true)!;
  expect(resolveReadingPosition(saved, 'conversation', [{ id: 'reading' }]).index).toEqual({ index: 0, viewPosition: 0, viewOffset: 16 });
});

it('does not save unready, empty or unmeasured geometry and isolates conversation identities', () => {
  expect(captureReadingPosition('conversation', layout(), false)).toBeUndefined();
  expect(captureReadingPosition('conversation', { ...layout(), data: [] }, true)).toBeUndefined();
  expect(captureReadingPosition('conversation', { ...layout(), sizeAtIndex: () => NaN }, true)).toBeUndefined();
  const saved = captureReadingPosition('conversation', layout(), true)!;
  expect(resolveReadingPosition(saved, 'other', [{ id: 'reading' }])).toEqual({ atBottom: true });
  expect(resolveReadingPosition(saved, 'conversation', [{ id: 'replacement' }]).index).toEqual({ index: 0, viewPosition: 0, viewOffset: 0 });
  expect(resolveReadingPosition(saved, 'conversation', []).index).toBeUndefined();
});

it('saves explicit latest navigation and clamps a resized anchor to measured content', () => {
  expect(captureReadingPosition('conversation', { ...layout(2500), start: 2, positionAtIndex: () => 2400 }, true)?.atBottom).toBe(true);
  expect(captureReadingPosition('conversation', { ...layout(), sizeAtIndex: () => 20 }, true)?.anchor?.withinItemOffset).toBe(19);
});
