/**
 * Save terminal scrollback while the daemon runs. A boat stop is a power-off
 * with no SIGTERM, so a save at shutdown never happens; after a wake,
 * `panels screen`/`output` and the desktop read what the last checkpoint kept.
 * Only panels with output since their last save are written.
 */
export interface ScrollbackCheckpointDeps {
  intervalMs: number;
  listRunningPanelIds(): string[];
  getOutputGeneration(panelId: string): number;
  save(panelId: string): Promise<void>;
  log(message: string, error?: Error): void;
}

export class ScrollbackCheckpoint {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly savedGeneration = new Map<string, number>();

  constructor(private readonly deps: ScrollbackCheckpointDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkpoint(); }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Save every panel with new output; returns how many were saved. Calls overlap into one run. */
  checkpoint(): Promise<number> {
    this.running ??= this.runCheckpoint().finally(() => { this.running = null; });
    return this.running;
  }

  private async runCheckpoint(): Promise<number> {
    const live = new Set(this.deps.listRunningPanelIds());
    for (const panelId of this.savedGeneration.keys()) {
      if (!live.has(panelId)) this.savedGeneration.delete(panelId);
    }
    let saved = 0;
    for (const panelId of live) {
      const generation = this.deps.getOutputGeneration(panelId);
      if (this.savedGeneration.get(panelId) === generation) continue;
      try {
        await this.deps.save(panelId);
        this.savedGeneration.set(panelId, generation);
        saved += 1;
      } catch (error) {
        this.deps.log(`[ScrollbackCheckpoint] Could not save panel ${panelId}`, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return saved;
  }
}
