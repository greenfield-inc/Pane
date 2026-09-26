import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  DEFAULT_REMOTE_DAEMON_HOST_CONFIG,
  encodePaneRemoteConnection,
  normalizeRemoteDaemonConfig,
  type PaneRemoteConnectionImportPayload,
  type RemoteHostSetupRequest,
  type RemoteHostSetupServiceResult,
  type RemoteHostSetupResult,
  type RemoteDaemonConfig,
  type RemoteDaemonHostAccess,
  type RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import {
  createPaneRemoteConnectionImportPayload,
  createRemoteDaemonConnectionPair,
} from './remotePairing';
import {
  buildTailscaleServeCommand,
  getTailscaleServeSetupInstructions,
  getTailscaleSetupInstructions,
  installTailscaleCommandOrThrow,
  resolveTailscaleCommand,
  runCommand as runTailscaleCommand,
  runTailscaleServeInteractive,
  type ResolvedCommand,
  type TailscaleSetupDependencies,
} from './tailscaleSetup';
import {
  boundary,
  decodeBoundary,
  type JsonObject,
} from '../../../shared/validation/boundaryDecoder';
import {
  assertRemoteDaemonServiceCanBeInstalled,
  buildManualRemoteDaemonCommand,
  installRemoteDaemonService,
  type RemoteDaemonServiceDependencies,
} from './remoteDaemonService';

export interface SetupRemoteHostOptions extends Omit<RemoteHostSetupRequest, 'dataDirectoryMode'> {
  printOnly?: boolean;
  interactiveTailscaleSetup?: boolean;
  autoSelectListenPort?: boolean;
  existingConfig?: object;
  writeConfig?: (config: RemoteHostConfigDocument) => Promise<void>;
  serviceDependencies?: RemoteDaemonServiceDependencies;
  tailscaleDependencies?: TailscaleSetupDependencies;
}

interface RemoteHostConfigDocument {
  remoteDaemon: RemoteDaemonConfig;
}

type WritableConfigDocument = JsonObject | RemoteHostConfigDocument;

export type SetupRemoteHostResult = Omit<RemoteHostSetupResult, 'dataDirectoryMode'>;

interface TunnelSelection {
  baseUrl: string;
  tunnel: PaneRemoteConnectionImportPayload['tunnel'];
  fallbackCommands: string[];
}

const DEFAULT_REMOTE_PANE_DIR = '.pane_remote';
const DEFAULT_TUNNEL_PREFERENCE: RemoteSetupTunnelPreference = 'tailscale';

export async function setupRemoteHost(options: SetupRemoteHostOptions = {}): Promise<SetupRemoteHostResult> {
  const paneDir = path.resolve(options.paneDir ?? process.env.PANE_DIR ?? path.join(os.homedir(), DEFAULT_REMOTE_PANE_DIR));
  if (!options.printOnly && options.installService !== false) {
    assertRemoteDaemonServiceCanBeInstalled(options.serviceDependencies);
  }
  const configPath = path.join(paneDir, 'config.json');
  const preferredListenPort = normalizePort(options.listenPort ?? DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenPort);
  const listenPort = options.autoSelectListenPort === true
    ? await findAvailableLoopbackPort(preferredListenPort)
    : preferredListenPort;
  const label = normalizeLabel(options.label);
  const channel = options.channel ?? 'stable';
  const manualDaemonCommand = buildManualRemoteDaemonCommand(paneDir, options.serviceDependencies);
  const tunnelSelection = selectTunnel({
    listenPort,
    preferTunnel: options.preferTunnel ?? DEFAULT_TUNNEL_PREFERENCE,
    exposeTailscale: options.exposeTailscale !== false,
    printOnly: options.printOnly === true,
    interactiveTailscaleSetup: options.interactiveTailscaleSetup === true,
    manualBaseUrl: options.baseUrl,
    tailscaleDependencies: options.tailscaleDependencies,
  });
  const pair = createRemoteDaemonConnectionPair({
    label,
    baseUrl: tunnelSelection.baseUrl,
  });
  const importPayload = createPaneRemoteConnectionImportPayload(pair, tunnelSelection.tunnel);
  const connectionCode = encodePaneRemoteConnection(importPayload);

  let wroteConfig = false;
  if (!options.printOnly) {
    const existingConfig = options.existingConfig
      ? decodeBoundary(options.existingConfig, boundary.jsonObject)
      : await readConfigFile(configPath);
    const nextRemoteDaemon = buildNextRemoteDaemonConfig(
      existingConfig.remoteDaemon,
      pair.client,
      listenPort,
      createRemoteHostAccess(tunnelSelection.baseUrl, tunnelSelection.tunnel),
    );
    const nextConfig = {
      ...existingConfig,
      remoteDaemon: nextRemoteDaemon,
    };
    if (options.writeConfig) {
      await options.writeConfig(nextConfig);
    } else {
      await writeConfigFileAtomically(paneDir, configPath, nextConfig);
    }
    wroteConfig = true;
  }

  const service = options.printOnly || options.installService === false
    ? {
        strategy: options.printOnly ? 'skipped' : 'manual',
        installed: false,
        started: false,
        message: options.printOnly
          ? 'Print-only mode did not write config or install a daemon service.'
          : 'Service installation disabled; use the manual daemon command.',
      } satisfies RemoteHostSetupServiceResult
    : await installRemoteDaemonService(paneDir, options.serviceDependencies);

  const result: SetupRemoteHostResult = {
    paneDir,
    configPath,
    label,
    listenPort,
    channel,
    connectionCode,
    tunnel: tunnelSelection.tunnel,
    fallbackTunnelCommands: tunnelSelection.fallbackCommands,
    service,
    manualDaemonCommand,
    wroteConfig,
  };
  if (options.repoRef) {
    result.repoRef = options.repoRef;
  }
  return result;
}

export function formatSetupRemoteHostResult(result: SetupRemoteHostResult): string {
  const lines = [
    'Pane remote daemon setup',
    `Data directory: ${result.paneDir}`,
    `Config: ${result.configPath}`,
    `Channel: ${result.channel}${result.repoRef ? ` (${result.repoRef})` : ''}`,
    `Service: ${result.service.strategy} - ${result.service.message}`,
    `Config written: ${result.wroteConfig ? 'yes' : 'no'}`,
    '',
    'Connection code:',
    result.connectionCode,
    '',
  ];

  if (result.tunnel?.command) {
    lines.push('Connection/tunnel command:');
    lines.push(result.tunnel.command);
    lines.push('');
  }

  if (result.tunnel?.note) {
    lines.push(`Connection note: ${result.tunnel.note}`);
    lines.push('');
  }

  const fallbackCommands = result.fallbackTunnelCommands.filter((command) => command !== result.tunnel?.command);
  if (fallbackCommands.length > 0) {
    lines.push('Fallback tunnel options:');
    for (const command of fallbackCommands) {
      lines.push(command);
    }
    lines.push('');
  }

  if (!result.service.started) {
    lines.push('Manual daemon command:');
    lines.push(result.manualDaemonCommand);
    lines.push('');
  }

  lines.push('Paste the full pane-remote:// code into Settings > Remote Pane in desktop Pane, or into https://runpane.com/app/.');
  return lines.join('\n');
}

function createRemoteHostAccess(
  baseUrl: string,
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'],
): RemoteDaemonHostAccess {
  const access: RemoteDaemonHostAccess = {
    baseUrl,
    updatedAt: new Date().toISOString(),
  };
  if (tunnel) {
    access.tunnel = tunnel;
  }
  return access;
}

export function readConfiguredTailscaleServeAccess(listenPort: number): RemoteDaemonHostAccess | null {
  const tailscaleCli = resolveTailscaleCommand();
  if (!tailscaleCli) {
    return null;
  }

  const serveStatus = runTailscaleCommand(tailscaleCli, ['serve', 'status']);
  if (!serveStatus.ok) {
    return null;
  }

  const serveUrl = extractFirstHttpsUrl([serveStatus.stdout, serveStatus.stderr].join('\n'));
  if (!serveUrl) {
    return null;
  }

  const tailscaleCommand = buildTailscaleServeCommand(tailscaleCli, listenPort);
  const tailscaleIp = readTailscaleIpv4(tailscaleCli);

  const tunnel: NonNullable<PaneRemoteConnectionImportPayload['tunnel']> = {
    kind: 'tailscale',
    selected: true,
    command: tailscaleCommand,
    note: 'Tailscale Serve is configured for this tailnet. Keep Pane running on this host when using current data mode. If another device cannot connect immediately, wait a few minutes for Tailscale Serve to finish provisioning, then retry.',
  };
  if (tailscaleIp) {
    tunnel.tailscaleIp = tailscaleIp;
  }
  return createRemoteHostAccess(serveUrl, tunnel);
}

function buildNextRemoteDaemonConfig(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Saved config is normalized before host setup reads or updates its fields.
  value: unknown,
  client: RemoteDaemonConfig['host']['clients'][number],
  listenPort: number,
  access: RemoteDaemonHostAccess,
): RemoteDaemonConfig {
  const current = normalizeRemoteDaemonConfig(value);
  return normalizeRemoteDaemonConfig({
    ...current,
    host: {
      ...current.host,
      config: {
        ...current.host.config,
        enabled: true,
        listenHost: DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenHost,
        listenPort,
        pairingRequired: true,
        allowInsecureHttpOnLoopback: true,
      },
      clients: upsertById(current.host.clients, client),
      access,
    },
  });
}

async function readConfigFile(configPath: string): Promise<JsonObject> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = decodeBoundary(JSON.parse(raw), boundary.json);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {};
    }
    throw error;
  }
}

async function writeConfigFileAtomically(
  paneDir: string,
  configPath: string,
  config: WritableConfigDocument,
): Promise<void> {
  await fs.mkdir(paneDir, { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function selectTunnel(options: {
  listenPort: number;
  preferTunnel: RemoteSetupTunnelPreference;
  exposeTailscale: boolean;
  printOnly: boolean;
  interactiveTailscaleSetup: boolean;
  manualBaseUrl?: string;
  tailscaleDependencies?: TailscaleSetupDependencies;
}): TunnelSelection {
  const sshCommand = buildSshForwardCommand(options.listenPort);
  const fallbackCommands = [sshCommand, buildTailscaleServeCommand(null, options.listenPort)];
  const manualBaseUrl = options.manualBaseUrl?.trim();

  if (manualBaseUrl) {
    return {
      baseUrl: manualBaseUrl,
      fallbackCommands,
      tunnel: {
        kind: 'manual',
        selected: true,
        note: 'Use the configured HTTPS tunnel or reverse proxy before connecting.',
      },
    };
  }

  if (options.preferTunnel === 'manual') {
    throw new Error('Manual HTTPS remote setup requires a base URL. Use an HTTPS tunnel or choose SSH Tunnel for local forwarding.');
  }

  if (options.preferTunnel === 'ssh') {
    return {
      baseUrl: `http://127.0.0.1:${options.listenPort}`,
      fallbackCommands,
      tunnel: {
        kind: 'ssh',
        selected: true,
        command: sshCommand,
        note: 'Run this SSH tunnel command on the client machine before connecting. SSH tunnel mode is intended for advanced local forwarding, not zero-config cross-device setup.',
      },
    };
  }

  if (options.preferTunnel === 'tailscale' || options.preferTunnel === 'auto') {
    const initialTailscaleCli = resolveTailscaleCommand(options.tailscaleDependencies);
    const tailscaleCommand = buildTailscaleServeCommand(initialTailscaleCli, options.listenPort);
    return selectTailscaleTunnel({
      listenPort: options.listenPort,
      exposeTailscale: options.exposeTailscale,
      printOnly: options.printOnly,
      interactiveTailscaleSetup: options.interactiveTailscaleSetup,
      tailscaleCli: initialTailscaleCli,
      tailscaleCommand,
      fallbackCommands: [sshCommand, tailscaleCommand],
      tailscaleDependencies: options.tailscaleDependencies,
    });
  }

  return assertNeverTunnelPreference(options.preferTunnel);
}

function selectTailscaleTunnel(options: {
  listenPort: number;
  exposeTailscale: boolean;
  printOnly: boolean;
  interactiveTailscaleSetup: boolean;
  tailscaleCli: ResolvedCommand | null;
  tailscaleCommand: string;
  fallbackCommands: string[];
  tailscaleDependencies?: TailscaleSetupDependencies;
}): TunnelSelection {
  if (!options.exposeTailscale) {
    throw new Error(`Tailscale is required for cross-device remote setup. Remove --no-tailscale-serve or choose SSH Tunnel under advanced options.\n\n${getTailscaleSetupInstructions()}`);
  }

  if (options.printOnly) {
    throw new Error('Tailscale setup cannot run in print-only mode because Pane must configure Tailscale Serve before it can create a cross-device connection code.');
  }

  const tailscaleCli = options.tailscaleCli ?? installTailscaleCommandOrThrow(options.tailscaleDependencies);
  const tailscaleCommand = buildTailscaleServeCommand(tailscaleCli, options.listenPort);

  const tailscaleServe = options.interactiveTailscaleSetup
    ? runTailscaleServeInteractive(tailscaleCli, options.listenPort, options.tailscaleDependencies)
    : runTailscaleCommand(
        tailscaleCli,
        ['serve', '--bg', '--tls-terminated-tcp=443', String(options.listenPort)],
        {},
        options.tailscaleDependencies,
      );
  if (!tailscaleServe.ok) {
    const instructions = options.interactiveTailscaleSetup
      ? getTailscaleServeSetupInstructions(options.listenPort)
      : getTailscaleSetupInstructions();
    throw new Error(`Tailscale Serve setup failed: ${firstNonEmpty(tailscaleServe.stderr, tailscaleServe.stdout, 'unknown error')}\n\n${instructions}`);
  }

  const serveStatus = runTailscaleCommand(tailscaleCli, ['serve', 'status'], {}, options.tailscaleDependencies);
  const serveUrl = extractFirstHttpsUrl([
    tailscaleServe.stdout,
    tailscaleServe.stderr,
    serveStatus.ok ? serveStatus.stdout : '',
    serveStatus.ok ? serveStatus.stderr : '',
  ].join('\n'));

  if (!serveUrl) {
    throw new Error(`Tailscale Serve was configured, but Pane could not find an HTTPS Tailscale URL in the command output. Run "${tailscaleCommand}" manually and confirm Tailscale is logged in.\n\n${getTailscaleSetupInstructions()}`);
  }

  const tailscaleIp = readTailscaleIpv4(tailscaleCli, options.tailscaleDependencies);

  const tunnel: NonNullable<TunnelSelection['tunnel']> = {
    kind: 'tailscale',
    selected: true,
    command: tailscaleCommand,
    note: 'Tailscale Serve is configured for this tailnet. Keep Pane running on this host when using current data mode. If another device cannot connect immediately, wait a few minutes for Tailscale Serve to finish provisioning, then retry.',
  };
  if (tailscaleIp) {
    tunnel.tailscaleIp = tailscaleIp;
  }

  return {
    baseUrl: serveUrl,
    fallbackCommands: options.fallbackCommands.includes(tailscaleCommand)
      ? options.fallbackCommands
      : [options.fallbackCommands[0], tailscaleCommand],
    tunnel,
  };
}

function assertNeverTunnelPreference(value: never): never {
  throw new Error(`Unsupported remote setup tunnel preference: ${String(value)}`);
}

function buildSshForwardCommand(port: number): string {
  const username = safeUsername();
  const hostname = os.hostname();
  return `ssh -N -L ${port}:127.0.0.1:${port} ${username}@${hostname}`;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return 'user';
  }
}

function normalizeLabel(label: string | undefined): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `${os.hostname()} Pane daemon`;
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error('Remote daemon listen port must be between 1 and 65535');
  }
  return value;
}

async function findAvailableLoopbackPort(preferredPort: number): Promise<number> {
  const maxAttempts = 100;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65535) {
      break;
    }
    if (await isLoopbackPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`Could not find an available remote daemon port starting at ${preferredPort}`);
}

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const cleanup = () => {
      server.removeAllListeners();
    };
    const resolveOnce = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    server.once('error', (error) => {
      if (isNodeErrorWithCode(error, 'EADDRINUSE') || isNodeErrorWithCode(error, 'EACCES')) {
        resolveOnce(false);
        return;
      }
      cleanup();
      reject(error);
    });
    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          cleanup();
          reject(error);
          return;
        }
        resolveOnce(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

function extractFirstHttpsUrl(output: string): string | null {
  const httpsMatch = output.match(/https:\/\/[^\s|"'<>]+/);
  if (httpsMatch) {
    return httpsMatch[0].replace(/[),.]+$/g, '');
  }

  const tailscaleTcpMatch = output.match(/tcp:\/\/([^/\s|"'<>:]+)(?::443)?(?:\s+\(TLS terminated\))?/);
  if (!tailscaleTcpMatch) {
    return null;
  }

  return `https://${tailscaleTcpMatch[1]}`;
}

function readTailscaleIpv4(
  tailscaleCli: ResolvedCommand,
  dependencies?: TailscaleSetupDependencies,
): string | null {
  const result = runTailscaleCommand(tailscaleCli, ['ip', '-4'], {}, dependencies);
  if (!result.ok) {
    return null;
  }

  return result.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .find(isIpv4Address)
    ?? null;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const numericPart = Number(part);
    return numericPart >= 0 && numericPart <= 255;
  });
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Setup parses external command JSON before reading its fields.
function isRecord(value: unknown): value is JsonObject {
  try {
    decodeBoundary(value, boundary.jsonObject);
    return true;
  } catch {
    return false;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught OS errors are decoded before inspecting their error code.
function isNodeErrorWithCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  try {
    const decoded = decodeBoundary(error, boundary.object({ code: boundary.string }));
    return decoded.code === code;
  } catch {
    return false;
  }
}


function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? '';
}
