/**
 * Session ports: a local service in a Runpane Cloud Session (`127.0.0.1:<port>`) published as a
 * tailnet-only URL on the Session's own name (`https://<host>.<tailnet>.ts.net:<httpsPort>/`), through
 * Tailscale Serve. Never Funnel. The daemon owns the state (`~/.runpane-cloud/ports.json`) and the
 * channels `runpane:ports:list|open|close|configure`; clients get `runpane:ports:changed` events.
 */

import { boundary, decodeOptionalBoundary, type JsonValue } from '../validation/boundaryDecoder';

/** Who published a port: a person or agent (`port open`), a repository's `.runpane/ports.json`, or auto-open. */
export type SessionPortSource = 'user' | 'manifest' | 'auto';

/** `http` only when the Session's name has no TLS certificate (Let's Encrypt limit); WireGuard still encrypts it. */
export type SessionPortScheme = 'https' | 'http';

/**
 * `serving`: Tailscale Serve has the entry. `missing`: the entry is gone (the next reconcile re-applies it).
 * `error`: it could not be applied, for example another Serve entry holds the tailnet port (see `detail`).
 */
export type SessionPortStatus = 'serving' | 'missing' | 'error';

export interface SessionPort {
  name: string;
  /** The local port the service listens on, in the Session. */
  port: number;
  /** The tailnet port of the URL (for http ports too). */
  httpsPort: number;
  url: string;
  scheme: SessionPortScheme;
  /** Path appended to the URL (the service is always mounted at `/`). */
  path: string;
  source: SessionPortSource;
  /** For `manifest` ports: the repository directory whose `.runpane/ports.json` declares it. */
  repo?: string;
  createdAt: string;
  status: SessionPortStatus;
  /** Why the port is http, or why it is not serving. */
  detail?: string;
  /** Only when the caller asked to verify: an HTTP answer came back over the URL. */
  reachable?: boolean | null;
}

/** A TCP listener started under a Pane panel that is not published. */
export interface SuggestedPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  paneId?: string;
  panelId?: string;
  detectedAt: string;
}

export interface SessionPortsManifestState {
  repo: string;
  ok: boolean;
  error?: string;
  /** Ports it declares (0 when invalid). */
  count: number;
}

export interface SessionPortsListResult {
  ok: true;
  /** False off a cloud Session (no Tailscale, or not running); the arrays are then empty. */
  available: boolean;
  unavailableReason?: string;
  /** The Session's MagicDNS name, without the trailing dot. */
  host?: string;
  /** What a new port gets: `http` when this Session's name has no TLS certificate. */
  scheme: SessionPortScheme;
  /** Publish detected ports without asking (a per-Session opt-in, default off). */
  autoOpen: boolean;
  ports: SessionPort[];
  suggested: SuggestedPort[];
  manifests: SessionPortsManifestState[];
  /**
   * Set when `~/.runpane-cloud/ports.json` exists but cannot be read or decoded. `ports` is then empty,
   * the file stays as it is for recovery, and open, close and auto-open fail with ERR_PORTS_STATE_INVALID
   * until someone repairs or removes it.
   */
  stateError?: string;
}

export interface SessionPortOpenRequest {
  port: number;
  name?: string;
  httpsPort?: number;
  path?: string;
  /** Replace another Serve entry on the tailnet port (e.g. a plain tcp forward). */
  yes?: boolean;
  scheme?: 'auto' | SessionPortScheme;
}

export interface SessionPortOpenResult {
  ok: true;
  port: SessionPort;
  alreadyOpen: boolean;
  /** The Serve entry `yes` replaced. */
  replaced?: { httpsPort: number; was: string };
}

export interface SessionPortCloseResult {
  ok: true;
  closed: SessionPort | null;
}

export interface SessionPortsConfigureResult {
  ok: true;
  autoOpen: boolean;
}

export const SESSION_PORTS_CHANGED_EVENT = 'runpane:ports:changed';
export const SESSION_PORTS_LIST_CHANNEL = 'runpane:ports:list';
export const SESSION_PORTS_OPEN_CHANNEL = 'runpane:ports:open';
export const SESSION_PORTS_CLOSE_CHANNEL = 'runpane:ports:close';

/** What the Ports chip row renders: the list result without the daemon's config fields. */
export type SessionPortsSnapshot = Pick<SessionPortsListResult, 'available' | 'unavailableReason' | 'host' | 'ports' | 'suggested'>;

const sessionPortSchema = boundary.object({
  name: boundary.string,
  port: boundary.number,
  httpsPort: boundary.number,
  url: boundary.string,
  scheme: boundary.enumeration('https', 'http'),
  path: boundary.string,
  source: boundary.enumeration('user', 'manifest', 'auto'),
  repo: boundary.optional(boundary.string),
  createdAt: boundary.string,
  status: boundary.enumeration('serving', 'missing', 'error'),
  detail: boundary.optional(boundary.string),
  reachable: boundary.optional(boundary.nullable(boundary.boolean)),
});

const suggestedPortSchema = boundary.object({
  port: boundary.number,
  address: boundary.string,
  process: boundary.optional(boundary.string),
  pid: boundary.optional(boundary.number),
  paneId: boundary.optional(boundary.string),
  panelId: boundary.optional(boundary.string),
  detectedAt: boundary.string,
});

const snapshotShellSchema = boundary.object({
  available: boundary.boolean,
  unavailableReason: boundary.optional(boundary.string),
  host: boundary.optional(boundary.string),
  ports: boundary.array(boundary.json),
  suggested: boundary.array(boundary.json),
});

const ipcEnvelopeSchema = boundary.object({
  success: boundary.literal(true),
  data: boundary.json,
});

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/** Only http(s) links may reach openExternal / window.open. */
function isOpenableSessionPortUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function decodePort(value: JsonValue): SessionPort | null {
  const decoded = decodeOptionalBoundary(value, sessionPortSchema);
  return decoded && isValidPort(decoded.port) && isValidPort(decoded.httpsPort) && isOpenableSessionPortUrl(decoded.url)
    ? decoded
    : null;
}

function decodeSuggested(value: JsonValue): SuggestedPort | null {
  const decoded = decodeOptionalBoundary(value, suggestedPortSchema);
  return decoded && isValidPort(decoded.port) ? decoded : null;
}

/**
 * Decodes a `runpane:ports:list` result or a `runpane:ports:changed` payload for the UI.
 * Accepts the bare result or an IPC `{ success, data }` envelope, and drops malformed
 * entries instead of failing the whole list, so one odd entry never blanks the chip row.
 * Returns null when the value is not a list result at all.
 */
export function decodeSessionPortsSnapshot<Value>(value: Value): SessionPortsSnapshot | null {
  const unwrapped = decodeOptionalBoundary(value, ipcEnvelopeSchema)?.data ?? value;
  const shell = decodeOptionalBoundary(unwrapped, snapshotShellSchema);
  if (!shell) return null;
  const ports = shell.ports.map(decodePort).filter((port): port is SessionPort => port !== null);
  const published = new Set(ports.map(port => port.port));
  const suggested = shell.suggested
    .map(decodeSuggested)
    .filter((port): port is SuggestedPort => port !== null && !published.has(port.port));
  const snapshot: SessionPortsSnapshot = {
    available: shell.available,
    ports: ports.sort((a, b) => a.httpsPort - b.httpsPort),
    suggested: suggested.sort((a, b) => a.port - b.port),
  };
  if (shell.host !== undefined) snapshot.host = shell.host;
  if (shell.unavailableReason !== undefined) snapshot.unavailableReason = shell.unavailableReason;
  return snapshot;
}
