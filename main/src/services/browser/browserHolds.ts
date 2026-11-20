/**
 * Which browser tabs keep their page alive while hidden. Two kinds of hold:
 * - Agent holds (D-126, P4): a tab an agent acted on stays alive, up to `limit` per agent, until
 *   `idleMs` passes with no action from it. A running call counts as action.
 * - Watch holds: a tab any of the person's screens shows (this computer's window, another desktop,
 *   the phone) stays alive while it does and for `watch.graceMs` after the last one leaves, so
 *   moving between devices never reloads it. At most `watch.limit` tabs are kept this way, not
 *   counting agent holds. A screen that stops reporting for `watch.silentMs` has left.
 * A hold that ends puts the tab to sleep: its page reloads from its URL on next use. Holds live in
 * memory only.
 */
export interface BrowserHoldOptions {
  limit: number;
  idleMs: number;
  watch: WatchLimits;
  /** The kept tabs changed: the window keeps exactly these pages alive while hidden. */
  onChange(held: readonly string[]): void;
  now?: () => number;
}

export interface WatchLimits { limit: number; graceMs: number; silentMs: number }

/** What kind of screen watches a tab, as browser_tabs names it. */
export type ViewerKind = 'host' | 'desktop' | 'phone' | 'web';

/** What a screen showing a tab reports every few seconds. */
export interface ViewerReport {
  kind: ViewerKind;
  /** Whether the tab is on that screen now (not a background tab, app or window). */
  onScreen: boolean;
  /** The space the screen gives the page, in CSS pixels; a viewer that takes control resizes the page to it. */
  width: number;
  height: number;
  /** The screen's device pixels per CSS pixel, so the page renders sharp there. */
  scale?: number;
}

export interface Viewer extends ViewerReport { id: string; lastSeen: number }

interface Hold { agent: string; lastAction: number; running: number }
interface Watch { viewers: Map<string, Viewer>; lastWatched: number; lastOnScreen: number }

export class BrowserHolds {
  private readonly holds = new Map<string, Hold>();
  private readonly watches = new Map<string, Watch>();
  private readonly asleep = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: BrowserHoldOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Tab ids whose pages stay alive now, for the window. */
  held(): string[] {
    return [...new Set([...this.holds.keys(), ...this.watches.keys()])];
  }

  /** Whether an agent holds the tab (browser_tabs' `held`). */
  isHeld(tabId: string): boolean {
    return this.holds.has(tabId);
  }

  /** Whether the tab's hold ended (idle, or another hold took its place), so its page reloads on next use. */
  isAsleep(tabId: string): boolean {
    return this.asleep.has(tabId);
  }

  /** The screens showing the tab now. */
  viewers(tabId: string): Viewer[] {
    return [...this.watches.get(tabId)?.viewers.values() ?? []];
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

  /** A screen shows the tab (or still does). A watched tab over the limit puts another to sleep. */
  watch(tabId: string, viewerId: string, report: ViewerReport): void {
    const now = this.now();
    const existing = this.watches.get(tabId);
    // A report with the tab off screen keeps a watch going but never starts one (nor wakes the tab).
    if (!existing && !report.onScreen) return;
    this.asleep.delete(tabId);
    const watch = existing ?? { viewers: new Map<string, Viewer>(), lastWatched: now, lastOnScreen: now };
    const before = watch.viewers.get(viewerId);
    // A screen joining, or coming back on screen, can change which pages keep painting for other devices.
    const changed = before === undefined || before.onScreen !== report.onScreen;
    watch.viewers.set(viewerId, { ...report, id: viewerId, lastSeen: now });
    watch.lastWatched = now;
    if (report.onScreen) watch.lastOnScreen = now;
    if (existing) {
      if (changed) this.changed();
      return;
    }
    this.watches.set(tabId, watch);
    this.overWatchLimit(tabId);
    this.changed();
  }

  /** A screen stopped showing the tab; the page stays for the grace time after the last one. */
  unwatch(tabId: string, viewerId: string): void {
    const watch = this.watches.get(tabId);
    if (!watch?.viewers.delete(viewerId)) return;
    watch.lastWatched = this.now();
    this.changed();
  }

  /** Puts the agent's longest-idle hold to sleep while it holds more than `limit`; returns the last one. */
  private overLimit(agent: string, keep: string): string | undefined {
    let evicted: string | undefined;
    for (;;) {
      const mine = [...this.holds].filter(([, other]) => other.agent === agent);
      if (mine.length <= this.options.limit) return evicted;
      const [idlest] = mine.filter(([id, other]) => id !== keep && other.running === 0).sort(([, a], [, b]) => a.lastAction - b.lastAction)[0] ?? [];
      if (!idlest) return evicted;
      this.dropHold(idlest);
      evicted = idlest;
    }
  }

  /** Puts the watched tab longest off every screen to sleep while more than `watch.limit` are kept; agent holds don't count. */
  private overWatchLimit(keep: string): string | undefined {
    let evicted: string | undefined;
    for (;;) {
      const kept = [...this.watches].filter(([id]) => !this.holds.has(id));
      if (kept.length <= this.options.watch.limit) return evicted;
      const [idlest] = kept
        .filter(([id, watch]) => id !== keep && ![...watch.viewers.values()].some(viewer => viewer.onScreen))
        .sort(([, a], [, b]) => a.lastOnScreen - b.lastOnScreen)[0] ?? [];
      if (!idlest) return evicted;
      this.dropWatch(idlest);
      evicted = idlest;
    }
  }

  /**
   * Puts holds idle for `idleMs` to sleep, drops the holds of agents that are gone, forgets screens
   * that stopped reporting, ends watches past their grace time, and forgets tabs that closed.
   */
  sweep(agentAlive: (agent: string) => boolean, busy: (tabId: string) => boolean, tabExists: (tabId: string) => boolean): void {
    let changed = false;
    const now = this.now();
    for (const [tabId, hold] of this.holds) {
      if (!tabExists(tabId)) {
        this.holds.delete(tabId);
        changed = true;
        continue;
      }
      if (hold.running > 0 || busy(tabId)) continue;
      if (!agentAlive(hold.agent) || now - hold.lastAction >= this.options.idleMs) {
        this.dropHold(tabId);
        changed = true;
      }
    }
    for (const [tabId, watch] of this.watches) {
      if (!tabExists(tabId)) {
        this.watches.delete(tabId);
        changed = true;
        continue;
      }
      for (const [id, viewer] of watch.viewers) {
        if (now - viewer.lastSeen < this.options.watch.silentMs) continue;
        watch.viewers.delete(id);
        watch.lastWatched = Math.max(watch.lastWatched, viewer.lastSeen);
        changed = true;
      }
      // A screen that has the tab off screen (a minimized window, a backgrounded app) doesn't keep it:
      // the grace time runs from the last moment any screen had it on screen.
      const shown = [...watch.viewers.values()].some(viewer => viewer.onScreen);
      if (shown || now - Math.max(watch.lastOnScreen, watch.viewers.size > 0 ? 0 : watch.lastWatched) < this.options.watch.graceMs || busy(tabId)) continue;
      this.dropWatch(tabId);
      changed = true;
    }
    if (changed) this.changed();
  }

  /**
   * This computer's window went away: its own screen stops watching every tab at once, with no
   * grace, so its pages don't reload into hidden windows nobody watches. Agent holds and other
   * devices' watches stay.
   */
  forgetScreensOfKind(kind: ViewerKind): void {
    let changed = false;
    for (const [tabId, watch] of this.watches) {
      for (const [id, viewer] of watch.viewers) if (viewer.kind === kind) watch.viewers.delete(id);
      if (watch.viewers.size > 0) continue;
      this.dropWatch(tabId);
      changed = true;
    }
    if (changed) this.changed();
  }

  /** The tab closed: forget it. */
  forget(tabId: string): void {
    this.asleep.delete(tabId);
    const held = this.holds.delete(tabId);
    const watched = this.watches.delete(tabId);
    if (held || watched) this.changed();
  }

  /** Ends an agent's hold; the tab sleeps unless a screen still keeps it. */
  private dropHold(tabId: string): void {
    this.holds.delete(tabId);
    if (!this.watches.has(tabId)) this.asleep.add(tabId);
  }

  /** Ends a tab's watch; the tab sleeps unless an agent still holds it. */
  private dropWatch(tabId: string): void {
    this.watches.delete(tabId);
    if (!this.holds.has(tabId)) this.asleep.add(tabId);
  }

  private changed(): void {
    this.options.onChange(this.held());
  }
}
