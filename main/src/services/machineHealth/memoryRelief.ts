import type { CleanupRun, CleanupSource, HealthProcess, MachineHealthSettings, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';

/** A process lifetime: the pid and its start time as the OS printed it. */
interface ProcessIdentity {
  pid: number;
  started: string;
}

export interface MemoryReliefDeps {
  now: () => number;
  paneName: (paneId: string) => string;
  /** Asks each process to stop, then forces it, only while pid and start time still match; resolves with those still running. */
  stop: (identities: readonly ProcessIdentity[]) => Promise<ProcessIdentity[]>;
  /** Panes auto-pause would pause after `hours` idle, with its skips (focused, waiting on you, open card, update hold). */
  idlePanes: (hours: number) => string[];
  /** Pauses those of `paneIds` that are still idle for `hours`, with the same skips; resolves with the ones it paused. */
  pauseIdle: (hours: number, paneIds: readonly string[]) => Promise<string[]>;
  /** A pinned Pane is never paused to relieve memory. */
  pinned: (paneId: string) => boolean;
  paneMemoryMB: (paneId: string) => number;
  settings: () => MachineHealthSettings | undefined;
  record: (run: CleanupRun) => void;
}

const DEFAULT_PAUSE_IDLE_HOURS = 2;

export interface IdleOffer {
  paneIds: string[];
  memoryMB: number;
}

/**
 * Processes that left their tab's tree but still carry a Pane's id. Any of them can be
 * something the person started on purpose (tmux, an editor, a database), so Pane never
 * stops one by itself: they are listed with what they are and stop only when asked.
 */
export function leftoverProcesses(snapshot: MachineHealthSnapshot): HealthProcess[] {
  return snapshot.panes.flatMap(pane => pane.processes.filter(proc => proc.escaped));
}

/** Under memory pressure: offer (or, opted in, do) an early pause of idle Panes; list processes left behind by finished work. */
export class MemoryRelief {
  private latest: MachineHealthSnapshot | null = null;
  private pausedThisEpisode = false;

  constructor(private readonly deps: MemoryReliefDeps) {}

  private hours(): number {
    return this.deps.settings()?.pauseIdleHours ?? DEFAULT_PAUSE_IDLE_HOURS;
  }

  async onSnapshot(snapshot: MachineHealthSnapshot): Promise<void> {
    this.latest = snapshot;
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
    const paneIds = this.idlePanes();
    return { paneIds, memoryMB: paneIds.reduce((sum, id) => sum + this.deps.paneMemoryMB(id), 0) };
  }

  private idlePanes(): string[] {
    return this.deps.idlePanes(this.hours()).filter(id => !this.deps.pinned(id));
  }

  leftBehind(): HealthProcess[] {
    return this.latest ? leftoverProcesses(this.latest) : [];
  }

  async pauseIdle(source: CleanupSource): Promise<CleanupRun> {
    const idle = this.idlePanes();
    const memory = new Map(idle.map(id => [id, this.deps.paneMemoryMB(id)]));
    const paused = await this.deps.pauseIdle(this.hours(), idle);
    const run: CleanupRun = {
      at: this.deps.now(), source, skipped: [], freedBytes: 0,
      removed: paused.map(id => ({ id, kind: 'idle-pane' as const, path: this.deps.paneName(id), sizeBytes: Math.round((memory.get(id) ?? 0) * 1024 * 1024) })),
    };
    this.deps.record(run);
    return run;
  }

  /** Stops the named processes, when the person asks, if they still run with the same start time. */
  async stopProcesses(processes: readonly HealthProcess[], source: CleanupSource): Promise<CleanupRun> {
    const running = await this.deps.stop(processes.map(proc => ({ pid: proc.pid, started: proc.started })));
    const stillRunning = new Set(running.map(identity => `${identity.pid}:${identity.started}`));
    const entry = (proc: HealthProcess) => ({ id: `${proc.pid}:${proc.started}`, kind: 'leftover-process' as const, path: `${proc.name} (${this.deps.paneName(proc.sessionId)})`, sizeBytes: Math.round(proc.rssMB * 1024 * 1024) });
    const run: CleanupRun = {
      at: this.deps.now(), source, freedBytes: 0,
      removed: processes.filter(proc => !stillRunning.has(`${proc.pid}:${proc.started}`)).map(entry),
      skipped: processes.filter(proc => stillRunning.has(`${proc.pid}:${proc.started}`)).map(proc => ({ ...entry(proc), reason: 'It did not stop.' })),
    };
    this.deps.record(run);
    return run;
  }
}
