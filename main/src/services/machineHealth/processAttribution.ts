import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import type { HealthProcess } from '../../../../shared/types/machineHealth';

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** As the OS prints it: `lstart` text on POSIX, CreationDate ticks on Windows. */
  started: string;
  /** `started` as epoch ms, for ordering parents before children. */
  startedAt: number;
  rssKB: number;
  /** Cumulative CPU time. */
  cpuSeconds: number;
  name: string;
}

/** A process Pane started directly: a tab's PTY shell, an agent CLI, a run script. */
export interface ProcessRoot {
  pid: number;
  sessionId: string;
  panelId: string | null;
}

export interface EnvTag {
  sessionId: string;
  panelId: string | null;
}

export type AttributedProcess = Omit<HealthProcess, 'cpuPercent'> & { cpuSeconds: number; startedAt: number };

/** `[D-]HH:MM:SS[.ff]` or `MM:SS[.ff]` from `ps -o time=` into seconds. */
function parseCpuTime(text: string): number {
  const [daysPart, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return Math.round((Number(daysPart) * 86400 + h * 3600 + m * 60 + s) * 100) / 100;
}

const POSIX_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*(.*)$/u;

/** Parse `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=`; `comm` goes last because it may hold spaces. */
export function parsePosixProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = POSIX_ROW.exec(line);
    if (!match) continue;
    const started = match[5].replace(/\s+/gu, ' ');
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKB: Number(match[3]),
      cpuSeconds: parseCpuTime(match[4]),
      started,
      startedAt: Date.parse(started),
      name: match[6].trim() || 'unknown',
    });
  }
  return rows;
}

/** Ticks since 0001-01-01 to epoch ms. */
const TICKS_AT_EPOCH = 621355968000000000n;

function parseWindowsProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parts = line.split('\t');
    if (parts.length < 6 || !/^\d+$/u.test(parts[2])) continue;
    rows.push({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      started: parts[2],
      startedAt: Number((BigInt(parts[2]) - TICKS_AT_EPOCH) / 10000n),
      rssKB: Math.round(Number(parts[3]) / 1024),
      cpuSeconds: Number(parts[4]) / 1e7,
      name: parts[5] || 'unknown',
    });
  }
  return rows;
}

/**
 * Every process on the machine with RSS, CPU time and start time, in one call.
 * The start-time text matches archiveProcessTracker's, so a stop can re-check identity.
 */
export async function readProcessRows(): Promise<ProcessRow[]> {
  const options = { encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { [long]$t = $_.CreationDate.ToUniversalTime().Ticks; $b = ($t - ($t % [long]10)).ToString(); "$($_.ProcessId)`t$($_.ParentProcessId)`t$b`t$($_.WorkingSetSize)`t$([long]$_.KernelModeTime + [long]$_.UserModeTime)`t$($_.Name)" } }'], options);
    return parseWindowsProcessTable(stdout);
  }
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,rss=,time=,lstart=,comm='], options);
  return parsePosixProcessTable(stdout);
}

const ENV_TAG = /(?:^|\s)PANE_SESSION_ID=([\w-]+)/u;
const PANEL_TAG = /(?:^|\s)PANE_PANEL_ID=([\w-]+)/u;

/**
 * Pane tags for processes outside every tab's tree, read from their environment.
 * Only processes reparented to init are read: that is where an escaped child lands.
 * Windows keeps no reparenting and exposes no cheap environment read, so it reads none.
 */
export async function readEscapedEnvTags(rows: readonly ProcessRow[], claimed: ReadonlySet<number>): Promise<Map<number, EnvTag>> {
  const tags = new Map<number, EnvTag>();
  if (process.platform === 'win32') return tags;
  const candidates = rows.filter(row => row.ppid === 1 && !claimed.has(row.pid)).map(row => row.pid);
  if (candidates.length === 0) return tags;
  if (process.platform === 'linux') {
    await Promise.all(candidates.map(async pid => {
      try {
        const environ = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').join(' ');
        const sessionId = ENV_TAG.exec(environ)?.[1];
        if (sessionId) tags.set(pid, { sessionId, panelId: PANEL_TAG.exec(environ)?.[1] ?? null });
      } catch {
        // Another user's process, or it exited.
      }
    }));
    return tags;
  }
  try {
    // macOS appends the environment to the command for this user's processes.
    const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', candidates.join(',')],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const pid = Number(/^\s*(\d+)/u.exec(line)?.[1]);
      const sessionId = ENV_TAG.exec(line)?.[1];
      if (pid && sessionId) tags.set(pid, { sessionId, panelId: PANEL_TAG.exec(line)?.[1] ?? null });
    }
  } catch {
    // Unreadable environments leave escaped processes unattributed.
  }
  return tags;
}

/**
 * Group processes by Pane: each root and its descendants, plus processes that
 * left their tree but carry a known Pane's PANE_SESSION_ID (and their descendants).
 * A child counts only if it started after its parent, so a reused parent pid
 * never adopts an older process.
 */
export function attributeProcesses(
  rows: readonly ProcessRow[],
  roots: readonly ProcessRoot[],
  envTags: ReadonlyMap<number, EnvTag>,
  knownSessions?: ReadonlySet<string>,
): Map<string, AttributedProcess[]> {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const assigned = new Map<number, AttributedProcess>();
  const claim = (start: ProcessRow, owner: EnvTag, escaped: boolean) => {
    const queue = [start];
    for (let next = 0; next < queue.length; next++) {
      const row = queue[next];
      if (assigned.has(row.pid)) continue;
      assigned.set(row.pid, {
        pid: row.pid, started: row.started, startedAt: row.startedAt, name: row.name,
        sessionId: owner.sessionId, panelId: owner.panelId, rssMB: row.rssKB / 1024, cpuSeconds: row.cpuSeconds, escaped,
      });
      for (const child of children.get(row.pid) ?? []) {
        if (child.startedAt >= row.startedAt) queue.push(child);
      }
    }
  };
  for (const root of roots) {
    const row = byPid.get(root.pid);
    if (row) claim(row, root, false);
  }
  for (const [pid, tag] of envTags) {
    const row = byPid.get(pid);
    if (!row || assigned.has(pid)) continue;
    if (knownSessions && !knownSessions.has(tag.sessionId)) continue;
    claim(row, tag, true);
  }
  const panes = new Map<string, AttributedProcess[]>();
  for (const proc of assigned.values()) {
    const list = panes.get(proc.sessionId);
    if (list) list.push(proc);
    else panes.set(proc.sessionId, [proc]);
  }
  for (const list of panes.values()) list.sort((a, b) => a.pid - b.pid);
  return panes;
}
