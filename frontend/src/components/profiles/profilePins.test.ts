import { describe, expect, it } from 'vitest';
import { isPinned, pinnedFirst, toggledPins } from './profilePins';

describe('profile pins', () => {
  it('adds a pin at the end and removes it again, ignoring a variant', () => {
    expect(toggledPins(['a/x'], 'b/y:fast')).toEqual(['a/x', 'b/y']);
    expect(toggledPins(['a/x', 'b/y'], 'a/x')).toEqual(['b/y']);
    expect(isPinned(['b/y'], 'b/y:fast')).toBe(true);
  });

  it('puts pinned items first in pin order, keeping the rest in their order', () => {
    const items = ['a/1', 'agent', 'b/2', 'c/3', 'd/4'];
    expect(pinnedFirst(items, ['c/3', 'a/1'], item => (item.includes('/') ? item : undefined))).toEqual(['c/3', 'a/1', 'agent', 'b/2', 'd/4']);
  });
});
