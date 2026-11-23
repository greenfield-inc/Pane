"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceContractCases = serviceContractCases;
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const errors_1 = require("../errors");
const http_1 = require("../http");
const sealing_1 = require("../sealing");
const service_1 = require("../service");
const cases_1 = require("./cases");
/** A small public repo every clone case can reach. */
const PUBLIC_REPO = { url: 'https://github.com/expressjs/express', branch: 'master' };
/** The service API contract: what the service must do for Pane. */
function serviceContractCases(target) {
    const timeoutMs = target.timeoutMs ?? 180_000;
    /** The control a case needs, or a skip message naming it. */
    const control = (name) => {
        const found = target.controls?.[name];
        if (!found)
            throw new cases_1.SkipCase(`the server offers no ${name} control`);
        return found;
    };
    const tokens = new Map();
    const tokenFor = async (who) => {
        const token = tokens.get(who) ?? (await target.signIn(who));
        tokens.set(who, token);
        return token;
    };
    const as = async (who) => (0, service_1.createServiceClient)({ baseUrl: target.baseUrl, token: await tokenFor(who) });
    const personalOrg = async (client) => {
        const org = (await client.getAccount()).organizations.find((m) => m.personal);
        strict_1.default.ok(org, 'every account has a personal organization');
        return org.organizationId;
    };
    /** Sends an operation request as written, including ones the typed client would not let you write. */
    const rawOperation = async (vmId, body) => (0, http_1.callRoute)({ baseUrl: target.baseUrl, token: await tokenFor('member') }, service_1.serviceRoutes.requestOperation, { params: { vmId }, body });
    const vmIn = (client, vmId, state) => (0, cases_1.waitFor)(() => client.getVm(vmId), (v) => v.state === state, `Session VM ${vmId} to be ${state}`, timeoutMs);
    const cleanUp = async (client, vmIds) => {
        for (const vmId of vmIds) {
            const current = await client.getVm(vmId);
            if (current.state === 'creating' || current.state === 'starting')
                await vmIn(client, vmId, 'running');
            if (current.state !== 'deleted' && current.state !== 'deleting')
                await client.deleteVm(vmId);
        }
    };
    const withVm = async (body) => {
        const member = await as('member');
        const { vm } = await member.createVm(await personalOrg(member), 'contract test', (0, node_crypto_1.randomUUID)());
        try {
            await body(member, await vmIn(member, vm.id, 'running'));
        }
        finally {
            await cleanUp(member, [vm.id]);
        }
    };
    return [
        {
            name: 'service: device sign-in starts with a code and a browser link, and a call without a token is refused',
            async run() {
                const anonymous = (0, service_1.createServiceClient)({ baseUrl: target.baseUrl });
                const code = await anonymous.startDeviceSignIn();
                strict_1.default.ok(code.verificationUriComplete.includes(code.userCode) || code.verificationUriComplete.startsWith(code.verificationUri));
                strict_1.default.equal((await anonymous.pollDeviceSignIn(code.deviceCode)).status, 'pending');
                await (0, cases_1.expectError)('unauthenticated', () => anonymous.getAccount());
            },
        },
        {
            name: 'service: a new account has a personal organization it owns, on the Free plan',
            async run() {
                const member = await as('member');
                const account = await member.getAccount();
                strict_1.default.equal(account.email.toLowerCase(), target.emails.member.toLowerCase());
                const personal = account.organizations.filter((m) => m.personal);
                strict_1.default.equal(personal.length, 1);
                strict_1.default.equal(personal[0]?.role, 'owner');
                const usage = await member.getUsage(await personalOrg(member));
                strict_1.default.equal(usage.plan, 'free');
                const me = usage.members.find((m) => m.accountId === account.id);
                strict_1.default.ok(me, 'usage lists the member');
                strict_1.default.equal(me.awakeLimit, 5, 'Free allows 5 awake at once');
                strict_1.default.equal(usage.members.length, 1);
                strict_1.default.equal(usage.agentHours.limit, 300, 'Free gives one member 300 agent-hours');
                strict_1.default.equal(Date.parse(usage.resetsAt), Date.UTC(Number(usage.month.slice(0, 4)), Number(usage.month.slice(5, 7)), 1), 'hours reset on the 1st');
            },
        },
        {
            name: 'service: no Session VM before the account is invited and has finished sign-up',
            async run() {
                const waitlisted = await as('waitlisted');
                strict_1.default.equal((await waitlisted.getAccount()).access, 'waitlisted');
                await (0, cases_1.expectError)('not_invited', async () => waitlisted.createVm(await personalOrg(waitlisted), 'nope', (0, node_crypto_1.randomUUID)()));
                const unverified = await as('unverified');
                strict_1.default.notEqual((await unverified.getAccount()).signupState, 'ready');
                await (0, cases_1.expectError)('signup_incomplete', async () => unverified.createVm(await personalOrg(unverified), 'nope', (0, node_crypto_1.randomUUID)()));
            },
        },
        {
            name: 'service: create, stop, start and delete a Session VM, each logged with who and why, and a retried create returns the same VM',
            async run() {
                const member = await as('member');
                const organizationId = await personalOrg(member);
                const { id: accountId } = await member.getAccount();
                const key = (0, node_crypto_1.randomUUID)();
                const first = await member.createVm(organizationId, 'lifecycle', key);
                try {
                    strict_1.default.equal((await member.createVm(organizationId, 'lifecycle', key)).vm.id, first.vm.id);
                    const vm = await vmIn(member, first.vm.id, 'running');
                    strict_1.default.equal(vm.organizationId, organizationId);
                    strict_1.default.equal(vm.createdByAccountId, accountId);
                    strict_1.default.equal(vm.memoryGiB, 8);
                    strict_1.default.ok((await member.listVms(organizationId)).vms.some((v) => v.id === vm.id));
                    await member.stopVm(vm.id);
                    strict_1.default.equal((await vmIn(member, vm.id, 'stopped')).stateReason, 'user');
                    await (0, cases_1.expectError)('invalid_state', () => member.stopVm(vm.id));
                    await member.startVm(vm.id);
                    await vmIn(member, vm.id, 'running');
                    const { entries } = await member.listActionLog(vm.id);
                    for (const operation of ['create', 'stop', 'start']) {
                        const entry = entries.find((e) => e.operation === operation);
                        strict_1.default.ok(entry, `the action log lists ${operation}`);
                        strict_1.default.deepEqual(entry.actor, { kind: 'user', accountId });
                    }
                    const ordered = entries.map((e) => Date.parse(e.requestedAt));
                    strict_1.default.deepEqual(ordered, [...ordered].sort((a, b) => b - a), 'the action log is newest first');
                    const page = await member.listActionLog(vm.id, { limit: 1 });
                    strict_1.default.equal(page.entries.length, 1);
                    strict_1.default.ok(page.nextCursor, 'a log longer than the page has a cursor');
                    strict_1.default.notEqual((await member.listActionLog(vm.id, { before: page.nextCursor, limit: 1 })).entries[0]?.id, page.entries[0]?.id);
                    await member.deleteVm(vm.id);
                    await vmIn(member, vm.id, 'deleted');
                    strict_1.default.ok(!(await member.listVms(organizationId)).vms.some((v) => v.id === vm.id), 'a deleted VM leaves the list');
                }
                finally {
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
                    strict_1.default.ok(found);
                    return found;
                };
                const { awakeLimit, awakeNow } = await me();
                const created = [];
                try {
                    for (let i = awakeNow; i < awakeLimit; i += 1)
                        created.push((await member.createVm(organizationId, `awake ${i + 1}`, (0, node_crypto_1.randomUUID)())).vm.id);
                    strict_1.default.equal((await me()).awakeNow, awakeLimit);
                    await (0, cases_1.expectError)('awake_limit_reached', () => member.createVm(organizationId, 'one too many', (0, node_crypto_1.randomUUID)()));
                    const [first] = created;
                    strict_1.default.ok(first);
                    await vmIn(member, first, 'running');
                    await member.stopVm(first);
                    await vmIn(member, first, 'stopped');
                    created.push((await member.createVm(organizationId, 'after a stop', (0, node_crypto_1.randomUUID)())).vm.id);
                    await (0, cases_1.expectError)('awake_limit_reached', () => member.startVm(first));
                }
                finally {
                    await cleanUp(member, created);
                }
            },
        },
        {
            name: 'service: runs only allow-listed operations, with fixed parameters',
            async run() {
                await withVm(async (member, vm) => {
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(vm.id, { operation: 'run_script', parameters: { script: 'id' } }));
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(vm.id, { operation: 'grant_access', parameters: { email: target.emails.waitlisted } }));
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(vm.id, { operation: 'bootstrap', parameters: {} }));
                    await (0, cases_1.expectError)('invalid_request', () => rawOperation(vm.id, { operation: 'update_pane', parameters: { url: 'https://example.com/pane.deb' } }));
                    await (0, cases_1.expectError)('release_not_published', () => member.requestOperation(vm.id, { operation: 'update_pane', parameters: { version: '0.0.1' } }));
                    const entry = await member.requestOperation(vm.id, { operation: 'collect_diagnostics', parameters: {} });
                    strict_1.default.equal(entry.operation, 'collect_diagnostics');
                    strict_1.default.ok((await member.listActionLog(vm.id)).entries.some((e) => e.id === entry.id), 'the operation is in the action log');
                });
            },
        },
        {
            name: 'service: pairing a running Session VM gives a one-time link for the relay identity the service vouches for, the same identity after a stop and start, logged without the link',
            async run() {
                await withVm(async (member, vm) => {
                    strict_1.default.equal(vm.relay, null, 'a VM no device has paired with has no vouched identity yet');
                    const first = await member.pairVm(vm.id);
                    const link = new URL(first.link);
                    const fragment = new URLSearchParams(link.hash.slice(1));
                    strict_1.default.equal(link.host, first.relay.domain, 'the link is under the relay domain');
                    strict_1.default.equal(fragment.get('c'), first.relay.computerId, 'the link names the vouched computer');
                    strict_1.default.ok(fragment.get('s'), 'the link carries a one-time secret');
                    strict_1.default.deepEqual((await member.getVm(vm.id)).relay, first.relay, 'the VM shows the identity the service vouches for');
                    await member.stopVm(vm.id);
                    await vmIn(member, vm.id, 'stopped');
                    await (0, cases_1.expectError)('invalid_state', () => member.pairVm(vm.id));
                    await member.startVm(vm.id);
                    await vmIn(member, vm.id, 'running');
                    const second = await member.pairVm(vm.id);
                    strict_1.default.deepEqual(second.relay, first.relay, 'the relay identity survives a stop and start');
                    strict_1.default.notEqual(second.link, first.link, 'each pairing gets a new link');
                    const logged = (await member.listActionLog(vm.id)).entries.filter((e) => e.operation === 'create_pairing_link');
                    strict_1.default.equal(logged.length, 2, 'each pairing is in the action log');
                    const firstLogged = logged.at(-1);
                    strict_1.default.ok(firstLogged && Date.parse(first.expiresAt) - Date.parse(firstLogged.requestedAt) <= 10 * 60_000, 'the link lasts at most 10 minutes');
                    const secret = fragment.get('s') ?? '';
                    strict_1.default.ok(logged.every((e) => !JSON.stringify(e).includes(secret)), 'the action log never holds the link');
                    await (0, cases_1.expectError)('vm_not_found', async () => (await as('waitlisted')).pairVm(vm.id));
                });
            },
        },
        {
            name: 'service: keeps the first relay identity a Session VM reported and refuses to pair one that reports another (relay_key_changed)',
            async run() {
                const replaceRelayKey = control('replaceRelayKey');
                await withVm(async (member, vm) => {
                    const { relay } = await member.pairVm(vm.id);
                    await replaceRelayKey(vm.id);
                    await (0, cases_1.expectError)('relay_key_changed', () => member.pairVm(vm.id));
                    strict_1.default.deepEqual((await member.getVm(vm.id)).relay, relay, 'the vouched identity stays the first one');
                });
            },
        },
        {
            name: 'service: a creator who is now View only, or no longer a member, cannot pair a device with the Session VM',
            async run() {
                const addMember = control('addMember');
                const changeMember = control('changeMember');
                const member = await as('member');
                const team = await personalOrg(await as('unverified'));
                await addMember('member', team, 'full_access');
                await changeMember('member', team, 'full_access');
                const { vm } = await member.createVm(team, 'team pairing', (0, node_crypto_1.randomUUID)());
                try {
                    await vmIn(member, vm.id, 'running');
                    await member.pairVm(vm.id);
                    await changeMember('member', team, 'view_only');
                    await (0, cases_1.expectError)('view_only', () => member.pairVm(vm.id));
                    await changeMember('member', team, null);
                    await (0, cases_1.expectError)('not_org_member', () => member.pairVm(vm.id));
                    strict_1.default.equal((await member.listActionLog(vm.id)).entries.filter((e) => e.operation === 'create_pairing_link').length, 1, 'a refused pairing is not logged as one');
                }
                finally {
                    await addMember('member', team, 'full_access');
                    await changeMember('member', team, 'full_access');
                    await cleanUp(member, [vm.id]);
                }
            },
        },
        {
            name: "service: another account cannot read or change a member's Session VM or organization",
            async run() {
                await withVm(async (member, vm) => {
                    const other = await as('waitlisted');
                    await (0, cases_1.expectError)('vm_not_found', () => other.getVm(vm.id));
                    await (0, cases_1.expectError)('vm_not_found', () => other.stopVm(vm.id));
                    await (0, cases_1.expectError)('vm_not_found', () => other.listActionLog(vm.id));
                    await (0, cases_1.expectError)('vm_not_found', () => other.startVm(vm.id));
                    await (0, cases_1.expectError)('vm_not_found', () => other.deleteVm(vm.id));
                    await (0, cases_1.expectError)('vm_not_found', () => other.requestOperation(vm.id, { operation: 'collect_diagnostics', parameters: {} }));
                    await (0, cases_1.expectError)('not_org_member', () => other.createVm(vm.organizationId, 'not mine', (0, node_crypto_1.randomUUID)()));
                    await (0, cases_1.expectError)('not_org_member', () => other.listVms(vm.organizationId));
                    await (0, cases_1.expectError)('not_org_member', () => other.getUsage(vm.organizationId));
                    strict_1.default.ok((await member.listVms(vm.organizationId)).vms.some((v) => v.id === vm.id));
                });
            },
        },
        {
            name: 'service: a VM paused for review answers under_review to start',
            async run() {
                const pause = control('pauseForReview');
                await withVm(async (member, vm) => {
                    await pause(vm.id);
                    strict_1.default.equal((await vmIn(member, vm.id, 'stopped')).stateReason, 'review');
                    await (0, cases_1.expectError)('under_review', () => member.startVm(vm.id));
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
                    await (0, cases_1.expectError)('no_capacity', async () => member.createVm(await personalOrg(member), 'no room', (0, node_crypto_1.randomUUID)()));
                }
                finally {
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
                strict_1.default.equal(usage.agentHours.limit, 600, 'two Full access members pool 2 x 300 hours; View only adds none');
                const viewer = usage.members.find((m) => m.role === 'view_only');
                strict_1.default.equal(viewer?.awakeLimit, 0);
                await (0, cases_1.expectError)('view_only', async () => (await as('waitlisted')).createVm(team, 'read only', (0, node_crypto_1.randomUUID)()));
                const own = await personalOrg(member);
                const { id: accountId } = await member.getAccount();
                const created = [];
                try {
                    for (let i = 0; i < 5; i += 1)
                        created.push((await member.createVm(own, `personal ${i + 1}`, (0, node_crypto_1.randomUUID)())).vm.id);
                    const inTeam = (await member.getUsage(team)).members.find((m) => m.accountId === accountId);
                    strict_1.default.equal(inTeam?.awakeNow, 5, "awakeNow counts the member's VMs in every organization");
                    await (0, cases_1.expectError)('awake_limit_reached', () => member.createVm(team, 'sixth', (0, node_crypto_1.randomUUID)()));
                    const setPlan = target.controls?.setPlan;
                    if (setPlan) {
                        await setPlan(team, 'pro');
                        strict_1.default.equal((await member.getUsage(own)).members.find((m) => m.accountId === accountId)?.awakeLimit, 20, 'the highest limit among memberships applies everywhere');
                        created.push((await member.createVm(team, 'sixth on Pro', (0, node_crypto_1.randomUUID)())).vm.id);
                        await setPlan(team, 'free');
                    }
                }
                finally {
                    await cleanUp(member, created);
                }
            },
        },
        {
            name: 'service: a sealing key is an X25519 key good for one create; a waitlisted account gets none, and a used or unknown key answers sealing_key_expired',
            async run() {
                await (0, cases_1.expectError)('not_invited', async () => (await as('waitlisted')).createSealingKey(await personalOrg(await as('waitlisted'))));
                const member = await as('member');
                const organizationId = await personalOrg(member);
                const key = await member.createSealingKey(organizationId);
                strict_1.default.equal(Buffer.from(key.publicKey, 'base64url').length, 32, 'a raw X25519 public key');
                const created = [];
                try {
                    created.push((await member.createVm(organizationId, 'sealing key', (0, node_crypto_1.randomUUID)(), { repo: PUBLIC_REPO, sealingKeyId: key.keyId })).vm.id);
                    await (0, cases_1.expectError)('sealing_key_expired', () => member.createVm(organizationId, 'reused key', (0, node_crypto_1.randomUUID)(), { repo: PUBLIC_REPO, sealingKeyId: key.keyId }));
                    await (0, cases_1.expectError)('sealing_key_expired', () => member.createVm(organizationId, 'unknown key', (0, node_crypto_1.randomUUID)(), { repo: PUBLIC_REPO, sealingKeyId: 'seal_unknown' }));
                }
                finally {
                    await cleanUp(member, created);
                }
            },
        },
        {
            name: "service: a create with a repo clones it and reports progress until the Pane id; the sealed GitHub token is in no answer, refusal or action log entry",
            async run() {
                const member = await as('member');
                const organizationId = await personalOrg(member);
                const token = `gho_contract${(0, node_crypto_1.randomUUID)().replaceAll('-', '')}`;
                const record = { token, source: 'contract-desktop', updatedAt: new Date().toISOString() };
                const key = await member.createSealingKey(organizationId);
                const sealed = await (0, sealing_1.sealGitHubToken)(key.publicKey, record);
                const leaks = (text) => text.includes(token) || text.includes(sealed);
                const refused = async (call) => {
                    try {
                        await call();
                    }
                    catch (error) {
                        strict_1.default.ok(error instanceof errors_1.CloudApiError && error.code === 'invalid_request', `expected invalid_request, got ${String(error)}`);
                        strict_1.default.ok(!leaks(`${error.message} ${error.next}`), 'a refusal never repeats the token');
                        return;
                    }
                    strict_1.default.fail('expected the create to be refused');
                };
                await refused(() => member.createVm(organizationId, 'not github', (0, node_crypto_1.randomUUID)(), { repo: { url: 'https://gitlab.com/example/repo', branch: 'main' }, sealingKeyId: key.keyId, sealedGitHubToken: sealed }));
                await refused(() => member.createVm(organizationId, 'no key', (0, node_crypto_1.randomUUID)(), { repo: PUBLIC_REPO, sealedGitHubToken: sealed }));
                await refused(() => member.createVm(organizationId, 'credentials in url', (0, node_crypto_1.randomUUID)(), { repo: { url: `https://x-access-token:${token}@github.com/expressjs/express`, branch: 'master' } }));
                const created = await member.createVm(organizationId, 'clone', (0, node_crypto_1.randomUUID)(), { repo: PUBLIC_REPO, sealingKeyId: key.keyId, sealedGitHubToken: sealed });
                try {
                    strict_1.default.ok(!leaks(JSON.stringify(created)), 'the create answer never holds the token');
                    strict_1.default.equal(created.vm.clone?.repo, 'expressjs/express');
                    const reads = [];
                    const ready = await (0, cases_1.waitFor)(async () => {
                        const read = await member.getVm(created.vm.id);
                        reads.push(read);
                        return read;
                    }, (v) => v.clone?.state === 'ready' || v.clone?.state === 'failed', 'the clone to finish', timeoutMs);
                    strict_1.default.equal(ready.clone?.state, 'ready', `the clone failed: ${ready.clone?.error?.message ?? ''}`);
                    strict_1.default.ok(ready.clone?.paneId, 'a finished clone names the Pane it made');
                    strict_1.default.ok(reads.some((v) => v.clone?.state === 'cloning' && v.clone.phase !== null), 'reads during the clone show its phase');
                    await (0, cases_1.expectError)('invalid_state', () => member.retryClone(created.vm.id));
                    const everything = [reads, await member.listVms(organizationId), await member.listActionLog(created.vm.id)];
                    strict_1.default.ok(!leaks(JSON.stringify(everything)), 'no VM read, list or action log entry holds the token');
                    const logged = (await member.listActionLog(created.vm.id)).entries.find((e) => e.operation === 'create');
                    strict_1.default.deepEqual(logged?.parameters, { repo: PUBLIC_REPO }, 'the action log shows the repo and nothing sealed');
                }
                finally {
                    await cleanUp(member, [created.vm.id]);
                }
            },
        },
        {
            name: "service: a clone that fails shows git's error and no Pane, and retryClone runs it again with a freshly sealed token",
            async run() {
                const member = await as('member');
                const organizationId = await personalOrg(member);
                const repo = { url: 'https://github.com/greenfield-inc/does-not-exist-pane-contract', branch: 'main' };
                const { vm } = await member.createVm(organizationId, 'failed clone', (0, node_crypto_1.randomUUID)(), { repo });
                try {
                    const failed = await (0, cases_1.waitFor)(() => member.getVm(vm.id), (v) => v.clone?.state === 'failed', 'the clone to fail', timeoutMs);
                    strict_1.default.ok(failed.clone?.error?.message, "a failed clone carries git's message");
                    strict_1.default.equal(failed.clone?.paneId, null, 'a failed clone makes no Pane');
                    strict_1.default.equal(failed.state, 'running', 'the VM stays up for a retry');
                    const key = await member.createVmSealingKey(vm.id);
                    const token = `gho_retry${(0, node_crypto_1.randomUUID)().replaceAll('-', '')}`;
                    await (0, cases_1.expectError)('invalid_request', async () => member.retryClone(vm.id, { sealedGitHubToken: await (0, sealing_1.sealGitHubToken)(key.publicKey, { token, source: 'contract-desktop', updatedAt: new Date().toISOString() }) }));
                    const sealed = await (0, sealing_1.sealGitHubToken)(key.publicKey, { token, source: 'contract-desktop', updatedAt: new Date().toISOString() });
                    const retried = await member.retryClone(vm.id, { sealingKeyId: key.keyId, sealedGitHubToken: sealed });
                    strict_1.default.equal(retried.operation.operation, 'retry_clone');
                    strict_1.default.deepEqual(retried.operation.parameters, {}, 'the retry is logged without the token');
                    strict_1.default.ok(!JSON.stringify([retried, await member.listActionLog(vm.id)]).includes(token), 'no answer holds the token');
                    strict_1.default.ok(!JSON.stringify(retried).includes(sealed));
                    await (0, cases_1.waitFor)(() => member.getVm(vm.id), (v) => v.clone?.state === 'failed', 'the retried clone to fail again', timeoutMs);
                }
                finally {
                    await cleanUp(member, [vm.id]);
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
                const used = async (month) => (await member.getUsage(own, month)).members.find((m) => m.accountId === accountId)?.agentHoursUsed ?? 0;
                await setClock('2027-01-31T23:00:00.000Z');
                const [janBefore, febBefore] = [await used('2027-01'), await used('2027-02')];
                const { vm } = await member.createVm(own, 'metered', (0, node_crypto_1.randomUUID)());
                try {
                    await vmIn(member, vm.id, 'running');
                    await setClock('2027-02-01T00:30:00.000Z');
                    strict_1.default.equal((await used('2027-01')) - janBefore, 1, 'the hour before midnight counts in January');
                    strict_1.default.equal((await used('2027-02')) - febBefore, 0.5, 'a running VM counts up to now');
                    await setMemoryGiB(vm.id, 16);
                    await setClock('2027-02-01T01:30:00.000Z');
                    strict_1.default.equal((await used('2027-02')) - febBefore, 2.5, 'an hour at 16 GiB counts as 2');
                    await member.stopVm(vm.id);
                    await vmIn(member, vm.id, 'stopped');
                    await setClock('2027-02-01T03:30:00.000Z');
                    strict_1.default.equal((await used('2027-02')) - febBefore, 2.5, 'a stopped VM counts nothing');
                }
                finally {
                    await cleanUp(member, [vm.id]);
                }
            },
        },
    ];
}
