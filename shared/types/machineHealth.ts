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
} as const satisfies Required<MachineHealthSettings>;

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

export type ReclaimKind =
  | 'update-snapshot'
  | 'migration-backup'
  | 'archived-pane-folder'
  | 'agent-temp'
  | 'paused-scratch'
  | 'foreign-worktree'
  | 'foreign-pane-data'
  | 'other-tool-data';

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

export interface StorageInventory {
  scannedAt: number;
  durationMs: number;
  items: ReclaimItem[];
  panes: PaneDiskUsage[];
  buckets: DiskBuckets;
}

export const MACHINE_HEALTH_INVENTORY_CHANNEL = 'resource-monitor:machine-inventory';
export const MACHINE_HEALTH_INVENTORY_CHANGED_EVENT = 'resource-monitor:machine-inventory-changed';
