import { EventEmitter } from 'events';
import * as os from 'os';
import { MACHINE_HEALTH_DEFAULTS, type HealthLevel, type LeakWarning, type MachineHealthSettings, type MachineHealthSnapshot, type PaneUsage, type StorageInventory } from '../../../../shared/types/machineHealth';
import type { ResourceSnapshot } from '../../../../shared/types/resourceMonitor';
import { readDiskVolumes, type VolumePath } from './diskSpace';
import { findLeak, leakRuleOf, type LeakRule, type RssSample } from './leakRule';
import { readMemoryPressure, readSwapUsedBytes, settleLevel, worstLevel, type MemoryPressureReading } from './memoryPressure';

const SAMPLE_INTERVAL_MS = 60_000;
const FIRST_SAMPLE_DELAY_MS = 20_000;
const INVENTORY_INTERVAL_MS = 24 * 60 * 60_000;
const FIRST_INVENTORY_DELAY_MS = 10 * 60_000;
/** A disk warning rescans only when the last scan is older than this, so a level flapping at a threshold costs one walk an hour. */
const INVENTORY_FRESH_MS = 60 * 60_000;
const GB = 1024 ** 3;
const MINUTE = 60_000;
const FOOTPRINT_SLACK_MS = 5_000;

function diskLevel(freeBytes: number, settings: MachineHealthSettings | undefined): HealthLevel {
  if (freeBytes < (settings?.diskCriticalGB ?? MACHINE_HEALTH_DEFAULTS.diskCriticalGB) * GB) return 'critical';
  if (freeBytes < (settings?.diskWarningGB ?? MACHINE_HEALTH_DEFAULTS.diskWarningGB) * GB) return 'warning';
  return 'ok';
}

export interface MachineHealthDeps {
  now: () => number;
  settings: () => MachineHealthSettings | undefined;
  volumePaths: () => VolumePath[];
  processes: () => Promise<ResourceSnapshot>;
  /** Walks storage off the main thread; run daily, on demand, and when disk reaches the warning level. */
  scanInventory: () => Promise<StorageInventory>;
  readDisk?: typeof readDiskVolumes;
  readMemory?: () => Promise<MemoryPressureReading>;
  readSwap?: () => Promise<number | null>;
  memory?: () => { totalBytes: number; freeBytes: number };
  cpuTimes?: () => CpuTimes;
  /** macOS footprints (pid → MB); when given, the leak rule reads these once a slice instead of RSS every sample. */
  readFootprints?: () => Promise<Map<number, number> | null>;
}

/** Summed CPU times of every core, in ms. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export interface LevelChange {
  kind: 'disk' | 'memory';
  level: HealthLevel;
  previous: HealthLevel;
}

interface ProcessHistory {
  startedAt: number;
  samples: RssSample[];
}

function machineCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Samples free disk, memory pressure and every Pane process once a minute,
 * keeps each process's RSS for the leak window in memory, and emits
 * `level-changed` and `leak` when a level moves or a process starts to leak.
 * Nothing is stored: a restart begins a fresh window.
 */
export class MachineHealthService extends EventEmitter {
  private latest: MachineHealthSnapshot | null = null;
  private memoryHistory: HealthLevel[] = [];
  private history = new Map<string, ProcessHistory>();
  /** Processes warned about, with their latest warning; kept until the process exits. */
  private flagged = new Map<string, LeakWarning>();
  private ignored = new Set<string>();
  private lastCpu: CpuTimes | null = null;
  private footprintsAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<MachineHealthSnapshot> | null = null;
  private inventory: StorageInventory | null = null;
  private inventoryInFlight: Promise<StorageInventory> | null = null;
  private inventoryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MachineHealthDeps) {
    super();
  }

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => {
      void this.sampleSafely();
      this.timer = setInterval(() => void this.sampleSafely(), SAMPLE_INTERVAL_MS);
      this.timer.unref?.();
    }, FIRST_SAMPLE_DELAY_MS);
    first.unref?.();
    this.timer = first;
    const firstScan = setTimeout(() => {
      void this.scanSafely();
      this.inventoryTimer = setInterval(() => void this.scanSafely(), INVENTORY_INTERVAL_MS);
      this.inventoryTimer.unref?.();
    }, FIRST_INVENTORY_DELAY_MS);
    firstScan.unref?.();
    this.inventoryTimer = firstScan;
    this.on('level-changed', (change: LevelChange) => {
      if (change.kind !== 'disk' || change.level === 'ok') return;
      if (this.inventory && this.deps.now() - this.inventory.scannedAt < INVENTORY_FRESH_MS) return;
      void this.scanSafely();
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    this.timer = null;
    this.inventoryTimer = null;
  }

  /**
   * The cached inventory, or null before the first scan finishes. Never waits for a walk. With none, a read
   * starts one scan (shared with any in flight) and nothing else; `refresh` (Measure now, Run now) scans and
   * then runs the scheduled pass. `inventory` fires when a scan ends.
   */
  getInventory(refresh = false): StorageInventory | null {
    if (refresh) void this.scanSafely();
    else if (!this.inventory && !this.inventoryInFlight) void this.scanInventory().catch(() => undefined);
    return this.inventory;
  }

  /** One scan; concurrent callers share it. */
  scanInventory(): Promise<StorageInventory> {
    this.inventoryInFlight ??= this.deps.scanInventory()
      .then(inventory => {
        this.inventory = inventory;
        this.emit('inventory', inventory);
        return inventory;
      })
      .finally(() => { this.inventoryInFlight = null; });
    return this.inventoryInFlight;
  }

  private async scanSafely(): Promise<void> {
    try {
      await this.scanInventory();
    } catch (error) {
      console.warn('[MachineHealth] storage scan failed:', error instanceof Error ? error.message : error);
    }
  }

  /** The latest sample, taking one first when none exists yet. */
  async getSnapshot(): Promise<MachineHealthSnapshot> {
    return this.latest ?? this.sample();
  }

  /** "Ignore for this process": no leak card until that process exits. */
  ignoreLeak(pid: number, started: string): void {
    this.ignored.add(`${pid}:${started}`);
  }

  private async sampleSafely(): Promise<void> {
    try {
      await this.sample();
    } catch (error) {
      console.warn('[MachineHealth] sample failed:', error instanceof Error ? error.message : error);
    }
  }

  /** One sample; concurrent callers share it. */
  sample(): Promise<MachineHealthSnapshot> {
    this.inFlight ??= this.takeSample().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async takeSample(): Promise<MachineHealthSnapshot> {
    const settings = this.deps.settings();
    const now = this.deps.now();
    const [readings, memoryReading, swapUsedBytes, processes] = await Promise.all([
      (this.deps.readDisk ?? readDiskVolumes)(this.deps.volumePaths()),
      (this.deps.readMemory ?? (() => readMemoryPressure()))(),
      (this.deps.readSwap ?? (() => readSwapUsedBytes()))(),
      this.readProcesses(),
    ]);
    const volumes = readings.map(volume => ({ ...volume, level: diskLevel(volume.freeBytes, settings) }));

    this.memoryHistory = [...this.memoryHistory, memoryReading.level].slice(-2);
    const memory = this.deps.memory?.() ?? { totalBytes: os.totalmem(), freeBytes: os.freemem() };
    const cpuTimes = this.deps.cpuTimes?.() ?? machineCpuTimes();
    const cpuPercent = this.lastCpu && cpuTimes.total > this.lastCpu.total
      ? Math.round((1 - (cpuTimes.idle - this.lastCpu.idle) / (cpuTimes.total - this.lastCpu.total)) * 1000) / 10
      : 0;
    this.lastCpu = cpuTimes;

    const snapshot: MachineHealthSnapshot = {
      sampledAt: now,
      platform: process.platform,
      hostname: os.hostname(),
      disk: { level: worstLevel(volumes.map(volume => volume.level)), volumes },
      memory: { level: settleLevel(this.memoryHistory), source: memoryReading.source, detail: memoryReading.detail, ...memory, swapUsedBytes },
      cpuPercent,
      // A failed process read is not an empty table: keep the last figures, leak history and ignores.
      ...(processes ? await this.processUsage(processes, now, leakRuleOf(settings)) : {
        app: this.latest?.app ?? { rssMB: 0, cpuPercent: 0 },
        panes: this.latest?.panes ?? [],
        leaks: this.latest?.leaks ?? [],
      }),
    };

    const previous = this.latest;
    this.latest = snapshot;
    if (previous) {
      for (const kind of ['disk', 'memory'] as const) {
        if (previous[kind].level !== snapshot[kind].level) {
          this.emit('level-changed', { kind, level: snapshot[kind].level, previous: previous[kind].level } satisfies LevelChange);
        }
      }
    } else {
      for (const kind of ['disk', 'memory'] as const) {
        if (snapshot[kind].level !== 'ok') this.emit('level-changed', { kind, level: snapshot[kind].level, previous: 'ok' } satisfies LevelChange);
      }
    }
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  private async readProcesses(): Promise<ResourceSnapshot | null> {
    try {
      return await this.deps.processes();
    } catch (error) {
      console.warn('[MachineHealth] process read failed, keeping the last process figures:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async processUsage(processes: ResourceSnapshot, now: number, rule: LeakRule): Promise<Pick<MachineHealthSnapshot, 'app' | 'panes' | 'leaks'>> {
    let footprints: Map<number, number> | null = null;
    // A few seconds of slack: timer jitter must not push a read to the next sample.
    if (this.deps.readFootprints && now - this.footprintsAt >= Math.max(MINUTE, rule.sliceMs) - FOOTPRINT_SLACK_MS) {
      // A failed read waits a slice too: top costs over a second of CPU.
      this.footprintsAt = now;
      footprints = await this.deps.readFootprints();
    }
    const panes: PaneUsage[] = processes.sessions.map(session => ({
      sessionId: session.sessionId,
      name: session.sessionName,
      rssMB: session.totalMemoryMB,
      cpuPercent: session.totalCpuPercent,
      processes: session.children.map(child => ({
        pid: child.pid,
        started: child.started,
        name: child.name,
        command: child.command,
        sessionId: session.sessionId,
        panelId: child.panelId,
        rssMB: Math.round(child.memoryMB * 10) / 10,
        cpuPercent: child.cpuPercent,
        escaped: child.escaped,
      })),
    }));
    return {
      app: {
        rssMB: Math.round(processes.electronProcesses.reduce((sum, p) => sum + p.memoryMB, 0)),
        cpuPercent: Math.round(processes.electronProcesses.reduce((sum, p) => sum + p.cpuPercent, 0) * 10) / 10,
      },
      panes,
      leaks: this.updateLeaks(panes, now, rule, footprints),
    };
  }

  private updateLeaks(panes: PaneUsage[], now: number, rule: LeakRule, footprints: Map<number, number> | null): LeakWarning[] {
    const usesFootprints = !!this.deps.readFootprints;
    const live = new Set<string>();
    const leaks: LeakWarning[] = [];
    const keepMs = rule.windowMs + rule.sliceMs;
    for (const pane of panes) {
      for (const proc of pane.processes) {
        const key = `${proc.pid}:${proc.started}`;
        live.add(key);
        const entry = this.history.get(key) ?? { startedAt: this.startedAtOf(proc.started, now), samples: [] };
        const footprint = footprints?.get(proc.pid);
        if (!usesFootprints) entry.samples.push({ at: now, rssMB: proc.rssMB });
        else if (footprint !== undefined) entry.samples.push({ at: now, rssMB: footprint });
        while (entry.samples.length > 1 && entry.samples[1].at <= now - keepMs) entry.samples.shift();
        this.history.set(key, entry);
        if (this.ignored.has(key)) continue;
        const previous = this.flagged.get(key);
        if (usesFootprints && footprint === undefined) {
          // No new reading since the last footprint read: keep a standing warning as it was.
          if (previous) leaks.push(previous);
          continue;
        }
        const finding = findLeak(entry.samples, entry.startedAt, now, rule);
        if (!finding) {
          this.flagged.delete(key);
          continue;
        }
        const warning: LeakWarning = {
          pid: proc.pid, started: proc.started, name: proc.name, sessionId: proc.sessionId, panelId: proc.panelId,
          memoryMB: finding.rssMB, growthMB: finding.growthMB, windowMs: finding.windowMs,
          series: entry.samples.filter(s => s.at >= now - rule.windowMs).map(s => Math.round(s.rssMB)),
        };
        leaks.push(warning);
        this.flagged.set(key, warning);
        if (!previous) this.emit('leak', warning);
      }
    }
    for (const key of [...this.history.keys()]) {
      if (live.has(key)) continue;
      this.history.delete(key);
      this.flagged.delete(key);
      this.ignored.delete(key);
    }
    return leaks;
  }

  /** POSIX start text parses as a date; Windows ticks and WSL keys fall back to first sight. */
  private startedAtOf(started: string, now: number): number {
    if (/^\d{15,}$/u.test(started)) return Number((BigInt(started) - 621355968000000000n) / 10000n);
    const parsed = Date.parse(started);
    return Number.isFinite(parsed) ? parsed : now;
  }
}
