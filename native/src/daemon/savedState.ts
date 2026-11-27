import { dehydrate, hashKey, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query';

import { hostIdHash } from '@/auth/hosts';

/** A saved file with any other version is discarded. */
const VERSION = 1;
/** Writes wait this long after the last change, so a burst of updates is written once… */
const WRITE_DELAY_MS = 2_000;
/** …but never longer than this after the first change of a burst. */
const WRITE_MAX_WAIT_MS = 10_000;
/** How many Panes keep their tab list, and Sessions their own data, each. */
const RECENT = 20;

/** What Home and a Pane's tabs paint from: each machine's lists, keyed `[machineId, channel, ...]`. */
const SAVED_CHANNELS = new Set([
  'sessions:get-all-with-projects',
  // Agent statuses, with the Ready memory.
  'runpane:workspace:state',
  'permission:getPending',
  'notify:remote-snapshot',
  'orchestration-sessions:list',
  'autopilot:snapshot',
  // The machine's lists as All reads them while the phone is on another machine.
  'all-machines:snapshot',
]);
/** Lists kept for the Panes and Sessions read most recently: their tabs, and a Session's name and members. */
const RECENT_CHANNELS = new Set(['panels:list', 'orchestration-sessions:get']);

/** Files by name, one per machine; the name carries nothing of the machine's token. */
export interface SavedStateFiles {
  read(name: string): string | null;
  write(name: string, text: string): void;
  remove(name: string): void;
  /** Every saved file's name. */
  list(): string[];
}

/** A machine's file: named by a hash of its id, so nothing of its token is in the name. */
export const machineFileName = (machineId: string) => `${hostIdHash(machineId)}.json`;
const fileName = machineFileName;

/** Deletes every file in `files` that belongs to none of `machineIds`. */
export function keepMachineFiles(files: SavedStateFiles, machineIds: readonly string[]) {
  const kept = new Set(machineIds.map(fileName));
  for (const name of files.list()) if (!kept.has(name)) files.remove(name);
}

/**
 * Keeps each machine's last-known lists on the phone, so a launch, a return or a switch paints
 * them before the machine answers. One file per machine, rewritten 2 s after its lists change
 * (at most 10 s into a burst). Restored lists count as stale: every screen still reads them fresh.
 * The files name lists by channel only; the machine's id goes back in when they are read.
 */
export function createSavedState(queryClient: QueryClient, files: SavedStateFiles, options: { saves(machineId: string): boolean }) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
  /** The data each list had when it was last written, so a read that changed nothing writes nothing. */
  const written = new WeakMap<Query, unknown>();

  const save = (machineId: string) => {
    clearTimeout(pending.get(machineId)?.timer);
    pending.delete(machineId);
    if (!options.saves(machineId)) return;
    const saved = new Set(savedQueries(queryClient, machineId));
    const { queries } = dehydrate(queryClient, { shouldDehydrateQuery: query => saved.has(query) });
    for (const query of saved) written.set(query, query.state.data);
    files.write(fileName(machineId), JSON.stringify({ version: VERSION, queries: queries.map(withoutMachine) }));
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [machineId, channel] = event.query.queryKey;
    if (typeof machineId !== 'string' || !isSaved(channel)) return;
    if (written.get(event.query) === event.query.state.data) return;
    const since = pending.get(machineId)?.since ?? Date.now();
    clearTimeout(pending.get(machineId)?.timer);
    const delay = Math.max(0, Math.min(WRITE_DELAY_MS, since + WRITE_MAX_WAIT_MS - Date.now()));
    pending.set(machineId, { timer: setTimeout(() => save(machineId), delay), since });
  });

  const forget = (machineId: string) => {
    clearTimeout(pending.get(machineId)?.timer);
    pending.delete(machineId);
    files.remove(fileName(machineId));
  };

  return {
    /**
     * Paints a machine's saved lists. Lists already in memory and newer stay as they are. A file
     * that can't be read back is deleted, so it can never stop the app from starting.
     */
    restore(machineId: string) {
      try {
        const saved = JSON.parse(files.read(fileName(machineId)) ?? 'null') as { version?: unknown; queries?: unknown } | null;
        if (saved?.version !== VERSION || !Array.isArray(saved.queries)) return;
        const queries = (saved.queries as DehydratedState['queries']).map(query => withMachine(query, machineId));
        hydrate(queryClient, { mutations: [], queries });
        void queryClient.invalidateQueries({ queryKey: [machineId], refetchType: 'none' });
      } catch {
        forget(machineId);
      }
    },
    /** Deletes a machine's file, when it is removed, signed out or paired again under a new id. */
    forget,
    /** Deletes every file that belongs to none of `machineIds`. */
    keepOnly(machineIds: readonly string[]) {
      keepMachineFiles(files, machineIds);
    },
    /** Writes every pending change now, as the app goes to the background. */
    flush() {
      for (const machineId of [...pending.keys()]) save(machineId);
    },
    stop() {
      unsubscribe();
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

function isSaved(channel: unknown): boolean {
  return typeof channel === 'string' && (SAVED_CHANNELS.has(channel) || RECENT_CHANNELS.has(channel));
}

/** Lists with data, a failed refresh included: the last answer is still the best one to paint. */
function savedQueries(queryClient: QueryClient, machineId: string): Query[] {
  const answered = queryClient.getQueryCache().findAll({ queryKey: [machineId], predicate: query => query.state.data !== undefined });
  const recent = [...RECENT_CHANNELS].flatMap(channel => answered
    .filter(query => query.queryKey[1] === channel)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, RECENT));
  return [...answered.filter(query => SAVED_CHANNELS.has(query.queryKey[1] as string)), ...recent];
}

type SavedQuery = DehydratedState['queries'][number];

/** A saved list keeps its last answer, without the machine's id or a later failed refresh. */
function withoutMachine(query: SavedQuery): SavedQuery {
  const queryKey = ['', ...query.queryKey.slice(1)];
  const state = { ...query.state, status: 'success' as const, error: null, fetchStatus: 'idle' as const, fetchFailureCount: 0, fetchFailureReason: null };
  return { ...query, queryKey, queryHash: hashKey(queryKey), state };
}

function withMachine(query: SavedQuery, machineId: string): SavedQuery {
  const queryKey = [machineId, ...query.queryKey.slice(1)];
  return { ...query, queryKey, queryHash: hashKey(queryKey) };
}
