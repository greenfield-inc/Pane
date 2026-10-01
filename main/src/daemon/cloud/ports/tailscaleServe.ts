import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../../shared/validation/boundaryDecoder';
import type { SessionPortScheme } from '../../../../../shared/types/sessionPorts';
import { commandExecutor, type CommandExecutor } from '../../../utils/commandExecutor';

const COMMAND_TIMEOUT_MS = 20_000;
const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** tailscaled keeps issued certificates here (root only), one pair per MagicDNS name. */
const CERT_DIRECTORY = '/var/lib/tailscale/certs';

/** One Tailscale Serve listener on a tailnet port, as `tailscale serve status --json` reports it. */
export type ServeListener =
  | { kind: 'web'; scheme: SessionPortScheme; proxy?: string }
  | { kind: 'tcp'; forward: string; terminateTls: boolean };

interface ServeSelf {
  running: boolean;
  backendState: string;
  /** MagicDNS name without the trailing dot. */
  dnsName?: string;
}

/** What the ports service needs from Tailscale; the real one shells out, tests pass a fake. */
export interface ServeBackend {
  self(): Promise<ServeSelf>;
  /** Tailnet port -> its listener. */
  listeners(dnsName: string): Promise<Map<number, ServeListener>>;
  applyWeb(scheme: SessionPortScheme, tailnetPort: number, localPort: number): Promise<void>;
  /** Removes whatever Serve entry holds the tailnet port. */
  remove(tailnetPort: number, listener: ServeListener): Promise<void>;
  /** Whether tailscaled already holds a certificate for the name (so HTTPS costs no new issuance). */
  certCached(dnsName: string): Promise<boolean>;
}

class ServeCommandError extends Error {}

const statusSchema = boundary.object({
  BackendState: boundary.string,
  Self: boundary.optional(boundary.object({ DNSName: boundary.optional(boundary.string) })),
});

const serveConfigSchema = boundary.object({
  TCP: boundary.optional(boundary.jsonObject),
  Web: boundary.optional(boundary.jsonObject),
});

const tcpEntrySchema = boundary.object({
  HTTPS: boundary.optional(boundary.boolean),
  HTTP: boundary.optional(boundary.boolean),
  TCPForward: boundary.optional(boundary.string),
  TerminateTLS: boundary.optional(boundary.string),
});

const webEntrySchema = boundary.object({
  Handlers: boundary.optional(boundary.jsonObject),
});

const handlerSchema = boundary.object({ Proxy: boundary.optional(boundary.string) });

/** Parses `tailscale serve status --json` (an empty config prints `{}` or nothing). */
export function parseServeListeners(raw: string, dnsName: string): Map<number, ServeListener> {
  const listeners = new Map<number, ServeListener>();
  if (!raw.trim()) return listeners;
  const config = decodeBoundary(JSON.parse(raw), serveConfigSchema);
  for (const [portText, value] of Object.entries(config.TCP ?? {})) {
    const port = Number(portText);
    const entry = decodeOptionalBoundary(value, tcpEntrySchema);
    if (!Number.isInteger(port) || !entry) continue;
    if (entry.HTTPS || entry.HTTP) {
      const scheme: SessionPortScheme = entry.HTTPS ? 'https' : 'http';
      const web = decodeOptionalBoundary(config.Web?.[`${dnsName}:${port}`], webEntrySchema);
      const root = decodeOptionalBoundary(web?.Handlers?.['/'], handlerSchema);
      listeners.set(port, { kind: 'web', scheme, proxy: root?.Proxy });
    } else if (entry.TCPForward) {
      listeners.set(port, { kind: 'tcp', forward: entry.TCPForward, terminateTls: Boolean(entry.TerminateTLS) });
    }
  }
  return listeners;
}

export function describeListener(listener: ServeListener): string {
  if (listener.kind === 'tcp') return `${listener.terminateTls ? 'TLS-terminated tcp' : 'plain tcp'} -> ${listener.forward}`;
  return `${listener.scheme} -> ${listener.proxy ?? '(no root handler)'}`;
}

export function localTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Runner = (file: string, args: readonly string[]) => Promise<RunResult>;

const exitCodeSchema = boundary.object({ code: boundary.number });
const outputSchema = boundary.object({ stdout: boundary.string, stderr: boundary.string });

/**
 * Runs argv through the shared CommandExecutor, with its timeout and output cap. A failed exit, a
 * timeout or too much output comes back as a non-zero result, which the backend reports.
 */
export function serveRunner(executor: Pick<CommandExecutor, 'execFileAsync'> = commandExecutor): Runner {
  return async (file, args) => {
    try {
      const result = await executor.execFileAsync(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_LIMIT, silent: true });
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const code = decodeOptionalBoundary(error, exitCodeSchema)?.code || 1;
      const output = decodeOptionalBoundary(error, outputSchema);
      return { code, stdout: output?.stdout ?? '', stderr: output?.stderr || (error instanceof Error ? error.message : String(error)) };
    }
  };
}

function needsRoot(result: RunResult): boolean {
  return /access denied|permission denied|must be root|use 'sudo/iu.test(result.stderr);
}

/**
 * The real backend. The Session's user is tailscaled's operator (bootstrap sets `--operator`), so Serve
 * changes normally need no sudo; `sudo -n` is the fallback for a node set up without it.
 */
export function createTailscaleServeBackend(run: Runner = serveRunner()): ServeBackend {
  const tailscale = async (args: readonly string[]): Promise<RunResult> => {
    const direct = await run('tailscale', args);
    if (direct.code === 0 || !needsRoot(direct)) return direct;
    return run('sudo', ['-n', 'tailscale', ...args]);
  };
  const mustSucceed = async (args: readonly string[]): Promise<void> => {
    const result = await tailscale(args);
    if (result.code !== 0) {
      throw new ServeCommandError(`tailscale ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
    }
  };
  return {
    async self() {
      const result = await run('tailscale', ['status', '--json']);
      if (result.code !== 0) return { running: false, backendState: result.stderr.trim() || 'tailscale unavailable' };
      const status = decodeOptionalBoundary(JSON.parse(result.stdout || '{}'), statusSchema);
      if (!status) return { running: false, backendState: 'unreadable tailscale status' };
      const dnsName = status.Self?.DNSName?.replace(/\.$/u, '') || undefined;
      return { running: status.BackendState === 'Running', backendState: status.BackendState, dnsName };
    },
    async listeners(dnsName) {
      const result = await tailscale(['serve', 'status', '--json']);
      if (result.code !== 0) throw new ServeCommandError(`tailscale serve status failed: ${result.stderr.trim()}`);
      return parseServeListeners(result.stdout, dnsName);
    },
    applyWeb: (scheme, tailnetPort, localPort) => mustSucceed(['serve', '--bg', `--${scheme}=${tailnetPort}`, localTarget(localPort)]),
    async remove(tailnetPort, listener) {
      const flag = listener.kind === 'web' ? listener.scheme : listener.terminateTls ? 'tls-terminated-tcp' : 'tcp';
      await mustSucceed(['serve', `--${flag}=${tailnetPort}`, 'off']);
    },
    async certCached(dnsName) {
      const result = await run('sudo', ['-n', 'test', '-s', `${CERT_DIRECTORY}/${dnsName}.crt`]);
      return result.code === 0;
    },
  };
}
