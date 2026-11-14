export interface PausableInterval {
  /** While paused, ticks are skipped; unpausing runs once at once if any tick was skipped. */
  setPaused(paused: boolean): void;
  stop(): void;
}

/** An unref'd interval for background work that waits while nobody is looking and catches up after. */
export function createPausableInterval(run: () => void, intervalMs: number): PausableInterval {
  let paused = false;
  let skipped = false;
  const timer = setInterval(() => {
    if (paused) skipped = true;
    else run();
  }, intervalMs);
  timer.unref?.();
  return {
    setPaused(next) {
      paused = next;
      if (paused || !skipped) return;
      skipped = false;
      run();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
