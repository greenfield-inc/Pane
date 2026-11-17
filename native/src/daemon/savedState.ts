import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query';

/** A saved file with any other version is discarded. */
const VERSION = 1;
/** Writes wait this long after the last change, so a burst of updates is written once. */
const WRITE_DELAY_MS = 2_000;
/** How many Panes keep their tab list. */
const RECENT_PANES = 20;

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
const PANE_TABS = 'panels:list';

export interface SavedStateFiles {
  read(machineId: string): string | null;
  write(machineId: string, text: string): void;
  remove(machineId: string): void;
}

/**
 * Keeps each machine's last-known lists on the phone, so a launch, a return or a switch paints
 * them before the machine answers. One file per machine, rewritten 2 s after its lists change.
 * Restored lists count as stale: every screen still reads them fresh.
 */
export function createSavedState(queryClient: QueryClient, files: SavedStateFiles, options: { saves(machineId: string): boolean }) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const save = (machineId: string) => {
    pending.delete(machineId);
    if (!options.saves(machineId)) return;
    const saved = new Set(savedQueries(queryClient, machineId));
    const { queries } = dehydrate(queryClient, { shouldDehydrateQuery: query => saved.has(query) });
    files.write(machineId, JSON.stringify({ version: VERSION, queries }));
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [machineId, channel] = event.query.queryKey;
    if (typeof machineId !== 'string' || !isSaved(channel)) return;
    clearTimeout(pending.get(machineId));
    pending.set(machineId, setTimeout(() => save(machineId), WRITE_DELAY_MS));
  });

  return {
    /** Paints a machine's saved lists. Lists already in memory and newer stay as they are. */
    restore(machineId: string) {
      let saved: { version?: unknown; queries?: unknown };
      try {
        saved = JSON.parse(files.read(machineId) ?? 'null') ?? {};
      } catch {
        saved = {};
      }
      if (saved.version !== VERSION || !Array.isArray(saved.queries)) return;
      hydrate(queryClient, { mutations: [], queries: saved.queries });
      void queryClient.invalidateQueries({ queryKey: [machineId], refetchType: 'none' });
    },
    /** Deletes a machine's file, on sign-out or removal. */
    forget(machineId: string) {
      clearTimeout(pending.get(machineId));
      pending.delete(machineId);
      files.remove(machineId);
    },
    stop() {
      unsubscribe();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

function isSaved(channel: unknown): boolean {
  return typeof channel === 'string' && (SAVED_CHANNELS.has(channel) || channel === PANE_TABS);
}

function savedQueries(queryClient: QueryClient, machineId: string): Query[] {
  const answered = queryClient.getQueryCache().findAll({ queryKey: [machineId], predicate: query => query.state.status === 'success' });
  const tabs = answered
    .filter(query => query.queryKey[1] === PANE_TABS)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, RECENT_PANES);
  return [...answered.filter(query => SAVED_CHANNELS.has(query.queryKey[1] as string)), ...tabs];
}
