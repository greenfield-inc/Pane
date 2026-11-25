import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretKey,
  SECRET_LEASE_DEFAULT_MS,
  SECRET_LEASE_MAX_MS,
  SECRET_LEASE_MIN_MS,
  SECRET_LEASE_REMINDER_MS,
  type PaneLoginUse,
  type SecretLeaseMachine,
  type SecretLeaseOnMachine,
  type SecretLeaseStartResult,
  type SecretLeaseSummary,
} from '../../../shared/types/paneSecrets';
import type { AppConfig } from '../types/config';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { OnePassword } from './onePassword';
import { decodeLogin, encodeLogin, loginUsesSchema } from './paneLogins';
import type { PaneSecretStore } from './paneSecrets';
import { MAX_TIMER_MS, type SecretLeaseGrant, type SecretLeaseRecord, type SecretLeaseStore } from './secretLeases';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';

const LIST_TIMEOUT_MS = 3_000;

/** A saved machine the desktop holds a connection to. */
export interface LeaseMachineLink {
  id: string;
  name: string;
  online: boolean;
  invoke(channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue>;
}


/** What a machine answers to `secrets:lease:list`. */
export interface HostLeaseList {
  leases: SecretLeaseSummary[];
  memoryOnly: boolean;
  /** Why this machine refuses leases, or null. */
  refusal: string | null;
  /** The newest uses of saved logins there; absent on a machine from before logins. */
  loginUses?: PaneLoginUse[];
}

const leaseSummarySchema = boundary.object({
  id: boundary.nonEmptyString,
  project: boundary.string,
  names: boundary.array(boundary.string),
  grantedAt: boundary.string,
  expiresAt: boundary.string,
  requestedBy: boundary.string,
  grantedOn: boundary.string,
  memoryOnly: boundary.boolean,
});
const hostLeaseListSchema = boundary.object({
  leases: boundary.array(leaseSummarySchema),
  memoryOnly: boundary.boolean,
  refusal: boundary.nullable(boundary.string),
  loginUses: boundary.optional(loginUsesSchema),
});

/** The push a desktop sends a machine: values and time remaining, never an absolute expiry. */
export const leasePushSchema = boundary.object({
  id: boundary.nonEmptyString,
  project: boundary.string,
  secrets: boundary.array(boundary.object({ name: boundary.string, reference: boundary.string, value: boundary.string })),
  /** Leased logins, their sites stored in `login`. A field of its own, so a machine from before logins never takes one as a plain secret. */
  logins: boundary.optional(boundary.array(boundary.object({ name: boundary.string, reference: boundary.string, login: boundary.string }))),
  expiresInMs: boundary.number,
  requestedBy: boundary.string,
  grantedOn: boundary.string,
});
/** What a push asks the receiving machine to store. Throws when a login in it is not one Pane wrote. */
export function pushedSecrets(push: ReturnType<typeof leasePushSchema['decode']>): SecretLeaseGrant['secrets'] {
  const logins = (push.logins ?? []).map(({ name, reference, login }) => {
    const stored = decodeLogin(login);
    if (!stored) throw new PaneError('SECRET_INVALID', 'A login in the lease is malformed. Nothing was stored.', 'Update Pane on both machines, then start the lease again.');
    return { name, reference, ...stored };
  });
  return [...push.secrets, ...logins];
}
export const leaseEndSchema = boundary.object({ id: boundary.nonEmptyString });

/** Why this machine can't take a lease: teammates on "Everyone on tailnet" run as the owner and could use it. */
export function hostLeaseRefusal(config: AppConfig): string | null {
  return config.workspaces?.visibility === 'tailnet'
    ? 'it is shared with everyone on the tailnet, whose commands there run as you'
    : null;
}

export function leaseRefused(machine: string, reason: string): PaneError {
  return new PaneError('SECRET_LEASE_REFUSED', `${machine} refused the lease: ${reason}. Nothing was stored there.`, 'Set that machine to "Only me" in Settings → Workspaces, or lease without it.');
}

/** Why a machine took no lease. A host too old for leases answers ERR_UNKNOWN_CHANNEL. */
function pushFailure(machine: string, error: Error): string {
  const code = 'code' in error ? String(error.code) : '';
  if (code === 'ERR_UNKNOWN_CHANNEL' || /unknown (command|channel)/i.test(error.message)) return `Pane on ${machine} needs an update for leases`;
  if (error instanceof PaneError && error.code === 'SECRET_LEASE_REFUSED') return error.message;
  return reasonOf(error);
}

export interface SecretLeaseServiceDeps {
  store: SecretLeaseStore;
  secrets: () => PaneSecretStore;
  onePassword: () => OnePassword;
  config: () => AppConfig;
  updateConfig: (update: (config: AppConfig) => Partial<AppConfig>) => Promise<AppConfig>;
  machines: () => LeaseMachineLink[];
  hostLabel: () => string;
  now?: () => number;
  /** Test builds only: a short lease length and reminder, so expiry and renewal run in minutes. */
  testTiming?: () => { lengthMs?: number; reminderMs?: number };
  /** Posts the "Extend" card for a lease about to end. */
  postReminder?: (lease: SecretLeaseRecord) => void;
  /** Closes that card once the lease renewed or ended without it. */
  closeReminder?: (leaseId: string) => void;
}

export interface SecretLeaseStart {
  project: string;
  names: string[];
  /** Saved machine ids to push to; this desktop always holds the lease it grants. */
  machines: string[];
  requestedBy: string;
  /** Renews this lease: same id, new values and expiry, pushed where it went before. */
  renews?: string;
  /** The length the person saw and approved on the card. Absent: the project's length now. */
  lengthMs?: number;
  /** Started from the Extend card itself: that card ends with its own answer, so it isn't closed here. */
  fromReminder?: boolean;
}

/**
 * Starts, pushes, renews and ends leases from the desktop. The desktop always keeps the lease it
 * grants, so it can renew it, end it everywhere, and push it again to a machine that lost it.
 */
export class SecretLeaseService {
  private reminderTimer: NodeJS.Timeout | null = null;
  private readonly reminded = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: SecretLeaseServiceDeps) {
    this.now = deps.now ?? Date.now;
    // A lease that ran out takes its Extend card with it.
    deps.store.onEnded(ids => {
      for (const id of ids) {
        this.reminded.delete(id);
        this.deps.closeReminder?.(id);
      }
    });
  }

  /** The project's lease length, or the test length in a test build. */
  lengthFor(project: string): number {
    const test = this.deps.testTiming?.().lengthMs;
    if (test) return test;
    return this.deps.config().secretLeaseLengths?.[project] ?? SECRET_LEASE_DEFAULT_MS;
  }

  /** How long before its end lease `lease` is reminded: an hour, or a quarter of a shorter lease, so a new one never reminds at once. */
  private reminderMs(lease: SecretLeaseSummary): number {
    const window = this.deps.testTiming?.().reminderMs ?? SECRET_LEASE_REMINDER_MS;
    return Math.min(window, (Date.parse(lease.expiresAt) - Date.parse(lease.grantedAt)) / 4);
  }

  async setLength(project: string, lengthMs: number): Promise<void> {
    if (!Number.isFinite(lengthMs) || lengthMs < SECRET_LEASE_MIN_MS || lengthMs > SECRET_LEASE_MAX_MS) {
      throw new PaneError('SECRET_INVALID', 'A lease lasts from 1 hour to 7 days. Nothing was changed.', 'Pick a length in that range.');
    }
    await this.deps.updateConfig(config => ({ secretLeaseLengths: { ...config.secretLeaseLengths, [project]: lengthMs } }));
  }

  /** Each name's 1Password reference on this desktop. Throws for a name that isn't one. */
  private referencesOf(project: string, names: readonly string[]): string[] {
    if (names.length === 0) throw new PaneError('SECRET_INVALID', 'A lease needs at least one secret. Nothing was leased.', 'Name the secrets to lease.');
    return names.map(name => {
      const reference = this.deps.secrets().referenceOf(project, name);
      if (!reference) {
        throw new PaneError(
          'SECRET_NOT_REFERENCE',
          `${paneSecretKey(project, name)} is not a 1Password reference on this computer, so it can't be leased. Nothing was leased.`,
          'Add it in Settings → Secrets with Add from 1Password, then start the lease again.',
        );
      }
      return reference;
    });
  }

  /**
   * Reads every reference in one 1Password call (one prompt), stores the lease here and pushes it to
   * each machine named. A machine that refuses or can't be reached is listed, and gets nothing.
   */
  async start(request: SecretLeaseStart): Promise<SecretLeaseStartResult> {
    const ownRefusal = hostLeaseRefusal(this.deps.config());
    if (ownRefusal) throw leaseRefused('This computer', ownRefusal);
    const references = this.referencesOf(request.project, request.names);
    const previous = request.renews ? this.deps.store.get(request.renews) : null;
    if (request.renews && !previous) {
      throw new PaneError('SECRET_LEASE_ENDED', 'That lease already ended, so it can\'t be extended. Nothing was read.', 'Start a new lease from Settings → Secrets, or ask the agent to run its lease command again.');
    }
    const targets = request.renews ? previous?.pushedTo ?? [] : request.machines.filter(id => id !== LOCAL_MACHINE_ID);
    const values = await this.deps.onePassword().read(references);
    const secrets = request.names.map((name, index): SecretLeaseGrant['secrets'][number] => {
      const sites = this.deps.secrets().sitesOf(request.project, name);
      const secret = { name, reference: references[index], value: values[index] };
      return sites ? { ...secret, sites } : secret;
    });
    const lengthMs = request.lengthMs ?? this.lengthFor(request.project);
    const lease = await this.deps.store.grant({
      id: request.renews,
      project: request.project,
      secrets,
      expiresInMs: lengthMs,
      // A renewal keeps who first asked; the Extend card itself is Pane's.
      requestedBy: previous?.requestedBy ?? request.requestedBy,
      grantedOn: this.deps.hostLabel(),
    });
    const { pushed, refused } = await this.pushTo(targets, lease.id);
    // A renewal keeps every machine it went to before: one asleep now gets the new expiry when it reconnects.
    await this.deps.store.setPushedTo(lease.id, [...new Set([...(previous?.pushedTo ?? []), ...pushed.map(machine => machine.id)])]);
    this.reminded.delete(lease.id);
    if (!request.fromReminder) this.deps.closeReminder?.(lease.id);
    this.armReminders();
    return { leaseId: lease.id, expiresAt: lease.expiresAt, machines: [this.deps.hostLabel(), ...pushed.map(machine => machine.name)], refused };
  }

  /** Sends lease `id`, with its time remaining, to each machine in `ids`. */
  private async pushTo(ids: readonly string[], id: string): Promise<{ pushed: LeaseMachineLink[]; refused: Array<{ machine: string; reason: string }> }> {
    const lease = this.deps.store.get(id);
    const links = this.deps.machines();
    const pushed: LeaseMachineLink[] = [];
    const refused: Array<{ machine: string; reason: string }> = [];
    if (!lease) return { pushed, refused };
    const secrets: Array<{ name: string; reference: string; value: string }> = [];
    const logins: Array<{ name: string; reference: string; login: string }> = [];
    for (const { name, reference, login } of lease.secrets) {
      const stored = login ? await this.deps.store.readLogin(lease.project, name) : null;
      if (stored) logins.push({ name, reference, login: encodeLogin(stored) });
      else secrets.push({ name, reference, value: await this.deps.store.read(lease.project, name) });
    }
    await Promise.all(ids.map(async machineId => {
      const link = links.find(candidate => candidate.id === machineId);
      if (!link) {
        refused.push({ machine: machineId, reason: 'this computer has no saved machine by that id' });
        return;
      }
      if (!link.online) {
        refused.push({ machine: link.name, reason: `${link.name} is offline` });
        return;
      }
      try {
        await link.invoke('secrets:lease:push', [{
          id,
          project: lease.project,
          secrets,
          ...(logins.length > 0 ? { logins } : {}),
          expiresInMs: Date.parse(lease.expiresAt) - this.now(),
          requestedBy: lease.requestedBy,
          grantedOn: lease.grantedOn,
        }]);
        pushed.push(link);
        await this.deps.store.notePushed(id, link.id);
      } catch (error) {
        refused.push({ machine: link.name, reason: pushFailure(link.name, error instanceof Error ? error : new Error(String(error))) });
      }
    }));
    return { pushed, refused };
  }

  /** Ends lease `id` here and asks every online machine to end it. An offline machine ends it at its own expiry. */
  async end(id: string): Promise<boolean> {
    const ended = await this.deps.store.end(id);
    await Promise.all(this.deps.machines().filter(link => link.online).map(link => (
      link.invoke('secrets:lease:end', [{ id }]).catch(() => undefined)
    )));
    this.reminded.delete(id);
    this.deps.closeReminder?.(id);
    this.armReminders();
    return ended;
  }

  async endAll(): Promise<number> {
    const ids = new Set(this.deps.store.list().map(lease => lease.id));
    for (const { leases } of (await this.remoteLists()).values()) for (const lease of leases) ids.add(lease.id);
    for (const id of ids) await this.end(id);
    return ids.size;
  }

  /** Each online machine's leases. A machine that doesn't answer within LIST_TIMEOUT_MS lists none, so one slow host never holds up Settings. */
  private async remoteLists(): Promise<Map<string, HostLeaseList>> {
    const lists = new Map<string, HostLeaseList>();
    await Promise.all(this.deps.machines().filter(link => link.online).map(async link => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const answer = await Promise.race([
          link.invoke('secrets:lease:list', []),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), LIST_TIMEOUT_MS); }),
        ]);
        lists.set(link.id, decodeBoundary(answer, hostLeaseListSchema));
      } catch {
        // A machine too old for leases, or one that stopped answering, lists none.
      } finally {
        clearTimeout(timer);
      }
    }));
    return lists;
  }

  /** Leases on this desktop and on each machine that answers, and the machines a lease can go to. */
  async overview(): Promise<{ leases: SecretLeaseOnMachine[]; machines: SecretLeaseMachine[]; loginUses: PaneLoginUse[] }> {
    const label = this.deps.hostLabel();
    const ownRefusal = hostLeaseRefusal(this.deps.config());
    const leases: SecretLeaseOnMachine[] = this.deps.store.list().map(lease => ({ ...lease, machineId: LOCAL_MACHINE_ID, machine: label }));
    const machines: SecretLeaseMachine[] = [{ id: LOCAL_MACHINE_ID, name: label, online: true, refusal: ownRefusal, memoryOnly: this.deps.store.memoryOnly() }];
    const lists = await this.remoteLists();
    const loginUses: PaneLoginUse[] = [];
    for (const link of this.deps.machines()) {
      const list = lists.get(link.id);
      for (const lease of list?.leases ?? []) leases.push({ ...lease, machineId: link.id, machine: link.name });
      for (const use of list?.loginUses ?? []) loginUses.push({ ...use, machine: link.name });
      const refusal = !link.online
        ? `${link.name} is offline`
        : list ? list.refusal : `Pane on ${link.name} needs an update for leases`;
      machines.push({ id: link.id, name: link.name, online: link.online, refusal, memoryOnly: list?.memoryOnly ?? false });
    }
    leases.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    return { leases, machines, loginUses };
  }

  /**
   * A machine reconnected: push it each of this desktop's leases it missed. A memory-only machine
   * that restarted lost them; any machine may have slept through a renewal, still holding the old
   * end or having already swept it at that end. A lease an agent ended there on purpose (gone before
   * the end it was last sent) stays ended.
   */
  async repushTo(machineId: string): Promise<void> {
    try {
      const due = this.deps.store.list().filter(lease => this.deps.store.get(lease.id)?.pushedTo?.includes(machineId));
      if (due.length === 0) return;
      const link = this.deps.machines().find(candidate => candidate.id === machineId);
      if (!link?.online) return;
      const list = decodeBoundary(await link.invoke('secrets:lease:list', []), hostLeaseListSchema);
      const held = new Map(list.leases.map(lease => [lease.id, Date.parse(lease.expiresAt)]));
      for (const lease of due) {
        const ends = Date.parse(lease.expiresAt);
        const there = held.get(lease.id);
        const lastSent = this.deps.store.get(lease.id)?.pushedUntil?.[machineId];
        // Gone from a machine that keeps leases at rest: it swept the old end if that end has passed.
        const sweptOldEnd = lastSent !== undefined && Date.parse(lastSent) <= this.now() && Date.parse(lastSent) < ends - 60_000;
        const missedRenewal = there !== undefined ? there < ends - 60_000 : sweptOldEnd;
        if (!missedRenewal && (there !== undefined || !list.memoryOnly)) continue;
        const { refused } = await this.pushTo([machineId], lease.id);
        if (refused.length > 0) console.warn(`[SecretLeases] Could not push lease ${lease.id} again to ${link.name}: ${refused[0].reason}`);
      }
    } catch (error) {
      console.warn(`[SecretLeases] Could not check the leases on a reconnected machine: ${reasonOf(error)}`);
    }
  }

  /**
   * A saved machine is being removed: end the leases pushed to it while it can still be told, and
   * forget it. Returns how many leases it may still hold until they expire there (it was offline).
   */
  async releaseMachine(machineId: string): Promise<number> {
    const held = this.deps.store.list().filter(lease => this.deps.store.get(lease.id)?.pushedTo?.includes(machineId));
    if (held.length === 0) return 0;
    const link = this.deps.machines().find(candidate => candidate.id === machineId);
    let ended = false;
    if (link?.online) {
      try {
        await Promise.all(held.map(lease => link.invoke('secrets:lease:end', [{ id: lease.id }])));
        ended = true;
      } catch (error) {
        console.warn(`[SecretLeases] Could not end leases on a machine being removed: ${reasonOf(error)}`);
      }
    }
    for (const lease of held) {
      await this.deps.store.setPushedTo(lease.id, (this.deps.store.get(lease.id)?.pushedTo ?? []).filter(id => id !== machineId));
    }
    return ended ? 0 : held.length;
  }

  /** Arms the timer for the next lease to reach its reminder point. */
  armReminders(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    const pending = this.deps.store.list().filter(lease => !this.reminded.has(lease.id));
    if (pending.length === 0) return;
    const next = Math.min(...pending.map(lease => Date.parse(lease.expiresAt) - this.reminderMs(lease)));
    this.reminderTimer = setTimeout(() => { this.remindDue(); }, Math.min(Math.max(next - this.now(), 0), MAX_TIMER_MS));
    this.reminderTimer.unref?.();
  }

  /**
   * At a lease's reminder point, post its Extend card. Renewal always goes through the person:
   * Pane never reads 1Password on a timer (silent renewal waits on a real 1Password test, D-132).
   */
  private remindDue(): void {
    const due = this.deps.store.list().filter(lease => !this.reminded.has(lease.id) && Date.parse(lease.expiresAt) - this.reminderMs(lease) <= this.now());
    for (const summary of due) {
      this.reminded.add(summary.id);
      const lease = this.deps.store.get(summary.id);
      if (lease) this.deps.postReminder?.(lease);
    }
    this.armReminders();
  }

  dispose(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
  }
}
