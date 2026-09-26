/**
 * Continuous agent-status state machine.
 *
 * Owns per-panel status trackers and arbitrates a published {@link AgentState}
 * from three signals: the screen/OSC {@link AgentDetectionResult}, recent PTY
 * byte-activity, and elapsed time. It is timer-free and clock-injectable.
 * Explicit blockers and working chrome win first, then reliable idle evidence.
 * Activity is a fallback when there is no live chrome, or extends existing work
 * behind a weak prompt (Claude keeps its composer visible during a turn).
 */

import type { AgentDetectionResult, AgentState } from '../../../../shared/types/agentStatus';

export interface AgentStatusMonitorOptions {
  /** How long PTY activity keeps a panel working before it may settle idle. */
  idleSettleMs?: number;
  /** Ignore unclassified boot output for this long after registration. */
  startupGraceMs?: number;
}

interface PanelTracker {
  startedAt: number;
  lastActivityAt: number | undefined;
  activityChunksInBurst: number;
  published: AgentState | undefined;
}

const AGENT_IDLE_SETTLE_MS = 10_000;

const DEFAULTS: Required<AgentStatusMonitorOptions> = {
  idleSettleMs: AGENT_IDLE_SETTLE_MS,
  startupGraceMs: 3000,
};

export class AgentStatusMonitor {
  private readonly trackers = new Map<string, PanelTracker>();
  private readonly options: Required<AgentStatusMonitorOptions>;

  constructor(options: AgentStatusMonitorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Begin tracking an agent panel. Only registered panels ever emit. */
  register(panelId: string, now: number): void {
    this.trackers.set(panelId, {
      startedAt: now,
      lastActivityAt: undefined,
      activityChunksInBurst: 0,
      published: undefined,
    });
  }

  unregister(panelId: string): void {
    this.trackers.delete(panelId);
  }

  isTracked(panelId: string): boolean {
    return this.trackers.has(panelId);
  }

  /** Number of panels currently tracked. */
  get size(): number {
    return this.trackers.size;
  }

  /** Record that PTY bytes were produced for a panel at `now`. */
  noteActivity(panelId: string, now: number): void {
    const tracker = this.trackers.get(panelId);
    if (!tracker) return;

    // Boot banners and shell prompt setup are not evidence of a task. Explicit
    // agent working chrome still takes effect immediately, including at startup.
    if (now - tracker.startedAt < this.options.startupGraceMs && tracker.published !== 'working') return;

    const startsNewBurst =
      tracker.lastActivityAt === undefined || now - tracker.lastActivityAt >= this.options.idleSettleMs;
    tracker.activityChunksInBurst = startsNewBurst ? 1 : tracker.activityChunksInBurst + 1;
    tracker.lastActivityAt = now;
  }

  getState(panelId: string): AgentState | undefined {
    return this.trackers.get(panelId)?.published;
  }

  /**
   * Re-evaluate a panel. Returns the newly published state when it changed, or
   * null when unchanged / still debouncing / not tracked.
   */
  update(panelId: string, detection: AgentDetectionResult, now: number): AgentState | null {
    const tracker = this.trackers.get(panelId);
    if (!tracker) return null;

    // Agent-owned viewer (transcript/model picker): hold the known state.
    if (detection.skipStateUpdate) return null;

    const { idleSettleMs } = this.options;
    const recentlyActive =
      tracker.lastActivityAt !== undefined && now - tracker.lastActivityAt < idleSettleMs;
    const activityCanPublishWorking =
      (tracker.published === 'working' || detection.matchedRuleId === null) &&
      (tracker.published !== 'idle' || tracker.activityChunksInBurst >= 2);

    // A blank boot screen is not yet an idle agent. Keep the initial unknown
    // state until live chrome appears or the startup grace expires.
    if (now - tracker.startedAt < this.options.startupGraceMs &&
        detection.matchedRuleId === null && !recentlyActive &&
        !detection.visibleWorking && !detection.visibleIdle && detection.state !== 'blocked') return null;

    let candidate: AgentState;
    if (detection.state === 'blocked') {
      candidate = 'blocked';
    } else if (detection.visibleWorking) {
      candidate = 'working';
      // Visible work is activity evidence too, even before boot output is trusted.
      tracker.lastActivityAt = now;
    } else if (detection.visibleIdle) {
      candidate = 'idle';
      tracker.lastActivityAt = undefined;
      tracker.activityChunksInBurst = 0;
    } else if (recentlyActive && activityCanPublishWorking) {
      candidate = 'working';
    } else {
      candidate = 'idle';
    }

    if (tracker.published === candidate) return null;
    tracker.published = candidate;
    return candidate;
  }
}
