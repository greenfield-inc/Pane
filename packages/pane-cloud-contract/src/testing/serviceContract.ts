import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callRoute } from '../http';
import { createServiceClient, PLANS, type ServiceClient, serviceRoutes, type SessionVm, type SubmittedOperation } from '../service';
import { type ContractCase, expectError, waitFor } from './cases';

type Who = 'member' | 'unverified' | 'waitlisted';

export interface ServiceContractTarget {
  baseUrl: string;
  /**
   * Signs in a test account and returns its token. `member` is invited, has finished sign-up, is on
   * the Free plan in its personal organization and has no Session VMs awake. `unverified` is invited
   * but has not finished the phone and card checks. `waitlisted` is not invited.
   */
  signIn(who: Who): Promise<string>;
  emails: Record<Who, string>;
  /** How long to wait for a VM to settle. Default 180 s. */
  timeoutMs?: number;
}

/** The service API contract: what the service must do for Pane. */
export function serviceContractCases(target: ServiceContractTarget): ContractCase[] {
  const timeoutMs = target.timeoutMs ?? 180_000;
  const tokens = new Map<Who, string>();
  const tokenFor = async (who: Who) => {
    const token = tokens.get(who) ?? (await target.signIn(who));
    tokens.set(who, token);
    return token;
  };
  const as = async (who: Who) => createServiceClient({ baseUrl: target.baseUrl, token: await tokenFor(who) });
  const personalOrg = async (client: ServiceClient) => {
    const org = (await client.getAccount()).organizations.find((m) => m.personal);
    assert.ok(org, 'every account has a personal organization');
    return org.organizationId;
  };
  /** Sends an operation request as written, including ones the typed client would not let you write. */
  const rawOperation = async (vmId: string, body: SubmittedOperation) =>
    callRoute({ baseUrl: target.baseUrl, token: await tokenFor('member') }, serviceRoutes.requestOperation, { params: { vmId }, body });
  const vmIn = (client: ServiceClient, vmId: string, state: SessionVm['state']) =>
    waitFor(() => client.getVm(vmId), (v) => v.state === state, `Session VM ${vmId} to be ${state}`, timeoutMs);
  const cleanUp = async (client: ServiceClient, vmIds: string[]) => {
    for (const vmId of vmIds) {
      const current = await client.getVm(vmId);
      if (current.state === 'creating' || current.state === 'starting') await vmIn(client, vmId, 'running');
      if (current.state !== 'deleted' && current.state !== 'deleting') await client.deleteVm(vmId);
    }
  };
  const withVm = async (body: (member: ServiceClient, vm: SessionVm) => Promise<void>) => {
    const member = await as('member');
    const { vm } = await member.createVm(await personalOrg(member), 'contract test', randomUUID());
    try {
      await body(member, await vmIn(member, vm.id, 'running'));
    } finally {
      await cleanUp(member, [vm.id]);
    }
  };

  return [
    {
      name: 'service: device sign-in starts with a code and a browser link, and a call without a token is refused',
      async run() {
        const anonymous = createServiceClient({ baseUrl: target.baseUrl });
        const code = await anonymous.startDeviceSignIn();
        assert.ok(code.verificationUriComplete.includes(code.userCode) || code.verificationUriComplete.startsWith(code.verificationUri));
        assert.equal((await anonymous.pollDeviceSignIn(code.deviceCode)).status, 'pending');
        await expectError('unauthenticated', () => anonymous.getAccount());
      },
    },
    {
      name: 'service: a new account has a personal organization it owns, on the Free plan',
      async run() {
        const member = await as('member');
        const account = await member.getAccount();
        assert.equal(account.email.toLowerCase(), target.emails.member.toLowerCase());
        const personal = account.organizations.filter((m) => m.personal);
        assert.equal(personal.length, 1);
        assert.equal(personal[0]?.role, 'owner');
        const usage = await member.getUsage(await personalOrg(member));
        assert.equal(usage.plan, 'free');
        const me = usage.members.find((m) => m.accountId === account.id);
        assert.ok(me, 'usage lists the member');
        assert.equal(me.awakeLimit, PLANS.free.awakeLimitPerMember);
        const fullAccess = usage.members.filter((m) => m.role !== 'view_only').length;
        assert.equal(usage.agentHours.limit, PLANS.free.agentHoursPerMember * fullAccess, 'hours are pooled per Full access member');
        assert.equal(Date.parse(usage.resetsAt), Date.UTC(Number(usage.month.slice(0, 4)), Number(usage.month.slice(5, 7)), 1), 'hours reset on the 1st');
      },
    },
    {
      name: 'service: no Session VM before the account is invited and has finished sign-up',
      async run() {
        const waitlisted = await as('waitlisted');
        assert.equal((await waitlisted.getAccount()).access, 'waitlisted');
        await expectError('not_invited', async () => waitlisted.createVm(await personalOrg(waitlisted), 'nope', randomUUID()));
        const unverified = await as('unverified');
        assert.notEqual((await unverified.getAccount()).signupState, 'ready');
        await expectError('signup_incomplete', async () => unverified.createVm(await personalOrg(unverified), 'nope', randomUUID()));
      },
    },
    {
      name: 'service: create, stop, start and delete a Session VM, each logged with who and why, and a retried create returns the same VM',
      async run() {
        const member = await as('member');
        const organizationId = await personalOrg(member);
        const { id: accountId } = await member.getAccount();
        const key = randomUUID();
        const first = await member.createVm(organizationId, 'lifecycle', key);
        try {
          assert.equal((await member.createVm(organizationId, 'lifecycle', key)).vm.id, first.vm.id);
          const vm = await vmIn(member, first.vm.id, 'running');
          assert.equal(vm.organizationId, organizationId);
          assert.equal(vm.createdByAccountId, accountId);
          assert.equal(vm.memoryGiB, 8);
          assert.ok((await member.listVms(organizationId)).vms.some((v) => v.id === vm.id));
          await member.stopVm(vm.id);
          assert.equal((await vmIn(member, vm.id, 'stopped')).stateReason, 'user');
          await expectError('invalid_state', () => member.stopVm(vm.id));
          await member.startVm(vm.id);
          await vmIn(member, vm.id, 'running');
          const { entries } = await member.listActionLog(vm.id);
          for (const operation of ['create', 'stop', 'start'] as const) {
            const entry = entries.find((e) => e.operation === operation);
            assert.ok(entry, `the action log lists ${operation}`);
            assert.deepEqual(entry.actor, { kind: 'user', accountId });
          }
          const ordered = entries.map((e) => Date.parse(e.requestedAt));
          assert.deepEqual(ordered, [...ordered].sort((a, b) => b - a), 'the action log is newest first');
          const page = await member.listActionLog(vm.id, { limit: 1 });
          assert.equal(page.entries.length, 1);
          assert.ok(page.nextCursor, 'a log longer than the page has a cursor');
          assert.notEqual((await member.listActionLog(vm.id, { before: page.nextCursor, limit: 1 })).entries[0]?.id, page.entries[0]?.id);
          await member.deleteVm(vm.id);
          await vmIn(member, vm.id, 'deleted');
          assert.ok(!(await member.listVms(organizationId)).vms.some((v) => v.id === vm.id), 'a deleted VM leaves the list');
        } finally {
          await cleanUp(member, [first.vm.id]);
        }
      },
    },
    {
      name: "service: a member can have at most their plan's awake limit of Session VMs awake at once, and a stopped one doesn't count",
      async run() {
        const member = await as('member');
        const organizationId = await personalOrg(member);
        const { id: accountId } = await member.getAccount();
        const me = async () => {
          const found = (await member.getUsage(organizationId)).members.find((m) => m.accountId === accountId);
          assert.ok(found);
          return found;
        };
        const { awakeLimit, awakeNow } = await me();
        const created: string[] = [];
        try {
          for (let i = awakeNow; i < awakeLimit; i += 1) created.push((await member.createVm(organizationId, `awake ${i + 1}`, randomUUID())).vm.id);
          assert.equal((await me()).awakeNow, awakeLimit);
          await expectError('awake_limit_reached', () => member.createVm(organizationId, 'one too many', randomUUID()));
          const [first] = created;
          assert.ok(first);
          await vmIn(member, first, 'running');
          await member.stopVm(first);
          await vmIn(member, first, 'stopped');
          created.push((await member.createVm(organizationId, 'after a stop', randomUUID())).vm.id);
          await expectError('awake_limit_reached', () => member.startVm(first));
        } finally {
          await cleanUp(member, created);
        }
      },
    },
    {
      name: 'service: runs only allow-listed operations, with fixed parameters',
      async run() {
        await withVm(async (member, vm) => {
          await expectError('operation_not_allowed', () => rawOperation(vm.id, { operation: 'run_script', parameters: { script: 'id' } }));
          await expectError('operation_not_allowed', () => rawOperation(vm.id, { operation: 'grant_access', parameters: { email: target.emails.waitlisted } }));
          await expectError('operation_not_allowed', () => rawOperation(vm.id, { operation: 'bootstrap', parameters: {} }));
          await expectError('invalid_request', () => rawOperation(vm.id, { operation: 'update_pane', parameters: { url: 'https://example.com/pane.deb' } }));
          await expectError('release_not_published', () => member.requestOperation(vm.id, { operation: 'update_pane', parameters: { version: '0.0.1' } }));
          const entry = await member.requestOperation(vm.id, { operation: 'collect_diagnostics', parameters: {} });
          assert.equal(entry.operation, 'collect_diagnostics');
          assert.ok((await member.listActionLog(vm.id)).entries.some((e) => e.id === entry.id), 'the operation is in the action log');
        });
      },
    },
    {
      name: "service: another account cannot read or change a member's Session VM or organization",
      async run() {
        await withVm(async (member, vm) => {
          const other = await as('waitlisted');
          await expectError('vm_not_found', () => other.getVm(vm.id));
          await expectError('vm_not_found', () => other.stopVm(vm.id));
          await expectError('vm_not_found', () => other.listActionLog(vm.id));
          await expectError('not_org_member', () => other.listVms(vm.organizationId));
          await expectError('not_org_member', () => other.getUsage(vm.organizationId));
          assert.ok((await member.listVms(vm.organizationId)).vms.some((v) => v.id === vm.id));
        });
      },
    },
  ];
}
