import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { AppConfig } from '../types/config';
import { PaneError } from '../../../shared/paneError';
import { normalizeRemoteDaemonConfig, type RemoteDaemonClientRecord } from '../../../shared/types/remoteDaemon';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { GLASSES_PAIRING_SECRET_PREFIX, GLASSES_TOKEN_PREFIX, type GlassesAccessState, type GlassesDevice, type GlassesPairingSecretResult } from '../../../shared/types/glasses';

/**
 * The Origins the Even Realities app's WebView sends for the Pane glasses app. Exact values only:
 * no wildcard, and never "null". Record the real value on a device before a release adds it here.
 * The Even app serves the glasses app from http://127.0.0.1 on a new port each launch, and a
 * loopback origin matches on any port (see `originKey`). A page on that address still needs a
 * glasses token or pairing secret. The owner adds more on one machine from
 * Settings › Remote Access › Glasses (`workspaces.glassesOrigins`), and `PANE_GLASSES_ORIGINS` (comma separated) adds them for a dev run, such as the Even simulator's.
 */
const EVEN_APP_ORIGINS: readonly string[] = ['http://127.0.0.1'];
const ORIGINS_ENV = 'PANE_GLASSES_ORIGINS';
/** Hosts whose origins match on any port: the Even app serves the glasses app from http://127.0.0.1 on a port it picks each launch. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The commands a glasses token reaches. Everything else is refused before it runs. */
export const GLASSES_CHANNELS: ReadonlySet<string> = new Set([
  'sessions:get-all-with-projects',
  'orchestration-sessions:list',
  'orchestration-sessions:get',
  'panels:list',
  'runpane:panels:screen',
  'runpane:panels:output',
  'runpane:panels:submit',
  // One key per request (`glassesKeyInput`): enough to answer a terminal menu, nothing more.
  'runpane:panels:input',
  // Opening a stopped tab starts its saved agent or command, as opening it in Pane does; the caller picks no command or folder.
  'runpane:panels:resume',
  // Opening and leaving a Pane mark it viewed, as selecting it on desktop does.
  'sessions:mark-viewed',
  'voice:transcribe',
  'voice:finalize-streaming',
  'notify:remote-snapshot',
  'notify:remote-command',
  'runpane:workspace:state',
  'remote:pwa-affordances',
]);

/** The events a glasses stream carries: Notify, agent status and list changes, never terminal bytes. */
export const GLASSES_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  'notify:shared-changed',
  'panel:agentStatus',
  'panel:activityStatus',
  'panel:created',
  'panel:deleted',
  'session:created',
  'session:deleted',
  'session:updated',
  'sessions:loaded',
  'orchestration-sessions:changed',
]);


const PAIRING_SECRET_TTL_MS = 10 * 60_000;
const MAX_PENDING_SECRETS = 32;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURES_BEFORE_LOCKOUT = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 60 * 60_000;
const MAX_DEVICE_NAME_LENGTH = 60;
const MAX_TRACKED_SOURCES = 1_000;
const MAX_REFUSED_ORIGINS = 10;
const COUNTED_FAILURES: ReadonlySet<GlassesFailureReason> = new Set(['token', 'pairing-secret', 'identity', 'credential-in-url']);

export type GlassesFailureReason = 'token' | 'pairing-secret' | 'origin' | 'identity' | 'funnel' | 'credential-in-url' | 'channel' | 'key';

const { up, down, enter, escape, tab } = RUNPANE_CONTRACT.terminalKeys;
/** The keys the glasses may send, one per request: ↑ ↓ Enter Esc Tab, and a menu choice's number. */
const GLASSES_KEYS: ReadonlySet<string> = new Set([up, down, enter, escape, tab, '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const keyRequestSchema = boundary.object({ panelId: boundary.nonEmptyString, input: boundary.string });

/**
 * The `runpane:panels:input` request the glasses may run: one panel and exactly one of
 * `GLASSES_KEYS`, sent as the user. Null for anything else, which is refused before it runs.
 */
export function glassesKeyInput(request: JsonValue | undefined): { panelId: string; input: string; source: 'user' } | null {
  const key = decodeOptionalBoundary(request, keyRequestSchema);
  return key && GLASSES_KEYS.has(key.input) ? { panelId: key.panelId, input: key.input, source: 'user' } : null;
}

interface GlassesConfigStore {
  getConfig(): Pick<AppConfig, 'remoteDaemon' | 'workspaces'>;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<object>;
}

interface PendingSecret {
  hash: Buffer;
  label: string;
  phoneId: string;
  expiresAt: number;
}

interface SourceFailures {
  failures: number[];
  lockouts: number;
  lockedUntil: number;
  lastFailureAt: number;
}

interface GlassesAccessOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * Per-device access for the Pane glasses app on the workspace listener. Device tokens and
 * single-use pairing secrets are 256-bit, stored only as SHA-256 hashes and compared in constant
 * time. Device records live in `remoteDaemon.host.clients` with `kind: 'glasses'`. Pending pairing
 * secrets and the failure counters live in memory and end with the process.
 */
export class GlassesAccess {
  private readonly pending: PendingSecret[] = [];
  private readonly sources = new Map<string, SourceFailures>();
  private readonly lastUsedWrites = new Map<string, number>();
  private readonly revokeListeners = new Set<(id: string) => void>();
  private readonly envOrigins: ReadonlySet<string>;
  private readonly refusedOrigins: { origin: string; at: string }[] = [];
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private funnelOn = false;

  constructor(private readonly config: GlassesConfigStore, options: GlassesAccessOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
    this.envOrigins = readEnvOrigins(options.env ?? process.env, this.log);
  }

  allowsOrigin(origin: string | undefined): boolean {
    if (origin === undefined || !isExactOrigin(origin)) return false;
    const key = originKey(origin);
    return [...EVEN_APP_ORIGINS, ...this.envOrigins, ...this.ownerOrigins()].some((allowed) => originKey(allowed) === key);
  }

  /**
   * Remembers a refused browser origin with its latest refusal, newest first, so the owner can
   * allow the Even app's from Settings. Logged once per origin.
   */
  noteRefusedOrigin(origin: string): void {
    // Only an origin that could ever be allowed is worth offering; "null" never is.
    if (!isExactOrigin(origin)) return;
    const index = this.refusedOrigins.findIndex((entry) => entry.origin === origin);
    if (index !== -1) this.refusedOrigins.splice(index, 1);
    this.refusedOrigins.unshift({ origin, at: new Date(this.now()).toISOString() });
    this.refusedOrigins.splice(MAX_REFUSED_ORIGINS);
    if (index === -1) this.log(`[Pane glasses] refused browser origin ${origin}; if this is the Even app, allow it in Settings › Remote Access › Glasses`);
  }

  state(): GlassesAccessState {
    return {
      devices: this.list(),
      allowedOrigins: [
        ...EVEN_APP_ORIGINS.map((origin) => ({ origin, source: 'pane' as const })),
        ...[...this.envOrigins].map((origin) => ({ origin, source: 'environment' as const })),
        ...this.ownerOrigins().map((origin) => ({ origin, source: 'owner' as const })),
      ],
      refusedOrigins: this.refusedOrigins.filter((entry) => !this.allowsOrigin(entry.origin)),
    };
  }

  /** Adds or removes one exact origin the owner allows on this machine; a loopback origin is kept without its port. */
  async setOwnerOrigin(origin: string, allowed: boolean): Promise<GlassesAccessState> {
    if (!isExactOrigin(origin)) {
      throw new PaneError(
        'ERR_GLASSES_ORIGIN_INVALID',
        `"${origin}" is not an exact origin, so it was not allowed; glasses origins are never null or a wildcard.`,
        'Use the origin exactly as Settings lists it under "Refused", such as https://app.example.com.',
      );
    }
    await this.config.updateConfigWith((current) => {
      const key = originKey(origin);
      const others = (current.workspaces?.glassesOrigins ?? []).filter((value) => !isExactOrigin(value) || originKey(value) !== key);
      return { workspaces: { ...current.workspaces, glassesOrigins: allowed ? [...others, key] : others } };
    });
    return this.state();
  }

  /** Set from `tailscale serve status` on each workspace sync. */
  setFunnelOn(on: boolean): void {
    this.funnelOn = on;
  }

  isFunnelOn(): boolean {
    return this.funnelOn;
  }

  /** A single-use secret the glasses trade once, within 10 minutes, for their device token. */
  createPairingSecret(deviceName: string, phoneId: string): GlassesPairingSecretResult {
    const label = cleanDeviceName(deviceName);
    const now = this.now();
    this.prunePending(now);
    if (this.pending.length >= MAX_PENDING_SECRETS) this.pending.shift();
    const secret = `${GLASSES_PAIRING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = now + PAIRING_SECRET_TTL_MS;
    this.pending.push({ hash: sha256(secret), label, phoneId, expiresAt });
    return { secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Trades a pairing secret for a new device token. The secret is consumed. An earlier token
   * paired from the same phone is revoked, so pairing again replaces it.
   */
  async pair(secret: string): Promise<{ token: string; device: GlassesDevice } | null> {
    const now = this.now();
    this.prunePending(now);
    const presented = sha256(secret);
    const index = this.pending.findIndex((candidate) => timingSafeEqual(candidate.hash, presented));
    if (index === -1) return null;
    const [{ label, phoneId }] = this.pending.splice(index, 1);
    const token = `${GLASSES_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record: RemoteDaemonClientRecord = {
      id: `glasses-${randomUUID()}`,
      label,
      createdAt: new Date(now).toISOString(),
      tokenHash: tokenHash(token).toString('hex'),
      kind: 'glasses',
      phoneId,
    };
    const replaced = this.list().filter((device) => device.phoneId === phoneId).map((device) => device.id);
    await this.writeClients((clients) => [...clients.filter((client) => !replaced.includes(client.id)), record]);
    for (const id of replaced) this.emitRevoked(id);
    return { token, device: toDevice(record) };
  }

  /** The device a token belongs to, or null. */
  verifyToken(token: string): RemoteDaemonClientRecord | null {
    const presented = tokenHash(token);
    let match: RemoteDaemonClientRecord | null = null;
    // Compare against every record so the time taken doesn't depend on which one matches.
    for (const client of this.records()) {
      const stored = Buffer.from(client.tokenHash, 'hex');
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = client;
    }
    return match;
  }

  isCurrent(id: string, tokenHash: string): boolean {
    return this.records().some((client) => client.id === id && client.tokenHash === tokenHash);
  }

  list(): GlassesDevice[] {
    return this.records().map(toDevice);
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.records().some((client) => client.id === id)) return false;
    await this.writeClients((clients) => clients.filter((client) => client.id !== id));
    this.emitRevoked(id);
    return true;
  }

  onRevoked(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** Records a use, writing it to config at most once a minute per device. */
  touch(id: string): void {
    const now = this.now();
    if (now - (this.lastUsedWrites.get(id) ?? 0) < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWrites.set(id, now);
    const lastUsedAt = new Date(now).toISOString();
    void this.writeClients((clients) => clients.map((client) => (client.id === id ? { ...client, lastUsedAt } : client)))
      .catch((error) => this.log(`[Pane glasses] could not save last use: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Milliseconds left on this source's lockout, or 0. */
  lockedFor(source: string): number {
    const state = this.sources.get(source);
    return state ? Math.max(0, state.lockedUntil - this.now()) : 0;
  }

  /** Logs a refused glasses request and counts it toward the source's lockout. Never logs a credential. */
  recordFailure(source: string, reason: GlassesFailureReason, detail?: string): void {
    const now = this.now();
    this.log(`[Pane glasses] refused ${reason} from ${source} at ${new Date(now).toISOString()}${detail ? ` (${detail})` : ''}`);
    // Only guesses at a credential count. A command outside the scope is a bug or an old app,
    // and any web page on the owner's phone can send a wrong origin or reach a Funnel, so
    // counting those would let a page lock the real glasses out.
    if (!COUNTED_FAILURES.has(reason)) return;
    let state = this.sources.get(source);
    if (state && now - state.lastFailureAt > MAX_LOCKOUT_MS && state.lockedUntil <= now) state = undefined;
    if (!state) {
      if (this.sources.size >= MAX_TRACKED_SOURCES) this.pruneSources(now);
      state = { failures: [], lockouts: 0, lockedUntil: 0, lastFailureAt: now };
      this.sources.set(source, state);
    }
    state.lastFailureAt = now;
    state.failures = [...state.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    if (state.failures.length >= FAILURES_BEFORE_LOCKOUT) {
      const duration = Math.min(FIRST_LOCKOUT_MS * 2 ** state.lockouts, MAX_LOCKOUT_MS);
      state.lockouts += 1;
      state.lockedUntil = now + duration;
      state.failures = [];
      this.log(`[Pane glasses] locked out ${source} for ${Math.round(duration / 1000)} s after ${FAILURES_BEFORE_LOCKOUT} refused requests`);
    }
  }

  private ownerOrigins(): string[] {
    return [...new Set((this.config.getConfig().workspaces?.glassesOrigins ?? []).filter(isExactOrigin).map(originKey))];
  }

  private records(): RemoteDaemonClientRecord[] {
    return normalizeRemoteDaemonConfig(this.config.getConfig().remoteDaemon).host.clients
      .filter((client) => client.kind === 'glasses');
  }

  private async writeClients(update: (clients: RemoteDaemonClientRecord[]) => RemoteDaemonClientRecord[]): Promise<void> {
    await this.config.updateConfigWith((current) => {
      const remoteDaemon = normalizeRemoteDaemonConfig(current.remoteDaemon);
      return { remoteDaemon: { ...remoteDaemon, host: { ...remoteDaemon.host, clients: update(remoteDaemon.host.clients) } } };
    });
  }

  private emitRevoked(id: string): void {
    for (const listener of this.revokeListeners) listener(id);
  }

  private prunePending(now: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].expiresAt <= now) this.pending.splice(index, 1);
    }
  }

  private pruneSources(now: number): void {
    for (const [source, state] of this.sources) {
      if (state.lockedUntil <= now && now - state.lastFailureAt > FAILURE_WINDOW_MS) this.sources.delete(source);
    }
  }
}

/** Who a refused request came from: the Tailscale login and tailnet address Serve reports. */
export function glassesSource(login: string | null, forwardedFor: string | null, socketAddress: string | undefined): string {
  const who = login?.trim().toLowerCase() || 'no-login';
  const forwarded = forwardedFor?.split(',')[0]?.trim();
  return `${who}@${forwarded || socketAddress || 'unknown'}`;
}

function readEnvOrigins(env: NodeJS.ProcessEnv, log: (line: string) => void): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of (env[ORIGINS_ENV] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    if (isExactOrigin(value)) origins.add(value);
    else log(`[Pane glasses] ignored ${ORIGINS_ENV} entry "${value}": use an exact origin such as https://app.example.com, never null or a wildcard`);
  }
  return origins;
}

function isExactOrigin(value: string): boolean {
  if (value === 'null' || value.includes('*')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

/** What an allow matches on: the origin itself, or scheme and host alone for a loopback host. */
function originKey(origin: string): string {
  const url = new URL(origin);
  return LOOPBACK_HOSTS.has(url.hostname) ? `${url.protocol}//${url.hostname}` : origin;
}

function cleanDeviceName(name: string): string {
  // Control characters would let a name forge log lines or break layouts on other screens.
  const cleaned = name.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DEVICE_NAME_LENGTH);
  if (!cleaned) {
    throw new PaneError(
      'ERR_GLASSES_DEVICE_NAME_REQUIRED',
      'Pairing glasses needs a device name, so this computer can list and revoke them; nothing was created.',
      'Send a device name such as "Even G2 · iPhone".',
    );
  }
  return cleaned;
}

/**
 * A glasses token's stored hash, in its own domain: a Pane that predates glasses keeps these
 * records as paired clients, and a plain SHA-256 would let the token in there with full access.
 */
function tokenHash(token: string): Buffer {
  return sha256(`pane-glasses-v1\0${token}`);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function toDevice(record: RemoteDaemonClientRecord): GlassesDevice {
  const device: GlassesDevice = { id: record.id, label: record.label, createdAt: record.createdAt };
  if (record.phoneId) device.phoneId = record.phoneId;
  if (record.lastUsedAt) device.lastUsedAt = record.lastUsedAt;
  return device;
}
