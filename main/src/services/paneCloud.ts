import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CloudApiError, createServiceClient, MACHINE_LIMITS, type ActionLogEntry, type Machine, type ServiceClient } from 'pane-cloud-contract';
import { tailnetProfileId } from './tailnetMachines';
import type { RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import type {
  PaneCloudAction,
  PaneCloudError,
  PaneCloudBusy,
  PaneCloudMachineView,
  PaneCloudSignIn,
  PaneCloudSnapshot,
} from '../../../shared/types/paneCloud';

/** The Pane Cloud service. PANE_CLOUD_URL points a dev build at a local stub or staging. */
export const DEFAULT_PANE_CLOUD_URL = 'https://cloud.runpane.com';

/** How the manager saves and forgets the codeless host of the seat's machine. */
export interface PaneCloudHosts {
  save(profile: RemotePaneConnectionProfile): Promise<void>;
  forget(machineId: string): Promise<void>;
}

export interface PaneCloudManagerOptions {
  serviceUrl: string;
  /** Where the service session is kept, 0600. It is Pane Cloud's own token, never a GitHub one. */
  tokenFile: string;
  hosts: PaneCloudHosts;
  onChange?: (snapshot: PaneCloudSnapshot) => void;
  fetch?: typeof fetch;
  /** How often to re-read the machine: while it changes state or waits for its tailnet login, and otherwise. */
  pollMs?: { waiting: number; steady: number };
}

const RECENT_ACTIONS = 20;
/** The fleet stops, resumes and throttles machines on its own, so a machine is re-read even when nothing is pending. */
const POLL_MS = { waiting: 5_000, steady: 30_000 };
const TRANSITIONAL = new Set<Machine['state']>(['creating', 'stopping', 'resuming', 'deleting']);

interface StoredSession {
  token: string;
  expiresAt: string;
}
const storedSessionSchema: BoundarySchema<StoredSession> = boundary.object({ token: boundary.nonEmptyString, expiresAt: boundary.nonEmptyString });

/**
 * Pane Cloud for desktop Pane: device sign-in, the seat's one machine and its action log, over the
 * service API's typed client. The machine joins the user's tailnet from a login link the user opens;
 * once it has, it is saved as a codeless Tailscale host. Pane never has a shell on it from here:
 * the only operations are the service's named ones.
 */
export class PaneCloudManager {
  private state: PaneCloudSnapshot = { signIn: { state: 'signed-out' }, machine: null, busy: null, error: null };
  private session: StoredSession | null | undefined;
  private signInAttempt = 0;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchWaiting = false;
  private disposed = false;
  /** The host last saved, so a refresh writes the config only when it changes. */
  private savedHost = '';

  constructor(private readonly options: PaneCloudManagerOptions) {}

  snapshot(): PaneCloudSnapshot {
    return this.state;
  }

  /**
   * Reads the account and the machine again. Without a session it answers signed out. A background
   * re-read keeps the last action's error on screen; a refresh the person asked for clears it.
   */
  async refresh({ background = false }: { background?: boolean } = {}): Promise<PaneCloudSnapshot> {
    const client = await this.signedInClient();
    if (!client) return this.update({ signIn: this.state.signIn.state === 'pending' ? this.state.signIn : { state: 'signed-out' }, machine: null });
    try {
      await this.load(client);
      return background ? this.state : this.update({ error: null });
    } catch (error) {
      return this.fail(error);
    }
  }

  /** Starts GitHub's device flow; main polls until the person approves, denies, or the code expires. */
  async startSignIn(): Promise<PaneCloudSnapshot> {
    const attempt = ++this.signInAttempt;
    try {
      const code = await this.client().startDeviceSignIn();
      const expiresAt = new Date(Date.now() + code.expiresIn * 1000).toISOString();
      void this.pollSignIn(attempt, code.deviceCode, code.interval);
      return this.update({ signIn: { state: 'pending', userCode: code.userCode, verificationUri: code.verificationUri, expiresAt }, error: null });
    } catch (error) {
      return this.fail(error);
    }
  }

  async signOut(): Promise<PaneCloudSnapshot> {
    this.signInAttempt += 1;
    const client = await this.signedInClient();
    // The local session goes either way; the service forgets it when it can.
    await client?.signOut().catch(() => undefined);
    await this.saveSession(null);
    this.stopWatching();
    return this.update({ signIn: { state: 'signed-out' }, machine: null, error: null });
  }

  createMachine(name: string): Promise<PaneCloudSnapshot> {
    return this.act('create', (client) => client.createMachine(name, randomUUID()));
  }

  startMachine(): Promise<PaneCloudSnapshot> {
    return this.act('start', (client, machineId) => client.startMachine(machineId));
  }

  stopMachine(): Promise<PaneCloudSnapshot> {
    return this.act('stop', (client, machineId) => client.stopMachine(machineId));
  }

  /** Installs the latest published Pane release; the service pins its checksum. */
  updatePane(): Promise<PaneCloudSnapshot> {
    return this.act('update', (client, machineId) => client.requestOperation(machineId, { operation: 'update_pane', parameters: {} }));
  }

  deleteMachine(): Promise<PaneCloudSnapshot> {
    return this.act('delete', async (client, machineId) => {
      await client.deleteMachine(machineId);
      await this.options.hosts.forget(machineId);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.signInAttempt += 1;
    this.stopWatching();
  }

  private async act(busy: PaneCloudBusy, run: (client: ServiceClient, machineId: string) => Promise<object | void>): Promise<PaneCloudSnapshot> {
    const client = await this.signedInClient();
    if (!client) {
      return this.update({ error: { message: 'You are not signed in to Pane Cloud.', next: 'Sign in with GitHub, then try again.' } });
    }
    const machineId = this.state.machine?.id ?? '';
    if (busy !== 'create' && !machineId) {
      return this.update({ error: { message: 'This seat has no Pane Cloud machine yet.', next: 'Create one first.' } });
    }
    this.update({ busy, error: null });
    try {
      await run(client, machineId);
      await this.load(client);
      return this.update({ busy: null });
    } catch (error) {
      await this.load(client).catch(() => undefined);
      return this.fail(error);
    }
  }

  private async pollSignIn(attempt: number, deviceCode: string, intervalSeconds: number): Promise<void> {
    let interval = intervalSeconds;
    while (attempt === this.signInAttempt && !this.disposed) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      if (attempt !== this.signInAttempt || this.disposed) return;
      try {
        const result = await this.client().pollDeviceSignIn(deviceCode);
        if (attempt !== this.signInAttempt) return;
        if (result.status === 'pending') continue;
        if (result.status === 'slow_down') {
          interval += 5;
          continue;
        }
        if (result.status === 'complete') {
          await this.saveSession({ token: result.token, expiresAt: result.expiresAt });
          this.update({ signIn: signedIn(result.account) });
          await this.refresh();
          return;
        }
        this.update({
          signIn: { state: 'signed-out' },
          error: result.status === 'denied'
            ? { message: 'GitHub sign-in was declined.', next: 'Sign in again and approve Pane Cloud on GitHub.' }
            : { message: 'The GitHub code expired before it was entered.', next: 'Sign in again for a new code.' },
        });
        return;
      } catch (error) {
        this.update({ signIn: { state: 'signed-out' } });
        this.fail(error);
        return;
      }
    }
  }

  private async load(client: ServiceClient): Promise<void> {
    const [account, { machines }] = await Promise.all([client.getAccount(), client.listMachines()]);
    const machine = machines.find((candidate) => candidate.state !== 'deleted') ?? null;
    let view: PaneCloudMachineView | null = null;
    if (machine) {
      const log = await client.listActionLog(machine.id, { limit: RECENT_ACTIONS });
      const profile = machine.tailnet.status === 'joined' && machine.tailnet.hostname ? hostProfile(machine, machine.tailnet.hostname) : null;
      if (profile && JSON.stringify(profile) !== this.savedHost) {
        await this.options.hosts.save(profile);
        this.savedHost = JSON.stringify(profile);
      }
      view = machineView(machine, log.entries, profile?.id ?? null);
    }
    this.update({ signIn: signedIn(account), machine: view });
    this.watchWhile(machine);
  }

  /** Keeps the snapshot moving while a machine exists: fast while it changes or waits to join, slower otherwise. */
  private watchWhile(machine: Machine | null): void {
    if (!machine || this.disposed) {
      this.stopWatching();
      return;
    }
    const waiting = TRANSITIONAL.has(machine.state) || machine.tailnet.status === 'awaiting_login';
    if (this.watchTimer && waiting === this.watchWaiting) return;
    this.stopWatching();
    this.watchWaiting = waiting;
    const poll = this.options.pollMs ?? POLL_MS;
    this.watchTimer = setInterval(() => { void this.refresh({ background: true }); }, waiting ? poll.waiting : poll.steady);
    this.watchTimer.unref?.();
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private client(token?: string): ServiceClient {
    return createServiceClient({ baseUrl: this.options.serviceUrl, token, fetch: this.options.fetch });
  }

  private async signedInClient(): Promise<ServiceClient | null> {
    const session = await this.loadSession();
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    return this.client(session.token);
  }

  private async loadSession(): Promise<StoredSession | null> {
    if (this.session !== undefined) return this.session;
    try {
      this.session = decodeBoundary(JSON.parse(await fs.readFile(this.options.tokenFile, 'utf8')), storedSessionSchema);
    } catch {
      this.session = null;
    }
    return this.session;
  }

  private async saveSession(session: StoredSession | null): Promise<void> {
    this.session = session;
    if (!session) {
      await fs.rm(this.options.tokenFile, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(this.options.tokenFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.tokenFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
    await fs.rename(temporary, this.options.tokenFile);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Callers pass whatever a service call threw; only CloudApiError is read.
  private fail(error: unknown): PaneCloudSnapshot {
    if (error instanceof CloudApiError && error.code === 'unauthenticated') {
      void this.saveSession(null);
      return this.update({ busy: null, signIn: { state: 'signed-out' }, machine: null, error: { message: 'Your Pane Cloud session ended.', next: 'Sign in with GitHub again.' } });
    }
    return this.update({ busy: null, error: describeError(error) });
  }

  private update(changes: Partial<PaneCloudSnapshot>): PaneCloudSnapshot {
    this.state = { ...this.state, ...changes };
    if (!this.disposed) this.options.onChange?.(this.state);
    return this.state;
  }
}

function signedIn(account: { githubLogin: string; name: string | null; access: 'invited' | 'waitlisted' }): PaneCloudSignIn {
  return { state: 'signed-in', githubLogin: account.githubLogin, name: account.name, access: account.access };
}

/** The codeless Tailscale host for a machine that joined the user's tailnet, as Remote Access saves one. */
function hostProfile(machine: Machine, hostname: string): RemotePaneConnectionProfile {
  const [name, ...domain] = hostname.replace(/\.$/, '').split('.');
  const tailnetDomain = domain.join('.');
  return {
    id: tailnetProfileId(tailnetDomain, name),
    label: machine.name,
    baseUrl: `https://${name}.${tailnetDomain}:8443`,
    token: '',
    transport: 'http+sse',
    tailnetMachine: name,
    tailnetDomain,
    paneCloud: { machineId: machine.id },
    hostKind: { label: 'Pane Cloud machine', icon: 'cloud' },
  };
}

const ACTORS = { user: 'you', service: 'Pane Cloud', host: 'the host' } satisfies Record<ActionLogEntry['actor']['kind'], PaneCloudAction['actor']>;

function machineView(machine: Machine, log: ActionLogEntry[], profileId: string | null): PaneCloudMachineView {
  return {
    id: machine.id,
    name: machine.name,
    state: machine.state,
    stateReason: machine.stateReason,
    paneVersion: machine.paneVersion,
    tailnetLoginUrl: machine.tailnet.status === 'awaiting_login' ? machine.tailnet.loginUrl : null,
    tailnetHostname: machine.tailnet.hostname,
    profileId,
    usage: machine.usage && {
      cpuSecondsUsed: machine.usage.cpuSecondsUsed,
      dailyCpuSeconds: MACHINE_LIMITS.dailyCpuSeconds,
      throttled: machine.usage.throttled,
      resetsAt: machine.usage.resetsAt,
    },
    actions: log.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      actor: ACTORS[entry.actor.kind],
      reason: entry.reason,
      status: entry.status,
      error: entry.error?.message ?? null,
      requestedAt: entry.requestedAt,
    })),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Callers pass whatever a service call threw; only CloudApiError is read.
function describeError(error: unknown): PaneCloudError {
  if (error instanceof CloudApiError) return { message: error.message, next: error.next };
  const detail = error instanceof Error ? error.message : String(error);
  return {
    message: `Pane could not reach Pane Cloud (${detail}).`,
    next: 'Check your connection and try again. Your saved hosts and this computer keep working without it.',
  };
}
