/** A swiped approval: its row's key (what the list hides), its question's id (what is closed) and title. */
export interface HeldArchive {
  key: string;
  id: string;
  title: string;
}

export interface ArchiveHoldState {
  /** Archived and still undoable, oldest first. */
  held: readonly HeldArchive[];
  /** Row keys the list and its counts leave out: held, or sent and not yet settled. */
  hidden: ReadonlySet<string>;
}

export const ARCHIVE_HOLD_MS = 5_000;

/**
 * Holds swiped approvals on the phone for `delayMs` before closing them, so Undo can cancel. Another
 * archive joins the hold and restarts its timer. `flush` sends what is held now; a close that fails
 * shows its row again. State is replaced on every change, for `useSyncExternalStore`.
 */
export function createArchiveHold(close: (id: string) => Promise<unknown>, delayMs = ARCHIVE_HOLD_MS) {
  let state: ArchiveHoldState = { held: [], hidden: new Set() };
  let sending: readonly HeldArchive[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const update = (held: readonly HeldArchive[], nextSending: readonly HeldArchive[]) => {
    sending = nextSending;
    state = { held, hidden: new Set([...held, ...sending].map(entry => entry.key)) };
    listeners.forEach(listener => listener());
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    stop();
    const batch = state.held;
    if (batch.length === 0) return;
    update([], [...sending, ...batch]);
    for (const entry of batch) {
      // Settled once the next snapshot is read: gone when it closed, back when it failed.
      void close(entry.id).catch(() => undefined).finally(() => update(state.held, sending.filter(sent => sent !== entry)));
    }
  };

  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    archive: (entry: HeldArchive) => {
      stop();
      update([...state.held, entry], sending);
      timer = setTimeout(flush, delayMs);
    },
    undo: () => {
      stop();
      update([], sending);
    },
    flush,
  };
}

/** The Undo bar's line: "Archived <title>", or "Archived 3 approvals". */
export function archivedLine(held: readonly HeldArchive[]): string {
  return held.length === 1 ? `Archived ${held[0].title}` : `Archived ${held.length} approvals`;
}
