import { describe, expect, it } from 'vitest';
import { contextLeft, DEFAULT_STATUS_ITEMS, prStateName, readStatusItems, STATUS_ITEMS_KEY, taskAge, writeStatusItems } from '../../../../shared/chatStatusBar';

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('status bar items', () => {
  it('shows every default item until the person changes them, and remembers a change in the bar\'s order', () => {
    const storage = memory();
    expect(readStatusItems(storage)).toEqual([...DEFAULT_STATUS_ITEMS]);
    writeStatusItems(storage, ['queue', 'model']);
    expect(readStatusItems(storage)).toEqual(['model', 'queue']);
    writeStatusItems(storage, [...DEFAULT_STATUS_ITEMS]);
    expect(storage.values.has(STATUS_ITEMS_KEY)).toBe(false);
  });

  it('keeps an empty choice, and falls back to the defaults on a broken value', () => {
    const storage = memory();
    writeStatusItems(storage, []);
    expect(readStatusItems(storage)).toEqual([]);
    expect(readStatusItems(memory({ [STATUS_ITEMS_KEY]: '{oops' }))).toEqual([...DEFAULT_STATUS_ITEMS]);
    expect(readStatusItems(memory({ [STATUS_ITEMS_KEY]: '["pr","nonsense"]' }))).toEqual(['pr']);
    expect(readStatusItems(undefined)).toEqual([...DEFAULT_STATUS_ITEMS]);
  });
});

describe('context left', () => {
  it('reads the share of the window still free, amber at 20% or less', () => {
    expect(contextLeft({ used: 118_000, size: 200_000 })).toEqual({ percent: 41, low: false, detail: '118k of 200k tokens used' });
    expect(contextLeft({ used: 160_000, size: 200_000 })).toMatchObject({ percent: 20, low: true });
    expect(contextLeft({ used: 250_000, size: 200_000 })).toMatchObject({ percent: 0, low: true });
    expect(contextLeft({ used: 10, size: 1_000_000 })?.detail).toBe('10 of 1M tokens used');
  });

  it('shows nothing when the adapter reports no usage', () => {
    expect(contextLeft(undefined)).toBeUndefined();
    expect(contextLeft({ used: 5, size: 0 })).toBeUndefined();
  });
});

describe('bar words', () => {
  it('names a task\'s age and a pull request\'s state', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(taskAge('2026-11-08T11:59:20Z', now)).toBe('40s');
    expect(taskAge('2026-11-08T11:57:00Z', now)).toBe('3m');
    expect(taskAge('2026-11-08T10:55:00Z', now)).toBe('1h 5m');
    expect(prStateName('OPEN', false)).toBe('Open');
    expect(prStateName('OPEN', true)).toBe('Draft');
    expect(prStateName('MERGED', false)).toBe('Merged');
    expect(prStateName(undefined, false)).toBeUndefined();
  });
});
