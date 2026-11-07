import { describe, expect, it } from 'vitest';
import type { AutopilotStack, AutopilotStackEntry } from '../../../../shared/types/autopilot';
import { pushEntry, resolveEntries, stepStack, showEntry, shownEntry, stackPosition } from './autopilotStack';

const entry = (id: string, extra: Partial<AutopilotStackEntry> = {}): AutopilotStackEntry => ({
  id,
  ref: { kind: 'item', notifyId: `n-${id}` },
  title: `Item ${id}`,
  tabs: [{ kind: 'item', label: 'Approval', notifyId: `n-${id}` }],
  addedAt: 1,
  ...extra,
});

const empty: AutopilotStack = { entries: [], shownId: null };

describe('Autopilot stack', () => {
  it('shows the first entry pushed onto an empty stack', () => {
    const stack = pushEntry(empty, entry('a'));
    expect(shownEntry(stack)?.id).toBe('a');
  });

  it('keeps the shown entry when more arrive: they wait off-screen (D-71)', () => {
    let stack = pushEntry(empty, entry('a'));
    stack = pushEntry(stack, entry('b'));
    stack = pushEntry(stack, entry('c'));
    expect(shownEntry(stack)?.id).toBe('a');
    expect(stack.entries.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('brings up the next waiting entry when the shown one is resolved', () => {
    let stack = pushEntry(pushEntry(pushEntry(empty, entry('a')), entry('b')), entry('c'));
    stack = resolveEntries(stack, new Set(['a']), 50);
    expect(shownEntry(stack)?.id).toBe('b');
    expect(stack.entries.find(e => e.id === 'a')?.doneAt).toBe(50);
  });

  it('does not move the person when an entry they are not looking at resolves', () => {
    let stack = pushEntry(pushEntry(pushEntry(empty, entry('a')), entry('b')), entry('c'));
    stack = resolveEntries(stack, new Set(['b']), 50);
    expect(shownEntry(stack)?.id).toBe('a');
    stack = resolveEntries(stack, new Set(['a']), 60);
    expect(shownEntry(stack)?.id).toBe('c');
  });

  it('stays on the last resolved entry when nothing else waits', () => {
    let stack = pushEntry(empty, entry('a'));
    stack = resolveEntries(stack, new Set(['a']), 50);
    expect(shownEntry(stack)?.id).toBe('a');
  });

  it('shows a newly pushed entry when everything on the stack is resolved', () => {
    let stack = resolveEntries(pushEntry(empty, entry('a')), new Set(['a']), 50);
    stack = pushEntry(stack, entry('b'));
    expect(shownEntry(stack)?.id).toBe('b');
  });

  it('steps back and forth through every entry, resolved or not', () => {
    let stack = pushEntry(pushEntry(pushEntry(empty, entry('a')), entry('b')), entry('c'));
    stack = stepStack(stack, 1);
    expect(shownEntry(stack)?.id).toBe('b');
    stack = stepStack(stack, 1);
    stack = stepStack(stack, 1);
    expect(shownEntry(stack)?.id).toBe('c');
    stack = stepStack(stack, -1);
    expect(shownEntry(stack)?.id).toBe('b');
    expect(stackPosition(stack)).toEqual({ index: 1, total: 3 });
  });

  it('pushing an item already on the stack refreshes it in place instead of adding it twice', () => {
    let stack = pushEntry(pushEntry(empty, entry('a')), entry('b'));
    stack = pushEntry(stack, entry('x', { ref: { kind: 'item', notifyId: 'n-b' }, title: 'Newer title', note: 'why' }));
    expect(stack.entries.map(e => e.id)).toEqual(['a', 'b']);
    expect(stack.entries[1]).toMatchObject({ title: 'Newer title', note: 'why' });
  });

  it('showEntry jumps to a chosen entry and ignores unknown ids', () => {
    let stack = pushEntry(pushEntry(empty, entry('a')), entry('b'));
    stack = showEntry(stack, 'b');
    expect(shownEntry(stack)?.id).toBe('b');
    expect(showEntry(stack, 'nope')).toBe(stack);
  });

  it('keeps at most the newest 200 entries, dropping the oldest resolved ones first', () => {
    let stack = empty;
    for (let i = 0; i < 205; i++) stack = pushEntry(stack, entry(String(i), { ref: { kind: 'url', url: `https://x/${i}` } }));
    expect(stack.entries.length).toBeLessThanOrEqual(200);
    expect(shownEntry(stack)?.id).toBe('0');
  });

  it('puts a `next` entry right after the one on screen, so it comes up when that one is answered (D-59)', () => {
    let stack = pushEntry(pushEntry(pushEntry(empty, entry('b1')), entry('b2')), entry('b3'));
    stack = pushEntry(stack, entry('a3'), 'next');
    expect(stack.entries.map(e => e.id)).toEqual(['b1', 'a3', 'b2', 'b3']);
    expect(shownEntry(stack)?.id).toBe('b1');
    stack = resolveEntries(stack, new Set(['b1']), 9);
    expect(shownEntry(stack)?.id).toBe('a3');
  });
});
