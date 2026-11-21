/**
 * The service API: what Pane (desktop, phone, runpane) calls on the Pane Cloud service.
 *
 * Every account belongs to organizations; a Session VM belongs to the organization it was created in
 * and answers only the member who created it. The service changes a VM only through signed fleet
 * operations, and logs each one in the VM's action log.
 */
import { z } from 'zod';
import { CloudApiError } from './errors';
import { FleetVmState, OperationError, StateReason, VmId, VmMemoryGiB } from './fleet';
import { callRoute, type ClientConfig, route } from './http';

const Timestamp = z.iso.datetime({ offset: true });
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// ---------- Plans (D-64) ----------

/**
 * The three plans. Hours are per Full access member a month, pooled across the organization; the
 * awake limit is per Full access member. Prices live with billing, not here.
 */
export const PLANS = {
  free: { agentHoursPerMember: 300, awakeLimitPerMember: 5 },
  pro: { agentHoursPerMember: 1500, awakeLimitPerMember: 20 },
  max: { agentHoursPerMember: 3000, awakeLimitPerMember: 50 },
} as const;
export const Plan = z.enum(['free', 'pro', 'max']);
export type Plan = z.infer<typeof Plan>;

/** Agent-hours one awake hour counts, by the VM's memory: an hour at 16 GiB counts as 2. */
export const AGENT_HOURS_PER_AWAKE_HOUR = { 8: 1, 16: 2 } as const;

// ---------- Sign-in ----------

/**
 * Device sign-in: Pane opens `verificationUriComplete` in the system browser, the person signs in
 * there (Google or GitHub), and Pane polls with `deviceCode` until it completes.
 */
export const DeviceCode = z
  .object({
    deviceCode: z.string().min(1),
    userCode: z.string().min(1),
    verificationUri: z.url(),
    /** verificationUri with the user code filled in. */
    verificationUriComplete: z.url(),
    expiresIn: z.number().int().positive(),
    /** Seconds to wait between token polls. */
    interval: z.number().int().positive(),
  })
  .strict();

/** `full_access` members open, type into and create Sessions; `view_only` members read shared ones. */
export const OrgRole = z.enum(['owner', 'full_access', 'view_only']);

export const Membership = z
  .object({
    organizationId: Id,
    name: z.string().min(1),
    /** The organization made for this account at sign-up. */
    personal: z.boolean(),
    role: OrgRole,
  })
  .strict();

export const Account = z
  .object({
    id: Id,
    email: z.email(),
    name: z.string().nullable(),
    /** `waitlisted` accounts see "You're on the list" and can create nothing. */
    access: z.enum(['invited', 'waitlisted']),
    /** The next sign-up step on the service's sign-up page; no VM can be created until `ready`. */
    signupState: z.enum(['needs_phone', 'needs_card', 'ready']),
    /** Every organization the account belongs to; the personal one is always there. */
    organizations: z.array(Membership).min(1),
  })
  .strict();
export type Account = z.infer<typeof Account>;

export const DeviceTokenResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('slow_down') }).strict(),
  z.object({ status: z.literal('expired') }).strict(),
  z.object({ status: z.literal('denied') }).strict(),
  z.object({ status: z.literal('complete'), token: z.string().min(1), expiresAt: Timestamp, account: Account }).strict(),
]);
export type DeviceTokenResult = z.infer<typeof DeviceTokenResult>;

// ---------- Session VMs ----------

export const SessionVm = z
  .object({
    id: VmId,
    organizationId: Id,
    createdByAccountId: Id,
    name: z.string().min(1).max(64),
    state: FleetVmState,
    /** `review`: paused for review; starting it answers under_review. */
    stateReason: StateReason.nullable(),
    memoryGiB: VmMemoryGiB,
    paneVersion: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type SessionVm = z.infer<typeof SessionVm>;

/** Lifecycle actions plus the allow-listed guest operations, as the VM's action log names them. */
export const LoggedOperation = z.enum(['create', 'start', 'stop', 'delete', 'bootstrap', 'update_pane', 'prepare_to_stop', 'collect_diagnostics']);

export const ActionLogEntry = z
  .object({
    id: Id,
    vmId: VmId,
    operation: LoggedOperation,
    /** The exact fixed parameters sent to the fleet, for the user to read. */
    parameters: z.record(z.string(), z.unknown()),
    actor: z
      .object({
        /** `user`: a member; `service`: the service on its own (a review pause); `host`: the fleet (host maintenance). */
        kind: z.enum(['user', 'service', 'host']),
        accountId: Id.nullable(),
      })
      .strict(),
    reason: z.string().min(1),
    status: z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: OperationError.nullable(),
    requestedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
  })
  .strict();
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

const VmAction = z.object({ vm: SessionVm, operation: ActionLogEntry }).strict();

/**
 * Operations a user may request by name. The service fills in the fixed parameters: update_pane
 * resolves `version` (default: the latest published release) to that release's checksum.
 */
export const UserOperationRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('update_pane'), parameters: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict() }).strict(),
  z.object({ operation: z.literal('collect_diagnostics'), parameters: z.object({}).strict() }).strict(),
]);
export type UserOperationRequest = z.infer<typeof UserOperationRequest>;

/** Operations a user may name in requestOperation. */
export const USER_OPERATIONS = ['update_pane', 'collect_diagnostics'] as const;
const UserOperationName = z.enum(USER_OPERATIONS);

/** What requestOperation accepts before parseUserOperation checks it. */
export const SubmittedOperation = z.object({ operation: z.string(), parameters: z.record(z.string(), z.json()) }).strict();
export type SubmittedOperation = z.infer<typeof SubmittedOperation>;

// ---------- Usage ----------

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const MemberUsage = z
  .object({
    accountId: Id,
    name: z.string().nullable(),
    role: OrgRole,
    /** Agent-hours this member's VMs counted this month. */
    agentHoursUsed: z.number().nonnegative(),
    /** VMs this member created that are creating, starting or running (D-68: waking counts). */
    awakeNow: z.number().int().nonnegative(),
    /** The plan's awake limit, or the organization's override for this member. */
    awakeLimit: z.number().int().positive(),
  })
  .strict();

/** An organization's usage for one calendar month (UTC). */
export const OrganizationUsage = z
  .object({
    organizationId: Id,
    plan: Plan,
    month: Month,
    /** When the month's hours reset: the 1st of the next month, 00:00 UTC. */
    resetsAt: Timestamp,
    agentHours: z
      .object({
        used: z.number().nonnegative(),
        /** The pooled hours: the plan's hours times the Full access members; null when the organization has no hour limit. */
        limit: z.number().int().positive().nullable(),
      })
      .strict(),
    members: z.array(MemberUsage),
  })
  .strict();
export type OrganizationUsage = z.infer<typeof OrganizationUsage>;

// ---------- Routes ----------

const pageQuery = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

export const serviceRoutes = {
  startDeviceSignIn: route({ id: 'service.startDeviceSignIn', method: 'POST', path: '/v1/auth/device', auth: false, body: z.object({}).strict(), response: DeviceCode }),
  pollDeviceSignIn: route({ id: 'service.pollDeviceSignIn', method: 'POST', path: '/v1/auth/token', auth: false, body: z.object({ deviceCode: z.string().min(1) }).strict(), response: DeviceTokenResult }),
  signOut: route({ id: 'service.signOut', method: 'POST', path: '/v1/auth/sign-out', auth: true, body: z.object({}).strict(), response: z.object({ signedOut: z.literal(true) }).strict() }),
  getAccount: route({ id: 'service.getAccount', method: 'GET', path: '/v1/account', auth: true, response: Account }),

  listVms: route({ id: 'service.listVms', method: 'GET', path: '/v1/organizations/:organizationId/vms', auth: true, response: z.object({ vms: z.array(SessionVm) }).strict() }),
  createVm: route({
    id: 'service.createVm',
    method: 'POST',
    path: '/v1/organizations/:organizationId/vms',
    auth: true,
    body: z.object({ name: z.string().min(1).max(64), idempotencyKey: z.string().min(8).max(128) }).strict(),
    response: VmAction,
    status: 202,
  }),
  getVm: route({ id: 'service.getVm', method: 'GET', path: '/v1/vms/:vmId', auth: true, response: SessionVm }),
  startVm: route({ id: 'service.startVm', method: 'POST', path: '/v1/vms/:vmId/start', auth: true, body: z.object({}).strict(), response: VmAction, status: 202 }),
  stopVm: route({ id: 'service.stopVm', method: 'POST', path: '/v1/vms/:vmId/stop', auth: true, body: z.object({}).strict(), response: VmAction, status: 202 }),
  deleteVm: route({ id: 'service.deleteVm', method: 'DELETE', path: '/v1/vms/:vmId', auth: true, response: VmAction, status: 202 }),
  requestOperation: route({ id: 'service.requestOperation', method: 'POST', path: '/v1/vms/:vmId/operations', auth: true, body: SubmittedOperation, response: ActionLogEntry, status: 202 }),
  listActionLog: route({
    id: 'service.listActionLog',
    method: 'GET',
    path: '/v1/vms/:vmId/operations',
    auth: true,
    query: pageQuery,
    response: z.object({ entries: z.array(ActionLogEntry), nextCursor: z.string().nullable() }).strict(),
  }),

  getUsage: route({
    id: 'service.getUsage',
    method: 'GET',
    path: '/v1/organizations/:organizationId/usage',
    auth: true,
    query: z.object({ month: Month.optional() }).strict(),
    response: OrganizationUsage,
  }),
};

/** Pane's client for the service API. */
export function createServiceClient(config: ClientConfig) {
  const r = serviceRoutes;
  return {
    startDeviceSignIn: () => callRoute(config, r.startDeviceSignIn, { body: {} }),
    pollDeviceSignIn: (deviceCode: string) => callRoute(config, r.pollDeviceSignIn, { body: { deviceCode } }),
    signOut: () => callRoute(config, r.signOut, { body: {} }),
    getAccount: () => callRoute(config, r.getAccount),
    listVms: (organizationId: string) => callRoute(config, r.listVms, { params: { organizationId } }),
    createVm: (organizationId: string, name: string, idempotencyKey: string) => callRoute(config, r.createVm, { params: { organizationId }, body: { name, idempotencyKey } }),
    getVm: (vmId: string) => callRoute(config, r.getVm, { params: { vmId } }),
    startVm: (vmId: string) => callRoute(config, r.startVm, { params: { vmId }, body: {} }),
    stopVm: (vmId: string) => callRoute(config, r.stopVm, { params: { vmId }, body: {} }),
    deleteVm: (vmId: string) => callRoute(config, r.deleteVm, { params: { vmId } }),
    requestOperation: (vmId: string, request: UserOperationRequest) => callRoute(config, r.requestOperation, { params: { vmId }, body: request }),
    listActionLog: (vmId: string, page: { before?: string; limit?: number } = {}) => callRoute(config, r.listActionLog, { params: { vmId }, query: page }),
    getUsage: (organizationId: string, month?: string) => callRoute(config, r.getUsage, { params: { organizationId }, query: { month } }),
  };
}
export type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * The service's allow-list check for a user's operation request: operation_not_allowed for any name
 * outside USER_OPERATIONS, invalid_request for parameters outside that operation's fixed schema.
 */
export function parseUserOperation(body: SubmittedOperation): UserOperationRequest {
  const { operation } = body;
  if (!UserOperationName.safeParse(operation).success) {
    throw new CloudApiError('operation_not_allowed', `"${operation}" is not an operation you can run on a Pane Cloud Session.`, `Use one of: ${USER_OPERATIONS.join(', ')}.`);
  }
  const parsed = UserOperationRequest.safeParse(body);
  if (!parsed.success) {
    throw new CloudApiError('invalid_request', `The parameters for ${operation} do not match the contract: ${z.prettifyError(parsed.error)}`, 'Send only the parameters the operation allows.');
  }
  return parsed.data;
}
