import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream';
import { createWebSocketStream, type WebSocket } from 'ws';

/**
 * Mirrors a remote host's forwarded ports onto this machine's loopback. Each port gets
 * listeners on 127.0.0.1 and ::1, and every connection they accept becomes one stream
 * to the host.
 */
export interface PortTunnel {
  /**
   * Listens for every host port in `hostPorts` that is not listening yet and closes the
   * listeners of ports no longer listed. Resolves to where each port is reachable here.
   */
  sync(hostPorts: readonly number[]): Promise<ReadonlyMap<number, number>>;
  close(): Promise<void>;
}

/** Opens one stream to a host port, already authenticated for the host's connection. */
export type OpenPortStream = (hostPort: number) => WebSocket;

interface PortListener {
  localPort: number;
  servers: net.Server[];
  sockets: Set<net.Socket>;
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
/** How many ports above the host's number to try when the host's own is taken here, before any free port. */
const MAX_PORT_ATTEMPTS = 20;
const ANSWER_PROBE_TIMEOUT_MS = 300;
const MAX_PORT = 65_535;
/**
 * Every Pane process on this machine lists its tunnel listeners here, one file per pid, so hosts
 * leave them out of their Ports lists. Otherwise two desktops would mirror each other's
 * listeners without end: two clients of one host, or two Panes connected to each other.
 */
const TUNNEL_REGISTRY_DIR = path.join(os.tmpdir(), 'pane-port-tunnels');
const TUNNEL_REGISTRY_FILE = path.join(TUNNEL_REGISTRY_DIR, `${process.pid}.json`);
const liveTunnels = new Set<ReadonlyMap<number, PortListener>>();
let removesRegistryOnExit = false;

export function createPortTunnel(openStream: OpenPortStream): PortTunnel {
  const listeners = new Map<number, PortListener>();
  liveTunnels.add(listeners);
  let closed = false;

  const ownLocalPorts = () => new Set([...listeners.values()].map(listener => listener.localPort));

  const accept = (hostPort: number, sockets: Set<net.Socket>) => (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const webSocket = openStream(hostPort);
    const stream = createWebSocketStream(webSocket);
    pipeline(socket, stream, socket, () => {
      socket.destroy();
      webSocket.terminate();
    });
  };

  const open = async (hostPort: number): Promise<PortListener | null> => {
    const taken = ownLocalPorts();
    for (let candidate = hostPort; candidate < hostPort + MAX_PORT_ATTEMPTS && candidate <= MAX_PORT; candidate += 1) {
      if (taken.has(candidate) || await answersHere(candidate)) continue;
      const listener = await listenFor(hostPort, candidate);
      if (listener) return listener;
    }
    // Everything near the host's number is taken: any free port the OS picks will do.
    const listener = await listenFor(hostPort, 0);
    if (!listener) console.warn(`[Pane port tunnel] No free local port for host port ${hostPort}`);
    return listener;
  };

  const listenFor = async (hostPort: number, localPort: number): Promise<PortListener | null> => {
    const sockets = new Set<net.Socket>();
    const bound = await listenOnLoopback(localPort, accept(hostPort, sockets));
    return bound && { localPort: bound.port, servers: bound.servers, sockets };
  };

  const shut = async (listener: PortListener) => {
    for (const socket of listener.sockets) socket.destroy();
    await Promise.all(listener.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  };

  return {
    async sync(hostPorts) {
      const wanted = new Set(hostPorts);
      for (const [hostPort, listener] of [...listeners]) {
        if (wanted.has(hostPort)) continue;
        listeners.delete(hostPort);
        await shut(listener);
      }
      for (const hostPort of wanted) {
        if (listeners.has(hostPort)) continue;
        const listener = await open(hostPort);
        if (!listener) continue;
        // A disconnect while this port was opening: the tunnel is gone, so is this listener.
        if (closed) await shut(listener);
        else {
          listeners.set(hostPort, listener);
          recordTunnelListeners();
        }
      }
      recordTunnelListeners();
      return new Map([...listeners].map(([hostPort, listener]) => [hostPort, listener.localPort]));
    },
    async close() {
      closed = true;
      const all = [...listeners.values()];
      listeners.clear();
      liveTunnels.delete(listeners);
      recordTunnelListeners();
      await Promise.all(all.map(shut));
    },
  };
}

/** Rewrites this process's registry file, or removes it when no tunnel listens. */
function recordTunnelListeners(): void {
  const ports = [...liveTunnels].flatMap(listeners => [...listeners.values()].map(listener => listener.localPort));
  try {
    if (ports.length === 0) {
      fs.rmSync(TUNNEL_REGISTRY_FILE, { force: true });
      return;
    }
    fs.mkdirSync(TUNNEL_REGISTRY_DIR, { recursive: true });
    if (!removesRegistryOnExit) {
      removesRegistryOnExit = true;
      process.once('exit', () => fs.rmSync(TUNNEL_REGISTRY_FILE, { force: true }));
    }
    // Renamed into place, so a host never reads half a file.
    const partial = `${TUNNEL_REGISTRY_FILE}.${Date.now()}.tmp`;
    fs.writeFileSync(partial, JSON.stringify(ports));
    fs.renameSync(partial, TUNNEL_REGISTRY_FILE);
  } catch (error) {
    console.warn('[Pane port tunnel] registry_write_failed:', error);
  }
}

/**
 * The tunnel listeners of every Pane process on this machine, by pid. A process removes its file
 * when it exits. A crashed process's file stays, which is harmless: a port is left out only when
 * the same pid owns it again.
 */
export async function readTunnelListeners(): Promise<ReadonlyMap<number, ReadonlySet<number>>> {
  const byPid = new Map<number, Set<number>>();
  const files = await fs.promises.readdir(TUNNEL_REGISTRY_DIR).catch(() => []);
  await Promise.all(files.filter(file => /^\d+\.json$/u.test(file)).map(async file => {
    try {
      const ports: unknown = JSON.parse(await fs.promises.readFile(path.join(TUNNEL_REGISTRY_DIR, file), 'utf8'));
      if (Array.isArray(ports)) byPid.set(Number.parseInt(file, 10), new Set(ports.filter(Number.isInteger)));
    } catch {
      // Removed between the listing and the read: that process has no tunnel any more.
    }
  }));
  return byPid;
}

/**
 * Whether a local service already answers on `port`. Binding alone cannot tell: macOS lets a
 * 127.0.0.1 listener take a port another app holds on 0.0.0.0, and would hide that app.
 */
async function answersHere(port: number): Promise<boolean> {
  const answers = await Promise.all(LOOPBACK_HOSTS.map(host => new Promise<boolean>(resolve => {
    const socket = net.connect({ host, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(ANSWER_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  })));
  return answers.some(Boolean);
}

/**
 * Listens on both loopback addresses, or on IPv4 alone when this machine has no IPv6. Port 0 lets
 * the OS pick IPv4's port, and IPv6 takes the same one. Null when the port is taken.
 */
async function listenOnLoopback(
  requestedPort: number,
  onConnection: (socket: net.Socket) => void,
): Promise<{ port: number; servers: net.Server[] } | null> {
  const servers: net.Server[] = [];
  let port = requestedPort;
  for (const host of LOOPBACK_HOSTS) {
    const server = net.createServer(onConnection);
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      server.once('error', resolve);
      server.listen(port, host, () => resolve(null));
    });
    if (!error) {
      servers.push(server);
      // SAFETY: a server listening on a host and port reports an AddressInfo.
      port = (server.address() as net.AddressInfo).port;
      continue;
    }
    if (host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) continue;
    await Promise.all(servers.map(open => new Promise<void>(resolve => open.close(() => resolve()))));
    return null;
  }
  return { port, servers };
}
