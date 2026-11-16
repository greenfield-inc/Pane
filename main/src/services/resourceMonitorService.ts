import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import type { App, ProcessMetric } from 'electron';
import type {
  ElectronProcessInfo,
  ChildProcessInfo,
  SessionResourceInfo,
  ResourceSnapshot,
} from '../../../shared/types/resourceMonitor';
import { attributeProcesses, readCommandLines, readEscapedEnvTags, readProcessRows, type AttributedProcess, type EnvTag, type ProcessRoot, type ProcessRow } from './machineHealth/processAttribution';
import { paneInstanceTag } from '../utils/appDirectory';

const execFileAsync = promisify(execFile);

/** How often escaped processes' environments are re-read. */
const ENV_SCAN_INTERVAL_MS = 5 * 60_000;

interface CpuSample {
  cpuTimeSeconds: number;
  timestamp: number;
}

export interface WslProcessSample {
  sessionId: string;
  pid: number;
  name: string;
  cpuTimeSeconds: number;
  memoryMB: number;
}

/**
 * Shell script run inside a WSL distro (one wsl.exe invocation per distro per
 * poll). Scans /proc/<pid>/environ for processes carrying PANE_SESSION_ID
 * (injected into every pane terminal and propagated via WSLENV) and emits one
 * line per process: sessionId|pid|cpuSeconds|rssKB|comm
 * Uses only POSIX sh + grep/tr/sed so it works on busybox-based distros too.
 */
const WSL_ENVIRON_SCAN_SCRIPT = [
  'clk=$(getconf CLK_TCK 2>/dev/null); case "$clk" in ""|0|*[!0-9]*) clk=100;; esac',
  'pg=$(getconf PAGESIZE 2>/dev/null); case "$pg" in ""|0|*[!0-9]*) pg=4096;; esac',
  'for e in $(grep -slz PANE_SESSION_ID= /proc/[0-9]*/environ 2>/dev/null); do ' +
    'p=${e#/proc/}; p=${p%/environ}; ' +
    's=$({ tr "\\0" "\\n" < "$e" | sed -n "s/^PANE_SESSION_ID=//p" | head -n 1; } 2>/dev/null); ' +
    '[ -n "$s" ] || continue; ' +
    'st=$(cat "/proc/$p/stat" 2>/dev/null) || continue; ' +
    '[ -n "$st" ] || continue; ' +
    'c=${st#*(}; c=${c%%)*}; ' +
    'rest=${st##*) }; ' +
    'set -- $rest; ' +
    '[ $# -ge 22 ] || continue; ' +
    'cpu=$(( (${12} + ${13}) / clk )); ' +
    'rss=$(( ${22} * (pg / 1024) )); ' +
    'printf "%s|%s|%s|%s|%s\\n" "$s" "$p" "$cpu" "$rss" "$c"; ' +
  'done',
].join('; ');

/**
 * Parse the output of WSL_ENVIRON_SCAN_SCRIPT. Pure function, exported for tests.
 * Lines are sessionId|pid|cpuSeconds|rssKB|comm; comm may itself contain pipes.
 */
export function parseWslEnvironScan(stdout: string): WslProcessSample[] {
  const samples: WslProcessSample[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 5) continue;
    const sessionId = parts[0];
    const pid = parseInt(parts[1], 10);
    const cpuTimeSeconds = parseInt(parts[2], 10);
    const rssKB = parseInt(parts[3], 10);
    if (!sessionId || isNaN(pid) || isNaN(cpuTimeSeconds) || isNaN(rssKB)) continue;
    const name = parts.slice(4).join('|').trim() || 'unknown';
    samples.push({ sessionId, pid, name, cpuTimeSeconds, memoryMB: rssKB / 1024 });
  }
  return samples;
}

interface ResourceMonitorInitializationOptions {
  app?: App | null;
  /** Every process Pane started directly, with its Pane and tab. */
  processRoots?: () => ProcessRoot[];
  /** Panes in this instance's database; escaped processes of other Pane instances are ignored. */
  knownSessionIds?: () => ReadonlySet<string>;
  readRows?: () => Promise<ProcessRow[]>;
  getSessionById?: (sessionId: string) => { name?: string; initial_prompt?: string } | undefined;
  getSessionWslDistro?: (sessionId: string) => string | null;
}

export class ResourceMonitorService {
  private app: App | null = null;
  private getSessionById: ((sessionId: string) => { name?: string; initial_prompt?: string } | undefined) | null = null;
  private getSessionWslDistro: ((sessionId: string) => string | null) | null = null;
  private previousCpuSamples = new Map<string, CpuSample>();
  private needsCpuWarmup = false;
  private wslScanFailedDistros = new Set<string>();
  private processRoots: (() => ProcessRoot[]) | null = null;
  private knownSessionIds: (() => ReadonlySet<string>) | null = null;
  private readRows: () => Promise<ProcessRow[]> = readProcessRows;
  /** Command lines by `pid:started`; read once per process lifetime. */
  private commands = new Map<string, string>();
  private envTags = new Map<string, { pid: number; tag: EnvTag }>();
  private envTagsReadAt = -Infinity;

  initialize(options: ResourceMonitorInitializationOptions = {}): void {
    this.app = options.app ?? null;
    this.processRoots = options.processRoots ?? null;
    this.knownSessionIds = options.knownSessionIds ?? null;
    this.readRows = options.readRows ?? readProcessRows;
    this.getSessionById = options.getSessionById ?? null;
    this.getSessionWslDistro = options.getSessionWslDistro ?? null;
  }

  private getElectronMetrics(): ElectronProcessInfo[] {
    if (!this.app) return [];
    const metrics: ProcessMetric[] = this.app.getAppMetrics();
    if (!metrics || metrics.length === 0) return [];
    return metrics.map(m => ({
      pid: m.pid,
      type: m.type,
      label: m.type === 'Browser' ? 'Main' : m.type === 'Tab' ? 'Renderer' : m.type,
      cpuPercent: m.cpu.percentCPUUsage,
      memoryMB: Math.round((m.memory.workingSetSize / 1024) * 100) / 100, // KB → MB
    }));
  }

  /**
   * Compute delta-based CPU percentage for a process using cached previous samples.
   * Keys are String(pid) for native processes and wsl:<distro>:<pid> for WSL
   * processes so Linux pids cannot collide with Windows pids.
   * Returns 0 on first observation (no previous sample to compare against).
   */
  private computeDeltaCpu(key: string, currentCpuTimeSeconds: number, currentTimestamp: number): number {
    const prev = this.previousCpuSamples.get(key);
    this.previousCpuSamples.set(key, { cpuTimeSeconds: currentCpuTimeSeconds, timestamp: currentTimestamp });

    if (!prev) return 0;

    const deltaWallSeconds = (currentTimestamp - prev.timestamp) / 1000;
    if (deltaWallSeconds <= 0) return 0;

    const deltaCpu = currentCpuTimeSeconds - prev.cpuTimeSeconds;
    if (deltaCpu < 0) return 0; // Process restarted with same PID

    return Math.round((deltaCpu / deltaWallSeconds) * 100 * 10) / 10;
  }

  /**
   * Remove stale entries from the CPU sample cache for keys no longer being tracked.
   */
  private cleanupCpuSampleCache(activeKeys: Set<string>): void {
    for (const key of this.previousCpuSamples.keys()) {
      if (!activeKeys.has(key)) {
        this.previousCpuSamples.delete(key);
      }
    }
  }

  /**
   * On Windows hosts, sessions running inside WSL hide behind a single wsl.exe
   * relay pid; the Windows process-tree walk cannot see into the distro. This
   * runs one batched environ scan per distro that has live WSL sessions and
   * groups the resulting samples by sessionId. Any failure (wsl.exe missing,
   * distro stopped, parse error) is swallowed so native polling is unaffected.
   */
  private async getWslSamplesBySession(sessionIds: string[]): Promise<Map<string, { distro: string; sample: WslProcessSample }[]>> {
    const result = new Map<string, { distro: string; sample: WslProcessSample }[]>();
    if (os.platform() !== 'win32' || !this.getSessionWslDistro) return result;

    const sessionDistro = new Map<string, string>();
    for (const sessionId of sessionIds) {
      try {
        const distro = this.getSessionWslDistro(sessionId);
        if (distro) sessionDistro.set(sessionId, distro);
      } catch {
        // Resolver failure: treat session as non-WSL
      }
    }
    if (sessionDistro.size === 0) return result;

    const distros = [...new Set(sessionDistro.values())];
    await Promise.all(distros.map(async distro => {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          'wsl.exe',
          ['-d', distro, '--', 'sh', '-c', WSL_ENVIRON_SCAN_SCRIPT],
          { encoding: 'utf8', timeout: 4000 }
        ));
        this.wslScanFailedDistros.delete(distro);
      } catch (error) {
        if (!this.wslScanFailedDistros.has(distro)) {
          this.wslScanFailedDistros.add(distro);
          console.warn(`[ResourceMonitor] WSL process scan failed for distro ${distro}, skipping:`, error instanceof Error ? error.message : error);
        }
        return;
      }
      for (const sample of parseWslEnvironScan(stdout)) {
        if (sessionDistro.get(sample.sessionId) !== distro) continue;
        const list = result.get(sample.sessionId) || [];
        list.push({ distro, sample });
        result.set(sample.sessionId, list);
      }
    }));
    return result;
  }

  private async getSessionMetrics(): Promise<SessionResourceInfo[]> {
    const now = Date.now();
    const roots = this.processRoots?.() ?? [];
    const sessionIds = [...new Set(roots.map(root => root.sessionId))];
    // A failed read rejects: an empty table would read as every process gone.
    // Windows reads no escaped processes, so with no tab running it has nothing to read.
    const rows = roots.length === 0 && process.platform === 'win32' ? [] : await this.readRows();
    const claimed = new Set<number>();
    for (const list of attributeProcesses(rows, roots, new Map()).values()) for (const proc of list) claimed.add(proc.pid);
    const envTags = await this.escapedEnvTags(rows, claimed, now);
    const known = this.knownSessionIds?.() ?? new Set(sessionIds);
    const bySession = attributeProcesses(rows, roots, envTags, known);
    const commandOf = await this.commandLines([...bySession.values()].flat());

    const sessions: SessionResourceInfo[] = [];
    const allTrackedKeys = new Set<string>();

    // WSL sessions on Windows: one batched in-distro scan per distro
    const wslSamplesBySession = await this.getWslSamplesBySession([...new Set([...sessionIds, ...bySession.keys()])]);

    for (const sessionId of new Set([...bySession.keys(), ...wslSamplesBySession.keys()])) {
      const session = this.getSessionById?.(sessionId);
      const sessionName = session?.name || session?.initial_prompt?.slice(0, 30) || sessionId;
      const children: ChildProcessInfo[] = [];
      for (const proc of bySession.get(sessionId) ?? []) {
        const key = `${proc.pid}:${proc.started}`;
        allTrackedKeys.add(key);
        const cpuPercent = this.computeDeltaCpu(key, proc.cpuSeconds, now);
        children.push({ pid: proc.pid, name: proc.name, command: proc.command ?? (commandOf.get(key) || undefined), cpuPercent, memoryMB: proc.rssMB, started: proc.started, panelId: proc.panelId, escaped: proc.escaped });
      }

      // WSL processes appear alongside the wsl.exe relay already attributed above
      for (const { distro, sample } of wslSamplesBySession.get(sessionId) ?? []) {
        const key = `wsl:${distro}:${sample.pid}`;
        allTrackedKeys.add(key);
        const cpuPercent = this.computeDeltaCpu(key, sample.cpuTimeSeconds, now);
        if (cpuPercent > 0 || sample.memoryMB > 0.1) {
          children.push({ pid: sample.pid, name: `${sample.name} (${distro})`, cpuPercent, memoryMB: sample.memoryMB, started: key, panelId: null, escaped: false });
        }
      }

      const totalCpu = children.reduce((sum, c) => sum + c.cpuPercent, 0);
      const totalMem = children.reduce((sum, c) => sum + c.memoryMB, 0);

      sessions.push({
        sessionId,
        sessionName,
        totalCpuPercent: Math.round(totalCpu * 10) / 10,
        totalMemoryMB: Math.round(totalMem * 10) / 10,
        children,
      });
    }

    // Clean up stale CPU samples for processes that no longer exist
    this.cleanupCpuSampleCache(allTrackedKeys);

    return sessions;
  }

  /** Command lines of Pane processes the table did not carry, by `pid:started`; new processes only. */
  private async commandLines(procs: readonly AttributedProcess[]): Promise<Map<string, string>> {
    const live = new Set(procs.map(proc => `${proc.pid}:${proc.started}`));
    for (const key of this.commands.keys()) if (!live.has(key)) this.commands.delete(key);
    const missing = procs.filter(proc => !proc.command && !this.commands.has(`${proc.pid}:${proc.started}`));
    if (missing.length > 0) {
      const read = await readCommandLines(missing.map(proc => proc.pid));
      // An unreadable command stays empty rather than being read again every sample.
      for (const proc of missing) this.commands.set(`${proc.pid}:${proc.started}`, read.get(proc.pid) ?? '');
    }
    return this.commands;
  }

  /** Escaped processes rarely change, and reading environments costs a process call: refresh every 5 minutes. */
  private async escapedEnvTags(rows: ProcessRow[], claimed: Set<number>, now: number): Promise<Map<number, EnvTag>> {
    if (now - this.envTagsReadAt >= ENV_SCAN_INTERVAL_MS) {
      this.envTagsReadAt = now;
      const tags = await readEscapedEnvTags(rows, claimed, paneInstanceTag());
      this.envTags = new Map([...tags].map(([pid, tag]) => [`${pid}:${rows.find(row => row.pid === pid)?.started ?? ''}`, { pid, tag }]));
    }
    const live = new Map<number, EnvTag>();
    const started = new Map(rows.map(row => [row.pid, row.started]));
    for (const [key, { pid, tag }] of this.envTags) {
      if (`${pid}:${started.get(pid) ?? ''}` === key) live.set(pid, tag);
    }
    return live;
  }

  async getSnapshot(): Promise<ResourceSnapshot> {
    const cpuReady = !this.needsCpuWarmup;
    // After this poll seeds the cache, the next poll will have real deltas
    if (this.needsCpuWarmup) this.needsCpuWarmup = false;

    const electronProcesses = this.getElectronMetrics();
    const sessions = await this.getSessionMetrics();

    const electronTotal = electronProcesses.reduce(
      (acc, p) => ({ cpu: acc.cpu + p.cpuPercent, mem: acc.mem + p.memoryMB }),
      { cpu: 0, mem: 0 }
    );
    const sessionTotal = sessions.reduce(
      (acc, s) => ({ cpu: acc.cpu + s.totalCpuPercent, mem: acc.mem + s.totalMemoryMB }),
      { cpu: 0, mem: 0 }
    );

    return {
      timestamp: Date.now(),
      cpuReady,
      totalCpuPercent: Math.round((electronTotal.cpu + sessionTotal.cpu) * 10) / 10,
      totalMemoryMB: Math.round((electronTotal.mem + sessionTotal.mem) * 10) / 10,
      electronProcesses,
      sessions,
    };
  }

  /** After the window hides, the next snapshot seeds CPU samples again rather than average over the hidden time. */
  handleVisibilityChange(hidden: boolean): void {
    if (!hidden) return;
    this.previousCpuSamples.clear();
    this.needsCpuWarmup = true;
  }
}

export const resourceMonitorService = new ResourceMonitorService();
