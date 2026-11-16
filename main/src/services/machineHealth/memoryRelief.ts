import type { CleanupRun, CleanupSource, HealthProcess, MachineHealthSettings, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';

/** A process lifetime: the pid and its start time as the OS printed it. */
interface ProcessIdentity {
  pid: number;
  started: string;
}

export interface MemoryReliefDeps {
  now: () => number;
  paneState: (paneId: string) => 'archived' | 'paused' | 'open';
  paneName: (paneId: string) => string;
  /** Asks each process to stop, then forces it, only while pid and start time still match; resolves with those still running. */
  stop: (identities: readonly ProcessIdentity[]) => Promise<ProcessIdentity[]>;
  /** Panes auto-pause would pause after `hours` idle, with its skips (focused, waiting on you, open card, update hold). */
  idlePanes: (hours: number) => string[];
  pauseIdle: (hours: number) => Promise<string[]>;
  paneMemoryMB: (paneId: string) => number;
  settings: () => MachineHealthSettings | undefined;
  record: (run: CleanupRun) => void;
}

const DEFAULT_PAUSE_IDLE_HOURS = 2;
/** A process that would not stop is not tried again by itself for this long. */
const RETRY_AFTER_MS = 30 * 60_000;

export interface SortedLeftovers {
  stopNow: HealthProcess[];
  leftBehind: HealthProcess[];
}

export interface IdleOffer {
  paneIds: string[];
  memoryMB: number;
}

/**
 * Processes that left their tab's tree but still carry a Pane's id: a Pane that is
 * archived or paused can no longer use them, so they stop by themselves; those of
 * a live Pane are listed under "Left behind" and stop only when the person asks.
 */
export function sortLeftovers(snapshot: MachineHealthSnapshot, paneState: MemoryReliefDeps['paneState']): SortedLeftovers {
  const stopNow: HealthProcess[] = [];
  const leftBehind: HealthProcess[] = [];
  for (const pane of snapshot.panes) {
    const state = paneState(pane.sessionId);
    for (const proc of pane.processes) {
      if (!proc.escaped) continue;
      (state === 'open' ? leftBehind : stopNow).push(proc);
    }
  }
  return { stopNow, leftBehind };
}

/** Under memory pressure: offer (or, opted in, do) an early pause of idle Panes; stop processes left behind by finished work. */
export class MemoryRelief {
  private latest: MachineHealthSnapshot | null = null;
  private pausedThisEpisode = false;
  private failedAt = new Map<string, number>();

  constructor(private readonly deps: MemoryReliefDeps) {}

  private hours(): number {
    return this.deps.settings()?.pauseIdleHours ?? DEFAULT_PAUSE_IDLE_HOURS;
  }

  async onSnapshot(snapshot: MachineHealthSnapshot): Promise<void> {
    this.latest = snapshot;
    const { stopNow, leftBehind } = sortLeftovers(snapshot, this.deps.paneState);
    const automatic = this.deps.settings()?.autoStopLeftovers === true ? leftBehind : [];
    const now = this.deps.now();
    const due = [...stopNow, ...automatic].filter(proc => now - (this.failedAt.get(`${proc.pid}:${proc.started}`) ?? -Infinity) >= RETRY_AFTER_MS);
    if (due.length > 0) await this.stopProcesses(due, 'schedule');
    if (snapshot.memory.level === 'ok') {
      this.pausedThisEpisode = false;
      return;
    }
    if (this.deps.settings()?.autoPauseUnderPressure === true && !this.pausedThisEpisode) {
      this.pausedThisEpisode = true;
      await this.pauseIdle('schedule');
    }
  }

  /** What "Pause idle Panes" would do now: which Panes, and about how much memory they hold. */
  idleOffer(): IdleOffer {
    const paneIds = this.deps.idlePanes(this.hours());
    return { paneIds, memoryMB: paneIds.reduce((sum, id) => sum + this.deps.paneMemoryMB(id), 0) };
  }

  leftBehind(): HealthProcess[] {
    return this.latest ? sortLeftovers(this.latest, this.deps.paneState).leftBehind : [];
  }

  async pauseIdle(source: CleanupSource): Promise<CleanupRun> {
    const memory = new Map(this.deps.idlePanes(this.hours()).map(id => [id, this.deps.paneMemoryMB(id)]));
    const paused = await this.deps.pauseIdle(this.hours());
    const run: CleanupRun = {
      at: this.deps.now(), source, skipped: [], freedBytes: 0,
      removed: paused.map(id => ({ id, kind: 'idle-pane' as const, path: this.deps.paneName(id), sizeBytes: Math.round((memory.get(id) ?? 0) * 1024 * 1024) })),
    };
    this.deps.record(run);
    return run;
  }

  /** Stops the named processes if they still run with the same start time. */
  async stopProcesses(processes: readonly HealthProcess[], source: CleanupSource): Promise<CleanupRun> {
    const running = await this.deps.stop(processes.map(proc => ({ pid: proc.pid, started: proc.started })));
    const stillRunning = new Set(running.map(identity => `${identity.pid}:${identity.started}`));
    const entry = (proc: HealthProcess) => ({ id: `${proc.pid}:${proc.started}`, kind: 'leftover-process' as const, path: `${proc.name} (${this.deps.paneName(proc.sessionId)})`, sizeBytes: Math.round(proc.rssMB * 1024 * 1024) });
    for (const id of stillRunning) this.failedAt.set(id, this.deps.now());
    const run: CleanupRun = {
      at: this.deps.now(), source, freedBytes: 0,
      removed: processes.filter(proc => !stillRunning.has(`${proc.pid}:${proc.started}`)).map(entry),
      skipped: processes.filter(proc => stillRunning.has(`${proc.pid}:${proc.started}`)).map(proc => ({ ...entry(proc), reason: 'It did not stop.' })),
    };
    this.deps.record(run);
    return run;
  }
}
