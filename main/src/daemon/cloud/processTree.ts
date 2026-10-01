import fs from 'fs';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  name: string;
}

const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh']);

/** Every process from /proc (Linux); empty elsewhere or when /proc is unreadable. */
export function readProcessTable(procRoot = '/proc'): ProcessEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const entries: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const entry = parseProcStat(fs.readFileSync(`${procRoot}/${name}/stat`, 'utf8'));
      if (entry) entries.push(entry);
    } catch {
      // The process exited while we read the table.
    }
  }
  return entries;
}

/** `pid (comm) state ppid ...`; comm may hold spaces and parentheses, so split at the last `)`. */
export function parseProcStat(stat: string): ProcessEntry | undefined {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(stat.slice(0, open).trim());
  const ppid = Number(stat.slice(close + 2).split(' ')[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return undefined;
  return { pid, ppid, name: stat.slice(open + 1, close) };
}

/**
 * Shells an agent started under a panel's PTY: the agent's tool commands, including ones it
 * moved to the background after its turn ended. A shell counts only below a non-shell process
 * (the agent), so the panel's own login shell does not, and MCP servers, which agents start
 * directly rather than through a shell, do not either.
 */
export function findAgentSpawnedShells(table: readonly ProcessEntry[], ptyPid: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const found: ProcessEntry[] = [];
  const queue: Array<{ entry: ProcessEntry; belowAgent: boolean }> = (children.get(ptyPid) ?? [])
    .map(entry => ({ entry, belowAgent: false }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const isShell = SHELL_NAMES.has(next.entry.name);
    if (isShell && next.belowAgent) {
      found.push(next.entry);
      continue;
    }
    const belowAgent = next.belowAgent || !isShell;
    for (const child of children.get(next.entry.pid) ?? []) queue.push({ entry: child, belowAgent });
  }
  return found;
}
