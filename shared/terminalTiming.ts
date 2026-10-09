/** Numeric-only, fixed-capacity diagnostics. Never store input, output or panel IDs. */
export class TerminalTiming {
  private readonly samples: Record<string, number[]> = {};
  private readonly counts: Record<string, number> = {};

  record(metric: 'inputRoundTrip' | 'ptyWrite' | 'outputParse' | 'outputRender' | 'eventLoopDelay', ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const values = this.samples[metric] ??= [];
    const count = this.counts[metric] ?? 0;
    values[count % 128] = ms;
    this.counts[metric] = count + 1;
  }

  snapshot(): Record<string, { count: number; recentMs: number[] }> {
    return Object.fromEntries(Object.entries(this.samples).map(([metric, values]) => [
      metric, { count: this.counts[metric], recentMs: [...values] },
    ]));
  }
}
