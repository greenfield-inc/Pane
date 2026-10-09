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
/** A socket read slower than this share of the interval stretches the interval, so polling stays cheap. */
const MAX_POLL_DUTY = 0.1;
const READ_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT_MS = 500;
/**
 * A port that accepts but does not answer in time may be a dev server busy
 * with its first request (next dev compiles the page), so it is asked again
 * on later polls, this many times.
 */
const SILENT_PORT_RETRIES = 10;
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
  /** Set when the socket table did not name the program (Windows `netstat`). */
  process?: string;
  sessionId?: string;
  paneName?: string;
}

/**
 * Lists every listening TCP port on this machine with the process that owns it,
 * which group that process belongs to, and whether the port speaks HTTP.
 */
export function createListeningPortMonitor(options: ListeningPortMonitorOptions): ListeningPortMonitor {
  const panePid = options.panePid ?? process.pid;
  // Ownership never changes for a running process, and a port keeps its kind
  // once it answers, so both are remembered while the listener lives.
  const owners = new Map<string, Owner>();
  const kinds = new Map<string, { kind: ListeningPortKind; retriesLeft: number }>();
  let current: ListeningPortsSnapshot = { host: os.hostname(), ports: [] };
  let inFlight: Promise<ListeningPortsSnapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  // Only the socket read paces polling: probes wait on other programs, and
  // the process table is read only when a new owner appears.
  let socketReadMs = 0;

  const read = async (): Promise<ListeningPortsSnapshot> => {
    const readStartedAt = Date.now();
    const sockets = await readListeningSockets();
    socketReadMs = Date.now() - readStartedAt;
    const key = (socket: ListeningSocket) => `${socket.port}:${socket.pid ?? ''}:${socket.process}`;
    const unknownOwners = sockets.filter(socket => !owners.has(key(socket)));
    const provisional = new Map<string, Owner>();
    const terminalPanes = options.terminalPanes();
    if (unknownOwners.length > 0) {
      const table = await readProcessTable();
      const terminals = new Map(terminalPanes.map(terminal => [terminal.pid, terminal]));
      // An empty table means the read failed: use the answer once and ask again next poll.
      const target = table.length > 0 ? owners : provisional;
      for (const socket of unknownOwners) target.set(key(socket), classify(socket, table, terminals, panePid));
    }
    // SAFETY: every live socket was classified above.
    const ownerOf = (socket: ListeningSocket) => (owners.get(key(socket)) ?? provisional.get(key(socket)))!;
    await Promise.all(sockets.filter(socket => (kinds.get(key(socket))?.retriesLeft ?? 1) > 0).map(async socket => {
      if (ONE_SHOT_LISTENERS.has(ownerOf(socket).process ?? socket.process)) {
        kinds.set(key(socket), { kind: 'tcp', retriesLeft: 0 });
        return;
      }
      const answer = await probe(socket.port);
      const previous = kinds.get(key(socket));
      const retriesLeft = answer !== 'silent' ? 0 : previous ? previous.retriesLeft - 1 : SILENT_PORT_RETRIES;
      kinds.set(key(socket), { kind: answer === 'web' ? 'web' : 'tcp', retriesLeft });
    }));

    const live = new Set(sockets.map(key));
    for (const cached of [...owners.keys()]) if (!live.has(cached)) owners.delete(cached);
    for (const cached of [...kinds.keys()]) if (!live.has(cached)) kinds.delete(cached);

    // Pane names can change while a server runs, so they are read every poll;
    // a Pane whose terminals are gone keeps the name it had.
    const paneNames = new Map(terminalPanes.map(terminal => [terminal.sessionId, terminal.paneName]));
    const ports = sockets.map((socket): ListeningPort => {
      const owner = ownerOf(socket);
      // SAFETY: every live socket was probed above.
      const port: ListeningPort = { ...socket, ...owner, kind: kinds.get(key(socket))!.kind };
      const currentName = owner.sessionId === undefined ? undefined : paneNames.get(owner.sessionId);
      if (currentName !== undefined) port.paneName = currentName;
      return port;
    });
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
      void refresh().catch(error => {
        console.warn('[ListeningPorts] refresh_failed:', error);
      }).finally(() => {
        if (running) schedule(Math.max(POLL_INTERVAL_MS, socketReadMs / MAX_POLL_DUTY));
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
  const row = rows.get(socket.pid);
  const named = socket.process || !row ? {} : { process: path.win32.basename(row.executable).replace(/\.exe$/iu, '') };
  // Walk up from the owner: the nearest terminal or Pane ancestor decides.
  // Terminals descend from Pane, so a terminal is always reached first.
  const seen = new Set<number>();
  for (let pid: number | undefined = socket.pid; pid !== undefined && pid > 0 && !seen.has(pid); pid = rows.get(pid)?.parentPid) {
    seen.add(pid);
    const terminal = terminals.get(pid);
    if (terminal) return { ...named, group: 'pane-terminal', sessionId: terminal.sessionId, paneName: terminal.paneName };
    if (pid === panePid) return { ...named, group: 'pane' };
  }
  return { ...named, group: row && isSystemProcess(row) ? 'system' : 'other' };
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

/**
 * `web` when the port answers an HTTP request with any status within 500 ms,
 * `silent` when it accepts and says nothing in that time, else `tcp`.
 */
function probe(port: number): Promise<ListeningPortKind | 'silent'> {
  return new Promise(resolve => {
    // `localhost` by name: a dev server may bind only IPv6 loopback, and
    // Node tries both address families.
    const request = http.request({ method: 'HEAD', host: 'localhost', port, path: '/' }, () => finish('web'));
    // An absolute deadline: a socket timeout restarts on every byte, so a
    // port that trickles bytes would hold the poll open forever.
    const deadline = setTimeout(() => finish('silent'), WEB_PROBE_TIMEOUT_MS);
    const finish = (answer: ListeningPortKind | 'silent') => {
      clearTimeout(deadline);
      resolve(answer);
      request.destroy();
    };
    request.on('error', () => finish('tcp'));
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

/**
 * Windows: `netstat` starts in milliseconds where PowerShell takes over a
 * second. It names no program; the process table supplies that for new pids.
 * A listening socket's remote address is all zeros, which holds in every
 * Windows language, unlike the localized state column.
 */
async function readWindowsSockets(): Promise<ListeningSocket[]> {
  const stdout = (await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])])).join('\n');
  const sockets: ListeningSocket[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [proto, local, remote, , pid] = line.trim().split(/\s+/u);
    if (proto !== 'TCP' || (remote !== '0.0.0.0:0' && remote !== '[::]:0') || !pid) continue;
    sockets.push({ port: portOf(local), pid: Number.parseInt(pid, 10), process: '' });
  }
  return sockets;
}
