import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { CoordinatorClient, CoordinatorError, type CloudHostState } from './coordinatorClient';
import { resolveDaemonTarget, type DaemonTarget } from './hostDirectory';
import {
  RemoteAuthError,
  RemoteConnectError,
  RemoteDaemonClient,
  RemoteRequestError,
  RemoteUnconfirmedResultError,
  nodeHttpTransport,
  type RemoteDaemonClientOptions,
  type RemoteHttpTransport,
} from './remoteDaemonClient';

/** An error with a stable `code` that daemonClient turns into a PaneDaemonClientError. */
export class RemoteTargetError extends Error {
  override name = 'RemoteTargetError';

  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Only a submit may wake a sleeping cloud host (plan S3: "Only submit triggers a wake"). */
const WAKING_CHANNELS = new Set(['runpane:panels:submit', 'runpane:panels:submit-composer']);
const IDEMPOTENT_SUBMIT_CHANNEL = 'runpane:panels:submit';
/** `--panel orchestrator` names the target Session's orchestrator panel. */
const ORCHESTRATOR_PANEL_SELECTOR = 'orchestrator';
const DEFAULT_WAKE_WAIT_MS = 90_000;
const RESEND_INTERVAL_MS = 2_000;
/** A cloud daemon answers this while its coordinator's stop lease holds (main/src/daemon/cloud/stopLease.ts). */
const SESSION_STOPPING_CODE = 'ERR_SESSION_STOPPING';
// Local Pane terminal ids name panels on this host, never on the target.
const LOCAL_IDENTITY_ENV = ['PANE_SESSION_ID', 'PANE_PANEL_ID', 'PANE_ORCHESTRATION_SESSION_ID'];

let activeTarget: DaemonTarget | null = null;

export interface TargetSelection {
  host?: string;
  thread?: string;
  paneDir?: string;
}

/**
 * Picks the daemon every `invokeDaemon` call in this process talks to:
 * `--thread` (cloud Sessions only), else `--host`, else `$RUNPANE_HOST`,
 * else the local socket. The CLI is one-shot, so this is process state.
 */
export function configureDaemonTarget(selection: TargetSelection, env: NodeJS.ProcessEnv = process.env): DaemonTarget | null {
  if (selection.host && selection.thread) {
    throw new Error('Use either --host or --thread, not both.');
  }
  const selector = selection.thread ?? selection.host ?? env.RUNPANE_HOST?.trim();
  if (!selector) {
    activeTarget = null;
    return null;
  }
  activeTarget = resolveDaemonTarget(selector, { env, paneDir: selection.paneDir, cloudOnly: Boolean(selection.thread) });
  for (const name of LOCAL_IDENTITY_ENV) delete env[name];
  return activeTarget;
}

export function getDaemonTarget(): DaemonTarget | null {
  return activeTarget;
}

export function resetDaemonTarget(): void {
  activeTarget = null;
}

export interface InvokeRemoteOptions {
  timeoutMs: number;
  transport?: RemoteHttpTransport;
  wakeWaitMs?: number;
  resendIntervalMs?: number;
  retryDelayMs?: number;
}

/**
 * Sends one channel call over HTTP `/invoke`. When the connection never opens
 * and the target is a cloud host: a submit asks the coordinator to wake it and
 * then resends the same request (same idempotency key); anything else asks for
 * the status only and fails with ERR_RUNPANE_HOST_<STATUS>. A host its coordinator
 * is stopping refuses everything (ERR_SESSION_STOPPING): a submit waits for the
 * stop and wakes it the same way; anything else fails with ERR_RUNPANE_HOST_STOPPING.
 */
export async function invokeRemote(
  target: DaemonTarget,
  channel: string,
  args: unknown[],
  options: InvokeRemoteOptions,
): Promise<JsonValue | undefined> {
  const transport = options.transport ?? nodeHttpTransport;
  const startedAt = Date.now();
  let baseUrl = target.host.baseUrl;
  const client = () => {
    const clientOptions: RemoteDaemonClientOptions = {
      profile: { ...target.host, baseUrl },
      runtimeId: cliRuntimeId(),
      clientLabel: `runpane CLI (${os.hostname()})`,
      transport,
    };
    if (options.retryDelayMs !== undefined) clientOptions.retryDelayMs = options.retryDelayMs;
    return new RemoteDaemonClient(clientOptions);
  };

  // The key is fixed once, so every resend is the same logical submit.
  const requestArgs = withIdempotencyKey(channel, args);
  const deliver = async () => {
    const resolved = await resolveOrchestratorPanel(channel, requestArgs, (listChannel, listArgs) => (
      client().invoke(listChannel, listArgs, { timeoutMs: 30_000 })
    ));
    return client().invoke(channel, resolved, { timeoutMs: options.timeoutMs });
  };
  try {
    return await deliver();
  } catch (error) {
    const stopping = error instanceof Error && isStopping(error);
    if (!(error instanceof RemoteConnectError) && !stopping) throw error instanceof Error ? toTargetError(error, target) : error;
    // A daemon under the coordinator's stop lease answered: it is about to sleep. Only a submit waits it out.
    if (stopping && (!WAKING_CHANNELS.has(channel) || !target.host.cloud || !target.coordinator)) throw stoppingError(target);
  }

  // The connection never opened (or the host is being stopped), so the host did not take the request.
  const cloud = target.host.cloud;
  if (!cloud || !target.coordinator) {
    throw new RemoteTargetError(
      `Could not reach ${target.host.label} at ${baseUrl}. ` +
      (cloud
        ? `It is probably asleep. Run \`runpane cloud wake ${cloud.hostname ?? target.host.label}\` (no runpane cloud coordinator is configured here to wake it on submit).`
        : 'Is the host up and on your tailnet?'),
      'ERR_RUNPANE_HOST_UNREACHABLE',
    );
  }
  const coordinator = new CoordinatorClient(target.coordinator, transport);
  const wakeWaitMs = options.wakeWaitMs ?? DEFAULT_WAKE_WAIT_MS;
  const deadline = startedAt + wakeWaitMs + options.timeoutMs;
  const resendIntervalMs = options.resendIntervalMs ?? RESEND_INTERVAL_MS;

  // Wakes (a submit) or only asks (anything else), then waits out a host that is still booting.
  const settle = async (waitMs: number): Promise<void> => {
    let state: CloudHostState;
    try {
      state = WAKING_CHANNELS.has(channel)
        ? await coordinator.wake(cloud.sessionId, waitMs)
        : await coordinator.status(cloud.sessionId);
    } catch (error) {
      if (error instanceof CoordinatorError) throw new RemoteTargetError(error.message, error.code);
      throw error;
    }
    // A re-enrolled host keeps its name but may come back with a new address.
    if (state.baseUrl) baseUrl = state.baseUrl;

    if (!WAKING_CHANNELS.has(channel) && state.status !== 'awake') {
      throw hostStateError(target, state, false);
    }
    if (state.status === 'waking') {
      state = await pollUntilSettled(coordinator, cloud.sessionId, deadline, resendIntervalMs);
      if (state.baseUrl) baseUrl = state.baseUrl;
    }
    if (state.status !== 'awake') {
      throw hostStateError(target, state, WAKING_CHANNELS.has(channel));
    }
  };
  await settle(wakeWaitMs);

  // Resend while the connection keeps failing to open (MagicDNS and routes can
  // lag the wake by a few seconds). Once it opens, the answer is final. A host
  // still under its stop lease is woken again once the stop it was fencing lands.
  for (;;) {
    try {
      return await deliver();
    } catch (error) {
      const stopping = error instanceof Error && isStopping(error);
      if (!(error instanceof RemoteConnectError) && !stopping) throw error instanceof Error ? toTargetError(error, target) : error;
      if (Date.now() + resendIntervalMs > deadline) {
        if (stopping) throw stoppingError(target);
        throw new RemoteTargetError(
          `${target.host.label} woke up but its daemon did not accept connections in time (${error instanceof Error ? error.message : String(error)}).`,
          'ERR_RUNPANE_HOST_DAEMON_DOWN',
        );
      }
      await delay(resendIntervalMs);
      if (stopping) await settle(Math.max(0, deadline - Date.now()));
    }
  }
}

function isStopping(error: Error): boolean {
  return error instanceof RemoteRequestError && error.code === SESSION_STOPPING_CODE;
}

function stoppingError(target: DaemonTarget): RemoteTargetError {
  const wakeName = target.host.cloud?.hostname ?? target.host.label;
  return new RemoteTargetError(
    `Cloud host ${target.host.label} is being stopped by its coordinator, so it took nothing new. `
      + `Once it is asleep, panels submit (or runpane cloud wake ${wakeName}) wakes it.`,
    'ERR_RUNPANE_HOST_STOPPING',
  );
}

async function pollUntilSettled(
  coordinator: CoordinatorClient,
  host: string,
  deadline: number,
  intervalMs: number,
): Promise<CloudHostState> {
  let state: CloudHostState = { status: 'waking' };
  while (state.status === 'waking' && Date.now() + intervalMs <= deadline) {
    await delay(intervalMs);
    state = await coordinator.status(host);
  }
  return state;
}

function hostStateError(target: DaemonTarget, state: CloudHostState, woke: boolean): RemoteTargetError {
  const name = target.host.label;
  // The tailnet hostname is one shell word; a label like "Glue Beta" would break a pasted command.
  const wakeName = target.host.cloud?.hostname ?? name;
  const detail = state.detail ? ` (${state.detail})` : '';
  const code = `ERR_RUNPANE_HOST_${state.status.toUpperCase().replace(/-/g, '_')}`;
  switch (state.status) {
    case 'asleep':
      return new RemoteTargetError(
        `Cloud host ${name} is asleep${detail}. Only panels submit wakes a host; run \`runpane cloud wake ${wakeName}\` to wake it.`,
        code,
      );
    case 'waking':
      return new RemoteTargetError(`Cloud host ${name} is still waking up${detail}. Try again in a few seconds.`, code);
    case 'daemon-down':
      return new RemoteTargetError(`Cloud host ${name} is running but its Pane daemon is not answering${detail}.`, code);
    case 'lost':
      return new RemoteTargetError(`Cloud host ${name} is lost: the provider no longer has it${detail}.`, code);
    case 'awake':
      return new RemoteTargetError(
        `Cloud host ${name} is awake${woke ? ' after a wake' : ''}, but ${target.host.baseUrl} did not accept a connection${detail}.`,
        'ERR_RUNPANE_HOST_UNREACHABLE',
      );
  }
}

function toTargetError(error: Error, target: DaemonTarget): Error {
  if (error instanceof RemoteRequestError) {
    return new RemoteTargetError(error.message, error.code ?? `ERR_RUNPANE_REMOTE_HTTP_${error.status}`);
  }
  if (error instanceof RemoteAuthError) {
    return new RemoteTargetError(`${target.host.label}: ${error.message}`, 'ERR_RUNPANE_REMOTE_AUTH');
  }
  if (error instanceof RemoteUnconfirmedResultError) {
    return new RemoteTargetError(error.message, 'ERR_RUNPANE_REMOTE_UNCONFIRMED');
  }
  return error;
}

/** A submit over HTTP always carries an idempotency key, so a resend after a wake delivers once. */
function withIdempotencyKey(channel: string, args: unknown[]): unknown[] {
  if (channel !== IDEMPOTENT_SUBMIT_CHANNEL) return args;
  const request = firstRequestObject(args);
  if (!request || request.idempotencyKey !== undefined) return args;
  return [{ ...request, idempotencyKey: `runpane-cli:${randomUUID()}` }, ...args.slice(1)];
}

/**
 * The request object a runpane channel takes as its first argument, or null.
 * Decoded from its wire form: CLI requests carry `undefined` optionals
 * (e.g. `asFilePointer`) that JSON drops but a strict JSON decoder rejects.
 */
function firstRequestObject(args: unknown[]): JsonObject | null {
  if (args[0] === undefined) return null;
  try {
    return decodeBoundary(JSON.parse(JSON.stringify(args[0])), boundary.jsonObject);
  } catch {
    return null;
  }
}

const panelListSchema = boundary.object({
  panels: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    title: boundary.optional(boundary.nullable(boundary.string)),
  })),
});

/** Every daemon has this built-in Session; a named Session the user created is the likelier target. */
const PANE_CHAT_SESSION_ID = 'legacy-pane-chat';

const sessionListSchema = boundary.object({
  sessions: boundary.array(boundary.object({
    id: boundary.string,
    name: boundary.string,
    archived: boundary.optional(boundary.boolean),
    agent: boundary.optional(boundary.string),
    panelIds: boundary.optional(boundary.jsonObject),
  })),
});

/**
 * Resolves `--panel orchestrator`. A peer's `panels:list` lists only the orchestrator panels it may
 * reach; a full client's daemon wants a Pane there, so its Sessions' orchestrator panels are read
 * from `sessions:list` instead (a peer may not call that).
 */
async function resolveOrchestratorPanel(
  channel: string,
  args: unknown[],
  invoke: (channel: string, args: unknown[]) => Promise<JsonValue | undefined>,
): Promise<unknown[]> {
  if (!WAKING_CHANNELS.has(channel)) return args;
  const request = firstRequestObject(args);
  if (!request || request.panelId !== ORCHESTRATOR_PANEL_SELECTOR) return args;
  let panels: { id: string; title?: string | null }[];
  try {
    panels = decodeBoundary(await invoke('runpane:panels:list', [{}]), panelListSchema).panels;
  } catch (error) {
    // The daemon answers a full client's pane-less panels:list with an error (a 500, retried as a read).
    if (error instanceof RemoteConnectError || error instanceof RemoteAuthError) throw error;
    let listed: JsonValue | undefined;
    try {
      listed = await invoke('runpane:sessions:list', []);
    } catch {
      throw error;
    }
    const all = decodeBoundary(listed, sessionListSchema).sessions.filter((session) => session.archived !== true);
    const named = all.filter((session) => session.id !== PANE_CHAT_SESSION_ID);
    const sessions = named.length > 0 ? named : all;
    panels = sessions.flatMap((session) => {
      if (!session.agent || !session.panelIds) return [];
      try {
        return [{ id: decodeBoundary(session.panelIds[session.agent], boundary.nonEmptyString), title: session.name }];
      } catch {
        return []; // A Session whose orchestrator panel is not created yet.
      }
    });
  }
  if (panels.length !== 1) {
    const found = panels.map((panel) => `${panel.id}${panel.title ? ` (${panel.title})` : ''}`).join(', ') || 'none';
    throw new RemoteTargetError(
      `--panel orchestrator needs exactly one orchestrator panel on the target; found ${panels.length}: ${found}. Pass --panel <id>.`,
      'ERR_RUNPANE_ORCHESTRATOR_AMBIGUOUS',
    );
  }
  return [{ ...request, panelId: panels[0]!.id }, ...args.slice(1)];
}

/** Stable per machine and user without writing a file: the daemon keys remote viewers by it. */
function cliRuntimeId(): string {
  const uid = process.getuid ? String(process.getuid()) : os.userInfo().username;
  return `runpane-cli-${createHash('sha256').update(`${os.hostname()}:${uid}`).digest('hex').slice(0, 16)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
