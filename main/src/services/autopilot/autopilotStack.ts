import type { AutopilotStack, AutopilotStackEntry, AutopilotStackRef } from '../../../../shared/types/autopilot';

/** The stack keeps this many entries; the oldest resolved ones go first. */
const STACK_LIMIT = 200;

export function sameRef(a: AutopilotStackRef, b: AutopilotStackRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'item': return b.kind === 'item' && a.notifyId === b.notifyId;
    case 'file': return b.kind === 'file' && a.path === b.path;
    case 'url': return b.kind === 'url' && a.url === b.url;
    case 'session': return b.kind === 'session' && a.sessionId === b.sessionId;
  }
}

export function shownEntry(stack: AutopilotStack): AutopilotStackEntry | undefined {
  return stack.entries.find(entry => entry.id === stack.shownId);
}

/** 0-based index of the shown entry and the number of entries. */
export interface StackPosition { index: number; total: number }

export function stackPosition(stack: AutopilotStack): StackPosition {
  return { index: Math.max(0, stack.entries.findIndex(entry => entry.id === stack.shownId)), total: stack.entries.length };
}

/**
 * Puts an entry on the stack. It waits off-screen unless nothing open is shown (D-71): the
 * entry on screen is never replaced. An entry about the same thing is refreshed in place.
 */
export function pushEntry(stack: AutopilotStack, entry: AutopilotStackEntry, placement: 'end' | 'next' = 'end'): AutopilotStack {
  const existing = stack.entries.find(candidate => sameRef(candidate.ref, entry.ref));
  if (existing) {
    const refreshed: AutopilotStackEntry = { ...existing, title: entry.title, note: entry.note ?? existing.note, tabs: entry.tabs, sessionId: entry.sessionId ?? existing.sessionId, sessionName: entry.sessionName ?? existing.sessionName, doneAt: undefined };
    const next = { ...stack, entries: stack.entries.map(candidate => candidate.id === existing.id ? refreshed : candidate) };
    return showIfIdle(next, existing.id);
  }
  // `next` (D-59, jumping back up): right after the entry on screen, so it is the one that comes up when that is answered.
  const at = placement === 'next' && stack.shownId ? stack.entries.findIndex(candidate => candidate.id === stack.shownId) + 1 : stack.entries.length;
  const entries = [...stack.entries.slice(0, at), entry, ...stack.entries.slice(at)];
  return trim(showIfIdle({ ...stack, entries }, entry.id));
}

/** Shows `id` when the person has nothing open in front of them. */
function showIfIdle(stack: AutopilotStack, id: string): AutopilotStack {
  const shown = shownEntry(stack);
  if (shown && shown.doneAt === undefined && shown.id !== id) return stack;
  if (shown && shown.id === id) return stack;
  return { ...stack, shownId: id };
}

function trim(stack: AutopilotStack): AutopilotStack {
  if (stack.entries.length <= STACK_LIMIT) return stack;
  const excess = stack.entries.length - STACK_LIMIT;
  const removable = [
    ...stack.entries.filter(entry => entry.doneAt !== undefined && entry.id !== stack.shownId),
    ...stack.entries.filter(entry => entry.doneAt === undefined && entry.id !== stack.shownId),
  ].slice(0, excess).map(entry => entry.id);
  const drop = new Set(removable);
  return { ...stack, entries: stack.entries.filter(entry => !drop.has(entry.id)) };
}

/**
 * Marks entries resolved (their item was answered or expired, or the person dismissed them).
 * When the shown entry resolves, the next open entry after it comes up, else the first open one
 * before it; with none open, the resolved entry stays on screen.
 */
export function resolveEntries(stack: AutopilotStack, ids: ReadonlySet<string>, now: number): AutopilotStack {
  if (!stack.entries.some(entry => ids.has(entry.id) && entry.doneAt === undefined)) return stack;
  const entries = stack.entries.map(entry => ids.has(entry.id) && entry.doneAt === undefined ? { ...entry, doneAt: now } : entry);
  const next: AutopilotStack = { ...stack, entries };
  const shown = shownEntry(next);
  if (!shown || shown.doneAt === undefined || !ids.has(shown.id)) return next;
  const index = entries.findIndex(entry => entry.id === shown.id);
  const after = entries.slice(index + 1).find(entry => entry.doneAt === undefined);
  const before = entries.slice(0, index).find(entry => entry.doneAt === undefined);
  const upNext = after ?? before;
  return upNext ? { ...next, shownId: upNext.id } : next;
}

/** ‹ › and ← →: one entry back or forward, resolved ones included. */
export function stepStack(stack: AutopilotStack, direction: 1 | -1): AutopilotStack {
  if (stack.entries.length === 0) return stack;
  const { index } = stackPosition(stack);
  const target = Math.min(stack.entries.length - 1, Math.max(0, index + direction));
  const id = stack.entries[target]?.id ?? null;
  return id === stack.shownId ? stack : { ...stack, shownId: id };
}

/** The chips: jump to an entry. */
export function showEntry(stack: AutopilotStack, id: string): AutopilotStack {
  if (!stack.entries.some(entry => entry.id === id) || stack.shownId === id) return stack;
  return { ...stack, shownId: id };
}
