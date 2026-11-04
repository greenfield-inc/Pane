import { describe, expect, it } from 'vitest';
import { dropOrder, stepOrder } from './sessionReorder';

describe('dropOrder', () => {
  it('puts the dragged Session before the row it is dropped on', () => {
    expect(dropOrder(['a', 'b', 'c', 'd'], 'd', { targetId: 'b', edge: 'before' })).toEqual(['a', 'd', 'b', 'c']);
  });

  it('puts the dragged Session after the row it is dropped on', () => {
    expect(dropOrder(['a', 'b', 'c', 'd'], 'a', { targetId: 'c', edge: 'after' })).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns null when the drop leaves the order as it was', () => {
    expect(dropOrder(['a', 'b', 'c'], 'b', { targetId: 'c', edge: 'before' })).toBeNull();
    expect(dropOrder(['a', 'b', 'c'], 'b', { targetId: 'b', edge: 'after' })).toBeNull();
  });

  it('returns null when either Session is not in the list', () => {
    expect(dropOrder(['a', 'b'], 'x', { targetId: 'a', edge: 'before' })).toBeNull();
    expect(dropOrder(['a', 'b'], 'a', { targetId: 'x', edge: 'before' })).toBeNull();
  });
});

describe('stepOrder', () => {
  it('moves a Session one place down or up', () => {
    expect(stepOrder(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(stepOrder(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
  });

  it('returns null at either end of the list', () => {
    expect(stepOrder(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(stepOrder(['a', 'b', 'c'], 'c', 1)).toBeNull();
  });
});
