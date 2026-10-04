import { describe, expect, it } from 'vitest';
import { formatSliceCost, unpricedCursorNote } from './usageMetering';

const priced = { unmeteredMessageCount: 0, costIncomplete: false };
const cursor = { unmeteredMessageCount: 4, costIncomplete: true };
const unpriced = { unmeteredMessageCount: 0, costIncomplete: true };

describe('formatSliceCost', () => {
  it('shows a complete cost as dollars', () => {
    expect(formatSliceCost({ messageCount: 3, unmeteredMessageCount: 0, costIncomplete: false, byModel: [priced] }, 12.5)).toBe('$12.50');
  });

  it('marks known dollars with ~ when the only gap is Cursor messages', () => {
    const slice = { messageCount: 7, unmeteredMessageCount: 4, costIncomplete: true, byModel: [priced, cursor] };
    expect(formatSliceCost(slice, 12.5)).toBe('~$12.50');
    expect(unpricedCursorNote(slice)).toBe('+ 4 Cursor messages, cost not reported');
  });

  it('shows no dollars for a Cursor-only slice', () => {
    const slice = { messageCount: 4, unmeteredMessageCount: 4, costIncomplete: true, byModel: [cursor] };
    expect(formatSliceCost(slice, 0)).toBe('n/a');
  });

  it('shows no dollars when a model also lacks a price', () => {
    const slice = { messageCount: 8, unmeteredMessageCount: 4, costIncomplete: true, byModel: [priced, unpriced, cursor] };
    expect(formatSliceCost(slice, 12.5)).toBe('n/a');
    expect(unpricedCursorNote({ messageCount: 3, unmeteredMessageCount: 0, costIncomplete: false, byModel: [priced] })).toBeNull();
  });
});
