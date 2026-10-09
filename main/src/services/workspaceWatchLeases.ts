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

/** Owns a whole watch request, so takeover cannot revive a superseded cadence loop. */
export class WorkspaceWatchLeases {
  private readonly named = new Map<string, AbortController>();

  acquire(name?: string, connection?: AbortSignal) {
    if (connection?.aborted) throw new WorkspaceWatchCancelledError('disconnected');
    const controller = new AbortController();
    if (name !== undefined) {
      this.named.get(name)?.abort(new WorkspaceWatchCancelledError('superseded'));
      this.named.set(name, controller);
    }
    const disconnect = () => controller.abort(new WorkspaceWatchCancelledError('disconnected'));
    const release = () => {
      connection?.removeEventListener('abort', disconnect);
      clearTimeout(timer);
      if (name !== undefined && this.named.get(name) === controller) this.named.delete(name);
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
