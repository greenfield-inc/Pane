/**
 * Which browser tabs agents hold (D-126, P4): a tab an agent acted on stays alive while hidden, up
 * to `limit` per agent, until `idleMs` passes with no action from it; then it sleeps, and its page
 * reloads from its URL on next use. A running call counts as action. Holds live in memory only.
 */
export interface BrowserHoldOptions {
  limit: number;
  idleMs: number;
  /** The held tabs changed: the renderer keeps exactly these pages alive while hidden. */
  onChange(held: readonly string[]): void;
  now?: () => number;
}

interface Hold { agent: string; lastAction: number; running: number }

export class BrowserHolds {
  private readonly holds = new Map<string, Hold>();
  private readonly asleep = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: BrowserHoldOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Tab ids held now, for the renderer and browser_tabs. */
  held(): string[] {
    return [...this.holds.keys()];
  }

  isHeld(tabId: string): boolean {
    return this.holds.has(tabId);
  }

  /** Whether the tab's hold ended (idle, or another hold took its place), so its page reloads on next use. */
  isAsleep(tabId: string): boolean {
    return this.asleep.has(tabId);
  }

  /**
   * An agent starts a call on a tab: the tab is held while it runs and from then on. Returns the
   * tab a fifth hold put to sleep, and whether this tab was asleep.
   */
  begin(agent: string, tabId: string): { evicted?: string; wasAsleep: boolean } {
    const wasAsleep = this.asleep.delete(tabId);
    const existing = this.holds.get(tabId);
    const hold: Hold = existing ?? { agent, lastAction: this.now(), running: 0 };
    hold.agent = agent;
    hold.running += 1;
    hold.lastAction = this.now();
    if (!existing) this.holds.set(tabId, hold);
    const evicted = this.overLimit(agent, tabId);
    this.changed();
    return evicted === undefined ? { wasAsleep } : { evicted, wasAsleep };
  }

  /** The call finished; the idle clock starts now. Calls that all ran at once may leave the agent over its limit. */
  end(tabId: string): void {
    const hold = this.holds.get(tabId);
    if (!hold) return;
    hold.running = Math.max(0, hold.running - 1);
    hold.lastAction = this.now();
    if (this.overLimit(hold.agent, tabId) !== undefined) this.changed();
  }

  /** Puts the agent's longest-idle hold to sleep while it holds more than `limit`; returns the last one. */
  private overLimit(agent: string, keep: string): string | undefined {
    let evicted: string | undefined;
    for (;;) {
      const mine = [...this.holds].filter(([, other]) => other.agent === agent);
      if (mine.length <= this.options.limit) return evicted;
      const [idlest] = mine.filter(([id, other]) => id !== keep && other.running === 0).sort(([, a], [, b]) => a.lastAction - b.lastAction)[0] ?? [];
      if (!idlest) return evicted;
      this.sleep(idlest);
      evicted = idlest;
    }
  }

  /** Puts holds idle for `idleMs` to sleep, drops the holds of agents that are gone, and forgets tabs that closed. */
  sweep(agentAlive: (agent: string) => boolean, busy: (tabId: string) => boolean, tabExists: (tabId: string) => boolean): void {
    let changed = false;
    for (const [tabId, hold] of this.holds) {
      if (!tabExists(tabId)) {
        this.holds.delete(tabId);
        changed = true;
        continue;
      }
      if (hold.running > 0 || busy(tabId)) continue;
      if (!agentAlive(hold.agent) || this.now() - hold.lastAction >= this.options.idleMs) {
        this.sleep(tabId);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** The tab closed: forget it. */
  forget(tabId: string): void {
    this.asleep.delete(tabId);
    if (this.holds.delete(tabId)) this.changed();
  }

  private sleep(tabId: string): void {
    this.holds.delete(tabId);
    this.asleep.add(tabId);
  }

  private changed(): void {
    this.options.onChange(this.held());
  }
}
