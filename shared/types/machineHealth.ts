import { RUNPANE_CONTRACT } from './generatedRunpaneContract';

/** Machine health: free disk, memory pressure, and what each Pane's processes cost. */

export type HealthLevel = 'ok' | 'warning' | 'critical';

/** Which OS signal produced the memory level. */
export type MemoryPressureSource = 'macos-pressure' | 'psi' | 'available';

/** Why a volume is watched: it holds Pane's data folder, a project's worktrees, or the OS temp folder. */
export type VolumeRole = 'pane-data' | 'worktrees' | 'temp';

export interface DiskVolume {
  /** The first watched path found on this volume. */
  path: string;
  roles: VolumeRole[];
  totalBytes: number;
  freeBytes: number;
  level: HealthLevel;
}

export interface HealthProcess {
  pid: number;
  /** Start time as the OS reports it; with the pid it names one process lifetime. */
  started: string;
  name: string;
  /** The full command line, at most 200 characters, when the OS gives it. */
  command?: string;
  sessionId: string;
  /** The tab that started it, when Pane knows. */
  panelId: string | null;
  rssMB: number;
  cpuPercent: number;
  /** Found by its PANE_SESSION_ID after it left its tab's process tree. */
  escaped: boolean;
}

export interface PaneUsage {
  sessionId: string;
  name: string;
  rssMB: number;
  cpuPercent: number;
  processes: HealthProcess[];
}

export interface LeakWarning {
  pid: number;
  started: string;
  name: string;
  sessionId: string;
  panelId: string | null;
  /** Memory now: the footprint on macOS (RSS leaves out compressed and swapped pages there), RSS elsewhere. */
  memoryMB: number;
  growthMB: number;
  windowMs: number;
  /** Memory readings in MB across the window, oldest first, for a sparkline. */
  series: number[];
}

export interface MachineHealthSnapshot {
  sampledAt: number;
  platform: NodeJS.Platform;
  hostname: string;
  disk: {
    level: HealthLevel;
    volumes: DiskVolume[];
  };
  memory: {
    level: HealthLevel;
    source: MemoryPressureSource;
    detail: string;
    totalBytes: number;
    freeBytes: number;
    swapUsedBytes: number | null;
  };
  /** Whole-machine CPU use since the previous sample, 0 to 100. */
  cpuPercent: number;
  /** Pane itself: the main process, renderers and helpers. */
  app: { rssMB: number; cpuPercent: number };
  panes: PaneUsage[];
  leaks: LeakWarning[];
}

/** Machine health settings in config.json; every field is an optional override of the default. */
export interface MachineHealthSettings {
  diskWarningGB?: number;
  diskCriticalGB?: number;
  leakWindowMinutes?: number;
  leakSliceMinutes?: number;
  leakMinRssMB?: number;
  leakMinGrowthMB?: number;
  leakMinGrowthPercent?: number;
  leakMinAgeMinutes?: number;
  /** Tier 2 "Do this automatically" switches; every one ships off. */
  autoClearAgentTemp?: boolean;
  autoClearPausedScratch?: boolean;
  autoClearArchivedFolders?: boolean;
  autoArchiveFinished?: boolean;
  /** A Pane counts as finished after this many idle days (default 14). */
  finishedIdleDays?: number;
  /** Under memory pressure, pause Panes idle this many hours (default 2). */
  pauseIdleHours?: number;
  autoPauseUnderPressure?: boolean;
}

/** The value of every machine health setting nobody has overridden. */
export const MACHINE_HEALTH_DEFAULTS = {
  diskWarningGB: 20,
  diskCriticalGB: 5,
  leakWindowMinutes: 30,
  leakSliceMinutes: 5,
  leakMinRssMB: 1024,
  leakMinGrowthMB: 500,
  leakMinGrowthPercent: 50,
  leakMinAgeMinutes: 30,
} as const satisfies Partial<Record<keyof MachineHealthSettings, number>>;

/** Sent without a payload when the disk or memory level changes; readers re-read the snapshot. */
export const MACHINE_HEALTH_CHANGED_EVENT = 'resource-monitor:machine-health-changed';
/** The read channel for this machine's latest snapshot; under resource-monitor: so daemon, phone and linked-machine allowlists already carry it. */
export const MACHINE_HEALTH_SNAPSHOT_CHANNEL = 'resource-monitor:machine-health';

/**
 * Tier 1: Pane made it and it can no longer be used; Pane removes it by itself.
 * Tier 2: Pane asks once, with sizes; each kind can be switched to automatic.
 * Tier 3: shown only, with its owner and how to free it.
 */
export type ReclaimTier = 1 | 2 | 3;

/** The kinds of reclaimable item; the runpane contract holds the list so the CLIs and the app agree. */
export const RECLAIM_KINDS = RUNPANE_CONTRACT.enums.reclaimKinds;
export type ReclaimKind = typeof RECLAIM_KINDS[number];

export interface ReclaimItem {
  /** Stable across scans: the kind and path. */
  id: string;
  kind: ReclaimKind;
  tier: ReclaimTier;
  path: string;
  /** Logical size. Freed bytes are measured from free space when cleanup runs. */
  sizeBytes: number;
  modifiedAt: number;
  /** The Pane it belongs to, when Pane knows. */
  sessionId: string | null;
  /** Plain words for why it can go, or who owns it. */
  reason: string;
  /** For worktree folders: the repository whose git records them. */
  projectPath?: string;
  /** Tier 3 only: the command or setting that frees it. */
  howToFree?: string;
}

export interface PaneDiskUsage {
  sessionId: string;
  name: string;
  worktreePath: string;
  /** Everything in the worktree, dependencies and scratch included. */
  worktreeBytes: number;
  dependencyBytes: number;
  buildOutputBytes: number;
  /** The worktree's .pane/scratch plus Pane's own scratch folder for this Pane. */
  scratchBytes: number;
  agentTempBytes: number;
}

/** Disk use by owner, for the stacked bar on the Resources page. */
export interface DiskBuckets {
  paneWorktrees: number;
  dependencies: number;
  qaAndScratch: number;
  agentTemp: number;
  paneData: number;
}

/** Where a cleanup came from: a person in Resources or a card, the schedule, or an agent through runpane. */
export type CleanupSource = 'ui' | 'card' | 'schedule' | 'cli';

/** What a cleanup acted on: a storage item, or a finished Pane it archived, a process it stopped, a Pane it paused. */
export type CleanupKind = ReclaimKind | 'finished-pane' | 'leftover-process' | 'idle-pane';

export interface CleanupEntry {
  id: string;
  kind: CleanupKind;
  /** A folder or file, or a Pane or process name. */
  path: string;
  sizeBytes: number;
  reason?: string;
}

export interface CleanupRun {
  at: number;
  source: CleanupSource;
  removed: CleanupEntry[];
  skipped: CleanupEntry[];
  /** Measured from free space on the affected volumes, before and after; never below 0. */
  freedBytes: number;
  /** True while removed items are still being deleted from the trash; freedBytes is filled in once they are. */
  deleting?: boolean;
}

export interface StorageInventory {
  scannedAt: number;
  durationMs: number;
  items: ReclaimItem[];
  panes: PaneDiskUsage[];
  buckets: DiskBuckets;
}

export const MACHINE_HEALTH_INVENTORY_CHANNEL = 'resource-monitor:machine-inventory';
export const MACHINE_HEALTH_INVENTORY_CHANGED_EVENT = 'resource-monitor:machine-inventory-changed';
/** Runs a cleanup through the one engine: `{ ids?, kinds?, source }`; tier 3 is refused. */
export const MACHINE_HEALTH_CLEANUP_CHANNEL = 'resource-monitor:machine-cleanup';
/** Finished Panes (PR merged or closed, folder missing, idle): `{ refresh? }`. */
export const MACHINE_HEALTH_FINISHED_CHANNEL = 'resource-monitor:machine-finished-panes';
export const MACHINE_HEALTH_FINISHED_CHANGED_EVENT = 'resource-monitor:machine-finished-changed';
/** Archives the named finished Panes through the normal archive path: `{ ids, source }`. */
export const MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL = 'resource-monitor:machine-archive-finished';
/** What memory relief would do now: `{ idle: { paneIds, memoryMB }, leftBehind: HealthProcess[] }`. */
export const MACHINE_HEALTH_RELIEF_CHANNEL = 'resource-monitor:machine-relief';
/** Pauses Panes idle past `pauseIdleHours` now: `{ source }`. */
export const MACHINE_HEALTH_PAUSE_IDLE_CHANNEL = 'resource-monitor:machine-pause-idle';
/** Stops processes the latest sample attributes to a Pane, by pid and start time: `{ processes: [{ pid, started }], source }`. */
export const MACHINE_HEALTH_STOP_PROCESSES_CHANNEL = 'resource-monitor:machine-stop-processes';
/** Restarts the run script a leaking process belongs to: `{ pid, started }`. */
export const MACHINE_HEALTH_RESTART_PROCESS_CHANNEL = 'resource-monitor:machine-restart-process';
/** No leak warning for this process until it exits: `{ pid, started }`. */
export const MACHINE_HEALTH_IGNORE_LEAK_CHANNEL = 'resource-monitor:machine-ignore-leak';
/** Hands `{ prompt }` to the agent of the open Session named `{ name }`, starting one if none is open; every machine health "Ask an agent". Returns `{ sessionId, panelId }`. */
export const MACHINE_HEALTH_ASK_AGENT_CHANNEL = 'resource-monitor:machine-ask-agent';
/** Recent cleanup runs on this machine, newest first; held in memory since the last start. */
export const MACHINE_HEALTH_HISTORY_CHANNEL = 'resource-monitor:machine-cleanup-history';

/** One row on a machine health card: a process, a Pane, or a reclaimable item. */
export interface HealthCardRow {
  label: string;
  detail: string;
  /** Memory (memory and leak cards) or disk bytes (disk and finished cards). */
  bytes: number;
  /** finished cards: why the Pane is finished, or why it is skipped; leftovers cards: the pid. */
  note?: string;
  skipped?: boolean;
  /** leftovers cards: the process's command line. */
  command?: string;
}

/**
 * Carried on a Pane-raised Notify card (`NotifyItem.machineHealth`) so newer screens draw the
 * machine health dialog; an older Pane drops the field and shows a plain card whose choices
 * still answer it.
 */
export interface MachineHealthCard {
  kind: 'disk' | 'memory' | 'leak' | 'finished' | 'leftovers';
  level: HealthLevel;
  /** The raising machine's OS hostname. */
  hostname: string;
  freeBytes?: number;
  totalBytes?: number;
  usedBytes?: number;
  swapUsedBytes?: number | null;
  rows: HealthCardRow[];
  /** memory cards: what "Pause idle Panes" stops. */
  pauseOffer?: { paneCount: number; memoryMB: number; hours: number };
  /** leak cards: the process and its memory across the window. */
  leak?: { pid: number; started: string; growthMB: number; windowMs: number; series: number[]; canRestart: boolean };
  /** Total bytes the primary action frees. Every row the action covers is in `rows`. */
  freesBytes?: number;
  /** The prompt "Ask an agent" sends to Pane Chat. */
  agentPrompt: string;
}

/** Sent to this machine's screens to open a view: Resources (on a machine) or Pane Chat. */
export const MACHINE_HEALTH_NAVIGATE_EVENT = 'resource-monitor:navigate';
