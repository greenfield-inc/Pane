const DEFAULT_IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
const DEFAULT_IDEMPOTENCY_MAX_KEYS = 2_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

interface IdempotencyEntry<T> {
  startedAt: number;
  promise: Promise<T>;
}

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Receiver-side dedupe for side-effecting requests. The first request with a
 * key runs; repeats inside the window (including while it is still running)
 * get its result. A run that throws is forgotten so a retry can send, because
 * submit throws only before it writes to the terminal.
 */
export class IdempotencyWindow<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();

  constructor(
    private readonly windowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
    private readonly maxKeys = DEFAULT_IDEMPOTENCY_MAX_KEYS,
    private readonly now: () => number = Date.now,
  ) {}

  /** `shouldRemember` returning false forgets a finished run (it sent nothing), so a retry sends. */
  async run(
    key: string,
    task: () => Promise<T>,
    shouldRemember: (result: T) => boolean = () => true,
  ): Promise<{ result: T; deduplicated: boolean }> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      return { result: await existing.promise, deduplicated: true };
    }

    const promise = task();
    this.entries.set(key, { startedAt: this.now(), promise });
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const forget = () => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    };
    try {
      const result = await promise;
      if (!shouldRemember(result)) forget();
      return { result, deduplicated: false };
    } catch (error) {
      forget();
      throw error;
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, entry] of this.entries) {
      if (entry.startedAt >= cutoff) break;
      this.entries.delete(key);
    }
  }
}
