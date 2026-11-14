/**
 * Each Session's live activity: working or idle, decided once on the host that runs its agents
 * and sent to every client (sidebar, All machines, web app and phone), so they all agree and a
 * reconnect re-reads it rather than guessing.
 *
 * The counted tabs are the orchestrator's own agent tabs and the agent tabs of the Session's
 * Panes (not archived or missing). Each tab answers the stricter mid-turn test
 * (agentStatus/midTurn.ts). The orchestrator, and each Pane, turns working once one of its tabs
 * has been mid-turn without a break for 10 s, and idle once none of its tabs has been mid-turn
 * for 10 s; a tab that is closed or leaves stops counting at once. The Session is working while
 * any of them is; "N working" counts the working Panes, so the label and the icon never
 * disagree. All state is in memory.
 */

import { EventEmitter } from 'events';
import type { SessionActivity } from '../../../shared/types/orchestrationSession';

const SESSION_WORKING_AFTER_MS = 10_000;
const SESSION_IDLE_AFTER_MS = 10_000;
/** The host re-evaluates on this cadence, the same as the terminal status poll. */
const SESSION_ACTIVITY_TICK_MS = 500;
/**
 * The member list (which tabs each Session counts) reads Panes and panels from the database, so
 * it is rebuilt at most this often, and at once when a Session changes (invalidateMembers).
 */
const MEMBERS_REFRESH_MS = 2_000;

export interface SessionActivityMembers {
  sessionId: string;
  orchestratorPanelIds: readonly string[];
  panes: ReadonlyArray<{ paneId: string; panelIds: readonly string[] }>;
}

interface Tab {
  /** Mid-turn without a break since then; undefined while not mid-turn. */
  midTurnSince: number | undefined;
  lastMidTurnAt: number | undefined;
}

interface Unit {
  working: boolean;
  /** Only the unit's current tabs: one that leaves is forgotten. */
  tabs: Map<string, Tab>;
}

const ORCHESTRATOR = '\u0000orchestrator';

export class SessionActivityRollup {
  /** Per Session, its orchestrator unit and one unit per Pane. */
  private readonly units = new Map<string, Map<string, Unit>>();
  private readonly published = new Map<string, SessionActivity>();

  constructor(private readonly options: { workingAfterMs?: number; idleAfterMs?: number } = {}) {}

  /** Re-evaluate every Session at `now`; returns the Sessions whose state or count changed. */
  update(members: readonly SessionActivityMembers[], isMidTurn: (panelId: string) => boolean, now: number): SessionActivity[] {
    const workingAfter = this.options.workingAfterMs ?? SESSION_WORKING_AFTER_MS;
    const idleAfter = this.options.idleAfterMs ?? SESSION_IDLE_AFTER_MS;
    const changes: SessionActivity[] = [];
    const seen = new Set<string>();
    for (const session of members) {
      seen.add(session.sessionId);
      const previous = this.units.get(session.sessionId);
      const units = new Map<string, Unit>();
      const groups: Array<{ key: string; panelIds: readonly string[] }> = [{ key: ORCHESTRATOR, panelIds: session.orchestratorPanelIds }, ...session.panes.map(pane => ({ key: pane.paneId, panelIds: pane.panelIds }))];
      for (const { key, panelIds } of groups) {
        const before = previous?.get(key);
        const unit: Unit = { working: before?.working ?? false, tabs: new Map() };
        for (const panelId of panelIds) {
          const tab = before?.tabs.get(panelId) ?? { midTurnSince: undefined, lastMidTurnAt: undefined };
          if (isMidTurn(panelId)) {
            tab.midTurnSince ??= now;
            tab.lastMidTurnAt = now;
          } else {
            tab.midTurnSince = undefined;
          }
          unit.tabs.set(panelId, tab);
        }
        const tabs = [...unit.tabs.values()];
        if (!unit.working) unit.working = tabs.some(tab => tab.midTurnSince !== undefined && now - tab.midTurnSince >= workingAfter);
        else unit.working = tabs.some(tab => tab.lastMidTurnAt !== undefined && now - tab.lastMidTurnAt < idleAfter);
        units.set(key, unit);
      }
      this.units.set(session.sessionId, units);
      const workingPanes = [...units].filter(([key, unit]) => key !== ORCHESTRATOR && unit.working).length;
      const next: SessionActivity = {
        sessionId: session.sessionId,
        state: [...units.values()].some(unit => unit.working) ? 'working' : 'idle',
        workingPanes,
      };
      const last = this.published.get(session.sessionId);
      this.published.set(session.sessionId, next);
      if (last ? last.state !== next.state || last.workingPanes !== next.workingPanes : next.state !== 'idle') changes.push(next);
    }
    for (const [sessionId, last] of this.published) {
      if (seen.has(sessionId)) continue;
      this.published.delete(sessionId);
      this.units.delete(sessionId);
      if (last.state !== 'idle' || last.workingPanes > 0) changes.push({ sessionId, state: 'idle', workingPanes: 0 });
    }
    return changes;
  }

  /** Every known Session's current activity, for a client's baseline read. */
  snapshot(): SessionActivity[] {
    return [...this.published.values()].map(activity => ({ ...activity }));
  }
}

export interface SessionActivitySources {
  members(): SessionActivityMembers[];
  isMidTurn(panelId: string, now: number): boolean;
  now?(): number;
}

/**
 * Drives the rollup on the host: re-evaluates on the status poll's cadence and emits `changed`
 * with each Session whose activity changed. Started once at startup; no per-client timers.
 */
export class SessionActivityService extends EventEmitter {
  private readonly rollup = new SessionActivityRollup();
  private timer: ReturnType<typeof setInterval> | null = null;
  private members: { list: SessionActivityMembers[]; at: number } | null = null;

  constructor(private readonly sources: SessionActivitySources) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), SESSION_ACTIVITY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.sources.now?.() ?? Date.now();
    let changes: SessionActivity[];
    try {
      if (!this.members || now - this.members.at >= MEMBERS_REFRESH_MS) this.members = { list: this.sources.members(), at: now };
      changes = this.rollup.update(this.members.list, panelId => this.sources.isMidTurn(panelId, now), now);
    } catch (error) {
      console.error('[SessionActivity] Could not update Session activity:', error);
      return;
    }
    for (const change of changes) this.emit('changed', change);
  }

  snapshot(): SessionActivity[] {
    return this.rollup.snapshot();
  }

  /** A Session was created, archived, or gained or lost a Pane: read the members on the next tick. */
  invalidateMembers(): void {
    this.members = null;
  }
}
