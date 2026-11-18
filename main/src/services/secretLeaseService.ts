import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretKey,
  SECRET_LEASE_DEFAULT_MS,
  SECRET_LEASE_MAX_MS,
  SECRET_LEASE_MIN_MS,
  SECRET_LEASE_REMINDER_MS,
  type SecretLeaseMachine,
  type SecretLeaseOnMachine,
  type SecretLeaseStartResult,
  type SecretLeaseSummary,
} from '../../../shared/types/paneSecrets';
import type { AppConfig } from '../types/config';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { OnePassword } from './onePassword';
import type { PaneSecretStore } from './paneSecrets';
import type { SecretLeaseRecord, SecretLeaseStore } from './secretLeases';

/** A saved machine the desktop holds a connection to. */
export interface LeaseMachineLink {
  id: string;
  name: string;
  online: boolean;
  invoke(channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue>;
}

/** The desktop's own id in machine lists. */
export const LOCAL_LEASE_MACHINE = 'local';

/** What a machine answers to `secrets:lease:list`. */
export interface HostLeaseList {
  leases: SecretLeaseSummary[];
  memoryOnly: boolean;
  /** Why this machine refuses leases, or null. */
  refusal: string | null;
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
});

/** The push a desktop sends a machine: values and time remaining, never an absolute expiry. */
export const leasePushSchema = boundary.object({
  id: boundary.nonEmptyString,
  project: boundary.string,
  secrets: boundary.array(boundary.object({ name: boundary.string, reference: boundary.string, value: boundary.string })),
  expiresInMs: boundary.number,
  requestedBy: boundary.string,
  grantedOn: boundary.string,
});
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
  /** Whether 1Password would answer a read now without asking the person. Absent: never known, so renewal is the card. */
  approvalLive?: () => Promise<boolean>;
  /** Posts the "Extend" card for a lease about to end. */
  postReminder?: (lease: SecretLeaseRecord, lengthMs: number) => void;
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
  }

  /** The project's lease length, or the test length in a test build. */
  lengthFor(project: string): number {
    const test = this.deps.testTiming?.().lengthMs;
    if (test) return test;
    return this.deps.config().secretLeaseLengths?.[project] ?? SECRET_LEASE_DEFAULT_MS;
  }

  private reminderMs(): number {
    return this.deps.testTiming?.().reminderMs ?? SECRET_LEASE_REMINDER_MS;
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
    const targets = request.renews ? previous?.pushedTo ?? [] : request.machines.filter(id => id !== LOCAL_LEASE_MACHINE);
    const values = await this.deps.onePassword().read(references);
    const secrets = request.names.map((name, index) => ({ name, reference: references[index], value: values[index] }));
    const lengthMs = this.lengthFor(request.project);
    const lease = await this.deps.store.grant({
      id: request.renews,
      project: request.project,
      secrets,
      expiresInMs: lengthMs,
      requestedBy: request.requestedBy,
      grantedOn: this.deps.hostLabel(),
    });
    const { pushed, refused } = await this.pushTo(targets, lease.id);
    await this.deps.store.setPushedTo(lease.id, pushed.map(machine => machine.id));
    this.reminded.delete(lease.id);
    this.deps.closeReminder?.(lease.id);
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
    const secrets = await Promise.all(lease.secrets.map(async secret => ({ ...secret, value: await this.deps.store.read(lease.project, secret.name) })));
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
          expiresInMs: Date.parse(lease.expiresAt) - this.now(),
          requestedBy: lease.requestedBy,
          grantedOn: lease.grantedOn,
        }]);
        pushed.push(link);
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

  private async remoteLists(): Promise<Map<string, HostLeaseList>> {
    const lists = new Map<string, HostLeaseList>();
    await Promise.all(this.deps.machines().filter(link => link.online).map(async link => {
      try {
        lists.set(link.id, decodeBoundary(await link.invoke('secrets:lease:list', []), hostLeaseListSchema));
      } catch {
        // A machine too old for leases, or one that stopped answering, lists none.
      }
    }));
    return lists;
  }

  /** Leases on this desktop and on each machine that answers, and the machines a lease can go to. */
  async overview(): Promise<{ leases: SecretLeaseOnMachine[]; machines: SecretLeaseMachine[] }> {
    const label = this.deps.hostLabel();
    const ownRefusal = hostLeaseRefusal(this.deps.config());
    const leases: SecretLeaseOnMachine[] = this.deps.store.list().map(lease => ({ ...lease, machineId: LOCAL_LEASE_MACHINE, machine: label }));
    const machines: SecretLeaseMachine[] = [{ id: LOCAL_LEASE_MACHINE, name: label, online: true, refusal: ownRefusal, memoryOnly: this.deps.store.memoryOnly() }];
    const lists = await this.remoteLists();
    for (const link of this.deps.machines()) {
      const list = lists.get(link.id);
      for (const lease of list?.leases ?? []) leases.push({ ...lease, machineId: link.id, machine: link.name });
      const refusal = !link.online
        ? `${link.name} is offline`
        : list ? list.refusal : `Pane on ${link.name} needs an update for leases`;
      machines.push({ id: link.id, name: link.name, online: link.online, refusal, memoryOnly: list?.memoryOnly ?? false });
    }
    leases.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    return { leases, machines };
  }

  /**
   * A machine reconnected: push each of this desktop's leases it should hold but doesn't (a
   * memory-only machine that restarted), with the time remaining.
   */
  async repushTo(machineId: string): Promise<void> {
    const due = this.deps.store.list().filter(lease => this.deps.store.get(lease.id)?.pushedTo?.includes(machineId));
    if (due.length === 0) return;
    const link = this.deps.machines().find(candidate => candidate.id === machineId);
    if (!link?.online) return;
    let held: Set<string>;
    try {
      held = new Set(decodeBoundary(await link.invoke('secrets:lease:list', []), hostLeaseListSchema).leases.map(lease => lease.id));
    } catch {
      return;
    }
    for (const lease of due) {
      if (held.has(lease.id)) continue;
      const { refused } = await this.pushTo([machineId], lease.id);
      if (refused.length > 0) console.warn(`[SecretLeases] Could not push lease ${lease.id} again to ${link.name}: ${refused[0].reason}`);
    }
  }

  /** Arms the timer for the next lease to reach its reminder point. */
  armReminders(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    const pending = this.deps.store.list().filter(lease => !this.reminded.has(lease.id));
    if (pending.length === 0) return;
    const next = Math.min(...pending.map(lease => Date.parse(lease.expiresAt) - this.reminderMs()));
    this.reminderTimer = setTimeout(() => { void this.remindDue(); }, Math.min(Math.max(next - this.now(), 0), 2 ** 31 - 1));
    this.reminderTimer.unref?.();
  }

  /**
   * At a lease's reminder point: renew it without a prompt when 1Password's approval is still live,
   * else post the Extend card. Pane never reads 1Password just to keep its approval alive.
   */
  private async remindDue(): Promise<void> {
    const due = this.deps.store.list().filter(lease => !this.reminded.has(lease.id) && Date.parse(lease.expiresAt) - this.reminderMs() <= this.now());
    for (const summary of due) {
      this.reminded.add(summary.id);
      const lease = this.deps.store.get(summary.id);
      if (!lease) continue;
      if (await this.renewSilently(lease)) continue;
      this.deps.postReminder?.(lease, this.lengthFor(lease.project));
    }
    this.armReminders();
  }

  /** Renews `lease` with no prompt if 1Password says its approval is live. False when it can't. */
  private async renewSilently(lease: SecretLeaseRecord): Promise<boolean> {
    if (!this.deps.approvalLive) return false;
    try {
      if (!(await this.deps.approvalLive())) return false;
      await this.start({ project: lease.project, names: lease.secrets.map(secret => secret.name), machines: [], requestedBy: lease.requestedBy, renews: lease.id });
      return true;
    } catch (error) {
      console.warn(`[SecretLeases] Silent renewal of lease ${lease.id} failed; showing the card: ${reasonOf(error)}`);
      return false;
    }
  }

  dispose(): void {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
  }
}
