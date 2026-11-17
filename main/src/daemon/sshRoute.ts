import { spawn } from 'child_process';
import net from 'net';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { ComputerRoute } from '../../../shared/types/remoteComputers';

const SSH_CONNECT_TIMEOUT_S = 10;
/** ssh sends a keepalive this often and drops the tunnel after three go unanswered. */
const SERVER_ALIVE_INTERVAL_S = 15;
const TUNNEL_READY_TIMEOUT_MS = 20_000;
const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Background reconnects stop after this long; the next `ensureSshRoute` starts again. */
const RECONNECT_GIVE_UP_MS = 5 * 60_000;

export interface SshCommandResult {
  /** ssh's exit code: 255 is ssh's own failure (connect, auth), anything else is the remote command's. Null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SshForward {
  /** Resolves when the ssh process ends, for any reason. */
  exited: Promise<void>;
  /** The last lines ssh wrote to stderr, for an error message. */
  stderr(): string;
  kill(): void;
}

/** The system `ssh`, with the person's own config and agent. Keys and passwords never leave this computer. */
export interface SshRunner {
  /** Runs `ssh <args>`; `onLine` gets each stdout line as it arrives. */
  run(args: string[], options: { timeoutMs: number; onLine?: (line: string) => void }): Promise<SshCommandResult>;
  /** Starts `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <host>`. */
  forward(host: string, localPort: number, remotePort: number): SshForward;
}

/** Options every Pane ssh call passes: fail instead of asking for a password or host key. */
export function sshBatchOptions(): string[] {
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`];
}

export const systemSshRunner: SshRunner = {
  run(args, { timeoutMs, onLine }) {
    return new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let pending = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? '';
        for (const line of lines) onLine?.(line);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer);
        if (pending) onLine?.(pending);
        resolve({ code, stdout, stderr: error ? `${stderr}\n${error.message}` : stderr, timedOut });
      };
      child.once('error', (error) => finish(null, error));
      child.once('close', (code) => finish(code));
    });
  },
  forward(host, localPort, remotePort) {
    const child = spawn('ssh', [
      '-N',
      ...sshBatchOptions(),
      '-o', 'ExitOnForwardFailure=yes',
      '-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_S}`,
      '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      host,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    const exited = new Promise<void>((resolve) => {
      child.once('error', (error) => { stderr += `\n${error.message}`; resolve(); });
      child.once('exit', () => resolve());
    });
    return { exited, stderr: () => stderr, kill: () => { child.kill(); } };
  },
};

/** The last non-empty line of some output, or the fallback. */
export function lastLine(text: string, fallback: string): string {
  return text.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).pop() ?? fallback;
}

/** The port to listen on: `preferred` when it is free on loopback, otherwise any free port. */
async function pickLocalPort(preferred: number | undefined): Promise<number> {
  const port = (preferred ? await tryListen(preferred) : null) ?? await tryListen(0);
  if (port === null) throw new PaneError('ERR_SSH_NO_LOCAL_PORT', 'This computer has no free loopback port for the SSH tunnel, so Pane opened none.', 'Close some programs listening on 127.0.0.1, then try again.');
  return port;
}

function tryListen(port: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      // SAFETY: a server listening on a TCP host and port reports an AddressInfo.
      const bound = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(bound));
    });
  });
}

/** Resolves true once something accepts TCP connections on the loopback port, false after `timeoutMs`. */
async function waitForListener(port: number, timeoutMs: number, stopped: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopped()) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function portOf(baseUrl: string): number | undefined {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

interface Tunnel {
  host: string;
  remotePort: number;
  /** The local port the last tunnel used; the next one tries it first so the dialled URL keeps working. */
  localPort: number | undefined;
  forward: SshForward | null;
  up: boolean;
  starting: Promise<string> | null;
  retry: ReturnType<typeof setTimeout> | null;
  retryDelayMs: number;
  /** When the tunnel dropped; background reconnects give up `RECONNECT_GIVE_UP_MS` later. */
  droppedAt: number | null;
  stopped: boolean;
}

/** One tunnel keeper per SSH route: starts `ssh -N -L`, and reconnects with backoff when it drops. */
export class SshTunnels {
  private readonly tunnels = new Map<string, Tunnel>();

  constructor(
    private readonly runner: SshRunner = systemSshRunner,
    private readonly timing = { readyTimeoutMs: TUNNEL_READY_TIMEOUT_MS, firstRetryMs: RECONNECT_FIRST_DELAY_MS, maxRetryMs: RECONNECT_MAX_DELAY_MS, giveUpMs: RECONNECT_GIVE_UP_MS },
  ) {}

  /** Makes sure the route's tunnel is up and resolves the local base URL to dial. */
  ensure(route: ComputerRoute): Promise<string> {
    if (route.kind !== 'ssh' || !route.ssh) {
      return Promise.reject(new PaneError('ERR_SSH_ROUTE_INVALID', `Route ${route.id} is not an SSH route, so Pane opened no tunnel for it.`, 'Remove the route and add the computer again from Add a device › SSH.'));
    }
    const key = tunnelKey(route.ssh.host, route.ssh.remotePort);
    let tunnel = this.tunnels.get(key);
    if (!tunnel) {
      tunnel = {
        host: route.ssh.host, remotePort: route.ssh.remotePort, localPort: portOf(route.baseUrl), forward: null, up: false,
        starting: null, retry: null, retryDelayMs: this.timing.firstRetryMs, droppedAt: null, stopped: false,
      };
      this.tunnels.set(key, tunnel);
    }
    tunnel.stopped = false;
    if (tunnel.up && tunnel.localPort) return Promise.resolve(localBaseUrl(tunnel.localPort));
    if (tunnel.starting) return tunnel.starting;
    this.clearRetry(tunnel);
    return this.start(tunnel);
  }

  /** Closes the route's tunnel and stops reconnecting it. */
  stop(host: string, remotePort: number): void {
    const key = tunnelKey(host, remotePort);
    const tunnel = this.tunnels.get(key);
    if (!tunnel) return;
    tunnel.stopped = true;
    this.clearRetry(tunnel);
    tunnel.forward?.kill();
    this.tunnels.delete(key);
  }

  stopAll(): void {
    for (const tunnel of [...this.tunnels.values()]) this.stop(tunnel.host, tunnel.remotePort);
  }

  private start(tunnel: Tunnel): Promise<string> {
    const attempt = (async () => {
      const localPort = await pickLocalPort(tunnel.localPort);
      const forward = this.runner.forward(tunnel.host, localPort, tunnel.remotePort);
      tunnel.forward = forward;
      let exited = false;
      void forward.exited.then(() => { exited = true; });
      const ready = await waitForListener(localPort, this.timing.readyTimeoutMs, () => exited || tunnel.stopped);
      if (!ready || exited) {
        forward.kill();
        tunnel.forward = null;
        const reason = lastLine(forward.stderr(), exited ? 'ssh exited' : `nothing listened on 127.0.0.1:${localPort} after ${Math.round(this.timing.readyTimeoutMs / 1000)} s`);
        throw new PaneError(
          'ERR_SSH_TUNNEL_FAILED',
          `Pane could not open the SSH tunnel to ${tunnel.host}: ${reasonOf(reason)}. Nothing changed on ${tunnel.host}.`,
          `Check that "ssh ${tunnel.host}" connects in a terminal without asking for a password, then try again.`,
        );
      }
      tunnel.localPort = localPort;
      tunnel.up = true;
      tunnel.droppedAt = null;
      tunnel.retryDelayMs = this.timing.firstRetryMs;
      void forward.exited.then(() => this.dropped(tunnel, forward));
      return localBaseUrl(localPort);
    })();
    tunnel.starting = attempt;
    // Clear `starting` before the caller sees the outcome, so a retry after a failure starts afresh.
    return attempt.finally(() => { if (tunnel.starting === attempt) tunnel.starting = null; });
  }

  private dropped(tunnel: Tunnel, forward: SshForward): void {
    if (tunnel.forward !== forward) return;
    tunnel.forward = null;
    tunnel.up = false;
    if (tunnel.stopped) return;
    console.warn(`[SSH route] Tunnel to ${tunnel.host} dropped (${lastLine(forward.stderr(), 'ssh exited')}); reconnecting.`);
    tunnel.droppedAt ??= Date.now();
    this.scheduleRetry(tunnel);
  }

  private scheduleRetry(tunnel: Tunnel): void {
    if (tunnel.stopped || tunnel.retry || tunnel.droppedAt === null) return;
    if (Date.now() - tunnel.droppedAt > this.timing.giveUpMs) {
      console.warn(`[SSH route] Gave up reconnecting to ${tunnel.host}; the next connect tries again.`);
      return;
    }
    const delay = tunnel.retryDelayMs;
    tunnel.retryDelayMs = Math.min(delay * 2, this.timing.maxRetryMs);
    tunnel.retry = setTimeout(() => {
      tunnel.retry = null;
      if (tunnel.stopped || tunnel.up || tunnel.starting) return;
      this.start(tunnel).catch((error) => {
        console.warn(`[SSH route] Reconnecting to ${tunnel.host} failed: ${reasonOf(error)}`);
        this.scheduleRetry(tunnel);
      });
    }, delay);
  }

  private clearRetry(tunnel: Tunnel): void {
    if (tunnel.retry) clearTimeout(tunnel.retry);
    tunnel.retry = null;
  }
}

function tunnelKey(host: string, remotePort: number): string {
  return `${host}\u0000${remotePort}`;
}

function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

let sharedTunnels: SshTunnels | null = null;

function tunnels(): SshTunnels {
  if (!sharedTunnels) {
    const created = new SshTunnels();
    sharedTunnels = created;
    // ssh children outlive Pane otherwise, holding their local ports.
    process.once('exit', () => created.stopAll());
  }
  return sharedTunnels;
}

/** Makes sure the tunnel for this SSH route is up and resolves the local base URL to dial. */
export function ensureSshRoute(route: ComputerRoute): Promise<string> {
  return tunnels().ensure(route);
}

/** Closes an SSH route's tunnel, for a route that was removed. */
export function stopSshRoute(route: ComputerRoute): void {
  if (route.ssh) sharedTunnels?.stop(route.ssh.host, route.ssh.remotePort);
}
