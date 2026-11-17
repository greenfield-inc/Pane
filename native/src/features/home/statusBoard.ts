import type { AllMachinesList, RecentRow } from '@/features/allMachines/allMachinesList';
import { waitingCounts } from '@/features/approvals/approvals';

/** Home's four tiles: each counts something and, when selected, lists it below. */
export type BoardTile = 'needs' | 'working' | 'ready' | 'all';

export type PaneRecentRow = Extract<RecentRow, { type: 'pane' }>;

/**
 * The tiles' counts. Needs you counts what waits on you: approvals (not answers held for Undo,
 * replies the agent is reading, stale items or machines that are offline) and Panes blocked at a
 * terminal prompt (D-81). Working and Ready count Panes whose agent works or finished unseen,
 * leaving paused ones out. All panes counts every open Pane.
 */
export function boardCounts(list: Pick<AllMachinesList, 'waiting' | 'recent'>): Record<BoardTile, number> {
  const panes = paneRows(list.recent);
  return {
    needs: waitingCounts(list.waiting).total + terminalWaiting(list).length,
    working: tilePanes(panes, 'working').length,
    ready: tilePanes(panes, 'ready').length,
    all: panes.length,
  };
}

/** The Panes a Working or Ready tile lists, newest activity first (the order `recent` comes in). */
export function tilePanes(recent: readonly RecentRow[], tile: 'working' | 'ready'): PaneRecentRow[] {
  const status = tile === 'working' ? 'working' : 'done';
  return paneRows(recent).filter(row => row.pane.status === status && !row.pane.paused);
}

/**
 * Panes whose agent waits at a prompt in its terminal with no approval behind it (Codex asking
 * "Allow this command?", for one): Needs you lists them after the approvals. A Pane with an
 * approval counts through that approval; paused Panes and machines that went offline stay out.
 */
export function terminalWaiting(list: Pick<AllMachinesList, 'waiting' | 'recent'>): PaneRecentRow[] {
  const asked = new Set(list.waiting.flatMap(row => {
    const paneId = row.type === 'question' ? row.item.source.paneId : row.request.sessionId;
    return paneId ? [`${row.machineKey}:${paneId}`] : [];
  }));
  return paneRows(list.recent).filter(row => row.pane.status === 'blocked' && !row.pane.paused && !row.stale && !asked.has(`${row.machineKey}:${row.pane.id}`));
}

function paneRows(recent: readonly RecentRow[]): PaneRecentRow[] {
  return recent.filter((row): row is PaneRecentRow => row.type === 'pane');
}

export interface TimeBucket<T> {
  label: string;
  rows: T[];
}

const HOUR = 60 * 60_000;

/**
 * History's Done today, newest first, under "Last hour", then "This evening", "This afternoon"
 * and "This morning" by the phone's clock. Rows keep their order; empty buckets are left out.
 */
export function todayBuckets<T>(rows: readonly T[], at: (row: T) => number, now: number): TimeBucket<T>[] {
  const buckets: TimeBucket<T>[] = [];
  for (const row of rows) {
    const label = bucketLabel(at(row), now);
    const last = buckets[buckets.length - 1];
    if (last?.label === label) last.rows.push(row);
    else buckets.push({ label, rows: [row] });
  }
  return buckets;
}

function bucketLabel(at: number, now: number): string {
  if (now - at < HOUR) return 'Last hour';
  const hour = new Date(at).getHours();
  if (hour >= 17) return 'This evening';
  if (hour >= 12) return 'This afternoon';
  return 'This morning';
}

/** How many Pinned rows the All panes tile shows before "Show N more". */
export const PINNED_PREVIEW = 4;
