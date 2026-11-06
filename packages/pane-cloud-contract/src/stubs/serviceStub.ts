import { CloudApiError } from '../errors';
import { MACHINE_LIMITS } from '../fleet';
import {
  type Account,
  type ActionLogEntry,
  type BillingStatus,
  CONNECTION_CODE_MAX_SECONDS,
  type DeviceTokenResult,
  type Invite,
  type Machine,
  parseUserOperation,
  serviceRoutes,
  type Team,
} from '../service';
import { bind, createRouteServer, listen, type RunningStub } from './server';

export interface StubAccount {
  githubLogin: string;
  name?: string;
  /** In the invite-only cohort. Others are waitlisted until a team invites them. */
  cohort: boolean;
}

export interface ServiceStubOptions {
  accounts: StubAccount[];
  /** Published Pane versions, oldest first; the last is what create and update_pane install by default. */
  paneVersions?: string[];
  now?: () => Date;
}

export interface ServiceStub extends RunningStub {
  /** The person entering the device code on GitHub and approving. */
  approveDevice(userCode: string, githubLogin: string): void;
  denyDevice(userCode: string): void;
  /** The fleet stopping a machine on its own; logged with actor `host`. */
  hostStop(machineId: string, reason: 'idle' | 'memory_pressure' | 'host_maintenance'): void;
  joinTailnet(machineId: string): void;
  setCpuSecondsUsed(machineId: string, seconds: number): void;
}

interface DeviceGrant {
  userCode: string;
  state: 'pending' | 'approved' | 'denied' | 'used';
  login: string | null;
}

interface AccountRecord {
  account: Omit<Account, 'pendingInvites'>;
  joinedAt: string;
}

/**
 * An in-memory Pane Cloud service that keeps the contract, for building the desktop adapter and for
 * the contract tests. Machines start and stop at once.
 */
export async function startServiceStub(options: ServiceStubOptions): Promise<ServiceStub> {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const versions = options.paneVersions ?? ['2.4.214', '2.4.215'];
  const latest = versions.at(-1) ?? '2.4.215';
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;

  const accounts = new Map<string, AccountRecord>();
  options.accounts.forEach((entry, index) => {
    accounts.set(entry.githubLogin.toLowerCase(), {
      account: {
        id: `acct_${index + 1}`,
        githubId: 1000 + index,
        githubLogin: entry.githubLogin,
        name: entry.name ?? null,
        email: null,
        access: entry.cohort ? 'invited' : 'waitlisted',
        teamId: null,
        role: null,
        tailscaleLogin: null,
      },
      joinedAt: iso(),
    });
  });
  const devices = new Map<string, DeviceGrant>();
  const tokens = new Map<string, string>();
  const teams = new Map<string, { id: string; name: string; ownerId: string }>();
  const invites = new Map<string, Invite>();
  const machines = new Map<string, Machine & { cpuSecondsUsed: number }>();
  const logs = new Map<string, ActionLogEntry[]>();
  const idempotent = new Map<string, { machineId: string; entryId: string }>();
  const codes = new Map<string, { id: string; code: string; expiresAt: string }>();

  const byId = (accountId: string) => [...accounts.values()].find((r) => r.account.id === accountId);
  const view = (record: AccountRecord): Account => ({
    ...record.account,
    pendingInvites: [...invites.values()].filter((i) => i.status === 'pending' && i.githubLogin.toLowerCase() === record.account.githubLogin.toLowerCase()),
  });
  const caller = (token: string | null): AccountRecord => {
    const accountId = token ? tokens.get(token) : undefined;
    const record = accountId ? byId(accountId) : undefined;
    if (!record) throw new CloudApiError('unauthenticated', 'The token is unknown or signed out.', 'Sign in again.');
    return record;
  };
  const teamOf = (record: AccountRecord) => {
    const team = record.account.teamId ? teams.get(record.account.teamId) : undefined;
    if (!team) throw new CloudApiError('not_team_member', 'This account is not on a team yet.', 'Accept a team invite, or ask to join the cohort.');
    return team;
  };
  const requireOwner = (record: AccountRecord) => {
    const team = teamOf(record);
    if (team.ownerId !== record.account.id) throw new CloudApiError('not_team_owner', 'Only the team owner can do this.', 'Ask your team owner.');
    return team;
  };
  const ownMachine = (record: AccountRecord, machineId: string) => {
    const machine = machines.get(machineId);
    if (!machine || machine.ownerAccountId !== record.account.id) {
      throw new CloudApiError('machine_not_found', `You have no machine ${machineId}.`, 'List your machines to find its id.');
    }
    return machine;
  };
  const publicMachine = ({ cpuSecondsUsed, ...machine }: Machine & { cpuSecondsUsed: number }): Machine => {
    const day = iso().slice(0, 10);
    const reset = new Date(`${day}T00:00:00.000Z`);
    reset.setUTCDate(reset.getUTCDate() + 1);
    return {
      ...machine,
      usage: machine.state === 'deleted' ? null : { day, cpuSecondsUsed, throttled: cpuSecondsUsed >= MACHINE_LIMITS.dailyCpuSeconds, resetsAt: reset.toISOString(), egressBytesThisMonth: 0, diskUsedBytes: 4 * 1024 ** 3 },
    };
  };
  const log = (
    machine: Machine,
    operation: ActionLogEntry['operation'],
    actor: AccountRecord | 'service' | 'host',
    reason: string,
    parameters: ActionLogEntry['parameters'] = {},
  ): ActionLogEntry => {
    const entry: ActionLogEntry = {
      id: nextId('act'),
      machineId: machine.id,
      operation,
      parameters,
      actor:
        actor === 'service' || actor === 'host'
          ? { kind: actor, accountId: null, githubLogin: null }
          : { kind: 'user', accountId: actor.account.id, githubLogin: actor.account.githubLogin },
      reason,
      status: 'succeeded',
      error: null,
      requestedAt: iso(),
      finishedAt: iso(),
    };
    logs.get(machine.id)?.unshift(entry);
    return entry;
  };
  const setState = (machine: Machine, state: Machine['state'], reason: Machine['stateReason']) => {
    machine.state = state;
    machine.stateReason = reason;
    machine.updatedAt = iso();
  };
  const requireState = (machine: Machine, state: Machine['state'], action: string) => {
    if (machine.state !== state) throw new CloudApiError('invalid_state', `${action} needs a ${state} machine; it is ${machine.state}.`, 'Refresh the machine and try the action that fits its state.');
  };
  const releaseFor = (version: string) => ({ version, arch: 'arm64', debSha256: 'a'.repeat(64) });
  const team = (teamId: string): Team => {
    const t = teams.get(teamId);
    if (!t) throw new Error(`stub: no team ${teamId}`);
    return {
      id: t.id,
      name: t.name,
      members: [...accounts.values()]
        .filter((r) => r.account.teamId === teamId)
        .map((r) => ({
          accountId: r.account.id,
          githubLogin: r.account.githubLogin,
          name: r.account.name,
          role: r.account.role ?? 'member',
          tailscaleLogin: r.account.tailscaleLogin,
          seat: { status: 'free', foundingPrice: true },
          joinedAt: r.joinedAt,
        })),
      invites: [...invites.values()].filter((i) => byId(i.invitedByAccountId)?.account.teamId === teamId && i.status === 'pending'),
    };
  };

  const r = serviceRoutes;
  const server = createRouteServer([
    bind(r.startDeviceSignIn, () => {
      const deviceCode = nextId('dev');
      const userCode = `STUB-${counter}`;
      devices.set(deviceCode, { userCode, state: 'pending', login: null });
      return { deviceCode, userCode, verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 1 };
    }),
    bind(r.pollDeviceSignIn, ({ body }): DeviceTokenResult => {
      const grant = devices.get(body.deviceCode);
      if (!grant || grant.state === 'used') return { status: 'expired' };
      if (grant.state === 'pending') return { status: 'pending' };
      if (grant.state === 'denied') return { status: 'denied' };
      grant.state = 'used';
      const record = accounts.get((grant.login ?? '').toLowerCase());
      if (!record) return { status: 'denied' };
      if (record.account.access === 'invited' && !record.account.teamId && options.accounts.find((a) => a.githubLogin.toLowerCase() === record.account.githubLogin.toLowerCase())?.cohort) {
        const teamId = nextId('team');
        teams.set(teamId, { id: teamId, name: `${record.account.githubLogin}'s team`, ownerId: record.account.id });
        record.account.teamId = teamId;
        record.account.role = 'owner';
      }
      const token = nextId('tok');
      tokens.set(token, record.account.id);
      return { status: 'complete', token, expiresAt: new Date(now().getTime() + 30 * 86_400_000).toISOString(), account: view(record) };
    }),
    bind(r.signOut, ({ token }) => {
      caller(token);
      tokens.delete(token ?? '');
      return { signedOut: true as const };
    }),
    bind(r.getAccount, ({ token }) => view(caller(token))),
    bind(r.setTailscaleLogin, ({ token, body }) => {
      const record = caller(token);
      record.account.tailscaleLogin = body.tailscaleLogin;
      return view(record);
    }),

    bind(r.listMachines, ({ token }) => {
      const record = caller(token);
      return { machines: [...machines.values()].filter((m) => m.ownerAccountId === record.account.id && m.state !== 'deleted').map(publicMachine) };
    }),
    bind(r.createMachine, ({ token, body }) => {
      const record = caller(token);
      const key = `${record.account.id}:${body.idempotencyKey}`;
      const repeat = idempotent.get(key);
      if (repeat) {
        const machine = machines.get(repeat.machineId);
        const entry = logs.get(repeat.machineId)?.find((e) => e.id === repeat.entryId);
        if (machine && entry) return { machine: publicMachine(machine), operation: entry };
      }
      if (record.account.access !== 'invited' || !record.account.teamId) {
        throw new CloudApiError('not_invited', "You're on the list. Pane Cloud is invite-only for now.", 'Wait for your invite, or ask a team owner to invite your GitHub login.');
      }
      if ([...machines.values()].some((m) => m.ownerAccountId === record.account.id && m.state !== 'deleted')) {
        throw new CloudApiError('seat_has_machine', 'Your seat already has a machine.', 'Open your existing machine, or delete it before creating another.');
      }
      const id = nextId('m');
      const machine: Machine & { cpuSecondsUsed: number } = {
        id,
        name: body.name,
        ownerAccountId: record.account.id,
        state: 'running',
        stateReason: null,
        paneVersion: latest,
        tailnet: { status: 'awaiting_login', loginUrl: `https://login.tailscale.com/a/stub-${id}`, hostname: null },
        limits: { vcpu: MACHINE_LIMITS.vcpu, memoryMiB: MACHINE_LIMITS.memoryMiB, diskGiB: MACHINE_LIMITS.diskGiB, dailyCpuSeconds: MACHINE_LIMITS.dailyCpuSeconds, monthlyEgressBytes: MACHINE_LIMITS.monthlyEgressBytes },
        usage: null,
        shared: false,
        createdAt: iso(),
        updatedAt: iso(),
        cpuSecondsUsed: 0,
      };
      machines.set(id, machine);
      logs.set(id, []);
      const entry = log(machine, 'create', record, 'You created this machine.');
      log(machine, 'bootstrap', 'service', 'First boot: install Pane and wait for your tailnet login.', { release: releaseFor(latest) });
      idempotent.set(key, { machineId: id, entryId: entry.id });
      return { machine: publicMachine(machine), operation: entry };
    }),
    bind(r.getMachine, ({ token, params }) => publicMachine(ownMachine(caller(token), params.machineId ?? ''))),
    bind(r.startMachine, ({ token, params }) => {
      const record = caller(token);
      const machine = ownMachine(record, params.machineId ?? '');
      requireState(machine, 'stopped', 'Start');
      setState(machine, 'running', null);
      return { machine: publicMachine(machine), operation: log(machine, 'start', record, 'You started this machine.') };
    }),
    bind(r.stopMachine, ({ token, params }) => {
      const record = caller(token);
      const machine = ownMachine(record, params.machineId ?? '');
      requireState(machine, 'running', 'Stop');
      log(machine, 'prepare_to_stop', 'service', 'Let Pane finish writing before the stop.');
      setState(machine, 'stopped', 'user');
      return { machine: publicMachine(machine), operation: log(machine, 'stop', record, 'You stopped this machine.') };
    }),
    bind(r.deleteMachine, ({ token, params }) => {
      const record = caller(token);
      const machine = ownMachine(record, params.machineId ?? '');
      if (machine.state === 'deleted') throw new CloudApiError('invalid_state', 'This machine is already deleted.', 'Nothing to do.');
      setState(machine, 'deleted', 'user');
      machine.shared = false;
      return { machine: publicMachine(machine), operation: log(machine, 'delete', record, 'You deleted this machine and its disk.') };
    }),
    bind(r.requestOperation, ({ token, params, body }) => {
      const record = caller(token);
      const machine = ownMachine(record, params.machineId ?? '');
      const request = parseUserOperation(body);
      requireState(machine, 'running', request.operation);
      if (request.operation === 'update_pane') {
        const version = request.parameters.version ?? latest;
        if (!versions.includes(version)) throw new CloudApiError('release_not_published', `Pane ${version} is not a published release.`, `Pick one of: ${versions.join(', ')}.`);
        machine.paneVersion = version;
        return log(machine, 'update_pane', record, `You updated Pane to ${version}.`, { release: releaseFor(version) });
      }
      return log(machine, 'collect_diagnostics', record, 'You collected diagnostics.');
    }),
    bind(r.listActionLog, ({ token, params, query }) => {
      const machine = ownMachine(caller(token), params.machineId ?? '');
      const all = logs.get(machine.id) ?? [];
      const start = query.before ? all.findIndex((e) => e.id === query.before) + 1 : 0;
      const entries = all.slice(start, start + (query.limit ?? 50));
      const last = entries.at(-1);
      return { entries, nextCursor: last && start + entries.length < all.length ? last.id : null };
    }),
    bind(r.setSharing, ({ token, params, body }) => {
      const record = caller(token);
      teamOf(record);
      const machine = ownMachine(record, params.machineId ?? '');
      machine.shared = body.shared;
      machine.updatedAt = iso();
      return publicMachine(machine);
    }),
    bind(r.leaveConnectionCode, ({ token, params, body }) => {
      const record = caller(token);
      const machine = ownMachine(record, params.machineId ?? '');
      if (!machine.shared) throw new CloudApiError('invalid_state', 'This machine is not shared with your team.', 'Turn on sharing for it first.');
      const teammate = byId(body.forAccountId);
      if (!teammate || teammate.account.teamId !== record.account.teamId || teammate.account.id === record.account.id) {
        throw new CloudApiError('not_team_member', 'That account is not a teammate.', 'Invite them to your team first.');
      }
      const expires = Date.parse(body.expiresAt);
      if (expires <= now().getTime() || expires > now().getTime() + CONNECTION_CODE_MAX_SECONDS * 1000) {
        throw new CloudApiError('invalid_request', `A connection code must expire within ${CONNECTION_CODE_MAX_SECONDS / 60} minutes.`, 'Mint a fresh code on the host and leave it again.');
      }
      const handoff = { id: nextId('cc'), code: body.code, expiresAt: body.expiresAt };
      codes.set(`${machine.id}:${teammate.account.id}`, handoff);
      return { id: handoff.id, machineId: machine.id, forAccountId: teammate.account.id, expiresAt: handoff.expiresAt };
    }),
    bind(r.claimConnectionCode, ({ token, params }) => {
      const record = caller(token);
      const key = `${params.machineId}:${record.account.id}`;
      const handoff = codes.get(key);
      codes.delete(key);
      const machine = machines.get(params.machineId ?? '');
      if (!handoff || !machine || Date.parse(handoff.expiresAt) <= now().getTime()) {
        throw new CloudApiError('connection_code_not_found', 'No connection code is waiting for you on this machine.', 'Ask the machine owner to approve you from their Pane.');
      }
      return { machineId: machine.id, code: handoff.code, tailnetHostname: machine.tailnet.hostname, expiresAt: handoff.expiresAt };
    }),

    bind(r.getBilling, ({ token }): BillingStatus => {
      const record = caller(token);
      const t = teamOf(record);
      return {
        teamId: t.id,
        plan: 'cohort',
        seatPriceCents: 4900,
        currency: 'usd',
        foundingPriceLocked: true,
        status: 'free',
        seats: team(t.id).members.length,
        chargesStartAt: null,
        graceEndsAt: null,
        currentPeriodEnd: null,
        manageUrl: t.ownerId === record.account.id ? 'https://billing.stripe.com/p/session/stub' : null,
      };
    }),
    bind(r.getTeam, ({ token }) => team(teamOf(caller(token)).id)),
    bind(r.createInvite, ({ token, body }) => {
      const record = caller(token);
      const t = requireOwner(record);
      if (team(t.id).members.some((m) => m.githubLogin.toLowerCase() === body.githubLogin.toLowerCase())) {
        throw new CloudApiError('already_member', `${body.githubLogin} is already on this team.`, 'Nothing to do.');
      }
      const invite: Invite = { id: nextId('inv'), githubLogin: body.githubLogin, invitedByAccountId: record.account.id, status: 'pending', createdAt: iso(), expiresAt: new Date(now().getTime() + 14 * 86_400_000).toISOString() };
      invites.set(invite.id, invite);
      return invite;
    }),
    bind(r.revokeInvite, ({ token, params }) => {
      const t = requireOwner(caller(token));
      const invite = invites.get(params.inviteId ?? '');
      if (!invite || byId(invite.invitedByAccountId)?.account.teamId !== t.id) throw new CloudApiError('invite_not_found', 'No such invite on your team.', 'List your team to see its invites.');
      invite.status = 'revoked';
      return invite;
    }),
    bind(r.acceptInvite, ({ token, params }) => {
      const record = caller(token);
      const invite = invites.get(params.inviteId ?? '');
      if (!invite || invite.status !== 'pending' || invite.githubLogin.toLowerCase() !== record.account.githubLogin.toLowerCase()) {
        throw new CloudApiError('invite_not_found', 'No pending invite for you with that id.', 'Ask the team owner to invite your GitHub login.');
      }
      if (record.account.teamId) throw new CloudApiError('already_member', 'You are already on a team.', 'Leave your current team first.');
      invite.status = 'accepted';
      record.account.teamId = byId(invite.invitedByAccountId)?.account.teamId ?? null;
      record.account.role = 'member';
      record.account.access = 'invited';
      record.joinedAt = iso();
      return view(record);
    }),
    bind(r.removeMember, ({ token, params }) => {
      const t = requireOwner(caller(token));
      const member = byId(params.accountId ?? '');
      if (!member || member.account.teamId !== t.id) throw new CloudApiError('not_team_member', 'That account is not on your team.', 'List your team to see its members.');
      if (member.account.id === t.ownerId) throw new CloudApiError('invalid_request', 'The owner cannot be removed.', 'Remove other members only.');
      member.account.teamId = null;
      member.account.role = null;
      for (const machine of machines.values()) if (machine.ownerAccountId === member.account.id) machine.shared = false;
      return team(t.id);
    }),
    bind(r.listSharedMachines, ({ token }) => {
      const t = teamOf(caller(token));
      return {
        machines: [...machines.values()]
          .filter((m) => m.shared && m.state !== 'deleted' && byId(m.ownerAccountId)?.account.teamId === t.id)
          .map((m) => {
            const owner = byId(m.ownerAccountId)?.account;
            if (!owner) throw new Error(`stub: no owner for ${m.id}`);
            return {
              machineId: m.id,
              name: m.name,
              state: m.state,
              owner: { accountId: owner.id, githubLogin: owner.githubLogin, name: owner.name, tailscaleLogin: owner.tailscaleLogin },
              tailnetHostname: m.tailnet.hostname,
              sharedAt: m.updatedAt,
            };
          }),
      };
    }),
  ]);

  const running = await listen(server);
  const anyMachine = (machineId: string) => {
    const machine = machines.get(machineId);
    if (!machine) throw new Error(`stub: no machine ${machineId}`);
    return machine;
  };
  return {
    ...running,
    approveDevice(userCode, githubLogin) {
      const grant = [...devices.values()].find((d) => d.userCode === userCode);
      if (!grant) throw new Error(`stub: no device code ${userCode}`);
      grant.state = 'approved';
      grant.login = githubLogin;
    },
    denyDevice(userCode) {
      const grant = [...devices.values()].find((d) => d.userCode === userCode);
      if (grant) grant.state = 'denied';
    },
    hostStop(machineId, reason) {
      const machine = anyMachine(machineId);
      setState(machine, 'stopped', reason);
      log(machine, 'stop', 'host', reason === 'idle' ? 'No agent ran and no one was connected for 30 minutes.' : `The host stopped this machine (${reason}).`);
    },
    joinTailnet(machineId) {
      const machine = anyMachine(machineId);
      machine.tailnet = { status: 'joined', loginUrl: null, hostname: `pane-${machineId}.tailnet.ts.net` };
    },
    setCpuSecondsUsed(machineId, seconds) {
      anyMachine(machineId).cpuSecondsUsed = seconds;
    },
  };
}
