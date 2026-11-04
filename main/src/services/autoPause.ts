import type { ToolPanel, TerminalPausedMark } from '../../../shared/types/panels';
import { pausedMarkOf } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { DEFAULT_AUTO_PAUSE_HOURS, isValidAutoPauseHours } from '../../../shared/types/autoPause';
import { paneInactiveSince, type PaneActivityInput } from './paneInactivity';

const HOUR_MS = 60 * 60 * 1000;
/** How often auto-pause looks for idle Panes. */
export const AUTO_PAUSE_SWEEP_MS = 5 * 60 * 1000;

export interface AutoPausePane extends Omit<PaneActivityInput, 'panels'> {
  id: string;
  archived?: boolean;
}

export interface AutoPauseDependencies {
  now(): number;
  settings(): { enabled?: boolean; hours?: number };
  /** Every Pane that is not archived, Session chat Panes included. */
  panes(): AutoPausePane[];
  panels(paneId: string): ToolPanel[];
  liveActivity(panelId: string): Date | undefined;
  agentState(panelId: string): AgentState | undefined;
  hasOpenNotify(panelIds: readonly string[]): boolean;
  /** The Pane the person has selected in a focused Pane window, if any. */
  focusedPaneId(): string | undefined;
  /** A tab an app update stopped and still holds for its own restore. */
  heldByUpdate(panel: ToolPanel): boolean;
  pause(panelIds: readonly string[], mark: TerminalPausedMark): Promise<string[]>;
  /** Tests and QA only (`PANE_AUTO_PAUSE_TEST_THRESHOLD_MS`): a short threshold, swept every few seconds. */
  testThresholdMs?: number;
}

/**
 * Pauses Panes nobody has used for the configured hours (on by default, 48 hours). A Pane
 * is idle when its `inactiveSince` is older than the threshold. It never pauses the Pane
 * selected in a focused window, a Pane whose agent waits on the person (a blocked prompt or
 * an open Notify card), an archived or already paused Pane, or tabs an update still holds.
 */
export class AutoPauser {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<string[]> | undefined;

  constructor(private readonly deps: AutoPauseDependencies) {}

  /** Starts or stops the periodic sweep to match the setting. */
  sync(): void {
    if (this.deps.settings().enabled === false) {
      this.stop();
      return;
    }
    if (this.timer) return;
    const every = this.deps.testThresholdMs ? Math.min(AUTO_PAUSE_SWEEP_MS, 5000) : AUTO_PAUSE_SWEEP_MS;
    this.timer = setInterval(() => { void this.sweep().catch(error => console.error('[AutoPause] Sweep failed:', error)); }, every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Pauses every idle Pane now. Returns the Panes it paused. */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<string[]> {
    const settings = this.deps.settings();
    if (settings.enabled === false) return [];
    const hours = settings.hours !== undefined && isValidAutoPauseHours(settings.hours) ? settings.hours : DEFAULT_AUTO_PAUSE_HOURS;
    const now = this.deps.now();
    const focused = this.deps.focusedPaneId();
    const paused: string[] = [];
    for (const pane of this.deps.panes()) {
      if (pane.archived || pane.id === focused) continue;
      const terminals = this.deps.panels(pane.id).filter(panel => panel.type === 'terminal');
      const running = terminals.filter(panel => !pausedMarkOf(panel));
      if (running.length === 0) continue;
      if (running.some(panel => this.deps.agentState(panel.id) === 'blocked' || this.deps.heldByUpdate(panel))) continue;
      if (this.deps.hasOpenNotify(running.map(panel => panel.id))) continue;
      const inactiveSince = paneInactiveSince({ ...pane, panels: this.deps.panels(pane.id) }, this.deps.liveActivity);
      if (now - inactiveSince.getTime() < (this.deps.testThresholdMs ?? hours * HOUR_MS)) continue;
      const done = await this.deps.pause(running.map(panel => panel.id), { at: new Date(now).toISOString(), by: 'auto', idleHours: hours });
      if (done.length > 0) paused.push(pane.id);
    }
    return paused;
  }
}
