"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceRoutes = exports.ClaimedConnectionCode = exports.ConnectionCodeHandoff = exports.CONNECTION_CODE_MAX_SECONDS = exports.SharedMachine = exports.Team = exports.TeamMember = exports.BillingStatus = exports.BetaStatus = exports.BETA_PUSH_WINDOW_MINUTES = exports.BETA_PUSH_WINDOW_DAYS = exports.BETA_NOTICE_DAYS = exports.SubmittedOperation = exports.USER_OPERATIONS = exports.UserOperationRequest = exports.ActionLogEntry = exports.LoggedOperation = exports.Machine = exports.MachineUsage = exports.MachineState = exports.DeviceTokenResult = exports.Account = exports.Invite = exports.DeviceCode = void 0;
exports.createServiceClient = createServiceClient;
exports.parseUserOperation = parseUserOperation;
/**
 * The service API: what desktop Pane's Pane Cloud adapter calls on the Pane Cloud service.
 *
 * Sign-in proves a GitHub identity and nothing more; the service keeps no GitHub token. No route
 * grants anyone access to a machine: only the machine's owner, from their own Pane, admits a
 * teammate on the host. The team directory and connection-code handoff only say whom to expect.
 */
const zod_1 = require("zod");
const fleet_1 = require("./fleet");
const errors_1 = require("./errors");
const http_1 = require("./http");
const Timestamp = zod_1.z.iso.datetime({ offset: true });
const Id = zod_1.z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const GithubLogin = zod_1.z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
// ---------- Sign-in ----------
/** Starts GitHub's device flow for identity only (no scopes). */
exports.DeviceCode = zod_1.z
    .object({
    deviceCode: zod_1.z.string().min(1),
    userCode: zod_1.z.string().min(1),
    verificationUri: zod_1.z.url(),
    expiresIn: zod_1.z.number().int().positive(),
    /** Seconds to wait between token polls. */
    interval: zod_1.z.number().int().positive(),
})
    .strict();
exports.Invite = zod_1.z
    .object({
    id: Id,
    githubLogin: GithubLogin,
    invitedByAccountId: Id,
    status: zod_1.z.enum(['pending', 'accepted', 'revoked']),
    createdAt: Timestamp,
    expiresAt: Timestamp,
})
    .strict();
exports.Account = zod_1.z
    .object({
    id: Id,
    githubId: zod_1.z.number().int().positive(),
    githubLogin: GithubLogin,
    name: zod_1.z.string().nullable(),
    email: zod_1.z.string().nullable(),
    /** `waitlisted` accounts see "You're on the list" and can create nothing. */
    access: zod_1.z.enum(['invited', 'waitlisted']),
    teamId: Id.nullable(),
    role: zod_1.z.enum(['owner', 'member']).nullable(),
    /** The Tailscale login the person confirmed, so hosts and teammates know whom to expect. */
    tailscaleLogin: zod_1.z.string().nullable(),
    /** Team invites addressed to this GitHub login and not yet accepted. */
    pendingInvites: zod_1.z.array(exports.Invite),
})
    .strict();
exports.DeviceTokenResult = zod_1.z.discriminatedUnion('status', [
    zod_1.z.object({ status: zod_1.z.literal('pending') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('slow_down') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('expired') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('denied') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('complete'), token: zod_1.z.string().min(1), expiresAt: Timestamp, account: exports.Account }).strict(),
]);
// ---------- Machines ----------
exports.MachineState = zod_1.z.enum([...fleet_1.FleetMachineState.options, 'suspended']);
exports.MachineUsage = zod_1.z
    .object({
    day: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cpuSecondsUsed: zod_1.z.number().nonnegative(),
    /** True once the daily CPU budget is used; the machine page says "Daily CPU budget used". */
    throttled: zod_1.z.boolean(),
    /** Next UTC midnight, when full speed returns. */
    resetsAt: Timestamp,
    egressBytesThisMonth: zod_1.z.number().int().nonnegative(),
    diskUsedBytes: zod_1.z.number().int().nonnegative(),
})
    .strict();
exports.Machine = zod_1.z
    .object({
    id: fleet_1.MachineId,
    name: zod_1.z.string().min(1).max(64),
    ownerAccountId: Id,
    state: exports.MachineState,
    stateReason: fleet_1.StateReason.nullable(),
    paneVersion: zod_1.z.string().nullable(),
    tailnet: fleet_1.TailnetStatus,
    limits: zod_1.z
        .object({
        vcpu: zod_1.z.literal(fleet_1.MACHINE_LIMITS.vcpu),
        memoryMiB: zod_1.z.literal(fleet_1.MACHINE_LIMITS.memoryMiB),
        diskGiB: zod_1.z.literal(fleet_1.MACHINE_LIMITS.diskGiB),
        dailyCpuSeconds: zod_1.z.literal(fleet_1.MACHINE_LIMITS.dailyCpuSeconds),
        monthlyEgressBytes: zod_1.z.literal(fleet_1.MACHINE_LIMITS.monthlyEgressBytes),
    })
        .strict(),
    /** Read live from the fleet's metrics; null while the fleet has none (a machine still creating). */
    usage: exports.MachineUsage.nullable(),
    /** Listed in the team's shared-machine directory. Listing admits nobody by itself. */
    shared: zod_1.z.boolean(),
    /** In the beta's push-window phase, when this start's window ends and the machine stops; null otherwise. */
    pushWindowEndsAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
})
    .strict();
/** Lifecycle actions plus the allow-listed guest operations, as the machine's action log names them. */
exports.LoggedOperation = zod_1.z.enum(['create', 'start', 'stop', 'delete', 'bootstrap', 'update_pane', 'prepare_to_stop', 'collect_diagnostics']);
exports.ActionLogEntry = zod_1.z
    .object({
    id: Id,
    machineId: fleet_1.MachineId,
    operation: exports.LoggedOperation,
    /** The exact fixed parameters sent to the fleet, for the user to read. */
    parameters: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
    actor: zod_1.z
        .object({
        /** `user`: the owner; `service`: S1 on its own (billing, end of beta); `host`: the fleet (idle stop, memory pressure). */
        kind: zod_1.z.enum(['user', 'service', 'host']),
        accountId: Id.nullable(),
        githubLogin: GithubLogin.nullable(),
    })
        .strict(),
    reason: zod_1.z.string().min(1),
    status: zod_1.z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: fleet_1.OperationError.nullable(),
    requestedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
})
    .strict();
const MachineAction = zod_1.z.object({ machine: exports.Machine, operation: exports.ActionLogEntry }).strict();
/**
 * Operations a user may request by name. The service fills in the fixed parameters: update_pane
 * resolves `version` (default: the latest published release) to that release's checksum.
 */
exports.UserOperationRequest = zod_1.z.discriminatedUnion('operation', [
    zod_1.z.object({ operation: zod_1.z.literal('update_pane'), parameters: zod_1.z.object({ version: zod_1.z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict() }).strict(),
    zod_1.z.object({ operation: zod_1.z.literal('collect_diagnostics'), parameters: zod_1.z.object({}).strict() }).strict(),
]);
/** Operations a user may name in requestOperation. */
exports.USER_OPERATIONS = ['update_pane', 'collect_diagnostics'];
const UserOperationName = zod_1.z.enum(exports.USER_OPERATIONS);
/** What requestOperation accepts before parseUserOperation checks it. */
exports.SubmittedOperation = zod_1.z.object({ operation: zod_1.z.string(), parameters: zod_1.z.record(zod_1.z.string(), zod_1.z.json()) }).strict();
// ---------- End of beta (D-7, T2) ----------
/** Banners and email start this many days before the end date. */
exports.BETA_NOTICE_DAYS = 30;
/** From this many days before the end date, machines start only for a push window. */
exports.BETA_PUSH_WINDOW_DAYS = 14;
/** How long a machine runs when started inside the push-window phase. */
exports.BETA_PUSH_WINDOW_MINUTES = 60;
/**
 * The public end of the beta, as the service tells the app. Phases follow from `endsAt` and now:
 * `open` (no date, or more than 30 days out), `notice` (banners and email), `push_windows` (no new
 * machines; a start runs for one push window) and `ended` (machines don't start; disks are deleted
 * only after Parsa approves, as a logged service action).
 */
exports.BetaStatus = zod_1.z
    .object({
    endsAt: Timestamp.nullable(),
    /** endsAt minus 30 days; null while no end date is set. */
    noticeAt: Timestamp.nullable(),
    /** endsAt minus 14 days; null while no end date is set. */
    pushWindowsFrom: Timestamp.nullable(),
    phase: zod_1.z.enum(['open', 'notice', 'push_windows', 'ended']),
    pushWindowMinutes: zod_1.z.literal(exports.BETA_PUSH_WINDOW_MINUTES),
    /** The public notice of the end date. */
    announcementUrl: zod_1.z.url().nullable(),
    /** The one-click template that runs the same machine in the user's own AWS account (T1). */
    ownAwsTemplateUrl: zod_1.z.url().nullable(),
})
    .strict();
// ---------- Billing ----------
exports.BillingStatus = zod_1.z
    .object({
    teamId: Id,
    plan: zod_1.z.enum(['cohort', 'paid']),
    seatPriceCents: zod_1.z.number().int().nonnegative(),
    currency: zod_1.z.literal('usd'),
    /** Founding teams keep $49 a seat if the price rises. */
    foundingPriceLocked: zod_1.z.boolean(),
    status: zod_1.z.enum(['free', 'active', 'grace', 'past_due', 'canceled']),
    seats: zod_1.z.number().int().nonnegative(),
    /** When charges start after notice; null while no notice has gone out. */
    chargesStartAt: Timestamp.nullable(),
    graceEndsAt: Timestamp.nullable(),
    currentPeriodEnd: Timestamp.nullable(),
    /** Stripe customer portal link for the team owner; null for members. */
    manageUrl: zod_1.z.url().nullable(),
})
    .strict();
// ---------- Team (E2) ----------
exports.TeamMember = zod_1.z
    .object({
    accountId: Id,
    githubLogin: GithubLogin,
    name: zod_1.z.string().nullable(),
    role: zod_1.z.enum(['owner', 'member']),
    tailscaleLogin: zod_1.z.string().nullable(),
    seat: zod_1.z.object({ status: zod_1.z.enum(['free', 'active', 'grace', 'canceled']), foundingPrice: zod_1.z.boolean() }).strict(),
    joinedAt: Timestamp,
})
    .strict();
exports.Team = zod_1.z
    .object({
    id: Id,
    name: zod_1.z.string().min(1),
    members: zod_1.z.array(exports.TeamMember),
    invites: zod_1.z.array(exports.Invite),
})
    .strict();
/** One entry of the team's shared-machine directory, which Your computers → Team reads. */
exports.SharedMachine = zod_1.z
    .object({
    machineId: fleet_1.MachineId,
    name: zod_1.z.string(),
    state: exports.MachineState,
    owner: zod_1.z.object({ accountId: Id, githubLogin: GithubLogin, name: zod_1.z.string().nullable(), tailscaleLogin: zod_1.z.string().nullable() }).strict(),
    tailnetHostname: zod_1.z.string().nullable(),
    sharedAt: Timestamp,
})
    .strict();
/** Longest a relayed connection code may stay claimable. */
exports.CONNECTION_CODE_MAX_SECONDS = 900;
/**
 * A named single-use connection code the owner's Pane minted on the host for one teammate, left with
 * the service for that teammate to pick up once. The host still checks the Tailscale login on the
 * request and the owner's approval; a code alone admits no one.
 */
exports.ConnectionCodeHandoff = zod_1.z
    .object({ id: Id, machineId: fleet_1.MachineId, forAccountId: Id, expiresAt: Timestamp })
    .strict();
exports.ClaimedConnectionCode = zod_1.z
    .object({ machineId: fleet_1.MachineId, code: zod_1.z.string().min(1), tailnetHostname: zod_1.z.string().nullable(), expiresAt: Timestamp })
    .strict();
// ---------- Routes ----------
const pageQuery = zod_1.z.object({ before: zod_1.z.string().optional(), limit: zod_1.z.coerce.number().int().min(1).max(200).optional() }).strict();
exports.serviceRoutes = {
    startDeviceSignIn: (0, http_1.route)({ id: 'service.startDeviceSignIn', method: 'POST', path: '/v1/auth/device', auth: false, body: zod_1.z.object({}).strict(), response: exports.DeviceCode }),
    pollDeviceSignIn: (0, http_1.route)({ id: 'service.pollDeviceSignIn', method: 'POST', path: '/v1/auth/token', auth: false, body: zod_1.z.object({ deviceCode: zod_1.z.string().min(1) }).strict(), response: exports.DeviceTokenResult }),
    signOut: (0, http_1.route)({ id: 'service.signOut', method: 'POST', path: '/v1/auth/sign-out', auth: true, body: zod_1.z.object({}).strict(), response: zod_1.z.object({ signedOut: zod_1.z.literal(true) }).strict() }),
    getAccount: (0, http_1.route)({ id: 'service.getAccount', method: 'GET', path: '/v1/account', auth: true, response: exports.Account }),
    setTailscaleLogin: (0, http_1.route)({ id: 'service.setTailscaleLogin', method: 'PUT', path: '/v1/account/tailscale-login', auth: true, body: zod_1.z.object({ tailscaleLogin: zod_1.z.string().min(3).max(320) }).strict(), response: exports.Account }),
    listMachines: (0, http_1.route)({ id: 'service.listMachines', method: 'GET', path: '/v1/machines', auth: true, response: zod_1.z.object({ machines: zod_1.z.array(exports.Machine) }).strict() }),
    createMachine: (0, http_1.route)({
        id: 'service.createMachine',
        method: 'POST',
        path: '/v1/machines',
        auth: true,
        body: zod_1.z.object({ name: zod_1.z.string().min(1).max(64), idempotencyKey: zod_1.z.string().min(8).max(128) }).strict(),
        response: MachineAction,
        status: 202,
    }),
    getMachine: (0, http_1.route)({ id: 'service.getMachine', method: 'GET', path: '/v1/machines/:machineId', auth: true, response: exports.Machine }),
    startMachine: (0, http_1.route)({ id: 'service.startMachine', method: 'POST', path: '/v1/machines/:machineId/start', auth: true, body: zod_1.z.object({}).strict(), response: MachineAction, status: 202 }),
    stopMachine: (0, http_1.route)({ id: 'service.stopMachine', method: 'POST', path: '/v1/machines/:machineId/stop', auth: true, body: zod_1.z.object({}).strict(), response: MachineAction, status: 202 }),
    deleteMachine: (0, http_1.route)({ id: 'service.deleteMachine', method: 'DELETE', path: '/v1/machines/:machineId', auth: true, response: MachineAction, status: 202 }),
    requestOperation: (0, http_1.route)({
        id: 'service.requestOperation',
        method: 'POST',
        path: '/v1/machines/:machineId/operations',
        auth: true,
        body: exports.SubmittedOperation, response: exports.ActionLogEntry, status: 202
    }),
    listActionLog: (0, http_1.route)({
        id: 'service.listActionLog',
        method: 'GET',
        path: '/v1/machines/:machineId/operations',
        auth: true,
        query: pageQuery,
        response: zod_1.z.object({ entries: zod_1.z.array(exports.ActionLogEntry), nextCursor: zod_1.z.string().nullable() }).strict(),
    }),
    setSharing: (0, http_1.route)({ id: 'service.setSharing', method: 'PUT', path: '/v1/machines/:machineId/sharing', auth: true, body: zod_1.z.object({ shared: zod_1.z.boolean() }).strict(), response: exports.Machine }),
    leaveConnectionCode: (0, http_1.route)({
        id: 'service.leaveConnectionCode',
        method: 'POST',
        path: '/v1/machines/:machineId/connection-codes',
        auth: true,
        body: zod_1.z.object({ forAccountId: Id, code: zod_1.z.string().min(1).max(256), expiresAt: Timestamp }).strict(),
        response: exports.ConnectionCodeHandoff,
        status: 201,
    }),
    claimConnectionCode: (0, http_1.route)({ id: 'service.claimConnectionCode', method: 'POST', path: '/v1/machines/:machineId/connection-codes/claim', auth: true, body: zod_1.z.object({}).strict(), response: exports.ClaimedConnectionCode }),
    getBeta: (0, http_1.route)({ id: 'service.getBeta', method: 'GET', path: '/v1/beta', auth: false, response: exports.BetaStatus }),
    getBilling: (0, http_1.route)({ id: 'service.getBilling', method: 'GET', path: '/v1/billing', auth: true, response: exports.BillingStatus }),
    getTeam: (0, http_1.route)({ id: 'service.getTeam', method: 'GET', path: '/v1/team', auth: true, response: exports.Team }),
    createInvite: (0, http_1.route)({ id: 'service.createInvite', method: 'POST', path: '/v1/team/invites', auth: true, body: zod_1.z.object({ githubLogin: GithubLogin }).strict(), response: exports.Invite, status: 201 }),
    revokeInvite: (0, http_1.route)({ id: 'service.revokeInvite', method: 'DELETE', path: '/v1/team/invites/:inviteId', auth: true, response: exports.Invite }),
    acceptInvite: (0, http_1.route)({ id: 'service.acceptInvite', method: 'POST', path: '/v1/invites/:inviteId/accept', auth: true, body: zod_1.z.object({}).strict(), response: exports.Account }),
    removeMember: (0, http_1.route)({ id: 'service.removeMember', method: 'DELETE', path: '/v1/team/members/:accountId', auth: true, response: exports.Team }),
    listSharedMachines: (0, http_1.route)({ id: 'service.listSharedMachines', method: 'GET', path: '/v1/team/machines', auth: true, response: zod_1.z.object({ machines: zod_1.z.array(exports.SharedMachine) }).strict() }),
};
/** The desktop adapter's client for the service API. */
function createServiceClient(config) {
    const r = exports.serviceRoutes;
    return {
        startDeviceSignIn: () => (0, http_1.callRoute)(config, r.startDeviceSignIn, { body: {} }),
        pollDeviceSignIn: (deviceCode) => (0, http_1.callRoute)(config, r.pollDeviceSignIn, { body: { deviceCode } }),
        signOut: () => (0, http_1.callRoute)(config, r.signOut, { body: {} }),
        getAccount: () => (0, http_1.callRoute)(config, r.getAccount),
        setTailscaleLogin: (tailscaleLogin) => (0, http_1.callRoute)(config, r.setTailscaleLogin, { body: { tailscaleLogin } }),
        listMachines: () => (0, http_1.callRoute)(config, r.listMachines),
        createMachine: (name, idempotencyKey) => (0, http_1.callRoute)(config, r.createMachine, { body: { name, idempotencyKey } }),
        getMachine: (machineId) => (0, http_1.callRoute)(config, r.getMachine, { params: { machineId } }),
        startMachine: (machineId) => (0, http_1.callRoute)(config, r.startMachine, { params: { machineId }, body: {} }),
        stopMachine: (machineId) => (0, http_1.callRoute)(config, r.stopMachine, { params: { machineId }, body: {} }),
        deleteMachine: (machineId) => (0, http_1.callRoute)(config, r.deleteMachine, { params: { machineId } }),
        requestOperation: (machineId, request) => (0, http_1.callRoute)(config, r.requestOperation, { params: { machineId }, body: request }),
        listActionLog: (machineId, page = {}) => (0, http_1.callRoute)(config, r.listActionLog, { params: { machineId }, query: page }),
        setSharing: (machineId, shared) => (0, http_1.callRoute)(config, r.setSharing, { params: { machineId }, body: { shared } }),
        leaveConnectionCode: (machineId, handoff) => (0, http_1.callRoute)(config, r.leaveConnectionCode, { params: { machineId }, body: handoff }),
        claimConnectionCode: (machineId) => (0, http_1.callRoute)(config, r.claimConnectionCode, { params: { machineId }, body: {} }),
        getBeta: () => (0, http_1.callRoute)(config, r.getBeta),
        getBilling: () => (0, http_1.callRoute)(config, r.getBilling),
        getTeam: () => (0, http_1.callRoute)(config, r.getTeam),
        createInvite: (githubLogin) => (0, http_1.callRoute)(config, r.createInvite, { body: { githubLogin } }),
        revokeInvite: (inviteId) => (0, http_1.callRoute)(config, r.revokeInvite, { params: { inviteId } }),
        acceptInvite: (inviteId) => (0, http_1.callRoute)(config, r.acceptInvite, { params: { inviteId }, body: {} }),
        removeMember: (accountId) => (0, http_1.callRoute)(config, r.removeMember, { params: { accountId } }),
        listSharedMachines: () => (0, http_1.callRoute)(config, r.listSharedMachines),
    };
}
/**
 * The service's allow-list check for a user's operation request: operation_not_allowed for any name
 * outside USER_OPERATIONS, invalid_request for parameters outside that operation's fixed schema.
 */
function parseUserOperation(body) {
    const { operation } = body;
    if (!UserOperationName.safeParse(operation).success) {
        throw new errors_1.CloudApiError('operation_not_allowed', `"${operation}" is not an operation you can run on a Pane Cloud machine.`, `Use one of: ${exports.USER_OPERATIONS.join(', ')}.`);
    }
    const parsed = exports.UserOperationRequest.safeParse(body);
    if (!parsed.success) {
        throw new errors_1.CloudApiError('invalid_request', `The parameters for ${operation} do not match the contract: ${zod_1.z.prettifyError(parsed.error)}`, 'Send only the parameters the operation allows.');
    }
    return parsed.data;
}
