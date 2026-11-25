import { PaneError } from '../../../shared/paneError';

export const MAX_WORKSPACE_WAIT_TIMEOUT_MS = 120_000;
// A backstop for abandoned requests; normal polls release their leases sooner.
const WATCH_LEASE_MS = MAX_WORKSPACE_WAIT_TIMEOUT_MS + 5_000;

export class WorkspaceWatchCancelledError extends Error {
  constructor(reason: 'disconnected' | 'superseded') {
    super(reason === 'superseded'
      ? 'Workspace watch superseded by a new request for this cursor'
      : 'Workspace watch client disconnected');
  }
}

/** The backstop reaped a request that was still parked before its own deadline. */
export class WorkspaceWatchLeaseExpiredError extends PaneError {
  constructor() {
    super(
      'ERR_WATCH_LEASE_EXPIRED',
      `Workspace watch lease expired after ${WATCH_LEASE_MS / 1_000}s before the wait reached its deadline. The wait was ended; the cursor did not move.`,
      'Run the watch again; it resumes from the same cursor.',
    );
  }
}

export interface WorkspaceWatchLease {
  signal: AbortSignal;
  release: () => void;
  /** When the backstop fired, or undefined while it has not. */
  expiredAt: () => number | undefined;
}

/** Owns a whole watch request, so takeover cannot revive a superseded cadence loop. */
export class WorkspaceWatchLeases {
  private readonly named = new Map<string, AbortController>();
  private readonly lastReleasedAt = new Map<string, number>();

  /**
   * A `--follow` watcher re-polls right after each poll returns, so it counts as
   * attached while a poll is in flight and for `graceMs` after the last one ended.
   */
  isAttached(name: string, graceMs: number): boolean {
    if (this.named.has(name)) return true;
    const releasedAt = this.lastReleasedAt.get(name);
    return releasedAt !== undefined && Date.now() - releasedAt <= graceMs;
  }

  acquire(name?: string, connection?: AbortSignal): WorkspaceWatchLease {
    if (connection?.aborted) throw new WorkspaceWatchCancelledError('disconnected');
    const controller = new AbortController();
    let expiredAt: number | undefined;
    if (name !== undefined) {
      this.named.get(name)?.abort(new WorkspaceWatchCancelledError('superseded'));
      this.named.set(name, controller);
    }
    const disconnect = () => controller.abort(new WorkspaceWatchCancelledError('disconnected'));
    const release = () => {
      connection?.removeEventListener('abort', disconnect);
      clearTimeout(timer);
      if (name !== undefined && this.named.get(name) === controller) {
        this.named.delete(name);
        this.lastReleasedAt.set(name, Date.now());
      }
    };
    const timer = setTimeout(() => {
      expiredAt = Date.now();
      controller.abort(new WorkspaceWatchLeaseExpiredError());
      release();
    }, WATCH_LEASE_MS);
    timer.unref();
    controller.signal.addEventListener('abort', release, { once: true });
    connection?.addEventListener('abort', disconnect, { once: true });
    return { signal: controller.signal, release, expiredAt: () => expiredAt };
  }
}

/**
 * Parks one wait under its lease. A lease that runs out at or after the wait's own deadline
 * (late post-timeout work, or a machine that slept through it) ends the park with `timedOut()`,
 * the result a normal deadline gives, so the caller's cursor keeps working. A lease lost any
 * other way, or one that runs out before the deadline, still rejects.
 */
export async function parkUnderLease<T>(
  lease: WorkspaceWatchLease,
  deadlineAt: number,
  park: (signal: AbortSignal) => Promise<T>,
  timedOut: () => T,
): Promise<T> {
  const expiredPastDeadline = () => {
    const expiredAt = lease.expiredAt();
    return expiredAt !== undefined && expiredAt >= deadlineAt;
  };
  let parked: T;
  try {
    parked = await park(lease.signal);
  } catch (error) {
    if (expiredPastDeadline()) return timedOut();
    throw error;
  }
  if (!expiredPastDeadline()) lease.signal.throwIfAborted();
  return parked;
}
