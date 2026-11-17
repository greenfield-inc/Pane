import { boundary, decodeOptionalBoundary } from '../../../../../shared/validation/boundaryDecoder';

/**
 * Which to-dos have their split hidden (D-420): a per-person view setting on this computer, in the
 * renderer's saved UI state beside the outer panels' widths, never in the database. Only hidden
 * to-dos are stored, each with when it was hidden, keyed by machine and number.
 */
export const SPLIT_MEMORY_STORAGE_KEY = 'pane-todo-split-hidden:v1';
/** The newest this many hidden to-dos are kept. */
export const SPLIT_MEMORY_LIMIT = 200;

type SplitMemory = Record<string, number>;

const memorySchema = boundary.record(boundary.number);

export function todoSplitKey(machineId: string, number: number): string {
  return `${machineId}:${number}`;
}

function read(storage: Storage): SplitMemory {
  try {
    const raw = storage.getItem(SPLIT_MEMORY_STORAGE_KEY);
    if (raw === null) return {};
    return decodeOptionalBoundary(JSON.parse(raw), memorySchema) ?? {};
  } catch {
    return {};
  }
}

function write(storage: Storage, memory: SplitMemory): void {
  const newest = Object.entries(memory).sort((a, b) => b[1] - a[1]).slice(0, SPLIT_MEMORY_LIMIT);
  try {
    storage.setItem(SPLIT_MEMORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage full or blocked: the split simply isn't remembered.
  }
}

export function readSplitHidden(storage: Storage, key: string): boolean {
  return key in read(storage);
}

export function writeSplitHidden(storage: Storage, key: string, hidden: boolean, now = Date.now()): void {
  const memory = read(storage);
  if (hidden) memory[key] = now;
  else if (key in memory) delete memory[key];
  else return;
  write(storage, memory);
}

/** Forgets the to-dos `keep` turns down (closed or gone). */
export function pruneSplitMemory(storage: Storage, keep: (key: string) => boolean): void {
  const memory = read(storage);
  const kept = Object.fromEntries(Object.entries(memory).filter(([key]) => keep(key)));
  if (Object.keys(kept).length !== Object.keys(memory).length) write(storage, kept);
}
