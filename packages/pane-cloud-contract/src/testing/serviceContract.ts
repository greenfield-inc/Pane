import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callRoute } from '../http';
import { createServiceClient, type Machine, type ServiceClient, serviceRoutes, type SubmittedOperation } from '../service';
import { type ContractCase, expectError, waitFor } from './cases';

type Who = 'owner' | 'teammate' | 'outsider';

export interface ServiceContractTarget {
  baseUrl: string;
  /**
   * Signs in a test account and returns its token. `owner` is in the cohort and owns a team with no
   * other members; `teammate` and `outsider` are waitlisted and on no team.
   */
  signIn(who: Who): Promise<string>;
  logins: Record<Who, string>;
  /** How long to wait for a machine to settle. Default 180 s (journey 2's 3 minutes). */
  timeoutMs?: number;
}

/** The service API contract: what S1 must do for the desktop adapter. */
export function serviceContractCases(target: ServiceContractTarget): ContractCase[] {
  const timeoutMs = target.timeoutMs ?? 180_000;
  const tokens = new Map<Who, string>();
  const tokenFor = async (who: Who) => {
    const token = tokens.get(who) ?? (await target.signIn(who));
    tokens.set(who, token);
    return token;
  };
  const as = async (who: Who) => createServiceClient({ baseUrl: target.baseUrl, token: await tokenFor(who) });
  /** Sends an operation request as written, including ones the typed client would not let you write. */
  const rawOperation = async (machineId: string, body: SubmittedOperation) =>
    callRoute({ baseUrl: target.baseUrl, token: await tokenFor('owner') }, serviceRoutes.requestOperation, { params: { machineId }, body });
  const machineIn = (client: ServiceClient, machineId: string, state: Machine['state']) =>
    waitFor(() => client.getMachine(machineId), (m) => m.state === state, `machine ${machineId} to be ${state}`, timeoutMs);
  const withMachine = async (body: (owner: ServiceClient, machine: Machine) => Promise<void>) => {
    const owner = await as('owner');
    const { machine } = await owner.createMachine('contract test', randomUUID());
    try {
      await body(owner, await machineIn(owner, machine.id, 'running'));
    } finally {
      const current = await owner.getMachine(machine.id);
      if (current.state !== 'deleted' && current.state !== 'deleting') await owner.deleteMachine(machine.id);
    }
  };

  return [
    {
      name: 'service: device sign-in starts with a GitHub code, and a call without a token is refused',
      async run() {
        const anonymous = createServiceClient({ baseUrl: target.baseUrl });
        const code = await anonymous.startDeviceSignIn();
        assert.ok(code.userCode.length > 0);
        assert.equal((await anonymous.pollDeviceSignIn(code.deviceCode)).status, 'pending');
        await expectError('unauthenticated', () => anonymous.getAccount());
      },
    },
    {
      name: 'service: a waitlisted account is told it is on the list and cannot create a machine',
      async run() {
        const outsider = await as('outsider');
        const account = await outsider.getAccount();
        assert.equal(account.githubLogin.toLowerCase(), target.logins.outsider.toLowerCase());
        assert.equal(account.access, 'waitlisted');
        await expectError('not_invited', () => outsider.createMachine('nope', randomUUID()));
      },
    },
    {
      name: 'service: create, stop, start and delete a machine, each logged with who and why',
      async run() {
        await withMachine(async (owner, machine) => {
          assert.equal(machine.limits.dailyCpuSeconds, 43_200);
          assert.equal(machine.shared, false);
          assert.equal((await owner.listMachines()).machines.filter((m) => m.state !== 'deleted').length, 1);
          await owner.stopMachine(machine.id);
          await machineIn(owner, machine.id, 'stopped');
          await expectError('invalid_state', () => owner.stopMachine(machine.id));
          await owner.startMachine(machine.id);
          await machineIn(owner, machine.id, 'running');
          const { entries } = await owner.listActionLog(machine.id);
          for (const operation of ['create', 'stop', 'start'] as const) {
            const entry = entries.find((e) => e.operation === operation);
            assert.ok(entry, `the action log lists ${operation}`);
            assert.equal(entry.actor.kind, 'user');
            assert.equal(entry.actor.githubLogin?.toLowerCase(), target.logins.owner.toLowerCase());
          }
          const ordered = entries.map((e) => Date.parse(e.requestedAt));
          assert.deepEqual(ordered, [...ordered].sort((a, b) => b - a), 'the action log is newest first');
          await owner.deleteMachine(machine.id);
          const gone = await waitFor(() => owner.getMachine(machine.id), (m) => m.state === 'deleted', 'the machine to be deleted', timeoutMs);
          assert.equal(gone.state, 'deleted');
          assert.ok(!(await owner.listMachines()).machines.some((m) => m.id === machine.id), 'a deleted machine leaves the list');
        });
      },
    },
    {
      name: 'service: one machine per seat, and a retried create returns the same machine',
      async run() {
        const owner = await as('owner');
        const key = randomUUID();
        const first = await owner.createMachine('seat test', key);
        try {
          const retried = await owner.createMachine('seat test', key);
          assert.equal(retried.machine.id, first.machine.id);
          await expectError('seat_has_machine', () => owner.createMachine('second', randomUUID()));
        } finally {
          await machineIn(owner, first.machine.id, 'running');
          await owner.deleteMachine(first.machine.id);
        }
      },
    },
    {
      name: 'service: runs only allow-listed operations, with fixed parameters',
      async run() {
        await withMachine(async (owner, machine) => {
          await expectError('operation_not_allowed', () => rawOperation(machine.id, { operation: 'run_script', parameters: { script: 'id' } }));
          await expectError('operation_not_allowed', () => rawOperation(machine.id, { operation: 'grant_access', parameters: { githubLogin: target.logins.outsider } }));
          await expectError('operation_not_allowed', () => rawOperation(machine.id, { operation: 'bootstrap', parameters: {} }));
          await expectError('invalid_request', () => rawOperation(machine.id, { operation: 'update_pane', parameters: { url: 'https://example.com/pane.deb' } }));
          await expectError('release_not_published', () => owner.requestOperation(machine.id, { operation: 'update_pane', parameters: { version: '0.0.1' } }));
          const entry = await owner.requestOperation(machine.id, { operation: 'collect_diagnostics', parameters: {} });
          assert.equal(entry.operation, 'collect_diagnostics');
          const { entries } = await owner.listActionLog(machine.id);
          assert.ok(entries.some((e) => e.id === entry.id), 'the operation is in the action log');
        });
      },
    },
    {
      name: "service: another account cannot read or change the owner's machine",
      async run() {
        await withMachine(async (_owner, machine) => {
          const outsider = await as('outsider');
          await expectError('machine_not_found', () => outsider.getMachine(machine.id));
          await expectError('machine_not_found', () => outsider.stopMachine(machine.id));
          await expectError('machine_not_found', () => outsider.listActionLog(machine.id));
        });
      },
    },
    {
      name: 'service: the beta end date is public, and its notice dates follow from it',
      async run() {
        const beta = await createServiceClient({ baseUrl: target.baseUrl }).getBeta();
        if (beta.endsAt === null) {
          assert.equal(beta.noticeAt, null);
          assert.equal(beta.pushWindowsFrom, null);
          assert.equal(beta.phase, 'open');
          return;
        }
        const ends = Date.parse(beta.endsAt);
        assert.equal(Date.parse(beta.noticeAt ?? ''), ends - 30 * 86_400_000, 'notice starts 30 days before the end');
        assert.equal(Date.parse(beta.pushWindowsFrom ?? ''), ends - 14 * 86_400_000, 'push windows start 14 days before the end');
      },
    },
    {
      name: "service: billing status is the team's",
      async run() {
        const owner = await as('owner');
        const account = await owner.getAccount();
        const billing = await owner.getBilling();
        assert.equal(billing.teamId, account.teamId);
        assert.ok(billing.seats >= 1);
      },
    },
    {
      name: 'service: invite a teammate, list the roster and shared machines, relay a connection code once, and withdraw it on unshare or removal',
      async run() {
        const owner = await as('owner');
        const teammate = await as('teammate');
        const invite = await owner.createInvite(target.logins.teammate);
        assert.equal(invite.status, 'pending');
        assert.ok((await teammate.getAccount()).pendingInvites.some((i) => i.id === invite.id), 'the teammate sees the invite');
        const joined = await teammate.acceptInvite(invite.id);
        assert.equal(joined.role, 'member');
        try {
          await expectError('not_team_owner', () => teammate.createInvite(target.logins.outsider));
          const confirmed = await teammate.setTailscaleLogin(`${target.logins.teammate}@github`);
          const team = await owner.getTeam();
          assert.ok(team.members.some((m) => m.accountId === joined.id && m.tailscaleLogin === confirmed.tailscaleLogin), 'the roster lists the teammate with their Tailscale login');
          assert.equal((await owner.getBilling()).seats, team.members.length, 'each member is a seat');
          await withMachine(async (ownerClient, machine) => {
            assert.ok(!(await teammate.listSharedMachines()).machines.some((m) => m.machineId === machine.id), 'an unshared machine is not listed');
            await expectError('invalid_state', () => ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: 'x', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
            await ownerClient.setSharing(machine.id, true);
            const listed = (await teammate.listSharedMachines()).machines.find((m) => m.machineId === machine.id);
            assert.ok(listed, 'the shared machine is in the team directory');
            assert.equal(listed.owner.githubLogin.toLowerCase(), target.logins.owner.toLowerCase());
            await expectError('machine_not_found', () => teammate.getMachine(machine.id));
            await expectError('machine_not_found', () => teammate.stopMachine(machine.id));
            const code = `pane-code-${randomUUID()}`;
            await expectError('invalid_request', () => ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
            await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code, expiresAt: new Date(Date.now() + 300_000).toISOString() });
            await expectError('connection_code_not_found', async () => (await as('outsider')).claimConnectionCode(machine.id));
            assert.equal((await teammate.claimConnectionCode(machine.id)).code, code);
            await expectError('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
            const soon = () => new Date(Date.now() + 300_000).toISOString();
            await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: `${code}-2`, expiresAt: soon() });
            await ownerClient.setSharing(machine.id, false);
            await expectError('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
            await ownerClient.setSharing(machine.id, true);
            await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: `${code}-3`, expiresAt: soon() });
            await owner.removeMember(joined.id);
            await expectError('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
          });
        } finally {
          if ((await owner.getTeam()).members.some((m) => m.accountId === joined.id)) await owner.removeMember(joined.id);
        }
        await expectError('not_team_member', () => teammate.listSharedMachines());
        assert.ok(!(await owner.getTeam()).members.some((m) => m.accountId === joined.id));
      },
    },
  ];
}
