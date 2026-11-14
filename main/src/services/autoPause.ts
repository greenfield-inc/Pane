import type { ToolPanel, TerminalPausedMark } from '../../../shared/types/panels';
import type { PauseOutcome } from './terminalPanelManager';
import { pausedMarkOf } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { DEFAULT_AUTO_PAUSE_HOURS, DEFAULT_CHAT_RELEASE_MINUTES, isValidAutoPauseHours, isValidChatReleaseMinutes } from '../../../shared/types/autoPause';
import { paneInactiveSince, type PaneActivityInput } from './paneInactivity';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** How often auto-pause looks for idle Panes. */
const AUTO_PAUSE_SWEEP_MS = 5 * 60 * 1000;

export interface AutoPausePane extends Omit<PaneActivityInput, 'panels'> {
  id: string;
  archived?: boolean;
}

export interface AutoPauseDependencies {
  now(): number;
  settings(): { enabled?: boolean; hours?: number; chatMinutes?: number };
  /** Every Pane that is not archived, Session chat Panes included. */
  panes(): AutoPausePane[];
  panels(paneId: string): ToolPanel[];
  /** A running tab's in-memory activity: terminal output or input, or a chat agent's last update or message. */
  liveActivity(panelId: string): Date | undefined;
  agentState(panelId: string): AgentState | undefined;
  hasOpenNotify(panelIds: readonly string[]): boolean;
  /** The Pane the person has selected in a focused Pane window, if any. */
  focusedPaneId(): string | undefined;
  /** The Pane selected in a Pane window that is on screen (shown and not minimized), focused or not. */
  shownPaneId(): string | undefined;
  /** A tab an app update stopped and still holds for its own restore. */
  heldByUpdate(panel: ToolPanel): boolean;
  /** Pauses a whole Pane: its tabs and its run script. */
  pause(paneId: string, mark: TerminalPausedMark): Promise<PauseOutcome>;
  /** Whether a chat tab's agent is running (or starting). */
  chatRunning(panelId: string): boolean;
  /** Stops chat tabs' agents; one with work in flight is left running and reported in `failed`. */
  pauseChats(panelIds: string[], mark: TerminalPausedMark): Promise<PauseOutcome>;
  /** Tests and QA only (`PANE_AUTO_PAUSE_TEST_THRESHOLD_MS`): a short threshold, swept every few seconds. */
  testThresholdMs?: number;
}

/**
 * Pauses Panes nobody has used for the configured hours (on by default, 48 hours). A Pane
 * is idle when its `inactiveSince` is older than the threshold. It never pauses the Pane
 * selected in a focused window, a Pane whose agent waits on the person (a blocked prompt or
 * an open Notify card), an archived or already paused Pane, or tabs an update still holds.
 *
 * Chat tabs also pause on their own, after `chatMinutes` (30 by default) with no message, agent
 * update or selection, under the same switch and the same skips, and never while their Pane is on
 * screen, even in an unfocused window; a chat tab with a turn, a
 * queued message, an approval, a question or a background task is never paused. Opening or
 * messaging a paused chat tab starts its agent again in the same conversation.
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
    const paused = await this.pauseIdlePanes(hours, now);
    await this.pauseIdleChats(settings.chatMinutes, now);
    return paused;
  }

  private async pauseIdlePanes(hours: number, now: number): Promise<string[]> {
    const paused: string[] = [];
    for (const pane of this.deps.panes()) {
      // Read per Pane: each pause takes seconds, and the person may focus a Pane meanwhile.
      if (pane.archived || pane.id === this.deps.focusedPaneId()) continue;
      const terminals = this.deps.panels(pane.id).filter(panel => panel.type === 'terminal');
      const running = terminals.filter(panel => !pausedMarkOf(panel));
      if (running.length === 0) continue;
      if (running.some(panel => this.deps.agentState(panel.id) === 'blocked' || this.deps.heldByUpdate(panel))) continue;
      if (this.deps.hasOpenNotify(running.map(panel => panel.id))) continue;
      const inactiveSince = paneInactiveSince({ ...pane, panels: this.deps.panels(pane.id) }, this.deps.liveActivity);
      if (now - inactiveSince.getTime() < (this.deps.testThresholdMs ?? hours * HOUR_MS)) continue;
      // One Pane that cannot pause never stops the sweep for the Panes after it.
      try {
        const outcome = await this.deps.pause(pane.id, { at: new Date(now).toISOString(), by: 'auto', idleHours: hours });
        if (outcome.failed.length > 0) console.error(`[AutoPause] Pane ${pane.id} did not fully pause:`, outcome.failed);
        if (outcome.paused.length > 0) paused.push(pane.id);
      } catch (error) {
        console.error(`[AutoPause] Pane ${pane.id} could not be paused:`, error);
      }
    }
    return paused;
  }

  /** Stops the agents of chat tabs idle for the chat threshold. Returns the tabs it paused. */
  private async pauseIdleChats(chatMinutes: number | undefined, now: number): Promise<string[]> {
    const minutes = chatMinutes !== undefined && isValidChatReleaseMinutes(chatMinutes) ? chatMinutes : DEFAULT_CHAT_RELEASE_MINUTES;
    const threshold = this.deps.testThresholdMs ?? minutes * MINUTE_MS;
    const idle: string[] = [];
    for (const pane of this.deps.panes()) {
      if (pane.archived || pane.id === this.deps.shownPaneId()) continue;
      for (const panel of this.deps.panels(pane.id)) {
        if (panel.type !== 'chat' || !this.deps.chatRunning(panel.id)) continue;
        if (this.deps.agentState(panel.id) === 'blocked' || this.deps.hasOpenNotify([panel.id])) continue;
        const lastUsed = Math.max(Date.parse(panel.metadata.lastActiveAt) || 0, this.deps.liveActivity(panel.id)?.getTime() ?? 0);
        if (now - lastUsed >= threshold) idle.push(panel.id);
      }
    }
    if (idle.length === 0) return [];
    try {
      const outcome = await this.deps.pauseChats(idle, { at: new Date(now).toISOString(), by: 'auto' });
      // A tab that started work since the sweep read it is left running; that is not a failure.
      return outcome.paused;
    } catch (error) {
      console.error('[AutoPause] Idle chat tabs could not be paused:', error);
      return [];
    }
  }
}
