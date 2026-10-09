import { execFile } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import { readProcessTable, type ProcessTableRow } from '../utils/processTree';
import {
  LISTENING_PORT_GROUP_ORDER,
  type ListeningPort,
  type ListeningPortGroup,
  type ListeningPortKind,
  type ListeningPortsSnapshot,
} from '../../../shared/types/listeningPorts';

const POLL_INTERVAL_MS = 2_000;
/** A read slower than this share of the interval stretches the interval, so polling stays cheap. */
const MAX_POLL_DUTY = 0.1;
const READ_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT_MS = 500;
/** Relays that exit after their first connection; probing one would end it. */
const ONE_SHOT_LISTENERS = new Set(['nc', 'ncat', 'netcat', 'socat']);

interface TerminalPane {
  /** The terminal's PTY process; everything it starts descends from it. */
  pid: number;
  sessionId: string;
  paneName: string;
}

export interface ListeningPortMonitorOptions {
  /** Root of Pane's own process tree. */
  panePid?: number;
  terminalPanes(): TerminalPane[];
  onChange?(snapshot: ListeningPortsSnapshot): void;
}

export interface ListeningPortMonitor {
  /** Reads the host's listening ports now and returns the new list. */
  refresh(): Promise<ListeningPortsSnapshot>;
  /** Refreshes every 2 s, or less often when a read is slow, until `stop`. */
  start(): void;
  stop(): void;
}

interface ListeningSocket {
  port: number;
  pid: number | null;
  process: string;
}

interface Owner {
  group: ListeningPortGroup;
  sessionId?: string;
  paneName?: string;
}

/**
 * Lists every listening TCP port on this machine with the process that owns it,
 * which group that process belongs to, and whether the port speaks HTTP.
 */
export function createListeningPortMonitor(options: ListeningPortMonitorOptions): ListeningPortMonitor {
  const panePid = options.panePid ?? process.pid;
  // Ownership never changes for a running process, and a port's kind is
  // checked once, so both are remembered while the listener lives.
  const owners = new Map<string, Owner>();
  const kinds = new Map<string, ListeningPortKind>();
  let current: ListeningPortsSnapshot = { host: os.hostname(), ports: [] };
  let inFlight: Promise<ListeningPortsSnapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const read = async (): Promise<ListeningPortsSnapshot> => {
    const sockets = await readListeningSockets();
    const key = (socket: ListeningSocket) => `${socket.port}:${socket.pid ?? ''}:${socket.process}`;
    const unknownOwners = sockets.filter(socket => !owners.has(key(socket)));
    const provisional = new Map<string, Owner>();
    if (unknownOwners.length > 0) {
      const table = await readProcessTable();
      const terminals = new Map(options.terminalPanes().map(terminal => [terminal.pid, terminal]));
      // An empty table means the read failed: use the answer once and ask again next poll.
      const target = table.length > 0 ? owners : provisional;
      for (const socket of unknownOwners) target.set(key(socket), classify(socket, table, terminals, panePid));
    }
    await Promise.all(sockets.filter(socket => !kinds.has(key(socket))).map(async socket => {
      kinds.set(key(socket), ONE_SHOT_LISTENERS.has(socket.process) ? 'tcp' : await probeKind(socket.port));
    }));

    const live = new Set(sockets.map(key));
    for (const cached of [...owners.keys()]) if (!live.has(cached)) owners.delete(cached);
    for (const cached of [...kinds.keys()]) if (!live.has(cached)) kinds.delete(cached);

    const ports = sockets.map((socket): ListeningPort => ({
      ...socket,
      // SAFETY: every live socket was classified and probed above.
      ...(owners.get(key(socket)) ?? provisional.get(key(socket)))!,
      kind: kinds.get(key(socket))!,
    }));
    ports.sort((a, b) =>
      LISTENING_PORT_GROUP_ORDER.indexOf(a.group) - LISTENING_PORT_GROUP_ORDER.indexOf(b.group) || a.port - b.port);
    return { host: os.hostname(), ports };
  };

  const refresh = (): Promise<ListeningPortsSnapshot> => {
    inFlight ??= read().then(next => {
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next;
        options.onChange?.(current);
      }
      return current;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      const startedAt = Date.now();
      void refresh().catch(error => {
        console.warn('[ListeningPorts] refresh_failed:', error);
      }).finally(() => {
        if (running) schedule(Math.max(POLL_INTERVAL_MS, (Date.now() - startedAt) / MAX_POLL_DUTY));
      });
    }, delayMs);
    timer.unref?.();
  };

  return {
    refresh,
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function classify(
  socket: ListeningSocket,
  table: ProcessTableRow[],
  terminals: Map<number, TerminalPane>,
  panePid: number,
): Owner {
  if (socket.pid === null) return { group: 'system' };
  const rows = new Map(table.map(row => [row.pid, row]));
  // Walk up from the owner: the nearest terminal or Pane ancestor decides.
  // Terminals descend from Pane, so a terminal is always reached first.
  const seen = new Set<number>();
  for (let pid: number | undefined = socket.pid; pid !== undefined && pid > 0 && !seen.has(pid); pid = rows.get(pid)?.parentPid) {
    seen.add(pid);
    const terminal = terminals.get(pid);
    if (terminal) return { group: 'pane-terminal', sessionId: terminal.sessionId, paneName: terminal.paneName };
    if (pid === panePid) return { group: 'pane' };
  }
  const row = rows.get(socket.pid);
  return row && isSystemProcess(row) ? { group: 'system' } : { group: 'other' };
}

/** An OS service: another user's process, or a program shipped with the OS. */
function isSystemProcess(row: ProcessTableRow): boolean {
  if (row.uid !== null && row.uid !== process.getuid?.()) return true;
  if (process.platform === 'darwin') return row.executable.startsWith('/System/') || row.executable.startsWith('/usr/libexec/');
  if (process.platform === 'win32') {
    const systemRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + path.win32.sep;
    return row.pid <= 4 || !path.win32.isAbsolute(row.executable) || row.executable.toLowerCase().startsWith(systemRoot);
  }
  return false;
}

/** `web` when the port answers an HTTP request with any status within 500 ms. */
function probeKind(port: number): Promise<ListeningPortKind> {
  return new Promise(resolve => {
    // `localhost` by name: a dev server may bind only IPv6 loopback, and
    // Node tries both address families.
    const request = http.request({ method: 'HEAD', host: 'localhost', port, path: '/', timeout: WEB_PROBE_TIMEOUT_MS }, response => {
      response.destroy();
      resolve('web');
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve('tcp'));
    request.end();
  });
}

/** One entry per listening port, from the platform's socket table. */
async function readListeningSockets(): Promise<ListeningSocket[]> {
  const sockets = process.platform === 'win32'
    ? await readWindowsSockets()
    : process.platform === 'darwin'
      ? await readLsofSockets()
      : await readSsSockets();
  const byPort = new Map<number, ListeningSocket>();
  for (const socket of sockets) {
    if (Number.isInteger(socket.port) && socket.port > 0 && !byPort.has(socket.port)) byPort.set(socket.port, socket);
  }
  return [...byPort.values()];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: READ_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matches, or when it could not read every process; its output is still the answer.
      if (error && error.code !== 1) reject(error);
      else resolve(stdout);
    });
  });
}

function portOf(address: string): number {
  return Number.parseInt(address.slice(address.lastIndexOf(':') + 1), 10);
}

/** macOS: `lsof -F` prints one field per line: p<pid>, c<command>, n<address>. */
async function readLsofSockets(): Promise<ListeningSocket[]> {
  const stdout = await run('lsof', ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  const sockets: ListeningSocket[] = [];
  let pid: number | null = null;
  let command = '';
  for (const line of stdout.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) pid = Number.parseInt(value, 10);
    else if (line.startsWith('c')) command = value;
    else if (line.startsWith('n')) sockets.push({ port: portOf(value), pid, process: command });
  }
  return sockets;
}

/** Linux: `ss` names the owner only for this user's processes; others list with no pid. */
async function readSsSockets(): Promise<ListeningSocket[]> {
  const stdout = await run('ss', ['-Hltnp']);
  const sockets: ListeningSocket[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4) continue;
    const owner = /users:\(\("([^"]*)",pid=(\d+)/u.exec(line);
    sockets.push({
      port: portOf(fields[3]),
      pid: owner ? Number.parseInt(owner[2], 10) : null,
      process: owner?.[1] ?? '',
    });
  }
  return sockets;
}

async function readWindowsSockets(): Promise<ListeningSocket[]> {
  const stdout = await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$names = @{}; Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }; '
      + 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalPort)`t$($_.OwningProcess)`t$($names[[int]$_.OwningProcess])" }',
  ]);
  const sockets: ListeningSocket[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [port, pid, name = ''] = line.split('\t');
    if (!pid) continue;
    sockets.push({ port: Number.parseInt(port, 10), pid: Number.parseInt(pid, 10), process: name });
  }
  return sockets;
}
