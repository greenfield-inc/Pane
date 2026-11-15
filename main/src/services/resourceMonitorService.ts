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
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { createRequire } from 'node:module';

const loadResourceDependency = createRequire(__filename);

const execFileAsync = promisify(execFile);

interface RawProcessStats {
  name: string;
  cpuTimeSeconds: number; // Cumulative CPU time in seconds
  memoryMB: number;
}

interface CpuSample {
  cpuTimeSeconds: number;
  timestamp: number;
}

interface WindowsBatchItem {
  Id: number;
  Name: string;
  CpuSeconds: number;
  MemoryMB: number;
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

  initialize(options: ResourceMonitorInitializationOptions = {}): void {
    this.app = options.app ?? null;
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

  private async getChildPids(parentPid: number): Promise<number[]> {
    try {
      if (os.platform() === 'win32') {
        const { stdout } = await execFileAsync(
          'powershell',
          ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId`],
          { encoding: 'utf8', timeout: 5000 }
        );
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      } else if (os.platform() === 'darwin') {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8', timeout: 5000 });
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      } else {
        const { stdout } = await execFileAsync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], { encoding: 'utf8', timeout: 5000 });
        return stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n));
      }
    } catch {
      return [];
    }
  }

  private async getAllDescendantPids(parentPid: number): Promise<number[]> {
    const children = await this.getChildPids(parentPid);
    const all: number[] = [...children];
    for (const child of children) {
      all.push(...await this.getAllDescendantPids(child));
    }
    return all;
  }

  /**
   * Parse a cputime string from `ps -o cputime=` into total seconds.
   * Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS"
   */
  private parseCputime(cputime: string): number {
    const trimmed = cputime.trim();
    if (!trimmed) return 0;

    let days = 0;
    let rest = trimmed;

    // Check for "D-" day prefix
    const dayMatch = rest.match(/^(\d+)-(.+)$/);
    if (dayMatch) {
      days = parseInt(dayMatch[1], 10);
      rest = dayMatch[2];
    }

    const parts = rest.split(':').map(p => parseInt(p, 10));
    let hours = 0, minutes = 0, seconds = 0;

    if (parts.length === 3) {
      [hours, minutes, seconds] = parts;
    } else if (parts.length === 2) {
      [minutes, seconds] = parts;
    } else {
      return 0;
    }

    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
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

  private async getUnixProcessStats(pid: number): Promise<RawProcessStats> {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'comm=,cputime=,rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const line = stdout.trim();
      if (!line) return { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
      const parts = line.split(/\s+/);
      const rss = parseInt(parts[parts.length - 1], 10) || 0;
      const cputime = parts[parts.length - 2] || '0:00';
      const name = parts.slice(0, -2).join(' ') || 'unknown';
      return { name, cpuTimeSeconds: this.parseCputime(cputime), memoryMB: rss / 1024 };
    } catch {
      return { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
    }
  }

  private async getUnixBatchRawStats(pids: number[]): Promise<Map<number, RawProcessStats>> {
    const result = new Map<number, RawProcessStats>();
    if (pids.length === 0) return result;
    // Batch all PIDs into a single ps call
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'pid=,comm=,cputime=,rss=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000 });
      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) continue;
        const rss = parseInt(parts[parts.length - 1], 10) || 0;
        const cputime = parts[parts.length - 2] || '0:00';
        const name = parts.slice(1, -2).join(' ') || 'unknown';
        result.set(pid, { name, cpuTimeSeconds: this.parseCputime(cputime), memoryMB: rss / 1024 });
      }
    } catch {
      // Fallback: try individual lookups for any PIDs not found
      const promises = pids.map(async pid => {
        const stats = await this.getUnixProcessStats(pid);
        result.set(pid, stats);
      });
      await Promise.all(promises);
    }
    return result;
  }

  private async getWindowsBatchRawStats(pids: number[]): Promise<Map<number, RawProcessStats>> {
    const result = new Map<number, RawProcessStats>();
    if (pids.length === 0) return result;
    try {
      const pidList = pids.join(',');
      const psCmd = `Get-Process -Id @(${pidList}) -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Id=$_.Id; Name=$_.ProcessName; CpuSeconds=[math]::Round($_.CPU,2); MemoryMB=[math]::Round($_.WorkingSet64/1MB,1) } } | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', psCmd],
        { encoding: 'utf8', timeout: 10000 }
      );
      const itemSchema = boundary.object({
        Id: boundary.number,
        Name: boundary.string,
        CpuSeconds: boundary.number,
        MemoryMB: boundary.number,
      });
      const parsed = JSON.parse(stdout);
      let items: WindowsBatchItem[];
      try {
        items = decodeBoundary(parsed, boundary.array(itemSchema));
      } catch {
        items = [decodeBoundary(parsed, itemSchema)];
      }
      for (const item of items) {
        result.set(item.Id, {
          name: item.Name || 'unknown',
          cpuTimeSeconds: item.CpuSeconds || 0,
          memoryMB: item.MemoryMB || 0,
        });
      }
    } catch {
      // PowerShell call failed — return empty results
    }
    return result;
  }

  /**
   * Convert raw process stats (cumulative CPU time) into final stats (delta-based CPU %).
   */
  private resolveProcessStats(pids: number[], rawStats: Map<number, RawProcessStats>, now: number): ChildProcessInfo[] {
    return pids
      .map(pid => {
        const raw = rawStats.get(pid) || { name: 'unknown', cpuTimeSeconds: 0, memoryMB: 0 };
        const cpuPercent = this.computeDeltaCpu(String(pid), raw.cpuTimeSeconds, now);
        return { pid, name: raw.name, cpuPercent, memoryMB: raw.memoryMB };
      })
      .filter(c => c.cpuPercent > 0 || c.memoryMB > 0.1);
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

    // Lazy imports to avoid circular dependency at module load time
    // SAFETY: This require targets the statically typed local module and selects its exported singleton.
    const { terminalPanelManager } = loadResourceDependency('./terminalPanelManager') as { terminalPanelManager: { getSessionPids(): Map<string, number[]> } };
    // SAFETY: This require targets the statically typed local module and selects its exported registry class.
    const { CliToolRegistry } = loadResourceDependency('./cliToolRegistry') as { CliToolRegistry: { getInstance(): { getAllManagers(): { getSessionPids(): Map<string, number[]> }[] } } };

    // Collect PIDs from all sources: terminal panels + CLI managers (Claude, Codex, etc.)
    const sessionPids = new Map<string, number[]>();

    // Terminal panel PIDs (bash shells)
    for (const [sessionId, pids] of terminalPanelManager.getSessionPids()) {
      sessionPids.set(sessionId, [...pids]);
    }

    // CLI manager PIDs (Claude Code, Codex, and any future CLI tools)
    try {
      const registry = CliToolRegistry.getInstance();
      for (const manager of registry.getAllManagers()) {
        for (const [sessionId, pids] of manager.getSessionPids()) {
          const existing = sessionPids.get(sessionId) || [];
          existing.push(...pids);
          sessionPids.set(sessionId, existing);
        }
      }
    } catch {
      // Registry may not be initialized yet during startup
    }

    const sessions: SessionResourceInfo[] = [];
    const allTrackedKeys = new Set<string>();

    // WSL sessions on Windows: one batched in-distro scan per distro
    const wslSamplesBySession = await this.getWslSamplesBySession([...sessionPids.keys()]);

    for (const [sessionId, ptyPids] of sessionPids) {
      const session = this.getSessionById?.(sessionId);
      const sessionName = session?.name || session?.initial_prompt?.slice(0, 30) || sessionId;

      const allPids: number[] = [];
      for (const ptyPid of ptyPids) {
        allPids.push(ptyPid);
        allPids.push(...await this.getAllDescendantPids(ptyPid));
      }

      // Track all PIDs for cache cleanup
      for (const pid of allPids) allTrackedKeys.add(String(pid));

      let children: ChildProcessInfo[];
      if (os.platform() === 'win32') {
        const rawStats = await this.getWindowsBatchRawStats(allPids);
        children = this.resolveProcessStats(allPids, rawStats, now);
      } else {
        const rawStats = await this.getUnixBatchRawStats(allPids);
        children = this.resolveProcessStats(allPids, rawStats, now);
      }

      // WSL processes appear alongside the wsl.exe relay already attributed above
      const wslEntries = wslSamplesBySession.get(sessionId);
      if (wslEntries) {
        for (const { distro, sample } of wslEntries) {
          const key = `wsl:${distro}:${sample.pid}`;
          allTrackedKeys.add(key);
          const cpuPercent = this.computeDeltaCpu(key, sample.cpuTimeSeconds, now);
          if (cpuPercent > 0 || sample.memoryMB > 0.1) {
            children.push({ pid: sample.pid, name: `${sample.name} (${distro})`, cpuPercent, memoryMB: sample.memoryMB });
          }
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
