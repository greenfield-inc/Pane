"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceRoutes = exports.OrganizationUsage = exports.MemberUsage = exports.RetryCloneRequest = exports.CreateVmRequest = exports.SealingKey = exports.SubmittedOperation = exports.USER_OPERATIONS = exports.UserOperationRequest = exports.ActionLogEntry = exports.LoggedOperation = exports.SessionVm = exports.DeviceTokenResult = exports.Account = exports.Membership = exports.OrgRole = exports.DeviceCode = exports.AGENT_HOURS_PER_AWAKE_HOUR = exports.Plan = exports.PLANS = void 0;
exports.createServiceClient = createServiceClient;
exports.parseUserOperation = parseUserOperation;
/**
 * The service API: what Pane (desktop, phone, runpane) calls on the Pane Cloud service.
 *
 * Every account belongs to organizations; a Session VM belongs to the organization it was created in
 * and answers only the member who created it. The service changes a VM only through signed fleet
 * operations, and logs each one in the VM's action log.
 */
const zod_1 = require("zod");
const errors_1 = require("./errors");
const fleet_1 = require("./fleet");
const http_1 = require("./http");
const Timestamp = zod_1.z.iso.datetime({ offset: true });
const Id = zod_1.z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// ---------- Plans (D-64) ----------
/**
 * The three plans. Hours are per Full access member a month, pooled across the organization; the
 * awake limit is per Full access member. Prices live with billing, not here.
 */
exports.PLANS = {
    free: { agentHoursPerMember: 300, awakeLimitPerMember: 5 },
    pro: { agentHoursPerMember: 1500, awakeLimitPerMember: 20 },
    max: { agentHoursPerMember: 3000, awakeLimitPerMember: 50 },
};
exports.Plan = zod_1.z.enum(['free', 'pro', 'max']);
/** Agent-hours one awake hour counts, by the VM's memory: an hour at 16 GiB counts as 2. */
exports.AGENT_HOURS_PER_AWAKE_HOUR = { 8: 1, 16: 2 };
// ---------- Sign-in ----------
/**
 * Device sign-in: Pane opens `verificationUriComplete` in the system browser, the person signs in
 * there (Google or GitHub), and Pane polls with `deviceCode` until it completes.
 */
exports.DeviceCode = zod_1.z
    .object({
    deviceCode: zod_1.z.string().min(1),
    userCode: zod_1.z.string().min(1),
    verificationUri: zod_1.z.url(),
    /** verificationUri with the user code filled in. */
    verificationUriComplete: zod_1.z.url(),
    expiresIn: zod_1.z.number().int().positive(),
    /** Seconds to wait between token polls. */
    interval: zod_1.z.number().int().positive(),
})
    .strict();
/** `full_access` members open, type into and create Sessions; `view_only` members read shared ones. */
exports.OrgRole = zod_1.z.enum(['owner', 'full_access', 'view_only']);
exports.Membership = zod_1.z
    .object({
    organizationId: Id,
    name: zod_1.z.string().min(1),
    /** The organization made for this account at sign-up. */
    personal: zod_1.z.boolean(),
    role: exports.OrgRole,
})
    .strict();
exports.Account = zod_1.z
    .object({
    id: Id,
    email: zod_1.z.email(),
    name: zod_1.z.string().nullable(),
    /** `waitlisted` accounts see "You're on the list" and can create nothing. */
    access: zod_1.z.enum(['invited', 'waitlisted']),
    /** The next sign-up step on the service's sign-up page; no VM can be created until `ready`. */
    signupState: zod_1.z.enum(['needs_phone', 'needs_card', 'ready']),
    /** Every organization the account belongs to; the personal one is always there. */
    organizations: zod_1.z.array(exports.Membership).min(1),
})
    .strict();
exports.DeviceTokenResult = zod_1.z.discriminatedUnion('status', [
    zod_1.z.object({ status: zod_1.z.literal('pending') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('slow_down') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('expired') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('denied') }).strict(),
    zod_1.z.object({ status: zod_1.z.literal('complete'), token: zod_1.z.string().min(1), expiresAt: Timestamp, account: exports.Account }).strict(),
]);
// ---------- Session VMs ----------
exports.SessionVm = zod_1.z
    .object({
    id: fleet_1.VmId,
    organizationId: Id,
    createdByAccountId: Id,
    name: zod_1.z.string().min(1).max(64),
    state: fleet_1.FleetVmState,
    /** `review`: paused for review; starting it answers under_review. */
    stateReason: fleet_1.StateReason.nullable(),
    memoryGiB: fleet_1.VmMemoryGiB,
    paneVersion: zod_1.z.string().nullable(),
    /**
     * The relay identity the VM reported when a device first paired with it, which the service
     * vouches for from then on; null before the first pairing.
     */
    relay: fleet_1.RelayIdentity.nullable(),
    /** The clone of the repo the Session was created for, as the guest reports it; null without one (D-107). */
    clone: fleet_1.CloneStatus.nullable().default(null),
    createdAt: Timestamp,
    updatedAt: Timestamp,
})
    .strict();
/** Lifecycle actions plus the allow-listed guest operations, as the VM's action log names them. */
exports.LoggedOperation = zod_1.z.enum(['create', 'start', 'stop', 'delete', 'bootstrap', 'update_pane', 'prepare_to_stop', 'collect_diagnostics', 'create_pairing_link', 'retry_clone']);
exports.ActionLogEntry = zod_1.z
    .object({
    id: Id,
    vmId: fleet_1.VmId,
    operation: exports.LoggedOperation,
    /** The exact fixed parameters sent to the fleet, for the user to read. */
    parameters: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
    actor: zod_1.z
        .object({
        /** `user`: a member; `service`: the service on its own (a review pause); `host`: the fleet (host maintenance). */
        kind: zod_1.z.enum(['user', 'service', 'host']),
        accountId: Id.nullable(),
    })
        .strict(),
    reason: zod_1.z.string().min(1),
    status: zod_1.z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: fleet_1.OperationError.nullable(),
    requestedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
})
    .strict();
const VmAction = zod_1.z.object({ vm: exports.SessionVm, operation: exports.ActionLogEntry }).strict();
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
// ---------- A new Session's repo and the sealed GitHub token (D-107) ----------
/**
 * A key to seal the person's GitHub token to (sealGitHubToken). Pane asks for one when the create
 * dialog opens: it reserves a free slot until `expiresAt`, and a create naming it after that answers
 * sealing_key_expired, so Pane asks again and seals again.
 */
exports.SealingKey = zod_1.z.object({ keyId: fleet_1.SealingKeyId, publicKey: fleet_1.SealingPublicKey, expiresAt: Timestamp }).strict();
/**
 * createVm's body. With `repo`, the VM clones it at boot and reports the clone on the VM. A private
 * repo's token goes sealed, to the key `sealingKeyId` names; the service passes it to the host and
 * never stores, logs or returns it. Pane sends no token when the person keeps it from this machine.
 */
exports.CreateVmRequest = zod_1.z
    .object({
    name: zod_1.z.string().min(1).max(64),
    idempotencyKey: zod_1.z.string().min(8).max(128),
    repo: fleet_1.CloneRepo.optional(),
    sealingKeyId: fleet_1.SealingKeyId.optional(),
    sealedGitHubToken: fleet_1.SealedSecret.optional(),
})
    .strict()
    .refine((body) => !body.sealedGitHubToken || (body.sealingKeyId && body.repo && (0, fleet_1.isGitHubRepo)(body.repo)), {
    message: 'A sealed GitHub token goes only with a github.com repo and the sealing key it was sealed to',
    path: ['sealedGitHubToken'],
});
/** retryClone's body: a fresh sealed token, sealed to a key from createVmSealingKey, after a sign-in error. */
exports.RetryCloneRequest = zod_1.z
    .object({ sealingKeyId: fleet_1.SealingKeyId.optional(), sealedGitHubToken: fleet_1.SealedSecret.optional() })
    .strict()
    .refine((body) => !body.sealedGitHubToken || body.sealingKeyId, { message: 'A sealed GitHub token goes with the sealing key it was sealed to', path: ['sealedGitHubToken'] });
// ---------- Usage ----------
const Month = zod_1.z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
exports.MemberUsage = zod_1.z
    .object({
    accountId: Id,
    name: zod_1.z.string().nullable(),
    role: exports.OrgRole,
    /** Agent-hours this member's VMs counted this month. */
    agentHoursUsed: zod_1.z.number().nonnegative(),
    /**
     * VMs this member has creating, starting or running (waking counts, D-68), across every
     * organization they belong to: the awake limit spans the account (D-74).
     */
    awakeNow: zod_1.z.number().int().nonnegative(),
    /**
     * The highest awake limit among the member's Full access memberships (5 Free, 20 Pro, 50 Max, or
     * an organization's override). 0 for a View only member of this organization, who can't create
     * or start a Session in it (view_only).
     */
    awakeLimit: zod_1.z.number().int().nonnegative(),
})
    .strict();
/** An organization's usage for one calendar month (UTC). */
exports.OrganizationUsage = zod_1.z
    .object({
    organizationId: Id,
    plan: exports.Plan,
    month: Month,
    /** When the month's hours reset: the 1st of the next month, 00:00 UTC. */
    resetsAt: Timestamp,
    agentHours: zod_1.z
        .object({
        used: zod_1.z.number().nonnegative(),
        /** The pooled hours: the plan's hours times the Full access members; null when the organization has no hour limit. */
        limit: zod_1.z.number().int().positive().nullable(),
    })
        .strict(),
    members: zod_1.z.array(exports.MemberUsage),
})
    .strict();
// ---------- Routes ----------
const pageQuery = zod_1.z.object({ before: zod_1.z.string().optional(), limit: zod_1.z.coerce.number().int().min(1).max(200).optional() }).strict();
exports.serviceRoutes = {
    startDeviceSignIn: (0, http_1.route)({ id: 'service.startDeviceSignIn', method: 'POST', path: '/v1/auth/device', auth: false, body: zod_1.z.object({}).strict(), response: exports.DeviceCode }),
    pollDeviceSignIn: (0, http_1.route)({ id: 'service.pollDeviceSignIn', method: 'POST', path: '/v1/auth/token', auth: false, body: zod_1.z.object({ deviceCode: zod_1.z.string().min(1) }).strict(), response: exports.DeviceTokenResult }),
    signOut: (0, http_1.route)({ id: 'service.signOut', method: 'POST', path: '/v1/auth/sign-out', auth: true, body: zod_1.z.object({}).strict(), response: zod_1.z.object({ signedOut: zod_1.z.literal(true) }).strict() }),
    getAccount: (0, http_1.route)({ id: 'service.getAccount', method: 'GET', path: '/v1/account', auth: true, response: exports.Account }),
    listVms: (0, http_1.route)({ id: 'service.listVms', method: 'GET', path: '/v1/organizations/:organizationId/vms', auth: true, response: zod_1.z.object({ vms: zod_1.z.array(exports.SessionVm) }).strict() }),
    createVm: (0, http_1.route)({
        id: 'service.createVm',
        method: 'POST',
        path: '/v1/organizations/:organizationId/vms',
        auth: true,
        body: exports.CreateVmRequest,
        response: VmAction,
        status: 202,
    }),
    /** A key for the GitHub token of the next create in this organization; needs the same access a create does. */
    createSealingKey: (0, http_1.route)({ id: 'service.createSealingKey', method: 'POST', path: '/v1/organizations/:organizationId/sealing-keys', auth: true, body: zod_1.z.object({}).strict(), response: exports.SealingKey, status: 201 }),
    /** A key for a fresh GitHub token for a running VM's retryClone. */
    createVmSealingKey: (0, http_1.route)({ id: 'service.createVmSealingKey', method: 'POST', path: '/v1/vms/:vmId/sealing-key', auth: true, body: zod_1.z.object({}).strict(), response: exports.SealingKey, status: 201 }),
    /** Runs a failed clone again; invalid_state unless the VM is running and its clone failed. Logged as retry_clone, without the token. */
    retryClone: (0, http_1.route)({ id: 'service.retryClone', method: 'POST', path: '/v1/vms/:vmId/clone/retry', auth: true, body: exports.RetryCloneRequest, response: VmAction, status: 202 }),
    getVm: (0, http_1.route)({ id: 'service.getVm', method: 'GET', path: '/v1/vms/:vmId', auth: true, response: exports.SessionVm }),
    startVm: (0, http_1.route)({ id: 'service.startVm', method: 'POST', path: '/v1/vms/:vmId/start', auth: true, body: zod_1.z.object({}).strict(), response: VmAction, status: 202 }),
    stopVm: (0, http_1.route)({ id: 'service.stopVm', method: 'POST', path: '/v1/vms/:vmId/stop', auth: true, body: zod_1.z.object({}).strict(), response: VmAction, status: 202 }),
    deleteVm: (0, http_1.route)({ id: 'service.deleteVm', method: 'DELETE', path: '/v1/vms/:vmId', auth: true, response: VmAction, status: 202 }),
    requestOperation: (0, http_1.route)({ id: 'service.requestOperation', method: 'POST', path: '/v1/vms/:vmId/operations', auth: true, body: exports.SubmittedOperation, response: exports.ActionLogEntry, status: 202 }),
    /**
     * A one-time link for pairing a device with a running VM, and the relay identity the service
     * vouches for. The client pairs only with a VM that presents exactly that key. A VM that reports
     * a different identity than its first one is refused with relay_key_changed. Logged as
     * create_pairing_link, without the link.
     */
    pairVm: (0, http_1.route)({ id: 'service.pairVm', method: 'POST', path: '/v1/vms/:vmId/pairing', auth: true, body: zod_1.z.object({}).strict(), response: fleet_1.PairingLink }),
    listActionLog: (0, http_1.route)({
        id: 'service.listActionLog',
        method: 'GET',
        path: '/v1/vms/:vmId/operations',
        auth: true,
        query: pageQuery,
        response: zod_1.z.object({ entries: zod_1.z.array(exports.ActionLogEntry), nextCursor: zod_1.z.string().nullable() }).strict(),
    }),
    getUsage: (0, http_1.route)({
        id: 'service.getUsage',
        method: 'GET',
        path: '/v1/organizations/:organizationId/usage',
        auth: true,
        query: zod_1.z.object({ month: Month.optional() }).strict(),
        response: exports.OrganizationUsage,
    }),
};
/** Pane's client for the service API. */
function createServiceClient(config) {
    const r = exports.serviceRoutes;
    return {
        startDeviceSignIn: () => (0, http_1.callRoute)(config, r.startDeviceSignIn, { body: {} }),
        pollDeviceSignIn: (deviceCode) => (0, http_1.callRoute)(config, r.pollDeviceSignIn, { body: { deviceCode } }),
        signOut: () => (0, http_1.callRoute)(config, r.signOut, { body: {} }),
        getAccount: () => (0, http_1.callRoute)(config, r.getAccount),
        listVms: (organizationId) => (0, http_1.callRoute)(config, r.listVms, { params: { organizationId } }),
        createVm: (organizationId, name, idempotencyKey, clone = {}) => (0, http_1.callRoute)(config, r.createVm, { params: { organizationId }, body: { name, idempotencyKey, ...clone } }),
        createSealingKey: (organizationId) => (0, http_1.callRoute)(config, r.createSealingKey, { params: { organizationId }, body: {} }),
        createVmSealingKey: (vmId) => (0, http_1.callRoute)(config, r.createVmSealingKey, { params: { vmId }, body: {} }),
        retryClone: (vmId, request = {}) => (0, http_1.callRoute)(config, r.retryClone, { params: { vmId }, body: request }),
        getVm: (vmId) => (0, http_1.callRoute)(config, r.getVm, { params: { vmId } }),
        startVm: (vmId) => (0, http_1.callRoute)(config, r.startVm, { params: { vmId }, body: {} }),
        stopVm: (vmId) => (0, http_1.callRoute)(config, r.stopVm, { params: { vmId }, body: {} }),
        deleteVm: (vmId) => (0, http_1.callRoute)(config, r.deleteVm, { params: { vmId } }),
        requestOperation: (vmId, request) => (0, http_1.callRoute)(config, r.requestOperation, { params: { vmId }, body: request }),
        pairVm: (vmId) => (0, http_1.callRoute)(config, r.pairVm, { params: { vmId }, body: {} }),
        listActionLog: (vmId, page = {}) => (0, http_1.callRoute)(config, r.listActionLog, { params: { vmId }, query: page }),
        getUsage: (organizationId, month) => (0, http_1.callRoute)(config, r.getUsage, { params: { organizationId }, query: { month } }),
    };
}
/**
 * The service's allow-list check for a user's operation request: operation_not_allowed for any name
 * outside USER_OPERATIONS, invalid_request for parameters outside that operation's fixed schema.
 */
function parseUserOperation(body) {
    const { operation } = body;
    if (!UserOperationName.safeParse(operation).success) {
        throw new errors_1.CloudApiError('operation_not_allowed', `"${operation}" is not an operation you can run on a Pane Cloud Session.`, `Use one of: ${exports.USER_OPERATIONS.join(', ')}.`);
    }
    const parsed = exports.UserOperationRequest.safeParse(body);
    if (!parsed.success) {
        throw new errors_1.CloudApiError('invalid_request', `The parameters for ${operation} do not match the contract: ${zod_1.z.prettifyError(parsed.error)}`, 'Send only the parameters the operation allows.');
    }
    return parsed.data;
}
