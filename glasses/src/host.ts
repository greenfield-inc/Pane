// The paired computers: one RemoteDaemonClient per computer, each with its own glasses token,
// merged into one PaneSource. Tokens go only in the Authorization header (and the voice
// WebSocket's subprotocol), never in a URL.
import { RemoteDaemonClient, createFetchEventStreamTransport, type RemoteFetch } from '../../shared/remoteClient';
import type { RemoteFetchResponse } from '../../shared/remoteClient/remoteDaemonClient';
import { GLASSES_COMMANDS, decodeGlassesPairingCode, type GlassesPairResult } from '../../shared/types/glasses';
import type { NotifyAnswer, NotifyRemoteCommand } from '../../shared/types/notify';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../shared/validation/boundaryDecoder';
import {
  GlassesError,
  agentLabel,
  cardsFromNotify,
  orderCards,
  type Card,
  type Computer,
  type Dictation,
  type HostRefusal,
  type NotifyCardState,
  type PaneEntry,
  type PaneSource,
  type PaneStatus,
  type TerminalScreen,
} from './model';
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
export function mergePaired(existing: readonly PairedComputer[], added: readonly PairedComputer[]): PairedComputer[] {
  const urls = new Set(added.map((computer) => computer.url));
  return [...existing.filter((computer) => !urls.has(computer.url)), ...added];
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
    sessions: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, archived: boundary.optional(boundary.boolean) })),
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
      agent: boundary.string,
      internalSessionId: boundary.string,
      panelIds: boundary.jsonObject,
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
}

/** One paired computer: its connection, Notify state, Panes and agent status. */
export class HostConnection {
  readonly id: string;
  private readonly client: RemoteDaemonClient;
  private notify: NotifyCardState | null = null;
  private entries: PaneEntry[] = [];
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
      paneCount: this.entries.length,
      workingCount: this.entries.filter((entry) => this.statusOf(entry) === 'working').length,
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
    // Notify is what home needs; the Pane counts can fill in later.
    await Promise.all([this.readNotify(), this.readLists().catch(() => {})]);
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
    if (LIST_EVENTS.has(channel)) {
      this.listTimer?.cancel();
      this.listTimer = this.deps.later(() => {
        this.listTimer = null;
        void this.readLists().catch(() => {});
      }, LIST_REFRESH_MS);
    }
  }

  private async invoke<T>(channel: string, args: unknown[], schema: BoundarySchema<T>): Promise<T> {
    return decodeBoundary(await this.client.invoke(channel, args), schema);
  }

  /** Unarchived Sessions and Panes, with the terminal each opens and its agent status. */
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
    const sessionEntries: PaneEntry[] = [];
    for (const session of named) {
      const panelId = decodeOptionalBoundary(session.panelIds[session.agent], boundary.string);
      if (panelId) sessionEntries.push({ kind: 'session', id: session.id, name: session.name, agent: agentLabel(session.agent), status: 'idle', panelId });
    }
    const panes = (sessions.data ?? []).flatMap((project) => project.sessions).filter((pane) => !pane.archived && !internal.has(pane.id));
    const paneEntries = await Promise.all(panes.map(async (pane): Promise<PaneEntry | null> => {
      const panels = await this.invoke('panels:list', [pane.id], panelsSchema).catch(() => null);
      const terminals = (panels?.data ?? []).filter((panel) => panel.type === 'terminal');
      const ranked = terminals.map((panel) => {
        const state = decodeOptionalBoundary(panel.state.customState, terminalStateSchema) ?? NO_TAB_STATE;
        return { panel, agentType: state.agentType, rank: terminalRank(state, panel.state.isActive ?? false) };
      });
      const chosen = ranked.reduce<(typeof ranked)[number] | undefined>((best, candidate) => (!best || candidate.rank > best.rank ? candidate : best), undefined);
      if (!chosen) return null;
      return { kind: 'pane', id: pane.id, name: pane.name, agent: agentLabel(chosen.agentType), status: 'idle', panelId: chosen.panel.id };
    }));
    this.entries = [...sessionEntries, ...paneEntries.filter((entry): entry is PaneEntry => entry !== null)];
    this.changed();
  }

  async panes(): Promise<PaneEntry[]> {
    await this.readLists();
    return this.entries.map((entry) => ({ ...entry, status: this.statusOf(entry) }));
  }

  async screen(panelId: string): Promise<TerminalScreen> {
    const screen = await this.invoke('runpane:panels:screen', [{ panelId, limit: SCREEN_LINES }], screenSchema);
    const known = this.statuses.get(panelId);
    const status = !screen.state.running ? 'stopped' : known ?? (screen.state.activityStatus === 'active' ? 'working' : 'idle');
    return { lines: stripAnsi(screen.text).split('\n'), status, agent: agentLabel(screen.state.agentType) };
  }

  async scrollback(panelId: string): Promise<string[]> {
    const output = await this.invoke('runpane:panels:output', [{ panelId, limit: SCROLLBACK_LINES }], outputSchema);
    return stripAnsi(output.text).split('\n');
  }

  async submit(panelId: string, input: string): Promise<void> {
    const result = await this.invoke('runpane:panels:submit', [{ panelId, input, source: 'user' }], submitSchema);
    if (!result.ok) throw new GlassesError('ERR_GLASSES_SUBMIT_BLOCKED', result.blocked?.message ?? 'The Pane did not take the input.', 'Look at the terminal, then hold to try again.');
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
  private readonly connections: HostConnection[];
  private readonly listeners = new Set<() => void>();

  constructor(paired: readonly PairedComputer[], deps: HostDeps) {
    this.connections = paired.map((computer) => new HostConnection(computer, deps, () => this.emit()));
  }

  start(): void {
    for (const connection of this.connections) void connection.connect();
  }

  stop(): void {
    for (const connection of this.connections) connection.stop();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  panes(computerId: string): Promise<PaneEntry[]> {
    return this.connection(computerId).panes();
  }

  screen(computerId: string, panelId: string): Promise<TerminalScreen> {
    return this.connection(computerId).screen(panelId);
  }

  scrollback(computerId: string, panelId: string): Promise<string[]> {
    return this.connection(computerId).scrollback(panelId);
  }

  submit(computerId: string, panelId: string, text: string): Promise<void> {
    return this.connection(computerId).submit(panelId, text);
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
