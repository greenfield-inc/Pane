/** Three quick tries in the first ~3 s, then doubling delays up to the cap. */
const QUICK_RETRY_DELAYS_MS = [250, 750, 2_000];

/** The wait before retry number `attempt` (from 0), with ±20 % jitter. Shared by reconnects and request retries. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random, maxDelayMs = 30_000): number {
  const base = QUICK_RETRY_DELAYS_MS[attempt] ?? 4_000 * 2 ** (attempt - QUICK_RETRY_DELAYS_MS.length);
  return Math.min(maxDelayMs, Math.round(Math.min(base, maxDelayMs) * (0.8 + random() * 0.4)));
}

/** One outage budget. A handshake never resets it; only completed restoration does. */
export class RecoveryCycle {
  private deadline: number | null = null;
  private attempt = 0;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly durationMs = 300_000,
    private readonly maxDelayMs = 30_000,
  ) {}

  get remainingMs(): number {
    this.deadline ??= Date.now() + this.durationMs;
    return Math.max(0, this.deadline - Date.now());
  }

  nextDelay(): number | null {
    const remaining = this.remainingMs;
    if (!remaining) return null;
    return Math.min(remaining, backoffDelayMs(this.attempt++, this.random, this.maxDelayMs));
  }

  reset(): void {
    this.deadline = null;
    this.attempt = 0;
  }
}
