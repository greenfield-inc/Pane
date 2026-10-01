import { PaneCommandError } from '../../core/commandError';

/** The longest stop lease a safe-to-stop request may ask for. */
export const MAX_STOP_LEASE_MS = 120_000;
export const SESSION_STOPPING_CODE = 'ERR_SESSION_STOPPING';

/** The only channels a held lease lets through: the coordinator's own check and its release. */
const LEASE_EXEMPT_CHANNELS: ReadonlySet<string> = new Set([
  'runpane:cloud:safe-to-stop',
  'runpane:cloud:stop-lease:release',
]);

/**
 * The fence between the coordinator's "safe" and its provider stop (boat snapshots ~4 s after the stop
 * call): while held, the daemon refuses every other call from every origin (paired clients, peers, the
 * local socket) with a retryable ERR_SESSION_STOPPING, so no submit or new agent turn can start and then
 * be lost in the snapshot. The coordinator releases it when it does not stop; otherwise it lapses, by
 * which time the sandbox is off. In memory only: a daemon restart drops it.
 */
export class StopLease {
  private expiresAt: number | null = null;

  constructor(private readonly now: () => number) {}

  grant(ms: number) {
    this.expiresAt = this.now() + ms;
    return { expiresAt: this.expiresAt, ms };
  }

  release(): boolean {
    const held = this.isHeld();
    this.expiresAt = null;
    return held;
  }

  isHeld(): boolean {
    if (this.expiresAt !== null && this.now() >= this.expiresAt) this.expiresAt = null;
    return this.expiresAt !== null;
  }

  /** The error a fenced call gets, or null when the call may run. */
  refusal(channel: string): PaneCommandError | null {
    if (LEASE_EXEMPT_CHANNELS.has(channel) || !this.isHeld()) return null;
    const retryAfterMs = Math.max(0, (this.expiresAt ?? 0) - this.now());
    return new PaneCommandError(
      'This cloud Session is being stopped by its coordinator; nothing new can start. Retry once it is asleep (a submit wakes it).',
      SESSION_STOPPING_CODE,
      { retryAfterMs },
    );
  }
}
