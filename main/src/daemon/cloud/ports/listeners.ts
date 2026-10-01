import fs from 'fs';
import type { ProcessEntry } from '../processTree';

export interface TcpListener {
  port: number;
  address: string;
  inode: number;
}

const LISTEN_STATE = '0A';
/** Loopback and wildcard binds: what a dev server an agent starts listens on. Tailnet IPs are tailscaled's own. */
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '0.0.0.0', '::', '::1', '::ffff:127.0.0.1', '::ffff:0.0.0.0']);

function ipv4FromHex(hex: string): string {
  // /proc prints the 32-bit address in host byte order (little-endian on x86 and arm64).
  const bytes = [6, 4, 2, 0].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return bytes.join('.');
}

function ipv6FromHex(hex: string): string {
  const groups: string[] = [];
  for (let word = 0; word < 4; word++) {
    const chunk = hex.slice(word * 8, word * 8 + 8).toLowerCase();
    // Each 32-bit word is little-endian.
    const bytes = [6, 4, 2, 0].map(offset => chunk.slice(offset, offset + 2)).join('');
    groups.push(bytes.slice(0, 4), bytes.slice(4, 8));
  }
  const text = groups.map(group => group.replace(/^0+(?=.)/u, '')).join(':');
  if (text === '0:0:0:0:0:0:0:0') return '::';
  if (text === '0:0:0:0:0:0:0:1') return '::1';
  const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/u.exec(text);
  if (mapped) {
    const high = Number.parseInt(mapped[1] ?? '0', 16);
    const low = Number.parseInt(mapped[2] ?? '0', 16);
    return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return text;
}

/** LISTEN sockets from the text of /proc/net/tcp or /proc/net/tcp6. */
export function parseProcNetTcp(text: string, family: 4 | 6): TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
    const [addressHex, portHex] = (fields[1] ?? '').split(':');
    if (!addressHex || !portHex) continue;
    const address = family === 4 ? ipv4FromHex(addressHex) : ipv6FromHex(addressHex);
    const inode = Number(fields[9]);
    listeners.push({ port: Number.parseInt(portHex, 16), address, inode });
  }
  return listeners;
}

export function isLocalBind(address: string): boolean {
  return LOCAL_ADDRESSES.has(address);
}

export function readLocalListeners(procRoot = '/proc'): TcpListener[] {
  const found: TcpListener[] = [];
  const sources: Array<[string, 4 | 6]> = [['net/tcp', 4], ['net/tcp6', 6]];
  for (const [file, family] of sources) {
    try {
      found.push(...parseProcNetTcp(fs.readFileSync(`${procRoot}/${file}`, 'utf8'), family));
    } catch {
      // No IPv6, or not Linux.
    }
  }
  return found.filter(listener => isLocalBind(listener.address));
}

/** Socket inode -> pid, for the processes this user may inspect (others are skipped). */
export function mapSocketOwners(inodes: ReadonlySet<number>, pids: readonly number[], procRoot = '/proc'): Map<number, number> {
  const owners = new Map<number, number>();
  if (inodes.size === 0) return owners;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`${procRoot}/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(`${procRoot}/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/u.exec(link);
      const inode = match ? Number(match[1]) : NaN;
      if (inodes.has(inode) && !owners.has(inode)) owners.set(inode, pid);
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

/** The panel whose PTY process `pid` descends from, if any. */
export function findPanelAncestor<Panel extends { pid: number }>(
  pid: number,
  table: readonly ProcessEntry[],
  panels: readonly Panel[],
): Panel | undefined {
  const parents = new Map(table.map(entry => [entry.pid, entry.ppid]));
  const byPid = new Map(panels.map(panel => [panel.pid, panel]));
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < 64; depth++) {
    const panel = byPid.get(current);
    if (panel) return panel;
    current = parents.get(current);
  }
  return undefined;
}
