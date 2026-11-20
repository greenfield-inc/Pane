import { PaneError } from '../../../shared/paneError';

export const MAX_WORKSPACE_WAIT_TIMEOUT_MS = 120_000;
// A backstop for abandoned requests; normal polls release their leases sooner.
const WATCH_LEASE_MS = MAX_WORKSPACE_WAIT_TIMEOUT_MS + 5_000;

export type WorkspaceWatchCancelReason = 'disconnected' | 'superseded' | 'replaced';

const CANCELLED = {
  disconnected: {
    code: 'ERR_WORKSPACE_WATCH_DISCONNECTED',
    message: 'Workspace watch client disconnected',
    next: 'Run runpane watch again if you still need it.',
  },
  superseded: {
    code: 'ERR_WORKSPACE_WATCH_SUPERSEDED',
    message: 'Workspace watch superseded by a new request for this cursor',
    next: 'Another watcher now owns this cursor: keep that one, or watch under a different --as name.',
  },
  replaced: {
    code: 'ERR_WORKSPACE_WATCH_REPLACED',
    message: 'Workspace watch replaced by a retry from the same watcher for this cursor',
    next: 'Nothing to do: the same watcher re-armed this cursor, and runpane keeps waiting on the new request.',
  },
} satisfies Record<WorkspaceWatchCancelReason, { code: string; message: string; next: string }>;

export class WorkspaceWatchCancelledError extends PaneError {
  constructor(readonly reason: WorkspaceWatchCancelReason) {
    super(CANCELLED[reason].code, CANCELLED[reason].message, CANCELLED[reason].next);
  }
}

interface NamedWatch {
  controller: AbortController;
  owner?: string;
}

/** Owns a whole watch request, so takeover cannot revive a superseded cadence loop. */
export class WorkspaceWatchLeases {
  private readonly named = new Map<string, NamedWatch>();
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

  /**
   * A new request for a named cursor takes it over. `owner` is the watcher's own token, kept across
   * its retries and reconnects: the same owner replaces its earlier wait quietly (`replaced`), and
   * any other caller, or one without a token, supersedes it.
   */
  acquire(name?: string, connection?: AbortSignal, owner?: string) {
    if (connection?.aborted) throw new WorkspaceWatchCancelledError('disconnected');
    const controller = new AbortController();
    if (name !== undefined) {
      const previous = this.named.get(name);
      const reason = owner !== undefined && previous?.owner === owner ? 'replaced' : 'superseded';
      previous?.controller.abort(new WorkspaceWatchCancelledError(reason));
      this.named.set(name, { controller, owner });
    }
    const disconnect = () => controller.abort(new WorkspaceWatchCancelledError('disconnected'));
    const release = () => {
      connection?.removeEventListener('abort', disconnect);
      clearTimeout(timer);
      if (name !== undefined && this.named.get(name)?.controller === controller) {
        this.named.delete(name);
        this.lastReleasedAt.set(name, Date.now());
      }
    };
    const timer = setTimeout(() => {
      controller.abort(new Error('Workspace watch lease expired'));
      release();
    }, WATCH_LEASE_MS);
    timer.unref();
    controller.signal.addEventListener('abort', release, { once: true });
    connection?.addEventListener('abort', disconnect, { once: true });
    return { signal: controller.signal, release };
  }
}
