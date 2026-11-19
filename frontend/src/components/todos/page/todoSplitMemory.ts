import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../../shared/validation/boundaryDecoder';

/**
 * Which to-dos have their split hidden (D-420), and which of their split's tabs are closed (T-25): a
 * per-person view setting on this computer, in the renderer's saved UI state beside the outer panels'
 * widths, never in the database. Only hidden to-dos, and to-dos with closed tabs, are stored, each
 * with when it last changed, keyed by machine and number.
 */
export const SPLIT_MEMORY_STORAGE_KEY = 'pane-todo-split-hidden:v1';
/** Each to-do's closed tabs, as `splitItemKey`s, with when they last changed. */
export const CLOSED_TABS_STORAGE_KEY = 'pane-todo-split-closed:v1';
/** The newest this many to-dos are kept in each. */
export const SPLIT_MEMORY_LIMIT = 200;

interface ClosedTabs {
  at: number;
  keys: string[];
}

const hiddenSchema = boundary.record(boundary.number);
const closedSchema = boundary.record(boundary.object({ at: boundary.number, keys: boundary.array(boundary.string) }));

export function todoSplitKey(machineId: string, number: number): string {
  return `${machineId}:${number}`;
}

function read<Value>(storage: Storage, storageKey: string, schema: BoundarySchema<Record<string, Value>>): Record<string, Value> {
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return {};
    return decodeOptionalBoundary(JSON.parse(raw), schema) ?? {};
  } catch {
    return {};
  }
}

function write<Value>(storage: Storage, storageKey: string, memory: Record<string, Value>, at: (value: Value) => number): void {
  const newest = Object.entries(memory).sort((a, b) => at(b[1]) - at(a[1])).slice(0, SPLIT_MEMORY_LIMIT);
  try {
    storage.setItem(storageKey, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage full or blocked: the split simply isn't remembered.
  }
}

const hiddenAt = (value: number) => value;
const closedAt = (value: ClosedTabs) => value.at;

export function readSplitHidden(storage: Storage, key: string): boolean {
  return key in read(storage, SPLIT_MEMORY_STORAGE_KEY, hiddenSchema);
}

export function writeSplitHidden(storage: Storage, key: string, hidden: boolean, now = Date.now()): void {
  const memory = read(storage, SPLIT_MEMORY_STORAGE_KEY, hiddenSchema);
  if (hidden) memory[key] = now;
  else if (key in memory) delete memory[key];
  else return;
  write(storage, SPLIT_MEMORY_STORAGE_KEY, memory, hiddenAt);
}

/** The `splitItemKey`s of the to-do's closed tabs. */
export function readClosedTabs(storage: Storage, key: string): string[] {
  return read(storage, CLOSED_TABS_STORAGE_KEY, closedSchema)[key]?.keys ?? [];
}

export function writeClosedTabs(storage: Storage, key: string, keys: readonly string[], now = Date.now()): void {
  const memory = read(storage, CLOSED_TABS_STORAGE_KEY, closedSchema);
  if (keys.length > 0) memory[key] = { at: now, keys: [...keys] };
  else if (key in memory) delete memory[key];
  else return;
  write(storage, CLOSED_TABS_STORAGE_KEY, memory, closedAt);
}

/** Forgets the to-dos `keep` turns down (closed or gone), in both memories. */
export function pruneSplitMemory(storage: Storage, keep: (key: string) => boolean): void {
  const hidden = read(storage, SPLIT_MEMORY_STORAGE_KEY, hiddenSchema);
  const keptHidden = Object.fromEntries(Object.entries(hidden).filter(([key]) => keep(key)));
  if (Object.keys(keptHidden).length !== Object.keys(hidden).length) write(storage, SPLIT_MEMORY_STORAGE_KEY, keptHidden, hiddenAt);
  const closed = read(storage, CLOSED_TABS_STORAGE_KEY, closedSchema);
  const keptClosed = Object.fromEntries(Object.entries(closed).filter(([key]) => keep(key)));
  if (Object.keys(keptClosed).length !== Object.keys(closed).length) write(storage, CLOSED_TABS_STORAGE_KEY, keptClosed, closedAt);
}
