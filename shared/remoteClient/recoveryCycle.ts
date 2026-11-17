/** Three quick tries in the first ~3 s, then doubling delays up to the cap. */
const QUICK_RETRY_DELAYS_MS = [250, 750, 2_000];

/** The wait before retry number `attempt` (from 0), with ±20 % jitter. Shared by reconnects and request retries. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random, maxDelayMs = 30_000): number {
  const base = QUICK_RETRY_DELAYS_MS[attempt] ?? 4_000 * 2 ** (attempt - QUICK_RETRY_DELAYS_MS.length);
  return Math.min(maxDelayMs, Math.round(Math.min(base, maxDelayMs) * (0.8 + random() * 0.4)));
}

/** The host sends a heartbeat every 5 s; a stream silent this long (two missed, with room for a slow one) is dead. */
export const STALE_STREAM_TIMEOUT_MS = 12_000;

/** A computer behind Pane's relay is retried this often at most, so it is back within seconds of an outage ending. */
export const RELAY_MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * After this long unreachable, a relay computer is likely gone (uninstalled or replaced) rather than asleep: retry it
 * about once a minute instead (D-73). A computer that wakes still reconnects at once through its own stream.
 */
const RELAY_SLOW_AFTER_MS = 60 * 60_000;
const RELAY_SLOW_MAX_DELAY_MS = 60_000;

/** A computer reached through a relay is never given up on while the app is open (D-15); only a revoked token stops it. */
export function relayRecoveryCycle(maxDelayMs = RELAY_MAX_RECONNECT_DELAY_MS): RecoveryCycle {
  return new RecoveryCycle(Math.random, Number.POSITIVE_INFINITY, maxDelayMs, { afterMs: RELAY_SLOW_AFTER_MS, maxDelayMs: RELAY_SLOW_MAX_DELAY_MS });
}

/** One outage budget. A handshake never resets it; only completed restoration does. */
export class RecoveryCycle {
  private startedAt: number | null = null;
  private attempt = 0;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly durationMs = 300_000,
    private readonly maxDelayMs = 30_000,
    /** Once the outage has lasted `afterMs`, retries wait up to this `maxDelayMs` instead. */
    private readonly slow?: { afterMs: number; maxDelayMs: number },
  ) {}

  get remainingMs(): number {
    this.startedAt ??= Date.now();
    return Math.max(0, this.startedAt + this.durationMs - Date.now());
  }

  nextDelay(): number | null {
    const remaining = this.remainingMs;
    if (!remaining) return null;
    const outageMs = Date.now() - (this.startedAt ?? Date.now());
    const cap = this.slow && outageMs >= this.slow.afterMs ? this.slow.maxDelayMs : this.maxDelayMs;
    return Math.min(remaining, backoffDelayMs(this.attempt++, this.random, cap));
  }

  reset(): void {
    this.startedAt = null;
    this.attempt = 0;
  }
}
