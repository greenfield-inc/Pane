import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import type { HealthProcess } from '../../../../shared/types/machineHealth';
import { PANE_INSTANCE_ENV } from '../../utils/appDirectory';
import { cLocaleEnv } from '../../utils/processTree';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_CHARS = 200;
const trimCommand = (text: string): string | undefined => text.replace(/\s+/gu, ' ').trim().slice(0, COMMAND_MAX_CHARS) || undefined;

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
  /** The command line, trimmed to COMMAND_MAX_CHARS; Windows reads it with the table, POSIX through readCommandLines. */
  command?: string;
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
    // Kept exactly as printed ("Nov  1" has two spaces): archiveProcessTracker compares this text to stop a process safely.
    const started = match[5];
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
    if (parts.length < 7 || !/^\d+$/u.test(parts[2])) continue;
    rows.push({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      started: parts[2],
      startedAt: Number((BigInt(parts[2]) - TICKS_AT_EPOCH) / 10000n),
      rssKB: Math.round(Number(parts[3]) / 1024),
      cpuSeconds: Number(parts[4]) / 1e7,
      name: parts[5] || 'unknown',
      command: trimCommand(parts.slice(6).join(' ')),
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
      'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { [long]$t = $_.CreationDate.ToUniversalTime().Ticks; $b = ($t - ($t % [long]10)).ToString(); $c = [string]$_.CommandLine -replace "\\s+", " "; if ($c.Length -gt 200) { $c = $c.Substring(0, 200) }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$b`t$($_.WorkingSetSize)`t$([long]$_.KernelModeTime + [long]$_.UserModeTime)`t$($_.Name)`t$c" } }'], options);
    return parseWindowsProcessTable(stdout);
  }
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,rss=,time=,lstart=,comm='], { ...options, env: cLocaleEnv() });
  return parsePosixProcessTable(stdout);
}

/**
 * POSIX command lines for `pids` (Windows reads them with the table). `ps` cannot
 * print the full name and the arguments in one call, so this is a second, narrow read.
 * Unreadable processes are left out.
 */
export async function readCommandLines(pids: readonly number[]): Promise<Map<number, string>> {
  const commands = new Map<number, string>();
  if (pids.length === 0 || process.platform === 'win32') return commands;
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async pid => {
      try {
        const command = trimCommand((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' '));
        if (command) commands.set(pid, command);
      } catch {
        // It exited.
      }
    }));
    return commands;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: cLocaleEnv() });
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      const command = match && trimCommand(match[2]);
      if (match && command) commands.set(Number(match[1]), command);
    }
  } catch {
    // Commands are optional; the processes show without one.
  }
  return commands;
}

const ENV_TAG = /(?:^|\s)PANE_SESSION_ID=([\w-]+)/u;
const PANEL_TAG = /(?:^|\s)PANE_PANEL_ID=([\w-]+)/u;
const INSTANCE_TAG = new RegExp(`(?:^|\\s)${PANE_INSTANCE_ENV}=([\\w-]+)`, 'u');

/** The tag in one process's environment text, when it names this Pane instance. */
function tagOf(environ: string, instanceTag: string): EnvTag | null {
  const sessionId = ENV_TAG.exec(environ)?.[1];
  if (!sessionId || INSTANCE_TAG.exec(environ)?.[1] !== instanceTag) return null;
  return { sessionId, panelId: PANEL_TAG.exec(environ)?.[1] ?? null };
}

/**
 * Pane tags for processes outside every tab's tree, read from their environment.
 * Only processes reparented to init are read: that is where an escaped child lands.
 * A process counts only when its PANE_INSTANCE is `instanceTag` (paneInstanceTag()),
 * so another Pane instance's processes are never this one's.
 * Windows keeps no reparenting and exposes no cheap environment read, so it reads none.
 */
export async function readEscapedEnvTags(rows: readonly ProcessRow[], claimed: ReadonlySet<number>, instanceTag: string): Promise<Map<number, EnvTag>> {
  const tags = new Map<number, EnvTag>();
  if (process.platform === 'win32') return tags;
  const candidates = rows.filter(row => row.ppid === 1 && !claimed.has(row.pid)).map(row => row.pid);
  if (candidates.length === 0) return tags;
  if (process.platform === 'linux') {
    await Promise.all(candidates.map(async pid => {
      try {
        const tag = tagOf((await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').join(' '), instanceTag);
        if (tag) tags.set(pid, tag);
      } catch {
        // Another user's process, or it exited.
      }
    }));
    return tags;
  }
  try {
    // macOS appends the environment to the command for this user's processes.
    const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', candidates.join(',')],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: cLocaleEnv() });
    for (const line of stdout.split('\n')) {
      const pid = Number(/^\s*(\d+)/u.exec(line)?.[1]);
      const tag = tagOf(line, instanceTag);
      if (pid && tag) tags.set(pid, tag);
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
        pid: row.pid, started: row.started, startedAt: row.startedAt, name: row.name, command: row.command,
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
