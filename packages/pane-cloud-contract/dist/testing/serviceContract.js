"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceContractCases = serviceContractCases;
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const http_1 = require("../http");
const service_1 = require("../service");
const cases_1 = require("./cases");
/** The service API contract: what S1 must do for the desktop adapter. */
function serviceContractCases(target) {
    const timeoutMs = target.timeoutMs ?? 180_000;
    const tokens = new Map();
    const tokenFor = async (who) => {
        const token = tokens.get(who) ?? (await target.signIn(who));
        tokens.set(who, token);
        return token;
    };
    const as = async (who) => (0, service_1.createServiceClient)({ baseUrl: target.baseUrl, token: await tokenFor(who) });
    /** Sends an operation request as written, including ones the typed client would not let you write. */
    const rawOperation = async (machineId, body) => (0, http_1.callRoute)({ baseUrl: target.baseUrl, token: await tokenFor('owner') }, service_1.serviceRoutes.requestOperation, { params: { machineId }, body });
    const machineIn = (client, machineId, state) => (0, cases_1.waitFor)(() => client.getMachine(machineId), (m) => m.state === state, `machine ${machineId} to be ${state}`, timeoutMs);
    const withMachine = async (body) => {
        const owner = await as('owner');
        const { machine } = await owner.createMachine('contract test', (0, node_crypto_1.randomUUID)());
        try {
            await body(owner, await machineIn(owner, machine.id, 'running'));
        }
        finally {
            const current = await owner.getMachine(machine.id);
            if (current.state !== 'deleted' && current.state !== 'deleting')
                await owner.deleteMachine(machine.id);
        }
    };
    return [
        {
            name: 'service: device sign-in starts with a GitHub code, and a call without a token is refused',
            async run() {
                const anonymous = (0, service_1.createServiceClient)({ baseUrl: target.baseUrl });
                const code = await anonymous.startDeviceSignIn();
                strict_1.default.ok(code.userCode.length > 0);
                strict_1.default.equal((await anonymous.pollDeviceSignIn(code.deviceCode)).status, 'pending');
                await (0, cases_1.expectError)('unauthenticated', () => anonymous.getAccount());
            },
        },
        {
            name: 'service: a waitlisted account is told it is on the list and cannot create a machine',
            async run() {
                const outsider = await as('outsider');
                const account = await outsider.getAccount();
                strict_1.default.equal(account.githubLogin.toLowerCase(), target.logins.outsider.toLowerCase());
                strict_1.default.equal(account.access, 'waitlisted');
                await (0, cases_1.expectError)('not_invited', () => outsider.createMachine('nope', (0, node_crypto_1.randomUUID)()));
            },
        },
        {
            name: 'service: create, stop, start and delete a machine, each logged with who and why',
            async run() {
                await withMachine(async (owner, machine) => {
                    strict_1.default.equal(machine.limits.dailyCpuSeconds, 43_200);
                    strict_1.default.equal(machine.shared, false);
                    strict_1.default.equal((await owner.listMachines()).machines.filter((m) => m.state !== 'deleted').length, 1);
                    await owner.stopMachine(machine.id);
                    await machineIn(owner, machine.id, 'stopped');
                    await (0, cases_1.expectError)('invalid_state', () => owner.stopMachine(machine.id));
                    await owner.startMachine(machine.id);
                    await machineIn(owner, machine.id, 'running');
                    const { entries } = await owner.listActionLog(machine.id);
                    for (const operation of ['create', 'stop', 'start']) {
                        const entry = entries.find((e) => e.operation === operation);
                        strict_1.default.ok(entry, `the action log lists ${operation}`);
                        strict_1.default.equal(entry.actor.kind, 'user');
                        strict_1.default.equal(entry.actor.githubLogin?.toLowerCase(), target.logins.owner.toLowerCase());
                    }
                    const ordered = entries.map((e) => Date.parse(e.requestedAt));
                    strict_1.default.deepEqual(ordered, [...ordered].sort((a, b) => b - a), 'the action log is newest first');
                    await owner.deleteMachine(machine.id);
                    const gone = await (0, cases_1.waitFor)(() => owner.getMachine(machine.id), (m) => m.state === 'deleted', 'the machine to be deleted', timeoutMs);
                    strict_1.default.equal(gone.state, 'deleted');
                    strict_1.default.ok(!(await owner.listMachines()).machines.some((m) => m.id === machine.id), 'a deleted machine leaves the list');
                });
            },
        },
        {
            name: 'service: one machine per seat, and a retried create returns the same machine',
            async run() {
                const owner = await as('owner');
                const key = (0, node_crypto_1.randomUUID)();
                const first = await owner.createMachine('seat test', key);
                try {
                    const retried = await owner.createMachine('seat test', key);
                    strict_1.default.equal(retried.machine.id, first.machine.id);
                    await (0, cases_1.expectError)('seat_has_machine', () => owner.createMachine('second', (0, node_crypto_1.randomUUID)()));
                }
                finally {
                    await machineIn(owner, first.machine.id, 'running');
                    await owner.deleteMachine(first.machine.id);
                }
            },
        },
        {
            name: 'service: runs only allow-listed operations, with fixed parameters',
            async run() {
                await withMachine(async (owner, machine) => {
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(machine.id, { operation: 'run_script', parameters: { script: 'id' } }));
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(machine.id, { operation: 'grant_access', parameters: { githubLogin: target.logins.outsider } }));
                    await (0, cases_1.expectError)('operation_not_allowed', () => rawOperation(machine.id, { operation: 'bootstrap', parameters: {} }));
                    await (0, cases_1.expectError)('invalid_request', () => rawOperation(machine.id, { operation: 'update_pane', parameters: { url: 'https://example.com/pane.deb' } }));
                    await (0, cases_1.expectError)('release_not_published', () => owner.requestOperation(machine.id, { operation: 'update_pane', parameters: { version: '0.0.1' } }));
                    const entry = await owner.requestOperation(machine.id, { operation: 'collect_diagnostics', parameters: {} });
                    strict_1.default.equal(entry.operation, 'collect_diagnostics');
                    const { entries } = await owner.listActionLog(machine.id);
                    strict_1.default.ok(entries.some((e) => e.id === entry.id), 'the operation is in the action log');
                });
            },
        },
        {
            name: "service: another account cannot read or change the owner's machine",
            async run() {
                await withMachine(async (_owner, machine) => {
                    const outsider = await as('outsider');
                    await (0, cases_1.expectError)('machine_not_found', () => outsider.getMachine(machine.id));
                    await (0, cases_1.expectError)('machine_not_found', () => outsider.stopMachine(machine.id));
                    await (0, cases_1.expectError)('machine_not_found', () => outsider.listActionLog(machine.id));
                });
            },
        },
        {
            name: 'service: the beta end date is public, and its notice dates follow from it',
            async run() {
                const beta = await (0, service_1.createServiceClient)({ baseUrl: target.baseUrl }).getBeta();
                if (beta.endsAt === null) {
                    strict_1.default.equal(beta.noticeAt, null);
                    strict_1.default.equal(beta.pushWindowsFrom, null);
                    strict_1.default.equal(beta.phase, 'open');
                    return;
                }
                const ends = Date.parse(beta.endsAt);
                strict_1.default.equal(Date.parse(beta.noticeAt ?? ''), ends - 30 * 86_400_000, 'notice starts 30 days before the end');
                strict_1.default.equal(Date.parse(beta.pushWindowsFrom ?? ''), ends - 14 * 86_400_000, 'push windows start 14 days before the end');
            },
        },
        {
            name: "service: billing status is the team's",
            async run() {
                const owner = await as('owner');
                const account = await owner.getAccount();
                const billing = await owner.getBilling();
                strict_1.default.equal(billing.teamId, account.teamId);
                strict_1.default.ok(billing.seats >= 1);
            },
        },
        {
            name: 'service: invite a teammate, list the roster and shared machines, relay a connection code once, and withdraw it on unshare or removal',
            async run() {
                const owner = await as('owner');
                const teammate = await as('teammate');
                const invite = await owner.createInvite(target.logins.teammate);
                strict_1.default.equal(invite.status, 'pending');
                strict_1.default.ok((await teammate.getAccount()).pendingInvites.some((i) => i.id === invite.id), 'the teammate sees the invite');
                const joined = await teammate.acceptInvite(invite.id);
                strict_1.default.equal(joined.role, 'member');
                try {
                    await (0, cases_1.expectError)('not_team_owner', () => teammate.createInvite(target.logins.outsider));
                    const confirmed = await teammate.setTailscaleLogin(`${target.logins.teammate}@github`);
                    const team = await owner.getTeam();
                    strict_1.default.ok(team.members.some((m) => m.accountId === joined.id && m.tailscaleLogin === confirmed.tailscaleLogin), 'the roster lists the teammate with their Tailscale login');
                    strict_1.default.equal((await owner.getBilling()).seats, team.members.length, 'each member is a seat');
                    await withMachine(async (ownerClient, machine) => {
                        strict_1.default.ok(!(await teammate.listSharedMachines()).machines.some((m) => m.machineId === machine.id), 'an unshared machine is not listed');
                        await (0, cases_1.expectError)('invalid_state', () => ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: 'x', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
                        await ownerClient.setSharing(machine.id, true);
                        const listed = (await teammate.listSharedMachines()).machines.find((m) => m.machineId === machine.id);
                        strict_1.default.ok(listed, 'the shared machine is in the team directory');
                        strict_1.default.equal(listed.owner.githubLogin.toLowerCase(), target.logins.owner.toLowerCase());
                        await (0, cases_1.expectError)('machine_not_found', () => teammate.getMachine(machine.id));
                        await (0, cases_1.expectError)('machine_not_found', () => teammate.stopMachine(machine.id));
                        const code = `pane-code-${(0, node_crypto_1.randomUUID)()}`;
                        await (0, cases_1.expectError)('invalid_request', () => ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
                        await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code, expiresAt: new Date(Date.now() + 300_000).toISOString() });
                        await (0, cases_1.expectError)('connection_code_not_found', async () => (await as('outsider')).claimConnectionCode(machine.id));
                        strict_1.default.equal((await teammate.claimConnectionCode(machine.id)).code, code);
                        await (0, cases_1.expectError)('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
                        const soon = () => new Date(Date.now() + 300_000).toISOString();
                        await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: `${code}-2`, expiresAt: soon() });
                        await ownerClient.setSharing(machine.id, false);
                        await (0, cases_1.expectError)('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
                        await ownerClient.setSharing(machine.id, true);
                        await ownerClient.leaveConnectionCode(machine.id, { forAccountId: joined.id, code: `${code}-3`, expiresAt: soon() });
                        await owner.removeMember(joined.id);
                        await (0, cases_1.expectError)('connection_code_not_found', () => teammate.claimConnectionCode(machine.id));
                    });
                }
                finally {
                    if ((await owner.getTeam()).members.some((m) => m.accountId === joined.id))
                        await owner.removeMember(joined.id);
                }
                await (0, cases_1.expectError)('not_team_member', () => teammate.listSharedMachines());
                strict_1.default.ok(!(await owner.getTeam()).members.some((m) => m.accountId === joined.id));
            },
        },
    ];
}
