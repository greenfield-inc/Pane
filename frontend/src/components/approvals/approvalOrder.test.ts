import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { approvalListedAt, nextAfterAnswer, newestFirst, placeAnswered } from '../../../../shared/approvalOrder';

const item = (id: string, createdAt: number, extra: Partial<NotifyItem> = {}): NotifyItem => ({
  id, title: id, ui: 'options', source: { name: 'agent', agent: 'Claude' }, state: 'waiting', createdAt, ...extra,
});

describe('newest first (T-88)', () => {
  it('puts the most recently asked approval first', () => {
    const list = [item('a', 1_000), item('c', 3_000), item('b', 2_000)].sort(newestFirst);
    expect(list.map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
  });

  it('lists an updated approval by when its latest version was asked', () => {
    const updated = item('old', 1_000, { version: 2, revision: { asked: 'why?', whatChanged: ['reworded'], by: 'agent', at: 5_000 } });
    const list = [item('new', 3_000), updated].sort(newestFirst);
    expect(list.map((entry) => entry.id)).toEqual(['old', 'new']);
    expect(approvalListedAt(updated)).toBe(5_000);
  });

  it('lists a reopened approval by when it was reopened', () => {
    const reopened = item('back', 1_000, { reopened: { by: 'you', at: 4_000, closedBy: 'pane', closedReason: 'asker stopped' } });
    expect([item('new', 3_000), reopened].sort(newestFirst).map((entry) => entry.id)).toEqual(['back', 'new']);
  });

  it('keeps approvals asked in the same millisecond in one order', () => {
    const forward = [item('b', 1_000), item('a', 1_000)].sort(newestFirst).map((entry) => entry.id);
    const backward = [item('a', 1_000), item('b', 1_000)].sort(newestFirst).map((entry) => entry.id);
    expect(forward).toEqual(backward);
  });
});

describe('the approval after the one just answered (T-88)', () => {
  it('is the next one down the list', () => {
    expect(nextAfterAnswer(['c', 'b', 'a'], 'c')).toBe('b');
    expect(nextAfterAnswer(['c', 'b', 'a'], 'b')).toBe('a');
  });

  it('is the one above when the answered one was last', () => {
    expect(nextAfterAnswer(['c', 'b', 'a'], 'a')).toBe('b');
  });

  it('is none when it was the only one', () => {
    expect(nextAfterAnswer(['a'], 'a')).toBeUndefined();
  });

  it('skips the ones that no longer wait', () => {
    expect(nextAfterAnswer(['d', 'c', 'b', 'a'], 'c', (id) => id !== 'b')).toBe('a');
    expect(nextAfterAnswer(['c', 'b', 'a'], 'c', () => false)).toBeUndefined();
  });

  it('is the top of the list when the answered one already left it', () => {
    expect(nextAfterAnswer(['c', 'b'], 'gone')).toBe('c');
  });
});

describe('the answered card\'s place in the current order (review S-2)', () => {
  it('keeps the current order when the card is still listed', () => {
    expect(placeAnswered(['c', 'a', 'b'], ['a', 'b'], 'a')).toEqual(['c', 'a', 'b']);
  });

  it('puts it back after the nearest card that was above it and still is', () => {
    expect(placeAnswered(['x', 'b', 'd'], ['b', 'a', 'd'], 'a')).toEqual(['x', 'b', 'a', 'd']);
  });

  it('puts it first when nothing above it is still listed', () => {
    expect(placeAnswered(['c', 'd'], ['a', 'b'], 'a')).toEqual(['a', 'c', 'd']);
  });
});
