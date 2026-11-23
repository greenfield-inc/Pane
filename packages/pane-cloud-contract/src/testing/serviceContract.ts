import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callRoute } from '../http';
import { createServiceClient, type Plan, type ServiceClient, serviceRoutes, type SessionVm, type SubmittedOperation } from '../service';
import { type ContractCase, expectError, SkipCase, waitFor } from './cases';

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
  /**
   * Test-mode setup the server offers. A case that needs a control it doesn't offer is skipped and
   * says so. `setClock` moves the service's clock forward only, so the clock case runs last.
   */
  controls?: Partial<ServiceContractControls>;
}

export interface ServiceContractControls {
  /** Stops a VM for review, as the automatic pause or a person's Suspend does. */
  pauseForReview(vmId: string): Promise<void> | void;
  /** How many VMs the host holds awake at once; null for no limit. */
  setCapacity(capacity: number | null): Promise<void> | void;
  /** Adds a test account to an organization with a role, as an accepted invitation does. */
  addMember(who: Who, organizationId: string, role: 'full_access' | 'view_only'): Promise<void> | void;
  /** Puts an organization on a plan. */
  setPlan(organizationId: string, plan: Plan): Promise<void> | void;
  /** Gives a VM 16 GiB, as a resize does. */
  setMemoryGiB(vmId: string, memoryGiB: 16): Promise<void> | void;
  /** Sets the service's clock (ISO time), never backwards. */
  setClock(at: string): Promise<void> | void;
}

/** The service API contract: what the service must do for Pane. */
export function serviceContractCases(target: ServiceContractTarget): ContractCase[] {
  const timeoutMs = target.timeoutMs ?? 180_000;
  /** The control a case needs, or a skip message naming it. */
  const control = <K extends keyof ServiceContractControls>(name: K): ServiceContractControls[K] => {
    const found = target.controls?.[name];
    if (!found) throw new SkipCase(`the server offers no ${name} control`);
    return found;
  };
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
        assert.equal(me.awakeLimit, 5, 'Free allows 5 awake at once');
        assert.equal(usage.members.length, 1);
        assert.equal(usage.agentHours.limit, 300, 'Free gives one member 300 agent-hours');
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
          await expectError('vm_not_found', () => other.startVm(vm.id));
          await expectError('vm_not_found', () => other.deleteVm(vm.id));
          await expectError('vm_not_found', () => other.requestOperation(vm.id, { operation: 'collect_diagnostics', parameters: {} }));
          await expectError('not_org_member', () => other.createVm(vm.organizationId, 'not mine', randomUUID()));
          await expectError('not_org_member', () => other.listVms(vm.organizationId));
          await expectError('not_org_member', () => other.getUsage(vm.organizationId));
          assert.ok((await member.listVms(vm.organizationId)).vms.some((v) => v.id === vm.id));
        });
      },
    },
    {
      name: 'service: a VM paused for review answers under_review to start',
      async run() {
        const pause = control('pauseForReview');
        await withVm(async (member, vm) => {
          await pause(vm.id);
          assert.equal((await vmIn(member, vm.id, 'stopped')).stateReason, 'review');
          await expectError('under_review', () => member.startVm(vm.id));
        });
      },
    },
    {
      name: 'service: create answers no_capacity when the host is full',
      async run() {
        const setCapacity = control('setCapacity');
        const member = await as('member');
        await setCapacity(0);
        try {
          await expectError('no_capacity', async () => member.createVm(await personalOrg(member), 'no room', randomUUID()));
        } finally {
          await setCapacity(null);
        }
      },
    },
    {
      name: 'service: in a second organization, View only members add no hours and get view_only, and the awake limit spans the account',
      async run() {
        const addMember = control('addMember');
        const member = await as('member');
        const unverified = await as('unverified');
        const team = await personalOrg(unverified);
        await addMember('member', team, 'full_access');
        await addMember('waitlisted', team, 'view_only');
        const usage = await member.getUsage(team);
        assert.equal(usage.agentHours.limit, 600, 'two Full access members pool 2 x 300 hours; View only adds none');
        const viewer = usage.members.find((m) => m.role === 'view_only');
        assert.equal(viewer?.awakeLimit, 0);
        await expectError('view_only', async () => (await as('waitlisted')).createVm(team, 'read only', randomUUID()));

        const own = await personalOrg(member);
        const { id: accountId } = await member.getAccount();
        const created: string[] = [];
        try {
          for (let i = 0; i < 5; i += 1) created.push((await member.createVm(own, `personal ${i + 1}`, randomUUID())).vm.id);
          const inTeam = (await member.getUsage(team)).members.find((m) => m.accountId === accountId);
          assert.equal(inTeam?.awakeNow, 5, "awakeNow counts the member's VMs in every organization");
          await expectError('awake_limit_reached', () => member.createVm(team, 'sixth', randomUUID()));
          const setPlan = target.controls?.setPlan;
          if (setPlan) {
            await setPlan(team, 'pro');
            assert.equal((await member.getUsage(own)).members.find((m) => m.accountId === accountId)?.awakeLimit, 20, 'the highest limit among memberships applies everywhere');
            created.push((await member.createVm(team, 'sixth on Pro', randomUUID())).vm.id);
            await setPlan(team, 'free');
          }
        } finally {
          await cleanUp(member, created);
        }
      },
    },
    {
      name: 'service: agent-hours count awake time to the minute, across a month boundary, still-running VMs included, and a 16 GiB hour as 2',
      async run() {
        const setClock = control('setClock');
        const setMemoryGiB = control('setMemoryGiB');
        const member = await as('member');
        const own = await personalOrg(member);
        const { id: accountId } = await member.getAccount();
        const used = async (month: string) => (await member.getUsage(own, month)).members.find((m) => m.accountId === accountId)?.agentHoursUsed ?? 0;
        await setClock('2027-01-31T23:00:00.000Z');
        const [janBefore, febBefore] = [await used('2027-01'), await used('2027-02')];
        const { vm } = await member.createVm(own, 'metered', randomUUID());
        try {
          await vmIn(member, vm.id, 'running');
          await setClock('2027-02-01T00:30:00.000Z');
          assert.equal((await used('2027-01')) - janBefore, 1, 'the hour before midnight counts in January');
          assert.equal((await used('2027-02')) - febBefore, 0.5, 'a running VM counts up to now');
          await setMemoryGiB(vm.id, 16);
          await setClock('2027-02-01T01:30:00.000Z');
          assert.equal((await used('2027-02')) - febBefore, 2.5, 'an hour at 16 GiB counts as 2');
          await member.stopVm(vm.id);
          await vmIn(member, vm.id, 'stopped');
          await setClock('2027-02-01T03:30:00.000Z');
          assert.equal((await used('2027-02')) - febBefore, 2.5, 'a stopped VM counts nothing');
        } finally {
          await cleanUp(member, [vm.id]);
        }
      },
    },
  ];
}
