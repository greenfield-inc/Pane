import { describe, expect, it } from 'vitest';
import { SPLIT_MEMORY_LIMIT, SPLIT_MEMORY_STORAGE_KEY, pruneSplitMemory, readSplitHidden, todoSplitKey, writeSplitHidden } from './todoSplitMemory';

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
    writeSplitHidden(storage, todoSplitKey('local', 12), true, 1);
    expect(readSplitHidden(storage, todoSplitKey('local', 12))).toBe(true);
    expect(readSplitHidden(storage, todoSplitKey('devbox', 12))).toBe(false);
    expect(readSplitHidden(storage, todoSplitKey('local', 13))).toBe(false);
    writeSplitHidden(storage, todoSplitKey('local', 12), false, 2);
    expect(readSplitHidden(storage, todoSplitKey('local', 12))).toBe(false);
  });

  it('reads nothing from a broken value', () => {
    const storage = memoryStorage();
    storage.setItem(SPLIT_MEMORY_STORAGE_KEY, '{nope');
    expect(readSplitHidden(storage, todoSplitKey('local', 1))).toBe(false);
    storage.setItem(SPLIT_MEMORY_STORAGE_KEY, '[1,2]');
    expect(readSplitHidden(storage, todoSplitKey('local', 1))).toBe(false);
  });

  it('prunes closed to-dos and keeps only the newest entries', () => {
    const storage = memoryStorage();
    writeSplitHidden(storage, todoSplitKey('local', 1), true, 1);
    writeSplitHidden(storage, todoSplitKey('local', 2), true, 2);
    pruneSplitMemory(storage, (key) => key !== todoSplitKey('local', 1));
    expect(readSplitHidden(storage, todoSplitKey('local', 1))).toBe(false);
    expect(readSplitHidden(storage, todoSplitKey('local', 2))).toBe(true);
    for (let number = 10; number < 10 + SPLIT_MEMORY_LIMIT + 5; number += 1) writeSplitHidden(storage, todoSplitKey('local', number), true, number);
    expect(readSplitHidden(storage, todoSplitKey('local', 2))).toBe(false);
    expect(readSplitHidden(storage, todoSplitKey('local', 10 + SPLIT_MEMORY_LIMIT + 4))).toBe(true);
  });
});
