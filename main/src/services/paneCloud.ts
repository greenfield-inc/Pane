import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CloudApiError, createServiceClient, PLANS, type Account, type ActionLogEntry, type OrganizationUsage, type ServiceClient, type SessionVm } from 'pane-cloud-contract';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { VouchedPairing } from '../../../shared/types/relay';
import type {
  PaneCloudAction,
  PaneCloudCreated,
  PaneCloudError,
  PaneCloudSession,
  PaneCloudSignIn,
  PaneCloudSnapshot,
  PaneCloudUsage,
} from '../../../shared/types/paneCloud';
import { SIGNED_OUT_PANE_CLOUD } from '../../../shared/types/paneCloud';

/** The Pane Cloud service. PANE_CLOUD_URL points a dev build at a local stub or staging. */
export const DEFAULT_PANE_CLOUD_URL = 'https://cloud.runpane.com';

export interface PaneCloudManagerOptions {
  serviceUrl: string;
  /** Where the service session is kept, 0600. It is Pane Cloud's own token, never a GitHub or agent one. */
  tokenFile: string;
  /** Opens the service's sign-in page in the system browser. */
  openExternal(url: string): void | Promise<void>;
  /** Pairs this desktop with a VM from the link and identity the service vouches for; resolves with the saved computer's id. */
  pair(pairing: VouchedPairing): Promise<string>;
  /** The saved computer this desktop holds for a relay id, or null when it isn't paired. */
  computerFor(relayComputerId: string): string | null;
  /** Creates the Session on the paired VM once it answers, from Create Session's input; resolves with the Session's id there. */
  startSession(machineId: string, input: JsonObject): Promise<string>;
  /** Forgets the saved computer of a deleted VM. */
  forget(machineId: string): Promise<void>;
  onChange?: (snapshot: PaneCloudSnapshot) => void;
  /** Secrets sync (K1) carries this desktop's secrets to new cloud Sessions; the card says so only then. */
  sendsSecrets?: boolean;
  fetch?: typeof fetch;
  /** How often to re-read: while a VM changes state, and otherwise. */
  pollMs?: { waiting: number; steady: number };
}

const POLL_MS = { waiting: 3_000, steady: 60_000 };
/** How long a new VM may take to answer as running before New cloud Session gives up. */
const BOOT_DEADLINE_MS = 3 * 60_000;
const AWAKE = new Set<SessionVm['state']>(['creating', 'starting', 'running']);
const CHANGING = new Set<SessionVm['state']>(['creating', 'starting', 'stopping', 'deleting']);
const UNNAMED = 'Cloud Session';

interface StoredSession {
  token: string;
  expiresAt: string;
}
/** Create Session's name; the rest of its input goes to the VM, which checks it. */
const namedSchema = boundary.object({ name: boundary.string });
const storedSessionSchema: BoundarySchema<StoredSession> = boundary.object({ token: boundary.nonEmptyString, expiresAt: boundary.nonEmptyString });

/**
 * Pane Cloud for desktop Pane: sign-in, one Session VM per cloud Session, and the month's usage, over
 * the service's typed client. A new VM is paired with this desktop over the relay, pinned to the key
 * the service vouches for, and is then a saved computer like any other; the Session is created on it
 * there. The service only ever runs its named operations: Pane has no shell on a VM from here.
 */
export class PaneCloudManager {
  private state: PaneCloudSnapshot = SIGNED_OUT_PANE_CLOUD;
  private session: StoredSession | null | undefined;
  private account: Account | null = null;
  private vms: SessionVm[] = [];
  private signInAttempt = 0;
  /** A background re-read in flight; the next tick waits for it instead of stacking another. */
  private reading = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchWaiting = false;
  private disposed = false;

  constructor(private readonly options: PaneCloudManagerOptions) {
    this.state = { ...SIGNED_OUT_PANE_CLOUD, sendsSecrets: options.sendsSecrets ?? false };
  }

  snapshot(): PaneCloudSnapshot {
    return this.state;
  }

  /** Reads the account, its cloud Sessions and the month's usage. A background re-read keeps the last error on screen. */
  async refresh({ background = false }: { background?: boolean } = {}): Promise<PaneCloudSnapshot> {
    if (background && this.reading) return this.state;
    const session = await this.loadSession();
    if (session && Date.parse(session.expiresAt) <= Date.now()) return this.expire(SIGN_IN_EXPIRED);
    const client = session ? this.client(session.token) : null;
    if (!client) {
      if (this.state.signIn.state === 'pending') return this.state;
      // The last list stays: those cloud Sessions still run. Sign-out clears it on purpose.
      if (background) return this.update({ signIn: { state: 'signed-out' } });
      return this.update({ signIn: { state: 'signed-out' }, error: null });
    }
    const generation = this.signInAttempt;
    this.reading = true;
    try {
      await this.load(client, generation);
      return background ? this.state : this.update({ error: null });
    } catch (error) {
      return this.fail(error);
    } finally {
      this.reading = false;
    }
  }

  /** Opens the service's sign-in page; main polls until the person finishes, declines, or the code expires. */
  async startSignIn(): Promise<PaneCloudSnapshot> {
    const attempt = ++this.signInAttempt;
    try {
      const code = await this.client().startDeviceSignIn();
      // The page opens in the system browser, so only a web address goes: any other scheme could launch a program.
      if (!/^https?:$/.test(new URL(code.verificationUriComplete).protocol)) {
        throw new PaneCloudFailure({ message: 'Pane Cloud sent a sign-in page that is not a web address, so Pane did not open it.', next: 'Try signing in again; if this keeps happening, write to Pane Cloud support.' });
      }
      void this.pollSignIn(attempt, code.deviceCode, code.interval, Date.now() + code.expiresIn * 1000);
      const snapshot = this.update({ signIn: { state: 'pending', userCode: code.userCode, verificationUri: code.verificationUri }, error: null });
      await this.options.openExternal(code.verificationUriComplete);
      return snapshot;
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
    this.forgetAccount();
    return this.update({ ...SIGNED_OUT_PANE_CLOUD, sendsSecrets: this.state.sendsSecrets });
  }

  /**
   * New cloud Session: a VM in the person's organization, paired with this desktop, with the
   * Session created on it. Throws a PaneCloudError-shaped error, also left in the snapshot.
   */
  async createSession(input: JsonObject): Promise<PaneCloudCreated> {
    const name = (decodeOptionalBoundary(input, namedSchema)?.name.trim().slice(0, 64) ?? '') || UNNAMED;
    let made: { client: ServiceClient; vmId: string; machineId: string | null } | null = null;
    try {
      const { client, account } = await this.readyToCreate();
      this.update({ creating: { name, step: 'creating' }, error: null });
      const organizationId = personalOrganization(account);
      const { vm } = await client.createVm(organizationId, name, randomUUID());
      made = { client, vmId: vm.id, machineId: null };
      await this.load(client);
      await this.waitUntilRunning(client, vm.id);

      this.update({ creating: { name, step: 'pairing' } });
      const pairing = await client.pairVm(vm.id);
      const machineId = await this.options.pair({ link: pairing.link, relay: pairing.relay });
      made.machineId = machineId;
      await this.load(client);

      this.update({ creating: { name, step: 'starting-session' } });
      const sessionId = await this.options.startSession(machineId, input);
      return { machineId, sessionId, snapshot: this.update({ creating: null }) };
    } catch (error) {
      // A VM without its Session would count toward the awake limit with nothing on it, so it goes.
      if (made) await this.discard(made).catch((cleanup) => console.warn('[PaneCloud] Could not delete the half-made cloud Session:', cleanup));
      const snapshot = await this.fail(error);
      this.update({ creating: null });
      throw snapshot.error ? new PaneCloudFailure(snapshot.error) : error;
    }
  }

  private async discard({ client, vmId, machineId }: { client: ServiceClient; vmId: string; machineId: string | null }): Promise<void> {
    if (machineId) await this.options.forget(machineId);
    await client.deleteVm(vmId);
    await this.load(client);
  }

  stop(vmId: string): Promise<PaneCloudSnapshot> {
    return this.act(vmId, (client) => client.stopVm(vmId));
  }

  start(vmId: string): Promise<PaneCloudSnapshot> {
    return this.act(vmId, (client) => client.startVm(vmId));
  }

  /** Deletes the VM with its disk, and forgets the computer this desktop saved for it. */
  remove(vmId: string): Promise<PaneCloudSnapshot> {
    const machineId = this.state.sessions.find((session) => session.vmId === vmId)?.machineId ?? null;
    return this.act(vmId, async (client) => {
      await client.deleteVm(vmId);
      if (machineId) await this.options.forget(machineId);
    });
  }

  /** Installs the latest published Pane release on the VM; the service pins its checksum. */
  updatePane(vmId: string): Promise<PaneCloudSnapshot> {
    return this.act(vmId, (client) => client.requestOperation(vmId, { operation: 'update_pane', parameters: {} }));
  }

  /** The VM's action log, newest first: every lifecycle step and operation, with who asked and why (D-6). */
  async actions(vmId: string): Promise<PaneCloudAction[]> {
    const client = await this.signedInClient();
    if (!client) throw new PaneCloudFailure(SIGNED_OUT_ERROR);
    const { entries } = await client.listActionLog(vmId, { limit: 50 });
    return entries.map(actionView);
  }

  dispose(): void {
    this.disposed = true;
    this.signInAttempt += 1;
    this.stopWatching();
  }

  private async readyToCreate(): Promise<{ client: ServiceClient; account: Account }> {
    const client = await this.signedInClient();
    if (!client) throw new PaneCloudFailure(SIGNED_OUT_ERROR);
    const account = await client.getAccount();
    this.account = account;
    if (account.access === 'waitlisted') {
      throw new PaneCloudFailure({ message: "You're on the list. Pane Cloud is invite-only for now, so you can't create a cloud Session yet.", next: 'Your invite arrives by email; create one then.' });
    }
    if (account.signupState !== 'ready') {
      throw new PaneCloudFailure({
        message: 'Your Pane Cloud sign-up is not finished, so no cloud Session was created.',
        next: account.signupState === 'needs_phone' ? 'Verify your mobile number on the Pane Cloud sign-up page, then try again.' : 'Add a card on the Pane Cloud sign-up page ($0 check), then try again.',
      });
    }
    return { client, account };
  }

  private async waitUntilRunning(client: ServiceClient, vmId: string): Promise<void> {
    const deadline = Date.now() + BOOT_DEADLINE_MS;
    const poll = this.options.pollMs ?? POLL_MS;
    for (;;) {
      const vm = await client.getVm(vmId);
      if (vm.state === 'running') return;
      if (!AWAKE.has(vm.state) || Date.now() > deadline) {
        throw new PaneCloudFailure({
          message: `The cloud Session did not start (it is ${vm.state}).`,
          next: 'Try New cloud Session again; if it keeps failing, write to Pane Cloud support.',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, poll.waiting));
    }
  }

  private async act(vmId: string, run: (client: ServiceClient) => Promise<object | void>): Promise<PaneCloudSnapshot> {
    const client = await this.signedInClient();
    if (!client) return this.update({ error: SIGNED_OUT_ERROR });
    this.update({ busy: [...this.state.busy, vmId], error: null });
    try {
      await run(client);
      await this.load(client);
      return this.update({ busy: this.state.busy.filter((id) => id !== vmId) });
    } catch (error) {
      await this.load(client).catch(() => undefined);
      this.update({ busy: this.state.busy.filter((id) => id !== vmId) });
      return this.fail(error);
    }
  }

  private async pollSignIn(attempt: number, deviceCode: string, intervalSeconds: number, expiresAt: number): Promise<void> {
    let interval = intervalSeconds;
    while (attempt === this.signInAttempt && !this.disposed) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      if (attempt !== this.signInAttempt || this.disposed) return;
      try {
        const result = await this.client().pollDeviceSignIn(deviceCode);
        if (attempt !== this.signInAttempt) return;
        if (result.status === 'pending' && Date.now() < expiresAt) continue;
        if (result.status === 'slow_down') {
          interval += 5;
          continue;
        }
        if (result.status === 'complete') {
          await this.saveSession({ token: result.token, expiresAt: result.expiresAt });
          this.account = result.account;
          this.update({ signIn: this.signedIn(result.account) });
          await this.refresh();
          return;
        }
        this.update({
          signIn: { state: 'signed-out' },
          error: result.status === 'denied'
            ? { message: 'Pane Cloud sign-in was declined.', next: 'Sign in again and approve Pane on the Pane Cloud page.' }
            : { message: 'The Pane Cloud sign-in page expired before you finished.', next: 'Sign in again for a new page.' },
        });
        return;
      } catch (error) {
        this.update({ signIn: { state: 'signed-out' } });
        await this.fail(error);
        return;
      }
    }
  }

  /** Reads the account, its VMs and usage. A read that started before a sign-out or new sign-in writes nothing. */
  private async load(client: ServiceClient, generation = this.signInAttempt): Promise<void> {
    const account = await client.getAccount();
    const organizationId = personalOrganization(account);
    const [{ vms }, usage] = await Promise.all([client.listVms(organizationId), client.getUsage(organizationId)]);
    if (generation !== this.signInAttempt) return;
    this.account = account;
    this.vms = vms;
    this.update({ signIn: this.signedIn(account), sessions: vms.map((vm) => this.sessionView(vm)), usage: usageView(usage, account) });
    this.watchWhile(account, vms);
  }

  private sessionView(vm: SessionVm): PaneCloudSession {
    return {
      vmId: vm.id,
      name: vm.name,
      awake: AWAKE.has(vm.state),
      underReview: vm.stateReason === 'review',
      machineId: vm.relay ? this.options.computerFor(vm.relay.computerId) : null,
      paneVersion: vm.paneVersion,
      createdAt: vm.createdAt,
    };
  }

  private signedIn(account: Account): PaneCloudSignIn {
    return {
      state: 'signed-in',
      email: account.email,
      name: account.name,
      access: account.access,
      signupState: account.signupState,
      signupUrl: new URL('/signup', this.options.serviceUrl).toString(),
      organizationId: personalOrganization(account),
    };
  }

  /**
   * Re-reads while the account has cloud Sessions: quickly while a VM changes state, slowly otherwise
   * (the service may pause one for review). An account with none is read only when a view opens.
   */
  private watchWhile(account: Account, vms: SessionVm[]): void {
    if (this.disposed || account.access !== 'invited' || vms.length === 0) {
      this.stopWatching();
      return;
    }
    const waiting = vms.some((vm) => CHANGING.has(vm.state));
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

  private forgetAccount(): void {
    this.account = null;
    this.vms = [];
    this.stopWatching();
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

  /**
   * Signed out by the service or by time. The cloud Sessions keep running and stay reachable as saved
   * computers, so the last list stays on screen; only the service calls wait for a new sign-in.
   */
  private async expire(error: PaneCloudError): Promise<PaneCloudSnapshot> {
    await this.saveSession(null);
    this.account = null;
    this.stopWatching();
    return this.update({ signIn: { state: 'signed-out' }, usage: null, busy: [], error });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Callers pass whatever a service call threw; only CloudApiError and PaneCloudFailure are read.
  private async fail(error: unknown): Promise<PaneCloudSnapshot> {
    if (error instanceof CloudApiError && error.code === 'unauthenticated') return this.expire(SESSION_ENDED);
    // Signed in, but nothing read yet: the service is down, which is not a sign-out.
    if (this.session && this.state.signIn.state === 'signed-out') return this.update({ signIn: { state: 'unavailable' }, error: describeError(error) });
    return this.update({ error: describeError(error) });
  }

  private update(changes: Partial<PaneCloudSnapshot>): PaneCloudSnapshot {
    this.state = { ...this.state, ...changes };
    if (!this.disposed) this.options.onChange?.(this.state);
    return this.state;
  }
}

/** A Pane Cloud failure with its next step, thrown to the caller of createSession. */
export class PaneCloudFailure extends Error {
  readonly next: string | null;
  readonly code: string | undefined;

  constructor(error: PaneCloudError) {
    super(error.message);
    this.name = 'PaneCloudFailure';
    this.next = error.next;
    this.code = error.code;
  }
}

const SIGNED_OUT_ERROR: PaneCloudError = { message: 'You are not signed in to Pane Cloud.', next: 'Sign in to Pane Cloud, then try again.' };
const SESSION_ENDED: PaneCloudError = { message: 'Your Pane Cloud session ended.', next: 'Sign in to Pane Cloud again. Your cloud Sessions keep running.' };
const SIGN_IN_EXPIRED: PaneCloudError = { message: 'Your Pane Cloud sign-in expired.', next: 'Sign in to Pane Cloud again. Your cloud Sessions keep running.' };

/** The organization cloud Sessions go in. The slice has personal organizations only (O1). */
function personalOrganization(account: Account): string {
  return (account.organizations.find((membership) => membership.personal) ?? account.organizations[0]).organizationId;
}

function usageView(usage: OrganizationUsage, account: Account): PaneCloudUsage {
  const you = usage.members.find((member) => member.accountId === account.id);
  return {
    plan: usage.plan,
    planAgentHours: PLANS[usage.plan].agentHoursPerMember,
    planAwakeLimit: PLANS[usage.plan].awakeLimitPerMember,
    resetsAt: usage.resetsAt,
    agentHoursUsed: usage.agentHours.used,
    agentHoursLimit: usage.agentHours.limit,
    awakeNow: you?.awakeNow ?? 0,
    awakeLimit: you?.awakeLimit ?? 0,
    members: usage.members.map((member) => ({
      accountId: member.accountId,
      name: member.name,
      you: member.accountId === account.id,
      agentHours: member.agentHoursUsed,
      awakeNow: member.awakeNow,
      awakeLimit: member.awakeLimit,
    })),
  };
}

const ACTORS = { user: 'you', service: 'Pane Cloud', host: 'the host' } satisfies Record<ActionLogEntry['actor']['kind'], PaneCloudAction['actor']>;

function actionView(entry: ActionLogEntry): PaneCloudAction {
  return {
    id: entry.id,
    operation: entry.operation,
    actor: ACTORS[entry.actor.kind],
    reason: entry.reason,
    failed: entry.status === 'failed',
    error: entry.error?.message ?? null,
    requestedAt: entry.requestedAt,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Callers pass whatever a service call threw; only CloudApiError and PaneCloudFailure are read.
function describeError(error: unknown): PaneCloudError {
  if (error instanceof CloudApiError) return { message: error.message, next: error.next, code: error.code };
  if (error instanceof PaneCloudFailure) return { message: error.message, next: error.next, code: error.code };
  // Pairing and creating the Session run on this computer and on the VM, not on the service.
  if (error instanceof PaneError) return { message: error.message, next: error.next ?? null, code: error.code };
  const detail = error instanceof Error ? error.message : String(error);
  return {
    message: `Pane could not reach Pane Cloud (${detail}).`,
    next: 'Check your connection and try again. Your other machines and this computer keep working without it.',
  };
}
