import fs from 'fs';
import http from 'http';
import https from 'https';
import { boundary, BoundaryDecodeError, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../../shared/validation/boundaryDecoder';
import { SESSION_PORTS_CHANGED_EVENT, type SessionPortsListResult } from '../../../../../shared/types/sessionPorts';
import { PaneCommandError } from '../../../core/commandError';
import type { PaneCommandRegistry, PaneCommandValue } from '../../commandRegistry';
import { CLOUD_SERVE_RECORD, whenCloudSession } from '../cloudSessionMarker';
import { readProcessTable } from '../processTree';
import { mapSocketOwners, readLocalListeners } from './listeners';
import { defaultPortsStatePath } from './portsStore';
import { SessionPortsService, type PanelProcess, type ProbeResult } from './sessionPorts';
import { createTailscaleServeBackend, type ServeBackend } from './tailscaleServe';

const DEFAULT_DAEMON_PORT = 42137;

interface SessionPortsWiring {
  commandRegistry: PaneCommandRegistry;
  panelIds(): string[];
  panelPid(panelId: string): number | undefined;
  paneIdOf(panelId: string): string | undefined;
  projectPaths(): string[];
  /** The daemon's own listen port, from its remote config. */
  daemonPort(): number | undefined;
  emit(channel: string, result: SessionPortsListResult): void;
  log(message: string): void;
  /** Tests: the Session marker file, the bootstrap state dir that means one is coming, how often to look, and the Serve backend. */
  serveRecordPath?: string;
  cloudBootstrapDir?: string;
  markerPollMs?: number;
  serve?: ServeBackend;
  statePath?: string;
}

const serveRecordSchema = boundary.object({ port: boundary.optional(boundary.number) });

const listRequestSchema = boundary.object({ verify: boundary.optional(boundary.boolean) });
const openRequestSchema = boundary.object({
  port: boundary.number,
  name: boundary.optional(boundary.string),
  httpsPort: boundary.optional(boundary.number),
  path: boundary.optional(boundary.string),
  yes: boundary.optional(boundary.boolean),
  scheme: boundary.optional(boundary.enumeration('auto', 'https', 'http')),
});
const closeRequestSchema = boundary.object({ target: boundary.union(boundary.number, boundary.string) });
const configureRequestSchema = boundary.object({ autoOpen: boundary.boolean });

function decodeRequest<T>(value: PaneCommandValue, schema: BoundarySchema<T>): T {
  try {
    return decodeBoundary(value ?? {}, schema);
  } catch (error) {
    if (error instanceof BoundaryDecodeError) throw new PaneCommandError(`Invalid ports request: ${error.message}`, 'ERR_PORTS_INVALID');
    throw error;
  }
}

/**
 * One GET with an overall deadline. Not fetch: undici gives up connecting after 10 s, and a first TLS
 * request on a new name waits while tailscaled gets the certificate, which can take longer.
 */
function probeUrl(url: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise(resolve => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).get(target, response => {
      clearTimeout(timer);
      response.resume();
      resolve({ ok: true, status: response.statusCode ?? 0 });
      request.destroy();
    });
    const timer = setTimeout(() => request.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    request.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

/** Whether this daemon runs in a Runpane Cloud Session; ports never act on a laptop's tailnet name. */
function readCloudServeRecord(file: string): { port?: number } | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), serveRecordSchema) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * Registers `runpane:ports:list|open|close|configure` and, in a Runpane Cloud Session, starts the
 * boot/wake reconcile and listener detection: at once, or when the bootstrap writes the Session marker
 * (after the daemon's first start on a new Session). Until then the channels answer `available: false`.
 */
export function registerSessionPortsHandlers(wiring: SessionPortsWiring): { service: SessionPortsService; stop(): void } | undefined {
  const serveRecordPath = wiring.serveRecordPath ?? CLOUD_SERVE_RECORD;
  // Re-read until it exists: on a new Session the bootstrap writes it after this daemon started.
  let record = readCloudServeRecord(serveRecordPath);
  const cloudRecord = () => (record ??= readCloudServeRecord(serveRecordPath));
  const service = new SessionPortsService({
    serve: wiring.serve ?? createTailscaleServeBackend(),
    statePath: wiring.statePath ?? defaultPortsStatePath(),
    reservedPorts: () => [...new Set([wiring.daemonPort() ?? DEFAULT_DAEMON_PORT, cloudRecord()?.port ?? DEFAULT_DAEMON_PORT])],
    projectPaths: () => wiring.projectPaths(),
    panelProcesses: () => wiring.panelIds().flatMap((panelId): PanelProcess[] => {
      const pid = wiring.panelPid(panelId);
      return pid === undefined ? [] : [{ pid, panelId, paneId: wiring.paneIdOf(panelId) }];
    }),
    readListeners: () => readLocalListeners(),
    readProcesses: () => readProcessTable(),
    mapSocketOwners: (inodes, pids) => mapSocketOwners(inodes, pids),
    probe: probeUrl,
    emit: result => wiring.emit(SESSION_PORTS_CHANGED_EVENT, result),
    now: Date.now,
    log: wiring.log,
  });
  const notCloud = (): SessionPortsListResult => ({
    ok: true,
    available: false,
    unavailableReason: 'Session ports are only for Runpane Cloud Sessions',
    scheme: 'https',
    autoOpen: false,
    ports: [],
    suggested: [],
    manifests: [],
  });
  const requireCloud = () => {
    if (!cloudRecord()) throw new PaneCommandError('Session ports are only for Runpane Cloud Sessions (this daemon is not in one).', 'ERR_PORTS_UNAVAILABLE');
  };

  wiring.commandRegistry.register('runpane:ports:list', async (request: PaneCommandValue = {}) => {
    const { verify } = decodeRequest(request, listRequestSchema);
    return cloudRecord() ? service.list({ verify }) : notCloud();
  });
  wiring.commandRegistry.register('runpane:ports:open', async (request: PaneCommandValue) => {
    const decoded = decodeRequest(request, openRequestSchema);
    requireCloud();
    return service.open(decoded);
  });
  wiring.commandRegistry.register('runpane:ports:close', async (request: PaneCommandValue) => {
    const { target } = decodeRequest(request, closeRequestSchema);
    requireCloud();
    return service.close(target);
  });
  wiring.commandRegistry.register('runpane:ports:configure', async (request: PaneCommandValue) => {
    const { autoOpen } = decodeRequest(request, configureRequestSchema);
    requireCloud();
    return service.configure({ autoOpen });
  });

  if (process.platform !== 'linux') return undefined;
  const stopWaiting = whenCloudSession(() => {
    if (!record) wiring.log('ports: this daemon is now in a Runpane Cloud Session (the bootstrap wrote its marker); starting');
    service.start();
  }, { path: serveRecordPath, bootstrapStateDir: wiring.cloudBootstrapDir, pollMs: wiring.markerPollMs });
  return {
    service,
    stop: () => {
      stopWaiting();
      service.stop();
    },
  };
}
