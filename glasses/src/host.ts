// The paired computers: one RemoteDaemonClient per computer, each with its own glasses token,
// merged into one PaneSource. Tokens go only in the Authorization header (and the voice
// WebSocket's subprotocol), never in a URL.
import { RemoteDaemonClient, RemoteRequestError, createFetchEventStreamTransport, type RemoteFetch } from '../../shared/remoteClient';
import type { RemoteFetchResponse } from '../../shared/remoteClient/remoteDaemonClient';
import { GLASSES_COMMANDS, decodeGlassesPairingCode, type GlassesPairResult } from '../../shared/types/glasses';
import type { NotifyAnswer, NotifyRemoteCommand } from '../../shared/types/notify';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../shared/validation/boundaryDecoder';
import {
  GlassesError,
  SCREEN_RECONNECTING,
  agentLabel,
  cardsFromNotify,
  orderCards,
  type Card,
  type Computer,
  type Dictation,
  type HostRefusal,
  type MachineOs,
  type NotifyCardState,
  type PaneEntry,
  type PaneSource,
  type PaneStatus,
  type TerminalKey,
  type TerminalScreen,
  type UnjoinedComputer,
} from './model';
import { AutoJoin, type VouchAnswer } from './autoJoin';
import { stripAnsi } from './text';
import type { Cancel } from './timers';
import { recordedDictation, streamingDictation, voiceMode, type VoiceHost, type VoiceSocket } from './voice';

/** A computer the glasses are paired with. The pairing secret is gone; only the device token is kept. */
export interface PairedComputer {
  name: string;
  /** `https://<dnsName>:8443` */
  url: string;
  token: string;
  /** The glasses' name on that computer, such as "Even G2 · iPhone". */
  deviceLabel: string;
}

export const STORAGE_KEY = 'pane.glasses.computers';
/** How the glasses name themselves to a computer while they pair. */
export const CLIENT_LABEL = 'Pane glasses';
/** Asks a computer to get pairing secrets for these glasses from your other computers. */
const VOUCH_COMMAND = 'runpane:glasses:vouch';
/** How long the glasses wait before trying an unreachable computer again. */
const RETRY_MS = 10_000;
/** How often a computer that refused the glasses is tried again, so Allow on the desktop recovers by itself. */
const REFUSED_RETRY_MS = 30_000;
/** Refusals only pairing again can fix; retrying them only feeds the host's lockout. */
const PAIR_AGAIN_CODES = new Set(['ERR_GLASSES_TOKEN_INVALID', 'ERR_GLASSES_TOKEN_REQUIRED']);
/** What a workspace answers a browser origin it doesn't allow (a simple request, so it is readable). */
const BROWSER_REFUSED = 'ERR_WORKSPACE_BROWSER_REFUSED';
const SCREEN_LINES = 40;
const SCROLLBACK_LINES = 400;
/** What an older Pane answers a command it doesn't let glasses run; it says nothing about access. */
const CHANNEL_REFUSED = 'ERR_GLASSES_CHANNEL_REFUSED';
/** The bytes each key sends, as the runpane contract's terminalKeys table gives them. */
const KEY_BYTES = {
  up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b', tab: '\t',
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
} as const satisfies Record<TerminalKey, string>;
/** List changes (Panes made, archived, renamed) arrive in bursts; recount once they settle. */
const LIST_REFRESH_MS = 1_000;

const pairedSchema: BoundarySchema<PairedComputer[]> = boundary.array(boundary.object({
  name: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
  deviceLabel: boundary.string,
}));

export function readPaired(stored: string): PairedComputer[] {
  if (!stored) return [];
  try {
    return decodeOptionalBoundary(JSON.parse(stored), pairedSchema) ?? [];
  } catch {
    return [];
  }
}

const hostErrorSchema = boundary.object({
  ok: boundary.literal(false),
  error: boundary.object({
    message: boundary.string,
    code: boundary.optional(boundary.string),
    next: boundary.optional(boundary.string),
  }),
});

/** The host's own `{ ok: false, error }` body, when a response carries one. */
async function readRefusal(response: Response): Promise<HostRefusal | null> {
  const body = await response.clone().json().catch(() => null);
  const parsed = decodeOptionalBoundary(body, hostErrorSchema);
  if (!parsed) return null;
  const refusal: HostRefusal = { code: parsed.error.code ?? `HTTP_${response.status}`, message: parsed.error.message };
  if (parsed.error.next) refusal.next = parsed.error.next;
  return refusal;
}

/** Seconds a lockout lasts, as the host names them ("… for 60 s."). */
function lockoutSeconds(refusal: HostRefusal): number {
  const match = /(\d+)\s*s\b/.exec(`${refusal.message} ${refusal.next ?? ''}`);
  return match ? Number(match[1]) : 60;
}

const pairResultSchema = boundary.object({
  ok: boundary.literal(true),
  result: boundary.object({
    token: boundary.nonEmptyString,
    device: boundary.object({ id: boundary.string, label: boundary.string, createdAt: boundary.string }),
  }),
});

export interface PairingFailure {
  name: string;
  url: string;
  code: string;
  message: string;
  next?: string;
}

export interface PairingOutcome {
  paired: PairedComputer[];
  failed: PairingFailure[];
}

export interface PairingDeps {
  fetch: typeof fetch;
  runtimeId: string;
  clientLabel: string;
  /** This app's `location.origin`, which each computer must allow. */
  origin: string;
}

/** The Even app's own origin, http://127.0.0.1 on any port, which Pane admits without an Allow. */
function isEvenAppOrigin(origin: string): boolean {
  return /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
}

/**
 * A computer that refuses the app's origin refuses its CORS preflight, which the WebView reports
 * only as a network error. For the Even app's origin that means an older Pane; for any other
 * origin, on a first connection, a missing Allow.
 */
export function noAnswerMessage(computerName: string, origin: string): string {
  return isEvenAppOrigin(origin)
    ? `${computerName} didn't answer. Check that Pane is open and up to date on it, and that Tailscale is on.`
    : `${computerName} didn't answer. If this is the first time, allow the Even app on it: Pane › Settings › Remote Access › Glasses › Allow (origin ${origin}).`;
}

/** Decodes the pasted code and trades each computer's single-use secret for its device token, once. */
export async function pairComputers(code: string, deps: PairingDeps): Promise<PairingOutcome> {
  const decoded = decodeGlassesPairingCode(code);
  const transport = createFetchEventStreamTransport(toRemoteFetch(deps.fetch));
  const outcome: PairingOutcome = { paired: [], failed: [] };
  await Promise.all(decoded.computers.map(async (computer) => {
    const baseUrl = computer.url.replace(/\/+$/, '');
    try {
      // No token yet: the secret goes in the body, never the URL.
      const request = transport.invokeRequest({ baseUrl, token: '', runtimeId: deps.runtimeId, clientLabel: deps.clientLabel }, GLASSES_COMMANDS.pair, [{ secret: computer.secret }]);
      const response = await deps.fetch(`${baseUrl}/invoke`, { method: 'POST', headers: request.headers, body: request.body });
      const refusal = response.ok ? null : await readRefusal(response);
      if (refusal) {
        const failure: PairingFailure = { name: computer.name, url: baseUrl, code: refusal.code, message: refusal.message };
        if (refusal.next) failure.next = refusal.next;
        outcome.failed.push(failure);
        return;
      }
      const result: GlassesPairResult = decodeBoundary(await response.json(), pairResultSchema).result;
      outcome.paired.push({ name: computer.name, url: baseUrl, token: result.token, deviceLabel: result.device.label });
    } catch (error) {
      // The pairing secret is spent only on success, so the same code works again within its 10 minutes.
      outcome.failed.push(error instanceof TypeError
        ? { name: computer.name, url: baseUrl, code: 'ERR_GLASSES_NO_ANSWER', message: noAnswerMessage(computer.name, deps.origin), next: 'Then paste again.' }
        : { name: computer.name, url: baseUrl, code: 'ERR_GLASSES_PAIR_UNREADABLE', message: `${computer.name} sent an answer Pane can't read: ${error instanceof Error ? error.message : String(error)}`, next: 'Update Pane on that computer, then paste again.' });
    }
  }));
  return outcome;
}

/** Adds newly paired computers, replacing an earlier pairing to the same URL. */
function mergePaired(existing: readonly PairedComputer[], added: readonly PairedComputer[]): PairedComputer[] {
  const urls = new Set(added.map((computer) => computer.url));
  return [...existing.filter((computer) => !urls.has(computer.url)), ...added];
}

export interface PairedStorage {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

/**
 * Adds newly paired computers to the stored list. Saves run one at a time, each merged into the
 * list as stored then, so a pasted code and an automatic join never drop each other's computers.
 */
export function pairedSaver(storage: PairedStorage): (added: readonly PairedComputer[]) => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return (added) => {
    const next = last.then(async () => {
      const stored = readPaired(await storage.getLocalStorage(STORAGE_KEY).catch(() => ''));
      await storage.setLocalStorage(STORAGE_KEY, JSON.stringify(mergePaired(stored, added)));
    });
    last = next.catch(() => {});
    return next;
  };
}

function toRemoteFetch(fetchImpl: typeof fetch): RemoteFetch {
  return async (url, init) => adaptResponse(await fetchImpl(url, init));
}

function adaptResponse(response: Response): RemoteFetchResponse {
  return {
    ok: response.ok,
    status: response.status,
    body: response.body,
    json: async () => decodeBoundary(await response.json(), boundary.json),
  };
}

// ---------- host payloads (only the fields the glasses read) ----------

const notifyStateSchema: BoundarySchema<NotifyCardState> = boundary.object({
  machine: boundary.string,
  epoch: boundary.string,
  revision: boundary.number,
  items: boundary.array(boundary.object({
    id: boundary.string,
    ui: boundary.enumeration('options', 'approve', 'ask', 'info'),
    title: boundary.string,
    context: boundary.optional(boundary.string),
    choices: boundary.optional(boundary.array(boundary.object({ label: boundary.string }))),
    suggestions: boundary.optional(boundary.array(boundary.string)),
    state: boundary.enumeration('waiting', 'sent', 'answered', 'expired', 'info'),
    createdAt: boundary.number,
    source: boundary.object({ name: boundary.string, paneId: boundary.optional(boundary.string), panelId: boundary.optional(boundary.string) }),
  })),
});

const sessionsSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.array(boundary.object({
    sessions: boundary.array(boundary.object({
      id: boundary.string,
      name: boundary.string,
      archived: boundary.optional(boundary.boolean),
      isHidden: boundary.optional(boundary.boolean),
      isFavorite: boundary.optional(boundary.boolean),
      favoritePinnedAt: boundary.optional(boundary.string),
      createdAt: boundary.optional(boundary.string),
      lastActivity: boundary.optional(boundary.string),
    })),
  }))),
  error: boundary.optional(boundary.string),
});

const orchestrationSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.object({
    sessions: boundary.array(boundary.object({
      id: boundary.string,
      name: boundary.string,
      archived: boundary.optional(boundary.boolean),
      isPinned: boundary.optional(boundary.boolean),
      agent: boundary.string,
      internalSessionId: boundary.string,
      panelIds: boundary.jsonObject,
      updatedAt: boundary.optional(boundary.string),
    })),
  })),
});

const panelsSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.array(boundary.object({
    id: boundary.string,
    type: boundary.string,
    title: boundary.string,
    state: boundary.object({ isActive: boundary.optional(boundary.boolean), customState: boundary.optional(boundary.json) }),
  }))),
});

const terminalStateSchema = boundary.object({
  agentType: boundary.optional(boundary.string),
  initialCommand: boundary.optional(boundary.string),
  isInitialized: boundary.optional(boundary.boolean),
});

type TerminalTabState = ReturnType<typeof terminalStateSchema.decode>;
const NO_TAB_STATE: TerminalTabState = { agentType: undefined, initialCommand: undefined, isInitialized: undefined };

/**
 * How likely a terminal tab is the one a Pane runs: its agent, then the command it was made
 * with, then a started process, then the tab in front. A tab that never started scores lowest.
 */
function terminalRank(state: TerminalTabState, isActive: boolean): number {
  return (state.agentType ? 8 : 0) + (state.initialCommand ? 4 : 0) + (state.isInitialized ? 2 : 0) + (isActive ? 1 : 0);
}

const workspaceStateSchema = boundary.object({
  entries: boundary.array(boundary.object({
    panelId: boundary.optional(boundary.string),
    to: boundary.optional(boundary.string),
    running: boundary.optional(boundary.boolean),
    baseline: boundary.optional(boundary.boolean),
  })),
});

const agentStatusEventSchema = boundary.object({ panelId: boundary.string, state: boundary.string });

const screenSchema = boundary.object({
  text: boundary.string,
  state: boundary.object({
    running: boundary.boolean,
    activityStatus: boundary.optional(boundary.string),
    agentType: boundary.optional(boundary.string),
  }),
});

const outputSchema = boundary.object({ text: boundary.string });

const submitSchema = boundary.object({
  ok: boundary.boolean,
  blocked: boundary.optional(boundary.object({ message: boundary.string })),
});

const affordancesSchema = boundary.object({
  voiceTranscription: boundary.object({
    availableModes: boundary.array(boundary.enumeration('recorded', 'streaming')),
    defaultMode: boundary.enumeration('recorded', 'streaming'),
  }),
});

const transcriptSchema = boundary.object({ text: boundary.string });

const vouchSchema = boundary.object({
  code: boundary.nullable(boundary.nonEmptyString),
  skipped: boundary.array(boundary.object({ name: boundary.nonEmptyString, reason: boundary.nonEmptyString })),
});

/** A Pane older than the OS report omits `os`; its rows show the plain monitor mark. */
const hostOsSchema = boundary.object({ os: boundary.optional(boundary.enumeration('macOS', 'Windows', 'Linux')) });

/** Epoch ms of an ISO time from the host, or undefined. */
function epochOf(iso: string | undefined): number | undefined {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function statusOf(agentState: string | undefined, running = true): PaneStatus {
  if (!running) return 'stopped';
  if (agentState === 'working') return 'working';
  if (agentState === 'blocked') return 'needs you';
  return 'idle';
}

const LIST_EVENTS = new Set(['panel:created', 'panel:deleted', 'session:created', 'session:deleted', 'session:updated', 'sessions:loaded', 'orchestration-sessions:changed']);

export interface HostDeps {
  fetch: typeof fetch;
  runtimeId: string;
  later(fn: () => void, ms: number): Cancel;
  now(): number;
  openSocket(url: string, protocols: string[]): VoiceSocket;
  /** This app's `location.origin`, named in the hint for a computer that never answered. */
  origin: string;
  /** Adds computers that joined on their own to the stored ones (see `pairedSaver`). */
  savePaired(added: readonly PairedComputer[]): Promise<void>;
}

/** One paired computer: its connection, Notify state, Panes and agent status. */
export class HostConnection {
  readonly id: string;
  private readonly client: RemoteDaemonClient;
  private notify: NotifyCardState | null = null;
  private entries: PaneEntry[] = [];
  private os: MachineOs | null = null;
  private readonly statuses = new Map<string, PaneStatus>();
  private refusal: HostRefusal | null = null;
  private lockedUntil = 0;
  private retryTimer: Cancel | null = null;
  private listTimer: Cancel | null = null;
  private lastSeenAt: number | null = null;
  private stopped = false;

  constructor(readonly paired: PairedComputer, private readonly deps: HostDeps, private readonly changed: () => void) {
    this.id = paired.url;
    const guarded = this.guardedFetch();
    this.client = new RemoteDaemonClient({
      profile: { id: paired.url, label: paired.name, baseUrl: paired.url, token: paired.token, transport: 'http+sse' },
      transport: createFetchEventStreamTransport(guarded),
      fetch: guarded,
      runtimeId: () => deps.runtimeId,
      clientLabel: paired.deviceLabel || 'Pane glasses',
      deviceLabel: paired.deviceLabel || 'Pane glasses',
      staleStreamTimeoutMs: 20_000,
      // The Even SDK's replacement timers stall while the app is idle; these keep firing.
      schedule: deps.later,
    });
    this.client.onRestore(() => this.restore());
    this.client.onStatus((state) => {
      if (state.lastSeenAt) this.lastSeenAt = Date.parse(state.lastSeenAt) || this.lastSeenAt;
      if (state.status === 'connected') this.refusal = null;
      if (state.status === 'error') this.scheduleRetry();
      this.changed();
    });
    this.client.onEvent((event) => {
      if (event.type !== 'daemon-event') return;
      this.onDaemonEvent(event.payload.channel, decodeOptionalBoundary(event.payload.args[0], boundary.json) ?? null);
    });
  }

  /**
   * Every request passes here. A refusal body is kept to show in the host's words; while the
   * host has locked these glasses out, nothing is sent until the time it named is over.
   */
  private guardedFetch(): RemoteFetch {
    return async (url, init) => {
      const now = this.deps.now();
      if (now < this.lockedUntil) {
        throw new GlassesError('ERR_GLASSES_LOCKED_OUT', this.refusal?.message ?? `${this.paired.name} is ignoring these glasses for now.`, this.refusal?.next);
      }
      let response: Response;
      try {
        response = await this.deps.fetch(url, init);
      } catch (error) {
        // A refused CORS preflight looks like a network error; ask the host which it is.
        if (error instanceof TypeError) void this.probeOrigin();
        throw error;
      }
      if (!response.ok) {
        const refusal = await readRefusal(response);
        // A command an older Pane doesn't let glasses run is no access problem: keep the connection.
        if (refusal?.code === CHANNEL_REFUSED) return { ...adaptResponse(response), status: 400 };
        if (refusal) {
          if (refusal.code === BROWSER_REFUSED) {
            this.refusal = this.originRefusal();
          } else if (response.status === 429 && refusal.code === 'ERR_GLASSES_LOCKED_OUT') {
            this.lockedUntil = now + lockoutSeconds(refusal) * 1000;
            refusal.retryAt = this.lockedUntil;
            this.refusal = refusal;
            this.waitOutLockout();
          } else if (response.status === 401 || response.status === 403) {
            this.refusal = refusal;
          }
          this.changed();
        }
      }
      return adaptResponse(response);
    };
  }

  private originRefusal(): HostRefusal {
    return {
      code: 'ERR_GLASSES_ORIGIN_REFUSED',
      message: `${this.paired.name} doesn't allow this app (origin ${this.deps.origin}).`,
      next: isEvenAppOrigin(this.deps.origin)
        ? 'Update Pane on that computer, or allow it there: Settings › Remote Access › Glasses › Allow.'
        : 'Allow it in Pane on that computer: Settings › Remote Access › Glasses › Allow.',
    };
  }

  private probing = false;

  /**
   * After a network error, a plain GET /health with no token needs no preflight: a computer that
   * no longer allows this origin answers it with a readable 403, one that is down doesn't answer.
   */
  private async probeOrigin(): Promise<void> {
    if (this.probing || this.refusal) return;
    this.probing = true;
    try {
      const response = await this.deps.fetch(`${this.paired.url}/health`, { method: 'GET' });
      if (response.ok || (await readRefusal(response))?.code !== BROWSER_REFUSED) return;
      this.refusal = this.originRefusal();
      this.scheduleRetry();
      this.changed();
    } catch {
      // Down or off the tailnet: the computer shows offline.
    } finally {
      this.probing = false;
    }
  }

  /** Stops the client's own retries and tries once more when the lockout ends. */
  private waitOutLockout(): void {
    this.retryTimer?.cancel();
    this.retryTimer = this.deps.later(() => {
      this.retryTimer = null;
      this.client.disconnect();
      void this.connect();
    }, Math.max(0, this.lockedUntil - this.deps.now()));
    // Let the current request fail; the client must not keep retrying into the lockout.
    this.deps.later(() => {
      if (this.deps.now() < this.lockedUntil) this.client.disconnect();
      this.changed();
    }, 0);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    if (this.refusal && PAIR_AGAIN_CODES.has(this.refusal.code)) return;
    const wait = this.deps.now() < this.lockedUntil ? this.lockedUntil - this.deps.now() : this.refusal ? REFUSED_RETRY_MS : RETRY_MS;
    this.retryTimer = this.deps.later(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
  }

  async connect(): Promise<void> {
    if (this.stopped || this.deps.now() < this.lockedUntil) return;
    try {
      await this.client.connect();
    } catch {
      // The status listener shows the computer offline or refused and schedules the next try.
    }
  }

  retry(): void {
    if (this.deps.now() < this.lockedUntil) return;
    this.retryTimer?.cancel();
    this.retryTimer = null;
    const refused = this.refusal !== null;
    this.refusal = null;
    if (this.client.getState().status === 'connected' && !refused) return;
    // Start over rather than wait on a health check or reconnect still backing off from the
    // refusal: a computer that just allowed the app should answer on this press.
    this.client.disconnect();
    void this.connect();
    this.changed();
  }

  stop(): void {
    this.stopped = true;
    this.retryTimer?.cancel();
    this.listTimer?.cancel();
    this.client.disconnect();
  }

  get live(): boolean {
    return this.client.getState().status === 'connected' && !this.refusal;
  }

  /**
   * Asks this computer to vouch for the glasses on your other computers. It names the glasses
   * from this token's own record, so nothing is sent but the command.
   */
  async vouch(): Promise<VouchAnswer> {
    try {
      const result = await this.invoke(VOUCH_COMMAND, [], vouchSchema);
      return { kind: 'answered', code: result.code, skipped: result.skipped };
    } catch (error) {
      // An older Pane doesn't let glasses run it, or doesn't know it.
      if (error instanceof RemoteRequestError && (error.code === CHANNEL_REFUSED || error.code === 'ERR_UNKNOWN_CHANNEL')) return { kind: 'unsupported' };
      return { kind: 'unavailable' };
    }
  }

  computer(): Computer {
    const state = this.client.getState().status;
    const live = state === 'connected';
    // A refusal after connecting is newer than the open stream, so it wins.
    const status = this.refusal ? 'refused' : live ? 'live' : state === 'connecting' || state === 'restoring' ? 'connecting' : 'offline';
    const computer: Computer = {
      id: this.id,
      name: this.paired.name,
      status,
      lastSeenAt: this.lastSeenAt,
      os: this.os,
      entries: this.entries.map((entry) => ({ ...entry, status: this.statusOf(entry) })),
    };
    if (this.refusal) computer.refusal = this.refusal;
    if (status === 'offline' && this.lastSeenAt === null) computer.hint = noAnswerMessage(this.paired.name, this.deps.origin);
    return computer;
  }

  cards(): Card[] {
    if (!this.notify || this.client.getState().status !== 'connected') return [];
    return cardsFromNotify(this.id, this.notify);
  }

  private statusOf(entry: PaneEntry): PaneStatus {
    return this.statuses.get(entry.panelId) ?? entry.status;
  }

  private async restore(): Promise<void> {
    // Notify is what home needs first; the rows and the OS mark can fill in later.
    await Promise.all([this.readNotify(), this.loadLists(), this.readOs().catch(() => {})]);
  }

  private scheduleLists(ms: number): void {
    this.listTimer?.cancel();
    this.listTimer = this.deps.later(() => {
      this.listTimer = null;
      // A reconnect reads the lists again in its restore.
      if (this.client.getState().status === 'connected') void this.loadLists();
    }, ms);
  }

  /** A failed read tries again later, so a live computer's rows don't stay empty. */
  private async loadLists(): Promise<void> {
    try {
      await this.readLists();
    } catch {
      if (!this.stopped) this.scheduleLists(RETRY_MS);
    }
  }

  /** The computer's OS, for its rows' logo; an older Pane leaves it unknown. */
  private async readOs(): Promise<void> {
    const os = (await this.invoke('remote:pwa-affordances', [], hostOsSchema)).os ?? null;
    if (os === this.os) return;
    this.os = os;
    this.changed();
  }

  private applyNotify(value: JsonValue): void {
    const state = decodeOptionalBoundary(value, notifyStateSchema);
    if (!state) return;
    const current = this.notify;
    // Ignore a state older than one already shown; a new epoch is a restarted host.
    if (current && current.epoch === state.epoch && current.revision > state.revision) return;
    this.notify = state;
    this.changed();
  }

  private async readNotify(): Promise<void> {
    this.applyNotify(decodeBoundary(await this.client.invoke('notify:remote-snapshot', []), boundary.json));
  }

  private onDaemonEvent(channel: string, value: JsonValue): void {
    if (channel === 'notify:shared-changed') {
      this.applyNotify(value);
      return;
    }
    if (channel === 'panel:agentStatus') {
      const event = decodeOptionalBoundary(value, agentStatusEventSchema);
      if (!event) return;
      this.statuses.set(event.panelId, statusOf(event.state));
      this.changed();
      return;
    }
    if (LIST_EVENTS.has(channel)) this.scheduleLists(LIST_REFRESH_MS);
  }

  private async invoke<T>(channel: string, args: unknown[], schema: BoundarySchema<T>): Promise<T> {
    return decodeBoundary(await this.client.invoke(channel, args), schema);
  }

  /**
   * Unarchived Sessions and Panes, with the terminal each opens and when each was last active.
   * Rows with the same time keep the Pane phone app's order (native/src/features/panes/paneList.ts):
   * pinned Sessions, pinned Panes newest pin first, the other Sessions in the host's order, the
   * other Panes newest first across every repository. Each shows once.
   */
  private async readLists(): Promise<void> {
    const [sessions, orchestration, workspace] = await Promise.all([
      this.invoke('sessions:get-all-with-projects', [], sessionsSchema),
      this.invoke('orchestration-sessions:list', [], orchestrationSchema).catch(() => null),
      this.invoke('runpane:workspace:state', [{}], workspaceStateSchema).catch(() => null),
    ]);
    for (const entry of workspace?.entries ?? []) {
      if (entry.baseline && entry.panelId) this.statuses.set(entry.panelId, statusOf(entry.to, entry.running ?? true));
    }
    const named = (orchestration?.data?.sessions ?? []).filter((session) => !session.archived);
    const internal = new Set((orchestration?.data?.sessions ?? []).map((session) => session.internalSessionId));
    const pinnedSessions: PaneEntry[] = [];
    const sessionEntries: PaneEntry[] = [];
    for (const session of named) {
      const panelId = decodeOptionalBoundary(session.panelIds[session.agent], boundary.string);
      if (!panelId) continue;
      const row: PaneEntry = { kind: 'session', id: session.id, name: session.name, agent: agentLabel(session.agent), status: 'idle', panelId };
      const activityAt = epochOf(session.updatedAt);
      if (activityAt !== undefined) row.activityAt = activityAt;
      (session.isPinned ? pinnedSessions : sessionEntries).push(row);
    }
    const panes = (sessions.data ?? []).flatMap((project) => project.sessions)
      .filter((pane) => !pane.archived && !pane.isHidden && !internal.has(pane.id))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const pinnedAt = new Map(panes.filter((pane) => pane.isFavorite).map((pane) => [pane.id, pane.favoritePinnedAt ?? '']));
    const paneEntries = await Promise.all(panes.map(async (pane): Promise<PaneEntry | null> => {
      const panels = await this.invoke('panels:list', [pane.id], panelsSchema).catch(() => null);
      const terminals = (panels?.data ?? []).filter((panel) => panel.type === 'terminal');
      const ranked = terminals.map((panel) => {
        const state = decodeOptionalBoundary(panel.state.customState, terminalStateSchema) ?? NO_TAB_STATE;
        return { panel, agentType: state.agentType, rank: terminalRank(state, panel.state.isActive ?? false) };
      });
      const chosen = ranked.reduce<(typeof ranked)[number] | undefined>((best, candidate) => (!best || candidate.rank > best.rank ? candidate : best), undefined);
      if (!chosen) return null;
      const entry: PaneEntry = { kind: 'pane', id: pane.id, name: pane.name, agent: agentLabel(chosen.agentType), status: 'idle', panelId: chosen.panel.id };
      const activityAt = epochOf(pane.lastActivity ?? pane.createdAt);
      if (activityAt !== undefined) entry.activityAt = activityAt;
      return entry;
    }));
    const listed = paneEntries.filter((entry): entry is PaneEntry => entry !== null);
    const pinnedPanes = listed.filter((entry) => pinnedAt.has(entry.id))
      .sort((a, b) => (pinnedAt.get(b.id) ?? '').localeCompare(pinnedAt.get(a.id) ?? '') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const otherPanes = listed.filter((entry) => !pinnedAt.has(entry.id));
    this.entries = [...pinnedSessions, ...pinnedPanes, ...sessionEntries, ...otherPanes];
    this.changed();
  }

  async screen(panelId: string): Promise<TerminalScreen> {
    try {
      const screen = await this.invoke('runpane:panels:screen', [{ panelId, limit: SCREEN_LINES }], screenSchema);
      const known = this.statuses.get(panelId);
      const status = !screen.state.running ? 'stopped' : known ?? (screen.state.activityStatus === 'active' ? 'working' : 'idle');
      return { lines: stripAnsi(screen.text).split('\n'), status, agent: agentLabel(screen.state.agentType) };
    } catch (error) {
      // Still inside its reconnect budget: a later read can succeed, so this is no problem yet.
      const state = this.client.getState().status;
      if (!this.refusal && (state === 'reconnecting' || state === 'connecting' || state === 'restoring')) {
        throw new GlassesError(SCREEN_RECONNECTING, `Lost the connection to ${this.paired.name}. Reconnecting.`, 'Wait: the screen comes back by itself.');
      }
      throw error;
    }
  }

  async scrollback(panelId: string, lines = SCROLLBACK_LINES): Promise<string[]> {
    const output = await this.invoke('runpane:panels:output', [{ panelId, limit: lines }], outputSchema);
    return stripAnsi(output.text).split('\n');
  }

  async markViewed(paneId: string): Promise<void> {
    await this.client.invoke('sessions:mark-viewed', [paneId]);
  }

  async resume(panelId: string): Promise<void> {
    await this.client.invoke('runpane:panels:resume', [{ panelId }]);
  }

  async submit(panelId: string, input: string): Promise<void> {
    const result = await this.invoke('runpane:panels:submit', [{ panelId, input, source: 'user' }], submitSchema);
    if (!result.ok) throw new GlassesError('ERR_GLASSES_SUBMIT_BLOCKED', result.blocked?.message ?? 'The Pane did not take the input.', 'Look at the terminal, then hold to try again.');
  }

  async key(panelId: string, key: TerminalKey): Promise<void> {
    try {
      await this.client.invoke('runpane:panels:input', [{ panelId, input: KEY_BYTES[key], source: 'user' }]);
    } catch (error) {
      if (error instanceof RemoteRequestError && error.code === CHANNEL_REFUSED) {
        throw new GlassesError('ERR_GLASSES_KEYS_UNSUPPORTED', `${this.paired.name}'s Pane can't take keys from the glasses yet.`, `Update Pane on ${this.paired.name}.`);
      }
      throw error;
    }
  }

  async answer(card: Card, answer: NotifyAnswer): Promise<void> {
    const command: NotifyRemoteCommand = { type: 'answer', id: card.itemId, answer };
    await this.client.invoke('notify:remote-command', [command]);
  }

  async dictate(onPreview: (text: string) => void): Promise<Dictation> {
    const affordances = await this.invoke('remote:pwa-affordances', [], affordancesSchema);
    const mode = voiceMode(affordances.voiceTranscription);
    if (!mode) {
      throw new GlassesError('ERR_GLASSES_VOICE_UNAVAILABLE', `${this.paired.name} can't turn speech into text.`, 'Add a Deepgram key (live) or a fal key (recorded) in Pane on that computer: Settings › Integrations › Voice transcription.');
    }
    const host: VoiceHost = {
      name: this.paired.name,
      baseUrl: this.paired.url,
      token: this.paired.token,
      now: this.deps.now,
      openSocket: this.deps.openSocket,
      finalizeStreaming: async (rawText, durationMs) => (await this.invoke('voice:finalize-streaming', [{ rawText, durationMs, language: 'en' }], transcriptSchema)).text,
      transcribe: async (audioDataUrl, durationMs) => (await this.invoke('voice:transcribe', [{ audioDataUrl, mimeType: 'audio/wav', durationMs, language: 'en' }], transcriptSchema)).text,
    };
    return mode === 'streaming' ? streamingDictation(host, onPreview) : recordedDictation(host, onPreview);
  }
}

/** Every paired computer as one source of cards, Panes and terminals. */
export class HostHub implements PaneSource {
  readonly demo = false;
  private connections: HostConnection[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly autoJoin: AutoJoin;

  constructor(paired: readonly PairedComputer[], private readonly deps: HostDeps) {
    this.autoJoin = new AutoJoin({
      vouchers: () => this.connections.map((connection) => ({ id: connection.id, name: connection.paired.name, live: connection.live, vouch: () => connection.vouch() })),
      join: (code) => this.join(code),
      later: deps.later,
      now: deps.now,
      changed: () => this.emit(),
    });
    this.connections = paired.map((computer) => new HostConnection(computer, deps, () => this.emit()));
  }

  /** Connects to every paired computer, and asks them to add the glasses to the rest, now and every 10 minutes. */
  start(): void {
    for (const connection of this.connections) void connection.connect();
    this.autoJoin.start();
  }

  stop(): void {
    this.autoJoin.stop();
    for (const connection of this.connections) connection.stop();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    this.autoJoin.poke();
  }

  /** Pairs with a code a computer vouched with, exactly as a pasted code, and connects to each computer that joined. */
  private async join(code: string): Promise<{ joined: string[]; failed: string[] }> {
    const { fetch, runtimeId, origin } = this.deps;
    const outcome = await pairComputers(code, { fetch, runtimeId, clientLabel: CLIENT_LABEL, origin });
    if (outcome.paired.length) {
      await this.deps.savePaired(outcome.paired);
      // A computer paired again replaces its old connection, as mergePaired replaces its record.
      const urls = new Set(outcome.paired.map((computer) => computer.url));
      for (const connection of this.connections) if (urls.has(connection.id)) connection.stop();
      const added = outcome.paired.map((computer) => new HostConnection(computer, this.deps, () => this.emit()));
      this.connections = [...this.connections.filter((connection) => !urls.has(connection.id)), ...added];
      for (const connection of added) void connection.connect();
      this.emit();
    }
    return { joined: outcome.paired.map((computer) => computer.name), failed: outcome.failed.map((failure) => failure.name) };
  }

  private connection(id: string): HostConnection {
    const connection = this.connections.find((candidate) => candidate.id === id);
    if (!connection) throw new GlassesError('ERR_GLASSES_UNKNOWN_COMPUTER', 'That computer is no longer paired.', 'Pair again from the Pane app.');
    return connection;
  }

  computers(): Computer[] {
    return this.connections.map((connection) => connection.computer());
  }

  cards(): Card[] {
    return orderCards(this.connections.flatMap((connection) => connection.cards()));
  }

  unjoined(): UnjoinedComputer[] {
    return this.autoJoin.unjoined();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  screen(computerId: string, panelId: string): Promise<TerminalScreen> {
    return this.connection(computerId).screen(panelId);
  }

  scrollback(computerId: string, panelId: string, lines?: number): Promise<string[]> {
    return this.connection(computerId).scrollback(panelId, lines);
  }

  markViewed(computerId: string, paneId: string): Promise<void> {
    return this.connection(computerId).markViewed(paneId);
  }

  resume(computerId: string, panelId: string): Promise<void> {
    return this.connection(computerId).resume(panelId);
  }

  submit(computerId: string, panelId: string, text: string): Promise<void> {
    return this.connection(computerId).submit(panelId, text);
  }

  key(computerId: string, panelId: string, key: TerminalKey): Promise<void> {
    return this.connection(computerId).key(panelId, key);
  }

  answer(card: Card, answer: NotifyAnswer): Promise<void> {
    return this.connection(card.computerId).answer(card, answer);
  }

  dictate(computerId: string, onPreview: (text: string) => void): Promise<Dictation> {
    return this.connection(computerId).dictate(onPreview);
  }

  /**
   * Retries one computer, or every unreachable one. A computer that refused the glasses is
   * retried only when named: a blanket retry (on wake, say) would count against its lockout.
   */
  retry(computerId?: string): void {
    for (const connection of this.connections) {
      if (computerId ? connection.id === computerId : connection.computer().status !== 'refused') connection.retry();
    }
  }
}
