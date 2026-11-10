import type { ChatTabContextUsage } from './types/chatTab';

/**
 * The line above the chat's composer (D-222, D-253, D-267): one muted footer line of the
 * chat's state, context left first, each item clickable. Model and mode stay on the
 * composer row (D-267). Which items show is remembered per device.
 */
export const STATUS_ITEMS = ['context', 'pr', 'tasks', 'queue'] as const;
export type StatusItem = typeof STATUS_ITEMS[number];

/** Every item shows until the person turns it off (D-255). */
export const DEFAULT_STATUS_ITEMS: readonly StatusItem[] = STATUS_ITEMS;

export const STATUS_ITEM_NAMES = {
  context: 'Context left',
  pr: 'Pull request',
  tasks: 'Background tasks',
  queue: 'Queued messages',
} satisfies Record<StatusItem, string>;

export const STATUS_ITEMS_KEY = 'pane-chat-status-items:v1';

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** The items this device shows, in the bar's order; unknown or unreadable values fall back to the defaults. */
export function readStatusItems(storage: StorageLike | undefined): StatusItem[] {
  let raw: string | null = null;
  try { raw = storage?.getItem(STATUS_ITEMS_KEY) ?? null; } catch { return [...DEFAULT_STATUS_ITEMS]; }
  if (raw === null) return [...DEFAULT_STATUS_ITEMS];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return [...DEFAULT_STATUS_ITEMS]; }
  if (!Array.isArray(parsed)) return [...DEFAULT_STATUS_ITEMS];
  // Only known item names count; anything else in the stored list is ignored.
  return STATUS_ITEMS.filter(item => parsed.includes(item));
}

/** Saves the chosen items; the default set is stored as no preference, so a later default change reaches it. */
export function writeStatusItems(storage: StorageLike | undefined, items: readonly StatusItem[]): void {
  const sorted = STATUS_ITEMS.filter(item => items.includes(item));
  try {
    if (sorted.length === DEFAULT_STATUS_ITEMS.length && sorted.every(item => DEFAULT_STATUS_ITEMS.includes(item))) storage?.removeItem(STATUS_ITEMS_KEY);
    else storage?.setItem(STATUS_ITEMS_KEY, JSON.stringify(sorted));
  } catch {
    // Storage full or blocked: the choice lasts until reload.
  }
}

/** At or below this share of the window left, the context item turns amber. */
export const CONTEXT_LOW_PERCENT = 20;

export interface ContextLeft {
  /** Whole percent of the context window still free, 0 to 100. */
  percent: number;
  low: boolean;
  /** "118k of 200k tokens used". */
  detail: string;
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** How much of the context window is left, or undefined when the adapter reported none. */
export function contextLeft(usage: ChatTabContextUsage | undefined): ContextLeft | undefined {
  if (!usage || !(usage.size > 0) || !(usage.used >= 0)) return undefined;
  const used = Math.min(usage.used, usage.size);
  const percent = Math.max(0, Math.min(100, Math.floor(((usage.size - used) / usage.size) * 100)));
  return { percent, low: percent <= CONTEXT_LOW_PERCENT, detail: `${tokens(used)} of ${tokens(usage.size)} tokens used` };
}

/** How long a background task has run: "40s", "3m", "1h 5m". */
export function taskAge(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

/** A pull request's state, as GitHub's gh reports it, in the bar's words. */
export function prStateName(state: string | undefined, draft: boolean | undefined): string | undefined {
  if (draft && (!state || state.toUpperCase() === 'OPEN')) return 'Draft';
  switch (state?.toUpperCase()) {
    case 'OPEN': return 'Open';
    case 'MERGED': return 'Merged';
    case 'CLOSED': return 'Closed';
    default: return undefined;
  }
}
