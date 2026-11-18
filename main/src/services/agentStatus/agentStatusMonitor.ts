/**
 * Continuous agent-status state machine.
 *
 * Owns per-panel status trackers and arbitrates a published {@link AgentState}
 * from three signals: the screen/OSC {@link AgentDetectionResult}, recent PTY
 * byte-activity (the "working" authority), and elapsed time. It is deliberately
 * timer-free and clock-injectable — the caller re-evaluates on PTY output and on
 * a short poll, so debounce/grace windows resolve purely from timestamps, which
 * keeps the machine fully unit-testable.
 *
 * Arbitration precedence: a state the program reported itself (OSC 7501)
 * stands as is; then a visible blocker wins immediately; otherwise recent
 * activity (or a working detection) means working; otherwise idle. PTY activity
 * stays authoritative for a measured settle window, and a single trailing chunk
 * cannot wake an already-idle panel unless working chrome is visible.
 */

import type { AgentDetectionResult, AgentState } from '../../../../shared/types/agentStatus';

export interface AgentStatusMonitorOptions {
  /** How long PTY activity keeps a panel working before it may settle idle. */
  idleSettleMs?: number;
  /** Idle is suppressed for this long after a panel registers. */
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

    const { idleSettleMs, startupGraceMs } = this.options;
    const recentlyActive =
      tracker.lastActivityAt !== undefined && now - tracker.lastActivityAt < idleSettleMs;
    const activityCanPublishWorking =
      tracker.published !== 'idle' || tracker.activityChunksInBurst >= 2;

    let candidate: AgentState;
    if (detection.reported) {
      candidate = detection.state;
    } else if (detection.state === 'blocked') {
      candidate = 'blocked';
    } else if (detection.visibleWorking || (recentlyActive && activityCanPublishWorking)) {
      candidate = 'working';
    } else {
      candidate = 'idle';
    }

    // Startup grace: a freshly launched agent shouldn't flash idle before it boots.
    if (candidate === 'idle' && !detection.reported && now - tracker.startedAt < startupGraceMs) {
      candidate = tracker.published ?? 'working';
    }

    if (tracker.published === candidate) return null;
    tracker.published = candidate;
    return candidate;
  }
}
