import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import type { HealthLevel, MemoryPressureSource } from '../../../../shared/types/machineHealth';

const execFileAsync = promisify(execFile);

export interface MemoryPressureReading {
  level: HealthLevel;
  source: MemoryPressureSource;
  /** The raw figure behind the level, for logs and tooltips. */
  detail: string;
}

export interface MemoryPressureDeps {
  sysctl: (name: string) => Promise<string>;
  readFile: (file: string) => Promise<string>;
  freemem?: () => number;
  totalmem?: () => number;
}

const defaultDeps: MemoryPressureDeps = {
  sysctl: async name => (await execFileAsync('sysctl', ['-n', name], { encoding: 'utf8', timeout: 2000 })).stdout,
  readFile: file => readFile(file, 'utf8'),
};

/** PSI "some avg60": share of the last minute some task stalled on memory. */
const PSI_WARNING = 10;
const PSI_CRITICAL = 30;
/** Available physical memory, as a share of the total. */
const AVAILABLE_WARNING = 0.10;
const AVAILABLE_CRITICAL = 0.05;

function fromAvailable(available: number, total: number): MemoryPressureReading {
  const share = total > 0 ? available / total : 1;
  const level: HealthLevel = share < AVAILABLE_CRITICAL ? 'critical' : share < AVAILABLE_WARNING ? 'warning' : 'ok';
  return { level, source: 'available', detail: `${Math.round(share * 100)}% available` };
}

/** Each OS's own signal: the macOS kernel level, Linux PSI (else MemAvailable), Windows available memory. */
export async function readMemoryPressure(platform: NodeJS.Platform = process.platform, deps: MemoryPressureDeps = defaultDeps): Promise<MemoryPressureReading> {
  // Tests and QA only: simulate a level for this Pane without signalling every app on the machine.
  const simulated = process.env.PANE_MEMORY_PRESSURE_TEST_LEVEL;
  if (simulated === 'ok' || simulated === 'warning' || simulated === 'critical') {
    return { level: simulated, source: 'available', detail: 'simulated (PANE_MEMORY_PRESSURE_TEST_LEVEL)' };
  }
  const freemem = deps.freemem ?? os.freemem;
  const totalmem = deps.totalmem ?? os.totalmem;
  if (platform === 'darwin') {
    try {
      const value = Number.parseInt((await deps.sysctl('kern.memorystatus_vm_pressure_level')).trim(), 10);
      const level: HealthLevel = value >= 4 ? 'critical' : value >= 2 ? 'warning' : 'ok';
      return { level, source: 'macos-pressure', detail: `kernel pressure level ${value}` };
    } catch {
      return fromAvailable(freemem(), totalmem());
    }
  }
  if (platform === 'linux') {
    try {
      const psi = await deps.readFile('/proc/pressure/memory');
      const avg60 = Number(/^some .*?avg60=([\d.]+)/mu.exec(psi)?.[1]);
      if (Number.isFinite(avg60)) {
        const level: HealthLevel = avg60 >= PSI_CRITICAL ? 'critical' : avg60 >= PSI_WARNING ? 'warning' : 'ok';
        return { level, source: 'psi', detail: `some avg60=${avg60}` };
      }
    } catch {
      // Kernels before 4.20, or PSI disabled: fall back to MemAvailable.
    }
    try {
      const meminfo = await deps.readFile('/proc/meminfo');
      const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'mu').exec(meminfo)?.[1]) * 1024;
      const available = kb('MemAvailable');
      const total = kb('MemTotal');
      if (Number.isFinite(available) && Number.isFinite(total)) return fromAvailable(available, total);
    } catch {
      // Fall through to the OS figures.
    }
  }
  return fromAvailable(freemem(), totalmem());
}

const RANK = { ok: 0, warning: 1, critical: 2 } as const satisfies Record<HealthLevel, number>;

/** The more severe of the levels; ok when there are none. */
export function worstLevel(levels: readonly HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
}

/** A level counts once two samples in a row reach it; it drops as soon as one sample is lower. */
export function settleLevel(recent: readonly HealthLevel[]): HealthLevel {
  if (recent.length < 2) return 'ok';
  const [previous, latest] = recent.slice(-2);
  return RANK[previous] <= RANK[latest] ? previous : latest;
}

/** macOS swap in use, from `vm.swapusage`; null elsewhere or when unreadable. */
export async function readSwapUsedBytes(platform: NodeJS.Platform = process.platform, deps: MemoryPressureDeps = defaultDeps): Promise<number | null> {
  if (platform !== 'darwin') return null;
  try {
    const match = /used = ([\d.]+)M/u.exec(await deps.sysctl('vm.swapusage'));
    return match ? Math.round(Number(match[1]) * 1024 * 1024) : null;
  } catch {
    return null;
  }
}
