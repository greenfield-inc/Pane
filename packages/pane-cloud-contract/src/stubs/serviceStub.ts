import { CloudApiError } from '../errors';
import {
  type Account,
  type ActionLogEntry,
  AGENT_HOURS_PER_AWAKE_HOUR,
  type DeviceTokenResult,
  type OrganizationUsage,
  type OrgRole,
  parseUserOperation,
  type Plan,
  PLANS,
  serviceRoutes,
  type SessionVm,
} from '../service';
import type { RelayIdentity } from '../fleet';
import { newRelayIdentity, pairingLinkFor } from './relayKey';
import { bind, createRouteServer, listen, type RunningStub } from './server';

export interface StubAccount {
  email: string;
  name?: string;
  /** Invited to the beta. Others are waitlisted and can create nothing. */
  invited: boolean;
  /** Where the account is in sign-up. Default `ready`. */
  signupState?: Account['signupState'];
}

export interface ServiceStubOptions {
  accounts: StubAccount[];
  /** Published Pane versions, oldest first; the last is what create and update_pane install by default. */
  paneVersions?: string[];
  /** VMs the stub's one host holds awake at once; past it, create and start answer no_capacity. Default unlimited. */
  capacity?: number;
  now?: () => Date;
}

export interface ServiceStub extends RunningStub {
  /** The person signing in on the hosted page and approving. */
  approveDevice(userCode: string, email: string): void;
  denyDevice(userCode: string): void;
  /** An automatic pause or a person's Suspend: the VM stops with reason `review`, logged with actor `service`. */
  pauseForReview(vmId: string): void;
  /** VMs the stub's host holds awake at once; null for no limit. */
  setCapacity(capacity: number | null): void;
  /** Adds an account to an organization, as an accepted invitation will. */
  addMember(organizationId: string, email: string, role: Exclude<OrgRole, 'owner'>): void;
  /** Changes an account's role in an organization, or removes it from the organization with null. */
  changeMember(organizationId: string, email: string, role: Exclude<OrgRole, 'owner'> | null): void;
  /** Puts an organization on a plan, as a subscription will. */
  setPlan(organizationId: string, plan: Plan): void;
  /** Gives a VM 16 GiB (or back to 8), as a resize will; its later awake hours count at the new rate. */
  setMemoryGiB(vmId: string, memoryGiB: SessionVm['memoryGiB']): void;
  /** The VM's Pane losing its relay key and making a new one, so its next pairing reports another identity. */
  replaceRelayKey(vmId: string): void;
}

interface DeviceGrant {
  userCode: string;
  state: 'pending' | 'approved' | 'denied' | 'used';
  email: string | null;
}

interface VmRecord {
  vm: SessionVm;
  /** Awake intervals in epoch ms at one memory size; the last one is open while the VM is awake. */
  awake: { from: number; to: number | null; memoryGiB: SessionVm['memoryGiB'] }[];
  log: ActionLogEntry[];
  /** The key the VM's Pane holds on its Session disk; it survives stops and starts. */
  relayKey: RelayIdentity;
}

const AWAKE: readonly SessionVm['state'][] = ['creating', 'starting', 'running'];
const HOUR = 3_600_000;

/**
 * An in-memory Pane Cloud service that keeps the contract, for building Pane against and for the
 * contract tests. Every account has a personal organization on the Free plan, and the awake limit spans
 * the account's organizations. VMs start and stop at
 * once, and agent-hours are counted from the stub's clock.
 */
export async function startServiceStub(options: ServiceStubOptions): Promise<ServiceStub> {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const versions = options.paneVersions ?? ['2.4.214', '2.4.215'];
  const latest = versions.at(-1) ?? '2.4.215';
  let capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  const plans = new Map<string, Plan>();
  const planOf = (organizationId: string): Plan => plans.get(organizationId) ?? 'free';
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;

  const accounts = new Map<string, Account>(
    options.accounts.map((entry, index): [string, Account] => [
      entry.email.toLowerCase(),
      {
        id: `acct_${index + 1}`,
        email: entry.email,
        name: entry.name ?? null,
        access: entry.invited ? 'invited' : 'waitlisted',
        signupState: entry.signupState ?? 'ready',
        organizations: [{ organizationId: `org_${index + 1}`, name: 'Personal', personal: true, role: 'owner' }],
      },
    ]),
  );
  const devices = new Map<string, DeviceGrant>();
  const tokens = new Map<string, string>();
  const vms = new Map<string, VmRecord>();
  const idempotent = new Map<string, { vmId: string; entryId: string }>();

  const byId = (accountId: string) => [...accounts.values()].find((a) => a.id === accountId);
  const caller = (token: string | null): Account => {
    const accountId = token ? tokens.get(token) : undefined;
    const account = accountId ? byId(accountId) : undefined;
    if (!account) throw new CloudApiError('unauthenticated', 'The token is unknown or signed out.', 'Sign in again.');
    return account;
  };
  const membership = (account: Account, organizationId: string) => {
    const found = account.organizations.find((m) => m.organizationId === organizationId);
    if (!found) throw new CloudApiError('not_org_member', `You are not a member of organization ${organizationId}.`, 'Pick one of the organizations on your account.');
    return found;
  };
  const ownVm = (account: Account, vmId: string) => {
    const record = vms.get(vmId);
    if (!record || record.vm.createdByAccountId !== account.id) {
      throw new CloudApiError('vm_not_found', `You have no Session VM ${vmId}.`, 'List your Session VMs to find its id.');
    }
    return record;
  };
  const isAwake = (record: VmRecord) => AWAKE.includes(record.vm.state);
  /** VMs an account has awake, across every organization it belongs to (D-74). */
  const awakeOf = (accountId: string) => [...vms.values()].filter((r) => r.vm.createdByAccountId === accountId && isAwake(r)).length;
  /** The highest awake limit among the account's Full access memberships (D-74). */
  const awakeLimitOf = (account: Account) =>
    Math.max(0, ...account.organizations.filter((m) => m.role !== 'view_only').map((m) => PLANS[planOf(m.organizationId)].awakeLimitPerMember));
  const requireFullAccess = (account: Account, organizationId: string) => {
    if (membership(account, organizationId).role === 'view_only') {
      throw new CloudApiError('view_only', 'You have View only access to this organization, so you can read its shared Sessions but not create or start one.', 'Ask the organization Owner for Full access.');
    }
  };
  /** The checks before a VM wakes: the account's awake limit, then the host's room. */
  const requireRoomToWake = (account: Account) => {
    const limit = awakeLimitOf(account);
    if (awakeOf(account.id) >= limit) {
      throw new CloudApiError('awake_limit_reached', `You already have ${limit} Sessions running, the most your plan allows at once.`, 'Stop one of your Sessions, then try again.');
    }
    if ([...vms.values()].filter(isAwake).length >= capacity) {
      throw new CloudApiError('no_capacity', 'The invite-only pool is full right now.', 'Stop one of your Sessions first, or try again later.');
    }
  };
  const setState = (record: VmRecord, state: SessionVm['state'], reason: SessionVm['stateReason']) => {
    const wasAwake = isAwake(record);
    record.vm.state = state;
    record.vm.stateReason = reason;
    record.vm.updatedAt = iso();
    const open = record.awake.at(-1);
    if (wasAwake && !isAwake(record) && open) open.to = now().getTime();
    if (!wasAwake && isAwake(record)) record.awake.push({ from: now().getTime(), to: null, memoryGiB: record.vm.memoryGiB });
  };
  const requireState = (record: VmRecord, state: SessionVm['state'], action: string) => {
    if (record.vm.state !== state) {
      throw new CloudApiError('invalid_state', `${action} needs a ${state} Session VM; it is ${record.vm.state}.`, 'Refresh the Session and try the action that fits its state.');
    }
  };
  const log = (record: VmRecord, operation: ActionLogEntry['operation'], actor: Account | 'service' | 'host', reason: string, parameters: ActionLogEntry['parameters'] = {}): ActionLogEntry => {
    const entry: ActionLogEntry = {
      id: nextId('act'),
      vmId: record.vm.id,
      operation,
      parameters,
      actor: actor === 'service' || actor === 'host' ? { kind: actor, accountId: null } : { kind: 'user', accountId: actor.id },
      reason,
      status: 'succeeded',
      error: null,
      requestedAt: iso(),
      finishedAt: iso(),
    };
    record.log.unshift(entry);
    return entry;
  };
  const releaseFor = (version: string) => ({ version, arch: 'arm64', debSha256: 'a'.repeat(64) });
  const agentHours = (record: VmRecord, from: number, to: number) => {
    const overlap = (i: VmRecord['awake'][number]) => Math.max(0, Math.min(i.to ?? now().getTime(), to) - Math.max(i.from, from));
    return record.awake.reduce((sum, i) => sum + (overlap(i) / HOUR) * AGENT_HOURS_PER_AWAKE_HOUR[i.memoryGiB], 0);
  };
  const usage = (organizationId: string, month: string): OrganizationUsage => {
    const from = Date.parse(`${month}-01T00:00:00.000Z`);
    const reset = new Date(from);
    reset.setUTCMonth(reset.getUTCMonth() + 1);
    const to = reset.getTime();
    const inOrg = [...vms.values()].filter((r) => r.vm.organizationId === organizationId);
    const members = [...accounts.values()].flatMap((account) => {
      const member = account.organizations.find((m) => m.organizationId === organizationId);
      if (!member) return [];
      const used = inOrg.filter((r) => r.vm.createdByAccountId === account.id).reduce((sum, r) => sum + agentHours(r, from, to), 0);
      return [{ accountId: account.id, name: account.name, role: member.role, agentHoursUsed: used, awakeNow: awakeOf(account.id), awakeLimit: member.role === 'view_only' ? 0 : awakeLimitOf(account) }];
    });
    const fullAccess = members.filter((m) => m.role !== 'view_only').length;
    return {
      organizationId,
      plan: planOf(organizationId),
      month,
      resetsAt: reset.toISOString(),
      agentHours: { used: members.reduce((sum, m) => sum + m.agentHoursUsed, 0), limit: PLANS[planOf(organizationId)].agentHoursPerMember * fullAccess },
      members,
    };
  };

  const r = serviceRoutes;
  const server = createRouteServer([
    bind(r.startDeviceSignIn, () => {
      const deviceCode = nextId('dev');
      const userCode = `STUB-${counter}`;
      devices.set(deviceCode, { userCode, state: 'pending', email: null });
      return { deviceCode, userCode, verificationUri: 'https://auth.example.test/device', verificationUriComplete: `https://auth.example.test/device?user_code=${userCode}`, expiresIn: 900, interval: 1 };
    }),
    bind(r.pollDeviceSignIn, ({ body }): DeviceTokenResult => {
      const grant = devices.get(body.deviceCode);
      if (!grant || grant.state === 'used') return { status: 'expired' };
      if (grant.state === 'pending') return { status: 'pending' };
      if (grant.state === 'denied') return { status: 'denied' };
      grant.state = 'used';
      const account = accounts.get((grant.email ?? '').toLowerCase());
      if (!account) return { status: 'denied' };
      const token = nextId('tok');
      tokens.set(token, account.id);
      return { status: 'complete', token, expiresAt: new Date(now().getTime() + 30 * 86_400_000).toISOString(), account };
    }),
    bind(r.signOut, ({ token }) => {
      caller(token);
      tokens.delete(token ?? '');
      return { signedOut: true as const };
    }),
    bind(r.getAccount, ({ token }) => caller(token)),

    bind(r.listVms, ({ token, params }) => {
      const account = caller(token);
      const organizationId = params.organizationId ?? '';
      membership(account, organizationId);
      return { vms: [...vms.values()].filter((v) => v.vm.organizationId === organizationId && v.vm.createdByAccountId === account.id && v.vm.state !== 'deleted').map((v) => v.vm) };
    }),
    bind(r.createVm, ({ token, params, body }) => {
      const account = caller(token);
      const organizationId = params.organizationId ?? '';
      requireFullAccess(account, organizationId);
      const key = `${account.id}:${organizationId}:${body.idempotencyKey}`;
      const repeat = idempotent.get(key);
      const repeated = repeat ? vms.get(repeat.vmId) : undefined;
      const repeatedEntry = repeated?.log.find((e) => e.id === repeat?.entryId);
      if (repeated && repeatedEntry) return { vm: repeated.vm, operation: repeatedEntry };
      if (account.access !== 'invited') throw new CloudApiError('not_invited', "You're on the list. Pane Cloud is invite-only for now.", 'Wait for your invite email.');
      if (account.signupState !== 'ready') throw new CloudApiError('signup_incomplete', 'Finish signing up before you create a cloud Session.', account.signupState === 'needs_phone' ? 'Verify your phone number on the sign-up page.' : 'Add a card on the sign-up page.');
      requireRoomToWake(account);
      const id = nextId('vm');
      const record: VmRecord = {
        vm: { id, organizationId, createdByAccountId: account.id, name: body.name, state: 'stopped', stateReason: null, memoryGiB: 8, paneVersion: latest, relay: null, createdAt: iso(), updatedAt: iso() },
        awake: [],
        log: [],
        relayKey: newRelayIdentity('runpane.net'),
      };
      vms.set(id, record);
      setState(record, 'running', null);
      const entry = log(record, 'create', account, 'You created this Session.');
      log(record, 'bootstrap', 'service', 'First boot: install Pane.', { release: releaseFor(latest) });
      idempotent.set(key, { vmId: id, entryId: entry.id });
      return { vm: record.vm, operation: entry };
    }),
    bind(r.getVm, ({ token, params }) => ownVm(caller(token), params.vmId ?? '').vm),
    bind(r.startVm, ({ token, params }) => {
      const account = caller(token);
      const record = ownVm(account, params.vmId ?? '');
      if (record.vm.stateReason === 'review') throw new CloudApiError('under_review', 'Your usage is under review, so this Session stays paused.', 'Check your email for the review notice, or reply to it to appeal.');
      requireState(record, 'stopped', 'Start');
      requireFullAccess(account, record.vm.organizationId);
      requireRoomToWake(account);
      setState(record, 'running', null);
      return { vm: record.vm, operation: log(record, 'start', account, 'You started this Session.') };
    }),
    bind(r.stopVm, ({ token, params }) => {
      const account = caller(token);
      const record = ownVm(account, params.vmId ?? '');
      requireState(record, 'running', 'Stop');
      log(record, 'prepare_to_stop', 'service', 'Let Pane finish writing before the stop.');
      setState(record, 'stopped', 'user');
      return { vm: record.vm, operation: log(record, 'stop', account, 'You stopped this Session.', { cause: 'user' }) };
    }),
    bind(r.deleteVm, ({ token, params }) => {
      const account = caller(token);
      const record = ownVm(account, params.vmId ?? '');
      if (record.vm.state === 'deleted') throw new CloudApiError('invalid_state', 'This Session is already deleted.', 'Nothing to do.');
      setState(record, 'deleted', 'user');
      return { vm: record.vm, operation: log(record, 'delete', account, 'You deleted this Session and its disk.') };
    }),
    bind(r.requestOperation, ({ token, params, body }) => {
      const account = caller(token);
      const record = ownVm(account, params.vmId ?? '');
      const request = parseUserOperation(body);
      requireState(record, 'running', request.operation);
      if (request.operation === 'update_pane') {
        const version = request.parameters.version ?? latest;
        if (!versions.includes(version)) throw new CloudApiError('release_not_published', `Pane ${version} is not a published release.`, `Pick one of: ${versions.join(', ')}.`);
        record.vm.paneVersion = version;
        return log(record, 'update_pane', account, `You updated Pane to ${version}.`, { release: releaseFor(version) });
      }
      return log(record, 'collect_diagnostics', account, 'You collected diagnostics.');
    }),
    bind(r.pairVm, ({ token, params }) => {
      const account = caller(token);
      const record = ownVm(account, params.vmId ?? '');
      // Pairing hands a device control of the VM: its creator must still have Full access in its organization.
      requireFullAccess(account, record.vm.organizationId);
      requireState(record, 'running', 'Pairing');
      const reported = record.relayKey;
      const vouched = record.vm.relay;
      if (vouched && (vouched.computerId !== reported.computerId || vouched.fingerprint !== reported.fingerprint || vouched.domain !== reported.domain)) {
        throw new CloudApiError('relay_key_changed', `This Session now reports relay key ${reported.computerId}, not ${vouched.computerId}, the one it paired with first, so no device was paired.`, 'Write to support with the Session name; its devices keep refusing the new key.');
      }
      record.vm.relay = reported;
      log(record, 'create_pairing_link', account, 'You paired a device with this Session.');
      return pairingLinkFor(reported, record.vm.name, now());
    }),
    bind(r.listActionLog, ({ token, params, query }) => {
      const all = ownVm(caller(token), params.vmId ?? '').log;
      const cursorAt = query.before ? all.findIndex((e) => e.id === query.before) : -1;
      if (query.before && cursorAt < 0) throw new CloudApiError('invalid_request', `Unknown cursor ${query.before}.`, 'Pass a nextCursor from an earlier page, or no cursor for the newest entries.');
      const start = cursorAt + 1;
      const entries = all.slice(start, start + (query.limit ?? 50));
      const last = entries.at(-1);
      return { entries, nextCursor: last && start + entries.length < all.length ? last.id : null };
    }),

    bind(r.getUsage, ({ token, params, query }) => {
      const organizationId = params.organizationId ?? '';
      membership(caller(token), organizationId);
      return usage(organizationId, query.month ?? iso().slice(0, 7));
    }),
  ]);

  const running = await listen(server);
  const grantFor = (userCode: string) => {
    const grant = [...devices.values()].find((d) => d.userCode === userCode);
    if (!grant) throw new Error(`stub: no device code ${userCode}`);
    return grant;
  };
  return {
    ...running,
    approveDevice(userCode, email) {
      const grant = grantFor(userCode);
      grant.state = 'approved';
      grant.email = email;
    },
    denyDevice(userCode) {
      grantFor(userCode).state = 'denied';
    },
    setCapacity(next) {
      capacity = next ?? Number.POSITIVE_INFINITY;
    },
    addMember(organizationId, email, role) {
      const account = accounts.get(email.toLowerCase());
      if (!account) throw new Error(`stub: no account ${email}`);
      if (!account.organizations.some((m) => m.organizationId === organizationId)) account.organizations.push({ organizationId, name: `Organization ${organizationId}`, personal: false, role });
    },
    changeMember(organizationId, email, role) {
      const account = accounts.get(email.toLowerCase());
      if (!account) throw new Error(`stub: no account ${email}`);
      const others = account.organizations.filter((m) => m.organizationId !== organizationId);
      const current = account.organizations.find((m) => m.organizationId === organizationId);
      account.organizations = role === null || !current ? others : [...others, { ...current, role }];
    },
    setPlan(organizationId, plan) {
      plans.set(organizationId, plan);
    },
    setMemoryGiB(vmId, memoryGiB) {
      const record = vms.get(vmId);
      if (!record) throw new Error(`stub: no Session VM ${vmId}`);
      const open = record.awake.at(-1);
      if (open && open.to === null) {
        open.to = now().getTime();
        record.awake.push({ from: now().getTime(), to: null, memoryGiB });
      }
      record.vm.memoryGiB = memoryGiB;
      record.vm.updatedAt = iso();
    },
    pauseForReview(vmId) {
      const record = vms.get(vmId);
      if (!record) throw new Error(`stub: no Session VM ${vmId}`);
      setState(record, 'stopped', 'review');
      log(record, 'stop', 'service', 'Paused while your usage is under review.', { cause: 'review' });
    },
    replaceRelayKey(vmId) {
      const record = vms.get(vmId);
      if (!record) throw new Error(`stub: no Session VM ${vmId}`);
      record.relayKey = newRelayIdentity('runpane.net');
    },
  };
}
