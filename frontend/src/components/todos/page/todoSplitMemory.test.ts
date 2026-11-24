import { describe, expect, it } from 'vitest';
import { todoKey } from '../../../../../shared/todoKey';
import type { TodoListRow, TodoRecord } from '../../../../../shared/types/todos';
import {
  CLOSED_TABS_STORAGE_KEY, SPLIT_MEMORY_LIMIT, SPLIT_MEMORY_STORAGE_KEY, pruneClosedTodos, pruneForPage, pruneSplitMemory, readClosedTabs, readSplitHidden, writeClosedTabs, writeSplitHidden,
} from './todoSplitMemory';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('todo split memory', () => {
  it('remembers hidden per machine and to-do number', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoKey('local', 12), true, 1);
    expect(readSplitHidden(storage, todoKey('local', 12))).toBe(true);
    expect(readSplitHidden(storage, todoKey('devbox', 12))).toBe(false);
    expect(readSplitHidden(storage, todoKey('local', 13))).toBe(false);
    writeSplitHidden(storage, todoKey('local', 12), false, 2);
    expect(readSplitHidden(storage, todoKey('local', 12))).toBe(false);
  });

  it('reads nothing from a broken value', () => {
    const storage = memoryStorage();
    storage.setItem(SPLIT_MEMORY_STORAGE_KEY, '{nope');
    expect(readSplitHidden(storage, todoKey('local', 1))).toBe(false);
    storage.setItem(SPLIT_MEMORY_STORAGE_KEY, '[1,2]');
    expect(readSplitHidden(storage, todoKey('local', 1))).toBe(false);
  });

  it('prunes closed to-dos and keeps only the newest entries', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoKey('local', 1), true, 1);
    writeSplitHidden(storage, todoKey('local', 2), true, 2);
    pruneSplitMemory(storage, (key) => key !== todoKey('local', 1));
    expect(readSplitHidden(storage, todoKey('local', 1))).toBe(false);
    expect(readSplitHidden(storage, todoKey('local', 2))).toBe(true);
    for (let number = 10; number < 10 + SPLIT_MEMORY_LIMIT + 5; number += 1) writeSplitHidden(storage, todoKey('local', number), true, number);
    expect(readSplitHidden(storage, todoKey('local', 2))).toBe(false);
    expect(readSplitHidden(storage, todoKey('local', 10 + SPLIT_MEMORY_LIMIT + 4))).toBe(true);
  });
});

describe('closed tabs memory (T-25)', () => {
  it('remembers each to-do’s closed tabs per machine and number', () => {
    const storage = memoryStorage();
    writeClosedTabs(storage, todoKey('local', 12), ['attachment:3', 'overview:s-12'], 1);
    expect(readClosedTabs(storage, todoKey('local', 12))).toEqual(['attachment:3', 'overview:s-12']);
    expect(readClosedTabs(storage, todoKey('devbox', 12))).toEqual([]);
    writeClosedTabs(storage, todoKey('local', 12), [], 2);
    expect(readClosedTabs(storage, todoKey('local', 12))).toEqual([]);
    expect(storage.getItem(CLOSED_TABS_STORAGE_KEY)).toBe('{}');
  });

  it('is kept apart from the hidden state', () => {
    const storage = memoryStorage();
    writeClosedTabs(storage, todoKey('local', 12), ['attachment:3'], 1);
    expect(readSplitHidden(storage, todoKey('local', 12))).toBe(false);
    writeSplitHidden(storage, todoKey('local', 12), true, 2);
    expect(readClosedTabs(storage, todoKey('local', 12))).toEqual(['attachment:3']);
  });

  it('reads nothing from a broken value', () => {
    const storage = memoryStorage();
    storage.setItem(CLOSED_TABS_STORAGE_KEY, '{nope');
    expect(readClosedTabs(storage, todoKey('local', 1))).toEqual([]);
    storage.setItem(CLOSED_TABS_STORAGE_KEY, JSON.stringify({ 'local:1': { at: 1, keys: 'attachment:1' } }));
    expect(readClosedTabs(storage, todoKey('local', 1))).toEqual([]);
  });

  it('is pruned with the hidden state: closed to-dos go, and only the newest are kept', () => {
    const storage = memoryStorage();
    writeClosedTabs(storage, todoKey('local', 1), ['attachment:1'], 1);
    writeClosedTabs(storage, todoKey('local', 2), ['attachment:2'], 2);
    pruneSplitMemory(storage, (key) => key !== todoKey('local', 1));
    expect(readClosedTabs(storage, todoKey('local', 1))).toEqual([]);
    expect(readClosedTabs(storage, todoKey('local', 2))).toEqual(['attachment:2']);
    for (let number = 10; number < 10 + SPLIT_MEMORY_LIMIT + 5; number += 1) writeClosedTabs(storage, todoKey('local', number), [`attachment:${number}`], number);
    expect(readClosedTabs(storage, todoKey('local', 2))).toEqual([]);
    expect(readClosedTabs(storage, todoKey('local', 10 + SPLIT_MEMORY_LIMIT + 4))).toEqual([`attachment:${10 + SPLIT_MEMORY_LIMIT + 4}`]);
  });
});

describe('pruneClosedTodos (T-51 W9)', () => {
  // SAFETY: pruning reads only a row's number and status.
  const row = (number: number, status: 'working' | 'done'): TodoListRow => ({ todo: { number } as TodoRecord, status: { status, reason: '' }, machine: 'm' });

  it('forgets only the shown machine\'s closed to-dos: the mini\'s done T-5 goes, this computer\'s T-5 stays', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoKey('local', 5), true, 1);
    writeSplitHidden(storage, todoKey('mini', 5), true, 2);
    pruneClosedTodos(storage, 'mini', [row(5, 'done')]);
    expect(readSplitHidden(storage, todoKey('mini', 5))).toBe(false);
    expect(readSplitHidden(storage, todoKey('local', 5))).toBe(true);
    // And this computer's list, with no T-5, leaves the mini's alone.
    writeSplitHidden(storage, todoKey('mini', 5), true, 3);
    pruneClosedTodos(storage, 'local', [row(5, 'working')]);
    expect(readSplitHidden(storage, todoKey('mini', 5))).toBe(true);
    expect(readSplitHidden(storage, todoKey('local', 5))).toBe(true);
  });
});

describe('pruneForPage (T-51 review F-3)', () => {
  // SAFETY: pruning reads only a row's number and status.
  const row = (number: number, status: 'working' | 'done'): TodoListRow => ({ todo: { number } as TodoRecord, status: { status, reason: '' }, machine: 'm' });
  const remembered = (storage: Storage) => ({ hidden: readSplitHidden(storage, todoKey('mini', 5)), closed: readClosedTabs(storage, todoKey('mini', 5)) });

  it('on the mini\'s T-5 page, a list still from this computer (its T-5 done) forgets nothing of the mini\'s', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoKey('mini', 5), true, 1);
    writeClosedTabs(storage, todoKey('mini', 5), ['attachment:1'], 1);
    // Just after the switch: the store's list is this computer's, where T-5 is done.
    pruneForPage(storage, 'mini', { machineId: 'local', rows: [row(5, 'done')] });
    expect(remembered(storage)).toEqual({ hidden: true, closed: ['attachment:1'] });
    // No list read yet: nothing either.
    pruneForPage(storage, 'mini', null);
    expect(remembered(storage)).toEqual({ hidden: true, closed: ['attachment:1'] });
    // The mini's own list, with its T-5 open, keeps both; once its T-5 is done, both go.
    pruneForPage(storage, 'mini', { machineId: 'mini', rows: [row(5, 'working')] });
    expect(remembered(storage)).toEqual({ hidden: true, closed: ['attachment:1'] });
    pruneForPage(storage, 'mini', { machineId: 'mini', rows: [row(5, 'done')] });
    expect(remembered(storage)).toEqual({ hidden: false, closed: [] });
  });

  it('pairing that list with the shown machine, as the page did before, erased the mini\'s layout', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoKey('mini', 5), true, 1);
    writeClosedTabs(storage, todoKey('mini', 5), ['attachment:1'], 1);
    pruneClosedTodos(storage, 'mini', [row(4, 'working')]);
    expect(remembered(storage)).toEqual({ hidden: false, closed: [] });
  });
});
