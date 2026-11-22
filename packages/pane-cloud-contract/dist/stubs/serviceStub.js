"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServiceStub = startServiceStub;
const errors_1 = require("../errors");
const service_1 = require("../service");
const relayKey_1 = require("./relayKey");
const server_1 = require("./server");
const AWAKE = ['creating', 'starting', 'running'];
const HOUR = 3_600_000;
/**
 * An in-memory Pane Cloud service that keeps the contract, for building Pane against and for the
 * contract tests. Every account has a personal organization on the Free plan, and the awake limit spans
 * the account's organizations. VMs start and stop at
 * once, and agent-hours are counted from the stub's clock.
 */
async function startServiceStub(options) {
    const now = options.now ?? (() => new Date());
    const iso = () => now().toISOString();
    const versions = options.paneVersions ?? ['2.4.214', '2.4.215'];
    const latest = versions.at(-1) ?? '2.4.215';
    let capacity = options.capacity ?? Number.POSITIVE_INFINITY;
    const relayDomain = options.relayDomain ?? 'runpane.net';
    const plans = new Map();
    const planOf = (organizationId) => plans.get(organizationId) ?? 'free';
    let counter = 0;
    const nextId = (prefix) => `${prefix}_${(counter += 1)}`;
    const accounts = new Map(options.accounts.map((entry, index) => [
        entry.email.toLowerCase(),
        {
            id: `acct_${index + 1}`,
            email: entry.email,
            name: entry.name ?? null,
            access: entry.invited ? 'invited' : 'waitlisted',
            signupState: entry.signupState ?? 'ready',
            organizations: [{ organizationId: `org_${index + 1}`, name: 'Personal', personal: true, role: 'owner' }],
        },
    ]));
    const devices = new Map();
    const tokens = new Map();
    const vms = new Map();
    const idempotent = new Map();
    const byId = (accountId) => [...accounts.values()].find((a) => a.id === accountId);
    const caller = (token) => {
        const accountId = token ? tokens.get(token) : undefined;
        const account = accountId ? byId(accountId) : undefined;
        if (!account)
            throw new errors_1.CloudApiError('unauthenticated', 'The token is unknown or signed out.', 'Sign in again.');
        return account;
    };
    const membership = (account, organizationId) => {
        const found = account.organizations.find((m) => m.organizationId === organizationId);
        if (!found)
            throw new errors_1.CloudApiError('not_org_member', `You are not a member of organization ${organizationId}.`, 'Pick one of the organizations on your account.');
        return found;
    };
    const ownVm = (account, vmId) => {
        const record = vms.get(vmId);
        if (!record || record.vm.createdByAccountId !== account.id) {
            throw new errors_1.CloudApiError('vm_not_found', `You have no Session VM ${vmId}.`, 'List your Session VMs to find its id.');
        }
        return record;
    };
    const isAwake = (record) => AWAKE.includes(record.vm.state);
    /** VMs an account has awake, across every organization it belongs to (D-74). */
    const awakeOf = (accountId) => [...vms.values()].filter((r) => r.vm.createdByAccountId === accountId && isAwake(r)).length;
    /** The highest awake limit among the account's Full access memberships (D-74). */
    const awakeLimitOf = (account) => Math.max(0, ...account.organizations.filter((m) => m.role !== 'view_only').map((m) => service_1.PLANS[planOf(m.organizationId)].awakeLimitPerMember));
    const requireFullAccess = (account, organizationId) => {
        if (membership(account, organizationId).role === 'view_only') {
            throw new errors_1.CloudApiError('view_only', 'You have View only access to this organization, so you can read its shared Sessions but not create or start one.', 'Ask the organization Owner for Full access.');
        }
    };
    /** The checks before a VM wakes: the account's awake limit, then the host's room. */
    const requireRoomToWake = (account) => {
        const limit = awakeLimitOf(account);
        if (awakeOf(account.id) >= limit) {
            throw new errors_1.CloudApiError('awake_limit_reached', `You already have ${limit} Sessions running, the most your plan allows at once.`, 'Stop one of your Sessions, then try again.');
        }
        if ([...vms.values()].filter(isAwake).length >= capacity) {
            throw new errors_1.CloudApiError('no_capacity', 'The invite-only pool is full right now.', 'Stop one of your Sessions first, or try again later.');
        }
    };
    const setState = (record, state, reason) => {
        const wasAwake = isAwake(record);
        record.vm.state = state;
        record.vm.stateReason = reason;
        record.vm.updatedAt = iso();
        const open = record.awake.at(-1);
        if (wasAwake && !isAwake(record) && open)
            open.to = now().getTime();
        if (!wasAwake && isAwake(record))
            record.awake.push({ from: now().getTime(), to: null, memoryGiB: record.vm.memoryGiB });
    };
    const requireState = (record, state, action) => {
        if (record.vm.state !== state) {
            throw new errors_1.CloudApiError('invalid_state', `${action} needs a ${state} Session VM; it is ${record.vm.state}.`, 'Refresh the Session and try the action that fits its state.');
        }
    };
    const log = (record, operation, actor, reason, parameters = {}) => {
        const entry = {
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
    const releaseFor = (version) => ({ version, arch: 'arm64', debSha256: 'a'.repeat(64) });
    const agentHours = (record, from, to) => {
        const overlap = (i) => Math.max(0, Math.min(i.to ?? now().getTime(), to) - Math.max(i.from, from));
        return record.awake.reduce((sum, i) => sum + (overlap(i) / HOUR) * service_1.AGENT_HOURS_PER_AWAKE_HOUR[i.memoryGiB], 0);
    };
    const usage = (organizationId, month) => {
        const from = Date.parse(`${month}-01T00:00:00.000Z`);
        const reset = new Date(from);
        reset.setUTCMonth(reset.getUTCMonth() + 1);
        const to = reset.getTime();
        const inOrg = [...vms.values()].filter((r) => r.vm.organizationId === organizationId);
        const members = [...accounts.values()].flatMap((account) => {
            const member = account.organizations.find((m) => m.organizationId === organizationId);
            if (!member)
                return [];
            const used = inOrg.filter((r) => r.vm.createdByAccountId === account.id).reduce((sum, r) => sum + agentHours(r, from, to), 0);
            return [{ accountId: account.id, name: account.name, role: member.role, agentHoursUsed: used, awakeNow: awakeOf(account.id), awakeLimit: member.role === 'view_only' ? 0 : awakeLimitOf(account) }];
        });
        const fullAccess = members.filter((m) => m.role !== 'view_only').length;
        return {
            organizationId,
            plan: planOf(organizationId),
            month,
            resetsAt: reset.toISOString(),
            agentHours: { used: members.reduce((sum, m) => sum + m.agentHoursUsed, 0), limit: service_1.PLANS[planOf(organizationId)].agentHoursPerMember * fullAccess },
            members,
        };
    };
    const r = service_1.serviceRoutes;
    const server = (0, server_1.createRouteServer)([
        (0, server_1.bind)(r.startDeviceSignIn, () => {
            const deviceCode = nextId('dev');
            const userCode = `STUB-${counter}`;
            devices.set(deviceCode, { userCode, state: 'pending', email: null });
            return { deviceCode, userCode, verificationUri: 'https://auth.example.test/device', verificationUriComplete: `https://auth.example.test/device?user_code=${userCode}`, expiresIn: 900, interval: 1 };
        }),
        (0, server_1.bind)(r.pollDeviceSignIn, ({ body }) => {
            const grant = devices.get(body.deviceCode);
            if (!grant || grant.state === 'used')
                return { status: 'expired' };
            if (grant.state === 'pending')
                return { status: 'pending' };
            if (grant.state === 'denied')
                return { status: 'denied' };
            grant.state = 'used';
            const account = accounts.get((grant.email ?? '').toLowerCase());
            if (!account)
                return { status: 'denied' };
            const token = nextId('tok');
            tokens.set(token, account.id);
            return { status: 'complete', token, expiresAt: new Date(now().getTime() + 30 * 86_400_000).toISOString(), account };
        }),
        (0, server_1.bind)(r.signOut, ({ token }) => {
            caller(token);
            tokens.delete(token ?? '');
            return { signedOut: true };
        }),
        (0, server_1.bind)(r.getAccount, ({ token }) => caller(token)),
        (0, server_1.bind)(r.listVms, ({ token, params }) => {
            const account = caller(token);
            const organizationId = params.organizationId ?? '';
            membership(account, organizationId);
            return { vms: [...vms.values()].filter((v) => v.vm.organizationId === organizationId && v.vm.createdByAccountId === account.id && v.vm.state !== 'deleted').map((v) => v.vm) };
        }),
        (0, server_1.bind)(r.createVm, ({ token, params, body }) => {
            const account = caller(token);
            const organizationId = params.organizationId ?? '';
            requireFullAccess(account, organizationId);
            const key = `${account.id}:${organizationId}:${body.idempotencyKey}`;
            const repeat = idempotent.get(key);
            const repeated = repeat ? vms.get(repeat.vmId) : undefined;
            const repeatedEntry = repeated?.log.find((e) => e.id === repeat?.entryId);
            if (repeated && repeatedEntry)
                return { vm: repeated.vm, operation: repeatedEntry };
            if (account.access !== 'invited')
                throw new errors_1.CloudApiError('not_invited', "You're on the list. Pane Cloud is invite-only for now.", 'Wait for your invite email.');
            if (account.signupState !== 'ready')
                throw new errors_1.CloudApiError('signup_incomplete', 'Finish signing up before you create a cloud Session.', account.signupState === 'needs_phone' ? 'Verify your phone number on the sign-up page.' : 'Add a card on the sign-up page.');
            requireRoomToWake(account);
            const id = nextId('vm');
            const record = {
                vm: { id, organizationId, createdByAccountId: account.id, name: body.name, state: 'stopped', stateReason: null, memoryGiB: 8, paneVersion: latest, relay: null, createdAt: iso(), updatedAt: iso() },
                awake: [],
                log: [],
                relayKey: (0, relayKey_1.newRelayIdentity)(relayDomain),
            };
            vms.set(id, record);
            setState(record, 'running', null);
            const entry = log(record, 'create', account, 'You created this Session.');
            log(record, 'bootstrap', 'service', 'First boot: install Pane.', { release: releaseFor(latest) });
            idempotent.set(key, { vmId: id, entryId: entry.id });
            return { vm: record.vm, operation: entry };
        }),
        (0, server_1.bind)(r.getVm, ({ token, params }) => ownVm(caller(token), params.vmId ?? '').vm),
        (0, server_1.bind)(r.startVm, ({ token, params }) => {
            const account = caller(token);
            const record = ownVm(account, params.vmId ?? '');
            if (record.vm.stateReason === 'review')
                throw new errors_1.CloudApiError('under_review', 'Your usage is under review, so this Session stays paused.', 'Check your email for the review notice, or reply to it to appeal.');
            requireState(record, 'stopped', 'Start');
            requireFullAccess(account, record.vm.organizationId);
            requireRoomToWake(account);
            setState(record, 'running', null);
            return { vm: record.vm, operation: log(record, 'start', account, 'You started this Session.') };
        }),
        (0, server_1.bind)(r.stopVm, ({ token, params }) => {
            const account = caller(token);
            const record = ownVm(account, params.vmId ?? '');
            requireState(record, 'running', 'Stop');
            log(record, 'prepare_to_stop', 'service', 'Let Pane finish writing before the stop.');
            setState(record, 'stopped', 'user');
            return { vm: record.vm, operation: log(record, 'stop', account, 'You stopped this Session.', { cause: 'user' }) };
        }),
        (0, server_1.bind)(r.deleteVm, ({ token, params }) => {
            const account = caller(token);
            const record = ownVm(account, params.vmId ?? '');
            if (record.vm.state === 'deleted')
                throw new errors_1.CloudApiError('invalid_state', 'This Session is already deleted.', 'Nothing to do.');
            setState(record, 'deleted', 'user');
            return { vm: record.vm, operation: log(record, 'delete', account, 'You deleted this Session and its disk.') };
        }),
        (0, server_1.bind)(r.requestOperation, ({ token, params, body }) => {
            const account = caller(token);
            const record = ownVm(account, params.vmId ?? '');
            const request = (0, service_1.parseUserOperation)(body);
            requireState(record, 'running', request.operation);
            if (request.operation === 'update_pane') {
                const version = request.parameters.version ?? latest;
                if (!versions.includes(version))
                    throw new errors_1.CloudApiError('release_not_published', `Pane ${version} is not a published release.`, `Pick one of: ${versions.join(', ')}.`);
                record.vm.paneVersion = version;
                return log(record, 'update_pane', account, `You updated Pane to ${version}.`, { release: releaseFor(version) });
            }
            return log(record, 'collect_diagnostics', account, 'You collected diagnostics.');
        }),
        (0, server_1.bind)(r.pairVm, ({ token, params }) => {
            const account = caller(token);
            const record = ownVm(account, params.vmId ?? '');
            requireState(record, 'running', 'Pairing');
            const reported = record.relayKey;
            const vouched = record.vm.relay;
            if (vouched && (vouched.computerId !== reported.computerId || vouched.fingerprint !== reported.fingerprint || vouched.domain !== reported.domain)) {
                throw new errors_1.CloudApiError('relay_key_changed', `This Session now reports relay key ${reported.computerId}, not ${vouched.computerId}, the one it paired with first, so no device was paired.`, 'Write to support with the Session name; its devices keep refusing the new key.');
            }
            record.vm.relay = reported;
            log(record, 'create_pairing_link', account, 'You paired a device with this Session.');
            return (0, relayKey_1.pairingLinkFor)(reported, record.vm.name, now());
        }),
        (0, server_1.bind)(r.listActionLog, ({ token, params, query }) => {
            const all = ownVm(caller(token), params.vmId ?? '').log;
            const cursorAt = query.before ? all.findIndex((e) => e.id === query.before) : -1;
            if (query.before && cursorAt < 0)
                throw new errors_1.CloudApiError('invalid_request', `Unknown cursor ${query.before}.`, 'Pass a nextCursor from an earlier page, or no cursor for the newest entries.');
            const start = cursorAt + 1;
            const entries = all.slice(start, start + (query.limit ?? 50));
            const last = entries.at(-1);
            return { entries, nextCursor: last && start + entries.length < all.length ? last.id : null };
        }),
        (0, server_1.bind)(r.getUsage, ({ token, params, query }) => {
            const organizationId = params.organizationId ?? '';
            membership(caller(token), organizationId);
            return usage(organizationId, query.month ?? iso().slice(0, 7));
        }),
    ]);
    const running = await (0, server_1.listen)(server);
    const grantFor = (userCode) => {
        const grant = [...devices.values()].find((d) => d.userCode === userCode);
        if (!grant)
            throw new Error(`stub: no device code ${userCode}`);
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
            if (!account)
                throw new Error(`stub: no account ${email}`);
            if (!account.organizations.some((m) => m.organizationId === organizationId))
                account.organizations.push({ organizationId, name: `Organization ${organizationId}`, personal: false, role });
        },
        setPlan(organizationId, plan) {
            plans.set(organizationId, plan);
        },
        setMemoryGiB(vmId, memoryGiB) {
            const record = vms.get(vmId);
            if (!record)
                throw new Error(`stub: no Session VM ${vmId}`);
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
            if (!record)
                throw new Error(`stub: no Session VM ${vmId}`);
            setState(record, 'stopped', 'review');
            log(record, 'stop', 'service', 'Paused while your usage is under review.', { cause: 'review' });
        },
        replaceRelayKey(vmId) {
            const record = vms.get(vmId);
            if (!record)
                throw new Error(`stub: no Session VM ${vmId}`);
            record.relayKey = (0, relayKey_1.newRelayIdentity)(relayDomain);
        },
    };
}
