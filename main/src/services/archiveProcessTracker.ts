import { execFile } from 'child_process';
import { promisify } from 'util';
import { isProcessAlive } from '../utils/processTree';

const execFileAsync = promisify(execFile);

export interface ArchiveProcessIdentity {
  pid: number;
  parent: number;
  started: string;
}

export interface ArchiveProcessObservation extends ArchiveProcessIdentity {
  exited: boolean;
}

/** A failed snapshot must never be interpreted as an empty process table. */
export async function readArchiveProcesses(): Promise<ArchiveProcessObservation[]> {
  const options = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
  const { stdout } = process.platform === 'win32'
    ? await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { [long]$ticks = $_.CreationDate.ToUniversalTime().Ticks; $birth = ($ticks - ($ticks % [long]10)).ToString(); "$($_.ProcessId) $($_.ParentProcessId) $birth" } }'], options)
    : await execFileAsync('ps', ['-Ao', 'pid=,ppid=,lstart=,stat='], options);
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error('Cannot parse the process identity snapshot');
    return { pid: Number(match[1]), parent: Number(match[2]), started: match[3], exited: false };
  }).map(record => {
    // Zombies cannot write files. POSIX state is not part of lifetime identity.
    if (process.platform !== 'win32') {
      const state = record.started.split(/\s+/u).pop() ?? '';
      record.started = record.started.slice(0, -(state.length)).trim();
      record.exited = state.startsWith('Z');
    }
    return record;
  });
}

/** Escalate only freshly matched lifetimes; never taskkill /T or signal a group
 * whose membership may now belong to a different process. */
async function terminateArchiveProcesses(identities: readonly ArchiveProcessIdentity[]): Promise<void> {
  if (identities.length === 0) return;
  if (process.platform === 'win32') {
    const records = identities.map(identity => {
      if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/u.test(identity.started)) {
        throw new Error('Invalid persisted Windows process identity');
      }
      return `@{Pid=${identity.pid};Started='${identity.started}'}`;
    }).join(',');
    // Opening Handle pins the Windows process object before comparing its birth
    // time. Kill uses that handle, not a later lookup of a potentially reused PID.
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `@(${records}) | ForEach-Object { try { $p = [Diagnostics.Process]::GetProcessById($_.Pid); $null = $p.Handle; [long]$ticks = $p.StartTime.ToUniversalTime().Ticks; if (($ticks - ($ticks % [long]10)).ToString() -eq $_.Started) { $p.Kill() } } catch { } finally { if ($p) { $p.Dispose(); $p = $null } } }`],
    { timeout: 5000, maxBuffer: 1024 * 1024 });
    return;
  }
  // POSIX exposes no portable process handle: re-read immediately before each
  // signal, and never signal a changed/missing identity or an entire PID group.
  for (const identity of identities) {
    const current = (await readArchiveProcesses()).find(item => item.pid === identity.pid);
    if (!current || current.exited || current.started !== identity.started) continue;
    try { process.kill(identity.pid, 'SIGKILL'); } catch { /* verification retains survivors */ }
  }
}

/** Persist before retiring manager maps. Retained identities survive restart;
 * unresolved processes block all filesystem cleanup and are retried explicitly. */
export class ArchiveProcessTracker {
  constructor(
    private identities: ArchiveProcessIdentity[],
    private save: (identities: ArchiveProcessIdentity[]) => void,
    private read = readArchiveProcesses,
    private terminate = terminateArchiveProcesses,
  ) {}

  async capture(roots: readonly number[]): Promise<void> {
    if (roots.length === 0) return;
    const table = await this.read();
    const selected = new Set(roots.filter(pid => Number.isInteger(pid) && pid > 0));
    for (const pid of selected) {
      if (!table.some(record => record.pid === pid) && isProcessAlive(pid)) {
        throw new Error(`Cannot establish process identity for PID ${pid}`);
      }
    }
    this.captureTable(table, selected);
  }

  private captureTable(table: ArchiveProcessObservation[], selected: Set<number>): void {
    const observed = new Map(table.map(record => [record.pid, record]));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const record of table) {
        if (!selected.has(record.parent) || selected.has(record.pid)) continue;
        const parent = observed.get(record.parent);
        // Windows retains a dead parent's PID; a newer process with that PID
        // is not this child's parent. Both values came from the same CIM rows.
        const validEdge = parent && (process.platform === 'win32'
          ? BigInt(parent.started) <= BigInt(record.started)
          : Date.parse(parent.started) <= Date.parse(record.started));
        if (validEdge) {
          selected.add(record.pid);
          expanded = true;
        }
      }
    }
    for (const record of table.filter(item => selected.has(item.pid) && !item.exited)) {
      if (!this.identities.some(item => item.pid === record.pid && item.started === record.started)) {
        this.identities.push(record);
      }
    }
    this.save(this.identities);
  }

  async terminateSurvivors(): Promise<void> {
    if (this.identities.length === 0) return;
    const table = await this.read();
    const matching = this.identities.filter(identity => table.some(item =>
      item.pid === identity.pid && item.started === identity.started && !item.exited));
    // Include children born since capture while a known parent still exists.
    this.captureTable(table, new Set(matching.map(identity => identity.pid)));
    const survivors = this.identities.filter(identity => table.some(item =>
      item.pid === identity.pid && item.started === identity.started && !item.exited));
    await this.terminate([...survivors].reverse());
  }

  async verifyExited(timeoutMs = 2000): Promise<void> {
    if (this.identities.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    do {
      const table = await this.read();
      this.identities = this.identities.filter(identity => {
        const current = table.find(record => record.pid === identity.pid);
        if (current?.exited) return false;
        if (!current && isProcessAlive(identity.pid)) return true;
        return current?.started === identity.started;
      });
      if (this.identities.length === 0 || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (this.identities.length > 0);
    this.save(this.identities);
    if (this.identities.length > 0) {
      throw new Error(`Archive teardown still has known processes running (PIDs ${this.identities.map(item => item.pid).join(', ')}). Retry cleanup retries confirmed process identities; close any processes that cannot be terminated.`);
    }
  }
}
