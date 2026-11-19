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
    let evicted: string | undefined;
    if (!existing) {
      this.holds.set(tabId, hold);
      const mine = [...this.holds].filter(([, other]) => other.agent === agent);
      if (mine.length > this.options.limit) {
        const [oldest] = mine.filter(([id, other]) => id !== tabId && other.running === 0).sort(([, a], [, b]) => a.lastAction - b.lastAction)[0] ?? [];
        if (oldest) {
          this.sleep(oldest);
          evicted = oldest;
        }
      }
    }
    this.changed();
    return evicted === undefined ? { wasAsleep } : { evicted, wasAsleep };
  }

  /** The call finished; the idle clock starts now. */
  end(tabId: string): void {
    const hold = this.holds.get(tabId);
    if (!hold) return;
    hold.running = Math.max(0, hold.running - 1);
    hold.lastAction = this.now();
  }

  /** Puts holds idle for `idleMs` to sleep, and drops the holds of agents that are gone. */
  sweep(agentAlive: (agent: string) => boolean, busy: (tabId: string) => boolean): void {
    let changed = false;
    for (const [tabId, hold] of this.holds) {
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
