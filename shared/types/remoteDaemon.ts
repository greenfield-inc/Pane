import type { VoiceTranscriptionMode } from './voiceTranscription';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { BoundarySchema, JsonObject, JsonValue } from '../validation/boundaryDecoder';

export type RemoteDaemonTransport = 'http+sse';
export type RemoteDaemonClientMode = 'local' | 'remote';
export type RemotePaneConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type RemoteSetupChannel = 'stable' | 'nightly';
export type RemoteSetupTunnelPreference = 'auto' | 'tailscale' | 'ssh' | 'manual';
export type RemoteSetupDataDirectoryMode = 'current' | 'isolated';

export interface RemoteDaemonHostConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  pairingRequired: boolean;
  allowInsecureHttpOnLoopback: boolean;
}

export type RemoteDaemonHostRuntimeStatus = 'inactive' | 'live' | 'error';
export type RemoteDaemonProcessImageStatus = 'current' | 'replaced' | 'deleted' | 'unknown';
export type RemoteDaemonRestartStatus = 'ready' | 'broken' | 'unknown';

export interface RemoteDaemonExecutableHealth {
  processImage: {
    status: RemoteDaemonProcessImageStatus;
    runtimePath: string | null;
    installedPath: string | null;
    evidence: string;
  };
  restart: {
    status: RemoteDaemonRestartStatus;
    launcherPath?: string;
    resolvedPath?: string;
    evidence: string;
  };
  diagnosticCode?:
    | 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED'
    | 'PANE_REMOTE_DAEMON_UPDATE_PENDING'
    | 'PANE_REMOTE_DAEMON_LAUNCHER_STALE';
  recoveryCommand?: string;
  checkedAt: string;
}

export interface RemoteDaemonConnectedClient {
  id: string;
  clientId: string | null;
  label: string | null;
  deviceLabel: string | null;
  remoteAddress: string | null;
  connectedAt: string;
  lastSeenAt: string;
}

export interface RemoteDaemonHostRuntimeState {
  enabled: boolean;
  status: RemoteDaemonHostRuntimeStatus;
  listenHost: string | null;
  listenPort: number | null;
  lastError: string | null;
  connectedClients: RemoteDaemonConnectedClient[];
  executableHealth: RemoteDaemonExecutableHealth;
  updatedAt: string;
}

export interface RemoteDaemonClientRecord {
  id: string;
  label: string;
  createdAt: string;
  tokenHash: string;
  lastUsedAt?: string;
}

export interface RemotePaneConnectionProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  transport: RemoteDaemonTransport;
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'];
}

export interface RemoteDaemonHostAccess {
  baseUrl: string;
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'];
  updatedAt: string;
}

export interface PaneRemoteConnectionImportPayload {
  v: 1;
  label: string;
  baseUrl: string;
  token: string;
  transport: RemoteDaemonTransport;
  tunnel?: {
    kind: 'ssh' | 'tailscale' | 'manual';
    command?: string;
    note?: string;
    selected: boolean;
    tailscaleIp?: string;
  };
}

export interface RemoteHostSetupRequest {
  dataDirectoryMode?: RemoteSetupDataDirectoryMode;
  paneDir?: string;
  label?: string;
  listenPort?: number;
  channel?: RemoteSetupChannel;
  repoRef?: string;
  installService?: boolean;
  exposeTailscale?: boolean;
  preferTunnel?: RemoteSetupTunnelPreference;
  baseUrl?: string;
}

export type RemoteHostSetupServiceStrategy =
  | 'systemd-user'
  | 'launch-agent'
  | 'scheduled-task'
  | 'manual'
  | 'skipped';

export interface RemoteHostSetupServiceResult {
  strategy: RemoteHostSetupServiceStrategy;
  installed: boolean;
  started: boolean;
  message: string;
}

export interface RemoteDaemonServiceInspection {
  launcherPath: string;
  launcherExists: boolean;
  launcherCurrent: boolean;
  savedExecutablePath: string | null;
  savedExecutableExists: boolean | null;
  resolvedExecutablePath: string | null;
  restartStatus: RemoteDaemonRestartStatus;
}

export interface RemoteDaemonServiceRepairResult {
  ok: boolean;
  changed: boolean;
  paneDir: string;
  strategy: RemoteHostSetupServiceStrategy;
  launcherPath: string;
  before: RemoteDaemonServiceInspection;
  after: RemoteDaemonServiceInspection;
  message: string;
}

export interface RemoteHostSetupResult {
  dataDirectoryMode: RemoteSetupDataDirectoryMode;
  paneDir: string;
  configPath: string;
  label: string;
  listenPort: number;
  channel: RemoteSetupChannel;
  repoRef?: string;
  connectionCode: string;
  tunnel: PaneRemoteConnectionImportPayload['tunnel'];
  fallbackTunnelCommands: string[];
  service: RemoteHostSetupServiceResult;
  manualDaemonCommand: string;
  wroteConfig: boolean;
}

export interface RemoteHostSetupTerminalCommandResult {
  command: string;
}

export interface RemoteHostConnectionCodeResult {
  connectionCode: string;
  client: RemoteDaemonClientRecord;
  access: RemoteDaemonHostAccess;
}

export interface RemoteDaemonImportResult {
  profile: RemotePaneConnectionProfile;
  connected: boolean;
  connectionError?: string;
}

export interface RemoteDaemonHostSettings {
  config: RemoteDaemonHostConfig;
  clients: RemoteDaemonClientRecord[];
  mobilePush: RemoteMobilePushSettings;
  access?: RemoteDaemonHostAccess;
}

export type RemoteMobilePlatform = 'ios' | 'android';

export interface RemoteMobilePushRegistration {
  id: string;
  clientId: string;
  platform: RemoteMobilePlatform;
  token: string;
  installationId: string;
  /** Client-local profile id used only to route a notification tap after launch. */
  hostProfileId: string;
  needsInputEnabled: boolean;
  completedEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  /** Bounded persistent deduplication window; no notification content is stored. */
  recentEventIds: string[];
}

export interface RemoteMobilePushSettings {
  registrations: RemoteMobilePushRegistration[];
  /** Monotonic host-owned sequence used to make repeated attention transitions distinct. */
  attentionSequence: number;
  /** Last observed agent state per panel, retained across daemon restarts. */
  panelStates: Record<string, 'blocked' | 'working' | 'idle' | 'unknown'>;
}

export interface RemoteMobilePushStatus {
  platform: RemoteMobilePlatform;
  registration: 'registered' | 'not-registered' | 'revoked';
  provider: 'ready' | 'missing-config' | 'invalid-config' | 'unavailable';
  code: string;
  message: string;
  needsInputEnabled?: boolean;
  completedEnabled?: boolean;
}

export interface RemoteDaemonClientSettings {
  profiles: RemotePaneConnectionProfile[];
  activeProfileId: string | null;
  mode: RemoteDaemonClientMode;
}

export interface RemoteDaemonConfig {
  host: RemoteDaemonHostSettings;
  client: RemoteDaemonClientSettings;
}

export interface RemoteDaemonConnectionPair {
  client: RemoteDaemonClientRecord;
  profile: RemotePaneConnectionProfile;
  token: string;
}

export interface RemotePwaTerminalShortcut {
  id: string;
  label: string;
  key: string;
  text: string;
  enabled: boolean;
}

export interface RemotePwaCustomCommand {
  name: string;
  command: string;
}

export interface RemotePwaVoiceModePresentation {
  label: string;
  priceLabel: string;
  latencyLabel: string;
  recommended: boolean;
}

export interface RemotePwaVoiceTranscriptionAffordance {
  availableModes: VoiceTranscriptionMode[];
  defaultMode: VoiceTranscriptionMode;
  configured: {
    cleanup: boolean;
    recorded: boolean;
    streaming: boolean;
    fal: boolean;
    deepgram: boolean;
    openRouter: boolean;
  };
  modes: Record<VoiceTranscriptionMode, RemotePwaVoiceModePresentation>;
}

export interface RemotePwaAffordances {
  terminalShortcuts: RemotePwaTerminalShortcut[];
  customCommands: RemotePwaCustomCommand[];
  voiceTranscription: RemotePwaVoiceTranscriptionAffordance;
}

export interface RemotePaneConnectionState {
  mode: RemoteDaemonClientMode;
  status: RemotePaneConnectionStatus;
  activeProfileId: string | null;
  activeProfileLabel: string | null;
  activeBaseUrl: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
}

export interface RemoteInvokeRequest {
  channel: string;
  args: JsonValue[];
  token?: string;
  runtimeId?: string;
  clientLabel?: string;
}

export interface RemoteDaemonHeartbeatPayload {
  timestamp: string;
}

export interface RemoteDaemonEventEnvelope {
  channel: string;
  args: Array<JsonValue | object>;
  timestamp: string;
}

const remoteHeartbeatPayloadSchema: BoundarySchema<RemoteDaemonHeartbeatPayload> = boundary.object({
  timestamp: boundary.nonEmptyString,
});

const remoteDaemonEventEnvelopeSchema = boundary.object({
  channel: boundary.string,
  args: boundary.array(boundary.json),
  timestamp: boundary.string,
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates external data with its named schema before use.
export function decodeRemoteHeartbeatPayload(value: unknown): RemoteDaemonHeartbeatPayload {
  return decodeBoundary(value, remoteHeartbeatPayloadSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates external data with its named schema before use.
export function decodeRemoteDaemonEventEnvelope(value: unknown): RemoteDaemonEventEnvelope {
  return decodeBoundary(value, remoteDaemonEventEnvelopeSchema);
}

export const DEFAULT_REMOTE_DAEMON_HOST_CONFIG: RemoteDaemonHostConfig = {
  enabled: false,
  listenHost: '127.0.0.1',
  listenPort: 42137,
  pairingRequired: true,
  allowInsecureHttpOnLoopback: true,
};

export function isLoopbackRemoteDaemonHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === '127.0.0.1' || normalizedHost === '::1' || normalizedHost === 'localhost';
}

export function getRemoteDaemonHostConfigValidationError(config: RemoteDaemonHostConfig): string | null {
  if (!config.enabled) {
    return null;
  }

  if (!isLoopbackRemoteDaemonHost(config.listenHost)) {
    return 'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.';
  }

  if (!config.allowInsecureHttpOnLoopback) {
    return 'Remote daemon HTTP API loopback transport is disabled by config';
  }

  return null;
}

export function createDefaultRemoteDaemonConfig(): RemoteDaemonConfig {
  return {
      host: {
      config: { ...DEFAULT_REMOTE_DAEMON_HOST_CONFIG },
        clients: [],
        mobilePush: { registrations: [], attentionSequence: 0, panelStates: {} },
    },
    client: {
      profiles: [],
      activeProfileId: null,
      mode: 'local',
    },
  };
}

export function createDefaultRemotePaneConnectionState(): RemotePaneConnectionState {
  return {
    mode: 'local',
    status: 'local',
    activeProfileId: null,
    activeProfileLabel: null,
    activeBaseUrl: null,
    lastError: null,
    lastSeenAt: null,
  };
}

export function createDefaultRemoteDaemonHostRuntimeState(): RemoteDaemonHostRuntimeState {
  return {
    enabled: false,
    status: 'inactive',
    listenHost: null,
    listenPort: null,
    lastError: null,
    connectedClients: [],
    executableHealth: createUnknownRemoteDaemonExecutableHealth(),
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

export function createUnknownRemoteDaemonExecutableHealth(): RemoteDaemonExecutableHealth {
  return {
    processImage: {
      status: 'unknown',
      runtimePath: null,
      installedPath: null,
      evidence: 'Executable identity has not been checked yet.',
    },
    restart: {
      status: 'unknown',
      evidence: 'Remote daemon launcher readiness has not been checked yet.',
    },
    checkedAt: '1970-01-01T00:00:00.000Z',
  };
}

const remoteClientRecordSchema: BoundarySchema<RemoteDaemonClientRecord> = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  createdAt: boundary.nonEmptyString,
  tokenHash: boundary.nonEmptyString,
  lastUsedAt: boundary.optional(boundary.nonEmptyString),
});
const remoteTunnelSchema: BoundarySchema<NonNullable<PaneRemoteConnectionImportPayload['tunnel']>> = boundary.object({
  kind: boundary.enumeration('ssh', 'tailscale', 'manual'),
  command: boundary.optional(boundary.nonEmptyString),
  note: boundary.optional(boundary.nonEmptyString),
  selected: boundary.boolean,
  tailscaleIp: boundary.optional(boundary.nonEmptyString),
});
const remoteProfileSchema: BoundarySchema<RemotePaneConnectionProfile> = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
  transport: boundary.literal('http+sse'),
  tunnel: boundary.optional(remoteTunnelSchema),
});
const remoteImportSchema = boundary.object({
  v: boundary.literal(1),
  label: boundary.nonEmptyString,
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
  transport: boundary.literal('http+sse'),
  tunnel: boundary.optional(remoteTunnelSchema),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This schema-backed type guard validates external records at their boundary.
export function isRemoteDaemonClientRecord(value: unknown): value is RemoteDaemonClientRecord {
  return matchesSchema(value, remoteClientRecordSchema);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This schema-backed type guard validates external records at their boundary.
export function isRemotePaneConnectionProfile(value: unknown): value is RemotePaneConnectionProfile {
  return matchesSchema(value, remoteProfileSchema);
}

export function encodePaneRemoteConnection(payload: PaneRemoteConnectionImportPayload): string {
  const normalizedPayload = normalizePaneRemoteConnectionImportPayload(payload);
  return `pane-remote://${base64UrlEncode(JSON.stringify(normalizedPayload))}`;
}

export function decodePaneRemoteConnection(input: string): PaneRemoteConnectionImportPayload {
  const trimmedInput = input.trim();
  if (!trimmedInput.startsWith('pane-remote://')) {
    throw new Error('Expected a pane-remote:// connection code');
  }

  const encodedPayload = trimmedInput.slice('pane-remote://'.length);
  if (encodedPayload.length === 0) {
    throw new Error('Remote connection code payload is empty');
  }

  let parsedPayload: JsonValue;
  try {
    parsedPayload = decodeBoundary(JSON.parse(base64UrlDecode(encodedPayload)), boundary.json);
  } catch (error) {
    throw new Error(`Remote connection code is not valid JSON: ${getErrorMessage(error)}`);
  }

  return normalizePaneRemoteConnectionImportPayload(parsedPayload);
}

export function remoteImportPayloadToProfile(
  payload: PaneRemoteConnectionImportPayload,
  profileId = createRemoteProfileId(),
): RemotePaneConnectionProfile {
  const normalizedPayload = normalizePaneRemoteConnectionImportPayload(payload);
  const profile: RemotePaneConnectionProfile = {
    id: profileId,
    label: normalizedPayload.label,
    baseUrl: normalizedPayload.baseUrl,
    token: normalizedPayload.token,
    transport: normalizedPayload.transport,
  };
  if (normalizedPayload.tunnel) {
    profile.tunnel = normalizedPayload.tunnel;
  }
  return profile;
}

export function normalizePaneRemoteConnectionImportPayload(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Connection imports are validated with the named import schema at this boundary.
  value: unknown,
): PaneRemoteConnectionImportPayload {
  const decoded = decodeBoundary(value, remoteImportSchema);
  const baseUrl = normalizeRemoteImportBaseUrl(decoded.baseUrl.trim());
  const tunnel = decoded.tunnel === undefined ? undefined : normalizeRemoteImportTunnel(decoded.tunnel);

  const payload: PaneRemoteConnectionImportPayload = {
    v: 1,
    label: decoded.label.trim(),
    baseUrl,
    token: decoded.token.trim(),
    transport: decoded.transport,
  };
  if (tunnel) {
    payload.tunnel = tunnel;
  }
  return payload;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates external data with its named schema before use.
export function normalizeRemoteDaemonConfig(value: unknown): RemoteDaemonConfig {
  const defaults = createDefaultRemoteDaemonConfig();
  const config = readJsonObject(value);
  if (config === undefined) {
    return defaults;
  }

  const host = readJsonObject(config.host) ?? {};
  const hostConfig = readJsonObject(host.config) ?? {};
  const clients = readJsonArray(host.clients).flatMap((client) => {
    try {
      return [decodeBoundary(client, remoteClientRecordSchema)];
    } catch {
      return [];
    }
  });
  const access = normalizeRemoteDaemonHostAccess(host.access);
  const mobilePush = normalizeRemoteMobilePushSettings(host.mobilePush);

  const client = readJsonObject(config.client) ?? {};
  const profiles = readJsonArray(client.profiles).flatMap((profile) => {
    try {
      return [decodeBoundary(profile, remoteProfileSchema)];
    } catch {
      return [];
    }
  });

  let activeProfileId = readOptionalString(client.activeProfileId) ?? null;
  if (activeProfileId && !profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = null;
  }

  const hostSettings: RemoteDaemonHostSettings = {
    config: {
      enabled: readBoolean(hostConfig.enabled, defaults.host.config.enabled),
      listenHost: readString(hostConfig.listenHost, defaults.host.config.listenHost),
      listenPort: readPort(hostConfig.listenPort, defaults.host.config.listenPort),
      pairingRequired: readBoolean(hostConfig.pairingRequired, defaults.host.config.pairingRequired),
      allowInsecureHttpOnLoopback: readBoolean(
        hostConfig.allowInsecureHttpOnLoopback,
        defaults.host.config.allowInsecureHttpOnLoopback,
      ),
    },
    clients: [...clients],
    mobilePush,
  };
  if (access) {
    hostSettings.access = access;
  }

  return {
    host: hostSettings,
    client: {
      profiles: [...profiles],
      activeProfileId,
      mode: activeProfileId && client.mode === 'remote' ? 'remote' : 'local',
    },
  };
}

function normalizeRemoteMobilePushSettings(value: JsonValue | undefined): RemoteMobilePushSettings {
  const settings = readJsonObject(value) ?? {};
  const registrations = readJsonArray(settings.registrations).flatMap((registration) => {
    const raw = readJsonObject(registration);
    if (!raw) return [];
    const id = readOptionalString(raw.id);
    const clientId = readOptionalString(raw.clientId);
    const platform: RemoteMobilePlatform | undefined = raw.platform === 'ios' || raw.platform === 'android' ? raw.platform : undefined;
    const token = readOptionalString(raw.token);
    const installationId = readOptionalString(raw.installationId);
    const hostProfileId = readOptionalString(raw.hostProfileId);
    if (!id || !clientId || !platform || !token || !installationId || !hostProfileId || id.length > 200 || token.length > 8192) return [];
    const normalized: RemoteMobilePushRegistration = {
      id, clientId, platform, token, installationId,
      hostProfileId,
      needsInputEnabled: readBoolean(raw.needsInputEnabled, true),
      completedEnabled: readBoolean(raw.completedEnabled, true),
      createdAt: readOptionalString(raw.createdAt) ?? new Date(0).toISOString(),
      updatedAt: readOptionalString(raw.updatedAt) ?? new Date(0).toISOString(),
      recentEventIds: readJsonArray(raw.recentEventIds).flatMap(value => {
        const eventId = readOptionalString(value);
        return eventId ? [eventId] : [];
      }).slice(-64),
    };
    const revokedAt = readOptionalString(raw.revokedAt);
    if (revokedAt) normalized.revokedAt = revokedAt;
    return [normalized];
  });
  const decodedAttentionSequence = decodeOptionalBoundary(settings.attentionSequence, boundary.number);
  const attentionSequence = decodedAttentionSequence !== undefined && Number.isSafeInteger(decodedAttentionSequence) && decodedAttentionSequence >= 0
    ? decodedAttentionSequence
    : 0;
  const panelStates = Object.fromEntries(Object.entries(readJsonObject(settings.panelStates) ?? {}).flatMap(([panelId, state]) => {
    const decoded = decodeOptionalBoundary(state, boundary.enumeration('blocked', 'working', 'idle', 'unknown'));
    return decoded ? [[panelId, decoded]] : [];
  }));
  return { registrations, attentionSequence, panelStates };
}

function normalizeRemoteDaemonHostAccess(value: JsonValue | undefined): RemoteDaemonHostAccess | undefined {
  const access = readJsonObject(value);
  if (access === undefined) {
    return undefined;
  }

  try {
    const baseUrl = normalizeRemoteImportBaseUrl(readRequiredString(access.baseUrl, 'Remote host access URL'));
    const tunnel = access.tunnel === undefined
      ? undefined
      : normalizeRemoteImportTunnel(access.tunnel);
    const updatedAt = readRequiredString(access.updatedAt, 'Remote host access timestamp');

    const normalizedAccess: RemoteDaemonHostAccess = {
      baseUrl,
      updatedAt,
    };
    if (tunnel) {
      normalizedAccess.tunnel = tunnel;
    }
    return normalizedAccess;
  } catch {
    return undefined;
  }
}

function normalizeRemoteImportTunnel(
  value: JsonValue | NonNullable<PaneRemoteConnectionImportPayload['tunnel']>,
): PaneRemoteConnectionImportPayload['tunnel'] {
  const decoded = decodeBoundary(value, remoteTunnelSchema);
  const tailscaleIp = decoded.tailscaleIp === undefined
    ? undefined
    : readRemoteTunnelIp(decoded.tailscaleIp);

  const tunnel: NonNullable<PaneRemoteConnectionImportPayload['tunnel']> = {
    kind: decoded.kind,
    selected: decoded.selected,
  };
  if (decoded.command) tunnel.command = decoded.command.trim();
  if (decoded.note) tunnel.note = decoded.note.trim();
  if (tailscaleIp) tunnel.tailscaleIp = tailscaleIp;
  return tunnel;
}

function readRemoteTunnelIp(value: JsonValue): string {
  const decoded = readOptionalString(value);
  if (decoded === undefined || !isRemoteTunnelIp(decoded)) {
    throw new Error('Remote tunnel Tailscale IP must be a valid IP address');
  }

  return decoded.trim();
}

function isRemoteTunnelIp(value: JsonValue): boolean {
  const decoded = readOptionalString(value);
  if (decoded === undefined) {
    return false;
  }

  const normalizedValue = decoded.trim();
  return isValidIpv4Address(normalizedValue) || isValidIpv6Address(normalizedValue);
}

function isValidIpv4Address(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const numericPart = Number(part);
    return numericPart >= 0 && numericPart <= 255;
  });
}

function isValidIpv6Address(value: string): boolean {
  if (!value.includes(':')) {
    return false;
  }

  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function normalizeRemoteImportBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Remote base URL must be a valid URL');
  }

  if (url.username || url.password) {
    throw new Error('Remote base URL must not contain credentials');
  }

  if (url.search || url.hash) {
    throw new Error('Remote base URL must not contain query strings or fragments');
  }

  if (url.protocol === 'http:') {
    const normalizedHostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!isLoopbackRemoteDaemonHost(normalizedHostname)) {
      throw new Error('HTTP remote base URLs must use a loopback host; use HTTPS for Tailscale or reverse-proxy endpoints');
    }
  } else if (url.protocol !== 'https:') {
    throw new Error('Remote base URL must use http or https');
  }

  return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
}

function readRequiredString(value: JsonValue | undefined, fieldName: string): string {
  const decoded = readOptionalString(value);
  if (decoded === undefined) {
    throw new Error(`${fieldName} is required`);
  }

  return decoded.trim();
}

function readBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  try {
    return decodeBoundary(value, boundary.boolean);
  } catch {
    return fallback;
  }
}

function readString(value: JsonValue | undefined, fallback: string): string {
  return readOptionalString(value) ?? fallback;
}

function readPort(value: JsonValue | undefined, fallback: number): number {
  try {
    const decoded = decodeBoundary(value, boundary.number);
    return Number.isInteger(decoded) && decoded > 0 && decoded <= 65535 ? decoded : fallback;
  } catch {
    return fallback;
  }
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
  try {
    return decodeBoundary(value, boundary.nonEmptyString);
  } catch {
    return undefined;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates external data with its named schema before use.
function readJsonObject(value: unknown): JsonObject | undefined {
  try {
    return decodeBoundary(value, boundary.jsonObject);
  } catch {
    return undefined;
  }
}

function readJsonArray(value: JsonValue | undefined): JsonValue[] {
  try {
    return decodeBoundary(value, boundary.array(boundary.json));
  } catch {
    return [];
  }
}

function matchesSchema<Output>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The supplied schema establishes the input contract at this parsing boundary.
  value: unknown,
  schema: BoundarySchema<Output>,
): boolean {
  try {
    decodeBoundary(value, schema);
    return true;
  } catch {
    return false;
  }
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalizedInput = input.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalizedInput.length % 4)) % 4;
  const binary = atob(`${normalizedInput}${'='.repeat(paddingLength)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

function createRemoteProfileId(): string {
  const generatedId = globalThis.crypto?.randomUUID?.();
  if (generatedId) return generatedId;

  return `remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unknown error';
}
