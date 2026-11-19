import type { LoadGateState } from '../../../../shared/types/todos';

/**
 * The load gate (P10, D-408): no fixed cap on to-dos at once. It reads machine-wide CPU and the OS
 * memory pressure level and moves between Normal, Holding and Shedding, with different thresholds to
 * enter and leave and minimum times so it doesn't flap. Every to-do start asks it first. All the
 * numbers are here, enforced in code, and tested on a fake clock and sampler.
 */
export const LOAD_GATE = {
  sampleEveryMs: 10_000,
  hold: { cpuAvgPercent: 85, cpuWindowMs: 60_000, memoryWindowMs: 30_000 },
  releaseHold: { cpuBelowPercent: 70, forMs: 120_000 },
  shed: { cpuPercent: 95, cpuForMs: 180_000, memoryCriticalForMs: 60_000 },
  releaseShed: { cpuBelowPercent: 85, forMs: 120_000 },
  /** Queued to-dos start one at a time this far apart while Normal. */
  queuedStartSpacingMs: 30_000,
  /** Paused to-dos resume first, after this long in Normal, one at a time this far apart. */
  resumeAfterNormalMs: 5 * 60_000,
  resumeSpacingMs: 2 * 60_000,
  /** Shedding pauses one in-progress to-do this often, newest-started first. */
  shedSpacingMs: 2 * 60_000,
  /** A shed to-do's tabs pause once idle, or after this long at most. */
  shedGraceMs: 10 * 60_000,
  /** Samples older than this are dropped. */
  keepSamplesMs: 4 * 60_000,
} as const;

export type MemoryLevel = 'ok' | 'warning' | 'critical' | 'unknown';

export interface LoadSample {
  at: number;
  /** Machine-wide CPU, 0–100; null when unknown. */
  cpuPercent: number | null;
  memory: MemoryLevel;
}

export interface LoadGateChange {
  from: LoadGateState;
  to: LoadGateState;
  at: number;
  why: string;
}

function memoryHigh(level: MemoryLevel): boolean {
  return level === 'warning' || level === 'critical';
}

export class LoadGate {
  private samples: LoadSample[] = [];
  private current: LoadGateState = 'normal';
  private enteredAt = 0;
  private reason = '';
  private lastStartAt = -Infinity;
  private lastResumeAt = -Infinity;
  private lastShedAt = -Infinity;

  constructor(private readonly isEnabled: () => boolean = () => true) {}

  /** The state starts and sheds obey: always Normal while the setting is off. */
  get state(): LoadGateState {
    return this.isEnabled() ? this.current : 'normal';
  }

  /** The state from readings alone, setting aside the setting. */
  get measuredState(): LoadGateState {
    return this.current;
  }

  get since(): number {
    return this.enteredAt;
  }

  get latest(): LoadSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Records a reading and moves the gate if a threshold has held long enough. Returns the change, if any. */
  record(sample: LoadSample): LoadGateChange | null {
    this.samples.push(sample);
    const keepFrom = sample.at - LOAD_GATE.keepSamplesMs;
    while (this.samples.length > 0 && this.samples[0].at < keepFrom) this.samples.shift();
    const next = this.evaluate(sample.at);
    if (!next || next.to === this.current) return null;
    const change: LoadGateChange = { from: this.current, to: next.to, at: sample.at, why: next.why };
    this.current = next.to;
    this.enteredAt = sample.at;
    this.reason = next.why;
    return change;
  }

  /** Forgets readings (sampling stopped because nothing is in progress or queued); the state is kept. */
  forgetSamples(): void {
    this.samples = [];
  }

  /** Whether `test` held for every reading over the last `forMs`, and the readings reach back that far. */
  private heldFor(now: number, forMs: number, test: (sample: LoadSample) => boolean): boolean {
    const from = now - forMs;
    const first = this.samples[0];
    // A reading at (or within one sample period after) the window's start counts as covering it.
    if (!first || first.at > from + LOAD_GATE.sampleEveryMs / 2) return false;
    return this.samples.filter(sample => sample.at >= from - LOAD_GATE.sampleEveryMs / 2).every(test);
  }

  private cpuAverage(now: number, windowMs: number): number | null {
    const from = now - windowMs;
    const first = this.samples[0];
    if (!first || first.at > from + LOAD_GATE.sampleEveryMs / 2) return null;
    const readings = this.samples.filter(sample => sample.at > from - LOAD_GATE.sampleEveryMs / 2 && sample.cpuPercent !== null);
    if (readings.length === 0) return null;
    return readings.reduce((sum, sample) => sum + (sample.cpuPercent ?? 0), 0) / readings.length;
  }

  private shedCondition(now: number): string | null {
    if (this.heldFor(now, LOAD_GATE.shed.memoryCriticalForMs, sample => sample.memory === 'critical')) return 'memory pressure critical';
    if (this.heldFor(now, LOAD_GATE.shed.cpuForMs, sample => sample.cpuPercent !== null && sample.cpuPercent >= LOAD_GATE.shed.cpuPercent)) return `CPU at ${LOAD_GATE.shed.cpuPercent}% or more`;
    return null;
  }

  private holdCondition(now: number): string | null {
    if (this.heldFor(now, LOAD_GATE.hold.memoryWindowMs, sample => memoryHigh(sample.memory))) return 'memory pressure high';
    const average = this.cpuAverage(now, LOAD_GATE.hold.cpuWindowMs);
    if (average !== null && average >= LOAD_GATE.hold.cpuAvgPercent) return `CPU at ${Math.round(average)}%`;
    return null;
  }

  private evaluate(now: number): { to: LoadGateState; why: string } | null {
    const shed = this.shedCondition(now);
    if (this.current !== 'shedding' && shed) return { to: 'shedding', why: shed };
    if (this.current === 'normal') {
      const hold = this.holdCondition(now);
      return hold ? { to: 'holding', why: hold } : null;
    }
    const released = this.heldFor(now, LOAD_GATE.releaseHold.forMs, sample => (sample.cpuPercent ?? 0) < LOAD_GATE.releaseHold.cpuBelowPercent && sample.memory !== 'warning' && sample.memory !== 'critical');
    if (released) return { to: 'normal', why: 'load came down' };
    if (this.current === 'shedding') {
      const eased = this.heldFor(now, LOAD_GATE.releaseShed.forMs, sample => (sample.cpuPercent ?? 0) < LOAD_GATE.releaseShed.cpuBelowPercent && sample.memory !== 'critical');
      if (eased) return { to: 'holding', why: this.holdCondition(now) ?? 'load easing' };
    }
    return null;
  }

  // ── Decisions ───────────────────────────────────────────────────────────

  /** A start (new Session, Start, Resume, Reopen, restart, delivery resume) may go now. */
  allowsStart(): boolean {
    return this.state === 'normal';
  }

  /** The next queued to-do may start: Normal, and 30 s since the last queued start. */
  mayStartQueued(now: number): boolean {
    return this.allowsStart() && now - this.lastStartAt >= LOAD_GATE.queuedStartSpacingMs;
  }

  noteQueuedStart(now: number): void {
    this.lastStartAt = now;
  }

  /** The next paused to-do may resume: 5 min of Normal, and 2 min since the last resume. */
  mayResumePaused(now: number): boolean {
    if (!this.allowsStart()) return false;
    if (this.isEnabled() && now - this.enteredAt < LOAD_GATE.resumeAfterNormalMs && this.enteredAt !== 0) return false;
    return now - this.lastResumeAt >= LOAD_GATE.resumeSpacingMs;
  }

  noteResume(now: number): void {
    this.lastResumeAt = now;
    this.lastStartAt = now;
  }

  /** Shedding, and 2 min since the last to-do was paused. */
  mayShed(now: number): boolean {
    return this.state === 'shedding' && now - this.lastShedAt >= LOAD_GATE.shedSpacingMs;
  }

  noteShed(now: number): void {
    this.lastShedAt = now;
  }

  /** "devbox is busy: memory pressure high for 3 min"; undefined while Normal. */
  line(machineName: string, now: number): string | undefined {
    if (this.state === 'normal') return undefined;
    const forMinutes = Math.max(1, Math.round((now - this.enteredAt) / 60_000));
    return `${machineName} is busy: ${this.reason} for ${forMinutes} min`;
  }
}

/** Picks which in-progress to-do to pause: newest-started first, skipping the floors. */
export interface ShedCandidate {
  number: number;
  startedAt: number;
  waitingOnYou: boolean;
  neverPause: boolean;
  /** Your unsent text in one of its tabs, or a pinned or focused Pane. */
  protectedTab: boolean;
}

export function pickShedTarget(running: readonly ShedCandidate[]): number | null {
  // Never the last running to-do: one always keeps moving.
  if (running.length <= 1) return null;
  const eligible = running
    .filter(candidate => !candidate.waitingOnYou && !candidate.neverPause && !candidate.protectedTab)
    .sort((a, b) => b.startedAt - a.startedAt);
  return eligible[0]?.number ?? null;
}
