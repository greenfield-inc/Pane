/**
 * Find and stop a terminal panel's processes that an earlier Pane process
 * left running.
 *
 * A daemon restart (a pinned upgrade, a crash, a stop that systemd ends with
 * SIGKILL) does not always take the panels' processes with it: Electron moves
 * itself out of the service's cgroup into its own `app-pane-<pid>.scope`, so
 * systemd's control-group kill misses the PTYs, and every legacy `pty.spawn`
 * child inherits the PTY masters of the panels spawned before it, so no PTY
 * hangs up when the daemon dies. The shells and the agents in them keep
 * running with nobody attached. Resuming the panel then starts a second
 * `claude --resume <id>` on the same conversation.
 *
 * Linux only: the scan reads /proc. Other platforms report nothing, and
 * resume behaves as before.
 */
import * as fs from 'fs';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Session id (the session leader's pid). */
  sid: number;
  /** Controlling terminal device number; 0 when the process has none. */
  ttyNr: number;
  comm: string;
  state: string;
}

/** Read access to the process table; tests replace it. */
export interface ProcessTable {
  list(): ProcessEntry[];
  /** The PANE_PANEL_ID a process was started with, or undefined. Reads only that one variable. */
  panelIdOf(pid: number): string | undefined;
}

interface StrayProcessTree {
  panelId: string;
  /** The PTY's shell, which leads its own session. */
  leaderPid: number;
  /** The shell and everything under it, leader first. */
  pids: number[];
}

/** Parse the fields of /proc/<pid>/stat that the scan needs. */
export function parseProcStat(text: string): ProcessEntry | undefined {
  // comm sits in parentheses and may itself contain spaces or ')'.
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).split(' ');
  // rest: state ppid pgrp session tty_nr ...
  const [state, ppid, , sid, ttyNr] = rest;
  const entry = {
    pid,
    ppid: Number(ppid),
    sid: Number(sid),
    ttyNr: Number(ttyNr),
    comm: text.slice(open + 1, close),
    state: state ?? '',
  };
  return [entry.pid, entry.ppid, entry.sid, entry.ttyNr].every(Number.isInteger) ? entry : undefined;
}

function readPanelIdFromEnviron(pid: number): string | undefined {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(`/proc/${pid}/environ`);
  } catch {
    return undefined;
  }
  const prefix = 'PANE_PANEL_ID=';
  for (const entry of raw.toString('utf8').split('\0')) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}

/** The live /proc table, or an empty one where /proc is not Linux's. */
function systemProcessTable(): ProcessTable {
  if (process.platform !== 'linux') return { list: () => [], panelIdOf: () => undefined };
  return {
    list: () => {
      let names: string[];
      try {
        names = fs.readdirSync('/proc');
      } catch {
        return [];
      }
      const entries: ProcessEntry[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const entry = parseProcStat(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
          if (entry) entries.push(entry);
        } catch {
          // The process exited between readdir and read.
        }
      }
      return entries;
    },
    panelIdOf: readPanelIdFromEnviron,
  };
}

function descendants(rootPid: number, entries: ProcessEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid);
    if (list) list.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() ?? 0;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

function isDescendantOf(pid: number, ancestor: number, byPid: Map<number, ProcessEntry>): boolean {
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    if (current.ppid === ancestor) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

/**
 * The process trees a panel still has outside this Pane process: PTY shells
 * started for `panelId` (they lead a session and hold a terminal) that are not
 * under `ownPid`, each with everything below it. A server that detached into
 * its own session (setsid, no terminal) is not part of a tree and is left
 * alone even though it inherited the panel id.
 */
export function findStrayPanelTrees(table: ProcessTable, panelId: string, ownPid: number = process.pid): StrayProcessTree[] {
  const entries = table.list().filter(entry => entry.state !== 'Z');
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  const trees: StrayProcessTree[] = [];
  for (const entry of entries) {
    if (entry.pid !== entry.sid || entry.ttyNr === 0 || entry.pid === ownPid) continue;
    if (isDescendantOf(entry.pid, ownPid, byPid)) continue;
    if (table.panelIdOf(entry.pid) !== panelId) continue;
    trees.push({ panelId, leaderPid: entry.pid, pids: descendants(entry.pid, entries) });
  }
  return trees;
}

interface TerminateOptions {
  graceMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

function processIsAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const entry = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return entry !== undefined && entry.state !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM every pid, wait up to `graceMs` for them to exit, then SIGKILL the
 * rest. Returns the pids still alive after that (normally none).
 */
export async function terminateProcesses(pids: number[], options: TerminateOptions = {}): Promise<number[]> {
  const graceMs = options.graceMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  const isAlive = options.isAlive ?? processIsAlive;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      kill(pid, signal);
    } catch {
      // Already gone (ESRCH) or not ours to signal.
    }
  };

  let alive = pids.filter(isAlive);
  for (const pid of alive) send(pid, 'SIGTERM');
  for (let waited = 0; alive.length > 0 && waited < graceMs; waited += pollMs) {
    await sleep(pollMs);
    alive = alive.filter(isAlive);
  }
  if (alive.length === 0) return [];
  for (const pid of alive) send(pid, 'SIGKILL');
  await sleep(pollMs);
  return alive.filter(isAlive);
}

/**
 * Stop the processes a panel still has from an earlier Pane process.
 * Returns the trees it found and the pids that survived SIGKILL.
 */
export async function stopStrayPanelProcesses(
  panelId: string,
  options: TerminateOptions & { table?: ProcessTable; ownPid?: number } = {},
): Promise<{ trees: StrayProcessTree[]; survivors: number[] }> {
  const trees = findStrayPanelTrees(options.table ?? systemProcessTable(), panelId, options.ownPid);
  if (trees.length === 0) return { trees, survivors: [] };
  const survivors = await terminateProcesses(trees.flatMap(tree => tree.pids), options);
  return { trees, survivors };
}

/**
 * Each pid with everything under it, read before anything is killed: once a
 * shell dies its children are re-parented and can no longer be found from it.
 */
export function processTrees(rootPids: number[], table: ProcessTable = systemProcessTable()): number[] {
  const entries = table.list();
  if (entries.length === 0) return rootPids;
  const seen = new Set<number>();
  for (const root of rootPids) for (const pid of descendants(root, entries)) seen.add(pid);
  return [...seen];
}
