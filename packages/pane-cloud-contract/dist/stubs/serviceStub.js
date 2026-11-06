"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServiceStub = startServiceStub;
const errors_1 = require("../errors");
const fleet_1 = require("../fleet");
const service_1 = require("../service");
const server_1 = require("./server");
/**
 * An in-memory Pane Cloud service that keeps the contract, for building the desktop adapter and for
 * the contract tests. Machines start and stop at once.
 */
async function startServiceStub(options) {
    const now = options.now ?? (() => new Date());
    const iso = () => now().toISOString();
    const versions = options.paneVersions ?? ['2.4.214', '2.4.215'];
    const latest = versions.at(-1) ?? '2.4.215';
    let counter = 0;
    const nextId = (prefix) => `${prefix}_${(counter += 1)}`;
    const accounts = new Map();
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
    const devices = new Map();
    const tokens = new Map();
    const teams = new Map();
    const invites = new Map();
    const machines = new Map();
    const logs = new Map();
    const idempotent = new Map();
    const codes = new Map();
    const dropCodes = (match) => {
        for (const key of [...codes.keys()])
            if (match(key))
                codes.delete(key);
    };
    const DAY = 86_400_000;
    const beta = () => {
        const ends = options.beta ? Date.parse(options.beta.endsAt) : null;
        const nowMs = now().getTime();
        const at = (ms) => (ms === null ? null : new Date(ms).toISOString());
        const noticeAt = ends === null ? null : ends - service_1.BETA_NOTICE_DAYS * DAY;
        const pushFrom = ends === null ? null : ends - service_1.BETA_PUSH_WINDOW_DAYS * DAY;
        let phase = 'open';
        if (ends !== null && noticeAt !== null && pushFrom !== null) {
            if (nowMs >= ends)
                phase = 'ended';
            else if (nowMs >= pushFrom)
                phase = 'push_windows';
            else if (nowMs >= noticeAt)
                phase = 'notice';
        }
        return {
            endsAt: at(ends),
            noticeAt: at(noticeAt),
            pushWindowsFrom: at(pushFrom),
            phase,
            pushWindowMinutes: service_1.BETA_PUSH_WINDOW_MINUTES,
            announcementUrl: options.beta?.announcementUrl ?? null,
            ownAwsTemplateUrl: options.beta?.ownAwsTemplateUrl ?? null,
        };
    };
    const byId = (accountId) => [...accounts.values()].find((r) => r.account.id === accountId);
    const view = (record) => ({
        ...record.account,
        pendingInvites: [...invites.values()].filter((i) => i.status === 'pending' && i.githubLogin.toLowerCase() === record.account.githubLogin.toLowerCase()),
    });
    const caller = (token) => {
        const accountId = token ? tokens.get(token) : undefined;
        const record = accountId ? byId(accountId) : undefined;
        if (!record)
            throw new errors_1.CloudApiError('unauthenticated', 'The token is unknown or signed out.', 'Sign in again.');
        return record;
    };
    const teamOf = (record) => {
        const team = record.account.teamId ? teams.get(record.account.teamId) : undefined;
        if (!team)
            throw new errors_1.CloudApiError('not_team_member', 'This account is not on a team yet.', 'Accept a team invite, or ask to join the cohort.');
        return team;
    };
    const requireOwner = (record) => {
        const team = teamOf(record);
        if (team.ownerId !== record.account.id)
            throw new errors_1.CloudApiError('not_team_owner', 'Only the team owner can do this.', 'Ask your team owner.');
        return team;
    };
    const ownMachine = (record, machineId) => {
        const machine = machines.get(machineId);
        if (!machine || machine.ownerAccountId !== record.account.id) {
            throw new errors_1.CloudApiError('machine_not_found', `You have no machine ${machineId}.`, 'List your machines to find its id.');
        }
        return machine;
    };
    const publicMachine = ({ cpuSecondsUsed, ...machine }) => {
        const day = iso().slice(0, 10);
        const reset = new Date(`${day}T00:00:00.000Z`);
        reset.setUTCDate(reset.getUTCDate() + 1);
        return {
            ...machine,
            usage: machine.state === 'deleted' ? null : { day, cpuSecondsUsed, throttled: cpuSecondsUsed >= fleet_1.MACHINE_LIMITS.dailyCpuSeconds, resetsAt: reset.toISOString(), egressBytesThisMonth: 0, diskUsedBytes: 4 * 1024 ** 3 },
        };
    };
    const log = (machine, operation, actor, reason, parameters = {}) => {
        const entry = {
            id: nextId('act'),
            machineId: machine.id,
            operation,
            parameters,
            actor: actor === 'service' || actor === 'host'
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
    const setState = (machine, state, reason) => {
        machine.state = state;
        machine.stateReason = reason;
        machine.updatedAt = iso();
    };
    const requireState = (machine, state, action) => {
        if (machine.state !== state)
            throw new errors_1.CloudApiError('invalid_state', `${action} needs a ${state} machine; it is ${machine.state}.`, 'Refresh the machine and try the action that fits its state.');
    };
    const releaseFor = (version) => ({ version, arch: 'arm64', debSha256: 'a'.repeat(64) });
    const team = (teamId) => {
        const t = teams.get(teamId);
        if (!t)
            throw new Error(`stub: no team ${teamId}`);
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
    const r = service_1.serviceRoutes;
    const server = (0, server_1.createRouteServer)([
        (0, server_1.bind)(r.startDeviceSignIn, () => {
            const deviceCode = nextId('dev');
            const userCode = `STUB-${counter}`;
            devices.set(deviceCode, { userCode, state: 'pending', login: null });
            return { deviceCode, userCode, verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 1 };
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
            const record = accounts.get((grant.login ?? '').toLowerCase());
            if (!record)
                return { status: 'denied' };
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
        (0, server_1.bind)(r.signOut, ({ token }) => {
            caller(token);
            tokens.delete(token ?? '');
            return { signedOut: true };
        }),
        (0, server_1.bind)(r.getAccount, ({ token }) => view(caller(token))),
        (0, server_1.bind)(r.setTailscaleLogin, ({ token, body }) => {
            const record = caller(token);
            record.account.tailscaleLogin = body.tailscaleLogin;
            return view(record);
        }),
        (0, server_1.bind)(r.listMachines, ({ token }) => {
            const record = caller(token);
            return { machines: [...machines.values()].filter((m) => m.ownerAccountId === record.account.id && m.state !== 'deleted').map(publicMachine) };
        }),
        (0, server_1.bind)(r.createMachine, ({ token, body }) => {
            const record = caller(token);
            const key = `${record.account.id}:${body.idempotencyKey}`;
            const repeat = idempotent.get(key);
            if (repeat) {
                const machine = machines.get(repeat.machineId);
                const entry = logs.get(repeat.machineId)?.find((e) => e.id === repeat.entryId);
                if (machine && entry)
                    return { machine: publicMachine(machine), operation: entry };
            }
            if (record.account.access !== 'invited' || !record.account.teamId) {
                throw new errors_1.CloudApiError('not_invited', "You're on the list. Pane Cloud is invite-only for now.", 'Wait for your invite, or ask a team owner to invite your GitHub login.');
            }
            const { phase } = beta();
            if (phase === 'push_windows' || phase === 'ended') {
                throw new errors_1.CloudApiError('invalid_state', 'The Pane Cloud beta is ending, so no new machines can be created.', 'Use the own-AWS template from GET /v1/beta to run a machine in your own account.');
            }
            if ([...machines.values()].some((m) => m.ownerAccountId === record.account.id && m.state !== 'deleted')) {
                throw new errors_1.CloudApiError('seat_has_machine', 'Your seat already has a machine.', 'Open your existing machine, or delete it before creating another.');
            }
            const id = nextId('m');
            const machine = {
                id,
                name: body.name,
                ownerAccountId: record.account.id,
                state: 'running',
                stateReason: null,
                paneVersion: latest,
                tailnet: { status: 'awaiting_login', loginUrl: `https://login.tailscale.com/a/stub-${id}`, hostname: null },
                limits: { vcpu: fleet_1.MACHINE_LIMITS.vcpu, memoryMiB: fleet_1.MACHINE_LIMITS.memoryMiB, diskGiB: fleet_1.MACHINE_LIMITS.diskGiB, dailyCpuSeconds: fleet_1.MACHINE_LIMITS.dailyCpuSeconds, monthlyEgressBytes: fleet_1.MACHINE_LIMITS.monthlyEgressBytes },
                usage: null,
                shared: false,
                pushWindowEndsAt: null,
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
        (0, server_1.bind)(r.getMachine, ({ token, params }) => publicMachine(ownMachine(caller(token), params.machineId ?? ''))),
        (0, server_1.bind)(r.startMachine, ({ token, params }) => {
            const record = caller(token);
            const machine = ownMachine(record, params.machineId ?? '');
            requireState(machine, 'stopped', 'Start');
            const { phase } = beta();
            if (phase === 'ended')
                throw new errors_1.CloudApiError('invalid_state', 'The Pane Cloud beta has ended, so machines no longer start.', 'Contact support if you still need work from this machine.');
            setState(machine, 'running', null);
            if (phase === 'push_windows') {
                machine.pushWindowEndsAt = new Date(now().getTime() + service_1.BETA_PUSH_WINDOW_MINUTES * 60_000).toISOString();
                return { machine: publicMachine(machine), operation: log(machine, 'start', record, `You started this machine for a ${service_1.BETA_PUSH_WINDOW_MINUTES}-minute push window before the beta ends.`) };
            }
            return { machine: publicMachine(machine), operation: log(machine, 'start', record, 'You started this machine.') };
        }),
        (0, server_1.bind)(r.stopMachine, ({ token, params }) => {
            const record = caller(token);
            const machine = ownMachine(record, params.machineId ?? '');
            requireState(machine, 'running', 'Stop');
            log(machine, 'prepare_to_stop', 'service', 'Let Pane finish writing before the stop.');
            setState(machine, 'stopped', 'user');
            machine.pushWindowEndsAt = null;
            return { machine: publicMachine(machine), operation: log(machine, 'stop', record, 'You stopped this machine.') };
        }),
        (0, server_1.bind)(r.deleteMachine, ({ token, params }) => {
            const record = caller(token);
            const machine = ownMachine(record, params.machineId ?? '');
            if (machine.state === 'deleted')
                throw new errors_1.CloudApiError('invalid_state', 'This machine is already deleted.', 'Nothing to do.');
            setState(machine, 'deleted', 'user');
            machine.shared = false;
            dropCodes((key) => key.startsWith(`${machine.id}:`));
            return { machine: publicMachine(machine), operation: log(machine, 'delete', record, 'You deleted this machine and its disk.') };
        }),
        (0, server_1.bind)(r.requestOperation, ({ token, params, body }) => {
            const record = caller(token);
            const machine = ownMachine(record, params.machineId ?? '');
            const request = (0, service_1.parseUserOperation)(body);
            requireState(machine, 'running', request.operation);
            if (request.operation === 'update_pane') {
                const version = request.parameters.version ?? latest;
                if (!versions.includes(version))
                    throw new errors_1.CloudApiError('release_not_published', `Pane ${version} is not a published release.`, `Pick one of: ${versions.join(', ')}.`);
                machine.paneVersion = version;
                return log(machine, 'update_pane', record, `You updated Pane to ${version}.`, { release: releaseFor(version) });
            }
            return log(machine, 'collect_diagnostics', record, 'You collected diagnostics.');
        }),
        (0, server_1.bind)(r.listActionLog, ({ token, params, query }) => {
            const machine = ownMachine(caller(token), params.machineId ?? '');
            const all = logs.get(machine.id) ?? [];
            const cursorAt = query.before ? all.findIndex((e) => e.id === query.before) : -1;
            if (query.before && cursorAt < 0)
                throw new errors_1.CloudApiError('invalid_request', `Unknown cursor ${query.before}.`, 'Pass a nextCursor from an earlier page, or no cursor for the newest entries.');
            const start = cursorAt + 1;
            const entries = all.slice(start, start + (query.limit ?? 50));
            const last = entries.at(-1);
            return { entries, nextCursor: last && start + entries.length < all.length ? last.id : null };
        }),
        (0, server_1.bind)(r.setSharing, ({ token, params, body }) => {
            const record = caller(token);
            teamOf(record);
            const machine = ownMachine(record, params.machineId ?? '');
            machine.shared = body.shared;
            if (!body.shared)
                dropCodes((key) => key.startsWith(`${machine.id}:`));
            machine.updatedAt = iso();
            return publicMachine(machine);
        }),
        (0, server_1.bind)(r.leaveConnectionCode, ({ token, params, body }) => {
            const record = caller(token);
            const machine = ownMachine(record, params.machineId ?? '');
            if (!machine.shared)
                throw new errors_1.CloudApiError('invalid_state', 'This machine is not shared with your team.', 'Turn on sharing for it first.');
            const teammate = byId(body.forAccountId);
            if (!teammate || teammate.account.teamId !== record.account.teamId || teammate.account.id === record.account.id) {
                throw new errors_1.CloudApiError('not_team_member', 'That account is not a teammate.', 'Invite them to your team first.');
            }
            const expires = Date.parse(body.expiresAt);
            if (expires <= now().getTime() || expires > now().getTime() + service_1.CONNECTION_CODE_MAX_SECONDS * 1000) {
                throw new errors_1.CloudApiError('invalid_request', `A connection code must expire within ${service_1.CONNECTION_CODE_MAX_SECONDS / 60} minutes.`, 'Mint a fresh code on the host and leave it again.');
            }
            const handoff = { id: nextId('cc'), code: body.code, expiresAt: body.expiresAt };
            codes.set(`${machine.id}:${teammate.account.id}`, handoff);
            return { id: handoff.id, machineId: machine.id, forAccountId: teammate.account.id, expiresAt: handoff.expiresAt };
        }),
        (0, server_1.bind)(r.claimConnectionCode, ({ token, params }) => {
            const record = caller(token);
            const key = `${params.machineId}:${record.account.id}`;
            const handoff = codes.get(key);
            codes.delete(key);
            const machine = machines.get(params.machineId ?? '');
            const owner = machine ? byId(machine.ownerAccountId) : undefined;
            const stillAllowed = machine && machine.shared && machine.state !== 'deleted' && record.account.teamId !== null && owner?.account.teamId === record.account.teamId;
            if (!handoff || !machine || !stillAllowed || Date.parse(handoff.expiresAt) <= now().getTime()) {
                throw new errors_1.CloudApiError('connection_code_not_found', 'No connection code is waiting for you on this machine.', 'Ask the machine owner to approve you from their Pane.');
            }
            return { machineId: machine.id, code: handoff.code, tailnetHostname: machine.tailnet.hostname, expiresAt: handoff.expiresAt };
        }),
        (0, server_1.bind)(r.getBeta, () => beta()),
        (0, server_1.bind)(r.getBilling, ({ token }) => {
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
        (0, server_1.bind)(r.getTeam, ({ token }) => team(teamOf(caller(token)).id)),
        (0, server_1.bind)(r.createInvite, ({ token, body }) => {
            const record = caller(token);
            const t = requireOwner(record);
            if (team(t.id).members.some((m) => m.githubLogin.toLowerCase() === body.githubLogin.toLowerCase())) {
                throw new errors_1.CloudApiError('already_member', `${body.githubLogin} is already on this team.`, 'Nothing to do.');
            }
            const invite = { id: nextId('inv'), githubLogin: body.githubLogin, invitedByAccountId: record.account.id, status: 'pending', createdAt: iso(), expiresAt: new Date(now().getTime() + 14 * 86_400_000).toISOString() };
            invites.set(invite.id, invite);
            return invite;
        }),
        (0, server_1.bind)(r.revokeInvite, ({ token, params }) => {
            const t = requireOwner(caller(token));
            const invite = invites.get(params.inviteId ?? '');
            if (!invite || byId(invite.invitedByAccountId)?.account.teamId !== t.id)
                throw new errors_1.CloudApiError('invite_not_found', 'No such invite on your team.', 'List your team to see its invites.');
            invite.status = 'revoked';
            return invite;
        }),
        (0, server_1.bind)(r.acceptInvite, ({ token, params }) => {
            const record = caller(token);
            const invite = invites.get(params.inviteId ?? '');
            if (!invite || invite.status !== 'pending' || Date.parse(invite.expiresAt) <= now().getTime() || invite.githubLogin.toLowerCase() !== record.account.githubLogin.toLowerCase()) {
                throw new errors_1.CloudApiError('invite_not_found', 'No pending invite for you with that id.', 'Ask the team owner to invite your GitHub login.');
            }
            if (record.account.teamId)
                throw new errors_1.CloudApiError('already_member', 'You are already on a team.', 'Ask your current team owner to remove you, then accept again.');
            invite.status = 'accepted';
            record.account.teamId = byId(invite.invitedByAccountId)?.account.teamId ?? null;
            record.account.role = 'member';
            record.account.access = 'invited';
            record.joinedAt = iso();
            return view(record);
        }),
        (0, server_1.bind)(r.removeMember, ({ token, params }) => {
            const t = requireOwner(caller(token));
            const member = byId(params.accountId ?? '');
            if (!member || member.account.teamId !== t.id)
                throw new errors_1.CloudApiError('not_team_member', 'That account is not on your team.', 'List your team to see its members.');
            if (member.account.id === t.ownerId)
                throw new errors_1.CloudApiError('invalid_request', 'The owner cannot be removed.', 'Remove other members only.');
            member.account.teamId = null;
            member.account.role = null;
            for (const machine of machines.values())
                if (machine.ownerAccountId === member.account.id)
                    machine.shared = false;
            dropCodes((key) => key.endsWith(`:${member.account.id}`) || [...machines.values()].some((m) => m.ownerAccountId === member.account.id && key.startsWith(`${m.id}:`)));
            return team(t.id);
        }),
        (0, server_1.bind)(r.listSharedMachines, ({ token }) => {
            const t = teamOf(caller(token));
            return {
                machines: [...machines.values()]
                    .filter((m) => m.shared && m.state !== 'deleted' && byId(m.ownerAccountId)?.account.teamId === t.id)
                    .map((m) => {
                    const owner = byId(m.ownerAccountId)?.account;
                    if (!owner)
                        throw new Error(`stub: no owner for ${m.id}`);
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
    const running = await (0, server_1.listen)(server);
    const anyMachine = (machineId) => {
        const machine = machines.get(machineId);
        if (!machine)
            throw new Error(`stub: no machine ${machineId}`);
        return machine;
    };
    return {
        ...running,
        approveDevice(userCode, githubLogin) {
            const grant = [...devices.values()].find((d) => d.userCode === userCode);
            if (!grant)
                throw new Error(`stub: no device code ${userCode}`);
            grant.state = 'approved';
            grant.login = githubLogin;
        },
        denyDevice(userCode) {
            const grant = [...devices.values()].find((d) => d.userCode === userCode);
            if (grant)
                grant.state = 'denied';
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
