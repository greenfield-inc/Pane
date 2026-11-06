/**
 * The service API: what desktop Pane's Pane Cloud adapter calls on the Pane Cloud service.
 *
 * Sign-in proves a GitHub identity and nothing more; the service keeps no GitHub token. No route
 * grants anyone access to a machine: only the machine's owner, from their own Pane, admits a
 * teammate on the host. The team directory and connection-code handoff only say whom to expect.
 */
import { z } from 'zod';
import { FleetMachineState, MACHINE_LIMITS, MachineId, OperationError, StateReason, TailnetStatus } from './fleet';
import { CloudApiError } from './errors';
import { callRoute, type ClientConfig, route } from './http';

const Timestamp = z.iso.datetime({ offset: true });
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const GithubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

// ---------- Sign-in ----------

/** Starts GitHub's device flow for identity only (no scopes). */
export const DeviceCode = z
  .object({
    deviceCode: z.string().min(1),
    userCode: z.string().min(1),
    verificationUri: z.url(),
    expiresIn: z.number().int().positive(),
    /** Seconds to wait between token polls. */
    interval: z.number().int().positive(),
  })
  .strict();

export const Invite = z
  .object({
    id: Id,
    githubLogin: GithubLogin,
    invitedByAccountId: Id,
    status: z.enum(['pending', 'accepted', 'revoked']),
    createdAt: Timestamp,
    expiresAt: Timestamp,
  })
  .strict();
export type Invite = z.infer<typeof Invite>;

export const Account = z
  .object({
    id: Id,
    githubId: z.number().int().positive(),
    githubLogin: GithubLogin,
    name: z.string().nullable(),
    email: z.string().nullable(),
    /** `waitlisted` accounts see "You're on the list" and can create nothing. */
    access: z.enum(['invited', 'waitlisted']),
    teamId: Id.nullable(),
    role: z.enum(['owner', 'member']).nullable(),
    /** The Tailscale login the person confirmed, so hosts and teammates know whom to expect. */
    tailscaleLogin: z.string().nullable(),
    /** Team invites addressed to this GitHub login and not yet accepted. */
    pendingInvites: z.array(Invite),
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

// ---------- Machines ----------

export const MachineState = z.enum([...FleetMachineState.options, 'suspended']);

export const MachineUsage = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cpuSecondsUsed: z.number().nonnegative(),
    /** True once the daily CPU budget is used; the machine page says "Daily CPU budget used". */
    throttled: z.boolean(),
    /** Next UTC midnight, when full speed returns. */
    resetsAt: Timestamp,
    egressBytesThisMonth: z.number().int().nonnegative(),
    diskUsedBytes: z.number().int().nonnegative(),
  })
  .strict();

export const Machine = z
  .object({
    id: MachineId,
    name: z.string().min(1).max(64),
    ownerAccountId: Id,
    state: MachineState,
    stateReason: StateReason.nullable(),
    paneVersion: z.string().nullable(),
    tailnet: TailnetStatus,
    limits: z
      .object({
        vcpu: z.literal(MACHINE_LIMITS.vcpu),
        memoryMiB: z.literal(MACHINE_LIMITS.memoryMiB),
        diskGiB: z.literal(MACHINE_LIMITS.diskGiB),
        dailyCpuSeconds: z.literal(MACHINE_LIMITS.dailyCpuSeconds),
        monthlyEgressBytes: z.literal(MACHINE_LIMITS.monthlyEgressBytes),
      })
      .strict(),
    /** Read live from the fleet's metrics; null while the fleet has none (a machine still creating). */
    usage: MachineUsage.nullable(),
    /** Listed in the team's shared-machine directory. Listing admits nobody by itself. */
    shared: z.boolean(),
    /** In the beta's push-window phase, when this start's window ends and the machine stops; null otherwise. */
    pushWindowEndsAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Machine = z.infer<typeof Machine>;

/** Lifecycle actions plus the allow-listed guest operations, as the machine's action log names them. */
export const LoggedOperation = z.enum(['create', 'start', 'stop', 'delete', 'bootstrap', 'update_pane', 'prepare_to_stop', 'collect_diagnostics']);

export const ActionLogEntry = z
  .object({
    id: Id,
    machineId: MachineId,
    operation: LoggedOperation,
    /** The exact fixed parameters sent to the fleet, for the user to read. */
    parameters: z.record(z.string(), z.unknown()),
    actor: z
      .object({
        /** `user`: the owner; `service`: S1 on its own (billing, end of beta); `host`: the fleet (idle stop, memory pressure). */
        kind: z.enum(['user', 'service', 'host']),
        accountId: Id.nullable(),
        githubLogin: GithubLogin.nullable(),
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

const MachineAction = z.object({ machine: Machine, operation: ActionLogEntry }).strict();

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

// ---------- End of beta (D-7, T2) ----------

/** Banners and email start this many days before the end date. */
export const BETA_NOTICE_DAYS = 30;
/** From this many days before the end date, machines start only for a push window. */
export const BETA_PUSH_WINDOW_DAYS = 14;
/** How long a machine runs when started inside the push-window phase. */
export const BETA_PUSH_WINDOW_MINUTES = 60;

/**
 * The public end of the beta, as the service tells the app. Phases follow from `endsAt` and now:
 * `open` (no date, or more than 30 days out), `notice` (banners and email), `push_windows` (no new
 * machines; a start runs for one push window) and `ended` (machines don't start; disks are deleted
 * only after Parsa approves, as a logged service action).
 */
export const BetaStatus = z
  .object({
    endsAt: Timestamp.nullable(),
    /** endsAt minus 30 days; null while no end date is set. */
    noticeAt: Timestamp.nullable(),
    /** endsAt minus 14 days; null while no end date is set. */
    pushWindowsFrom: Timestamp.nullable(),
    phase: z.enum(['open', 'notice', 'push_windows', 'ended']),
    pushWindowMinutes: z.literal(BETA_PUSH_WINDOW_MINUTES),
    /** The public notice of the end date. */
    announcementUrl: z.url().nullable(),
    /** The one-click template that runs the same machine in the user's own AWS account (T1). */
    ownAwsTemplateUrl: z.url().nullable(),
  })
  .strict();
export type BetaStatus = z.infer<typeof BetaStatus>;

// ---------- Billing ----------

export const BillingStatus = z
  .object({
    teamId: Id,
    plan: z.enum(['cohort', 'paid']),
    seatPriceCents: z.number().int().nonnegative(),
    currency: z.literal('usd'),
    /** Founding teams keep $49 a seat if the price rises. */
    foundingPriceLocked: z.boolean(),
    status: z.enum(['free', 'active', 'grace', 'past_due', 'canceled']),
    seats: z.number().int().nonnegative(),
    /** When charges start after notice; null while no notice has gone out. */
    chargesStartAt: Timestamp.nullable(),
    graceEndsAt: Timestamp.nullable(),
    currentPeriodEnd: Timestamp.nullable(),
    /** Stripe customer portal link for the team owner; null for members. */
    manageUrl: z.url().nullable(),
  })
  .strict();
export type BillingStatus = z.infer<typeof BillingStatus>;

// ---------- Team (E2) ----------

export const TeamMember = z
  .object({
    accountId: Id,
    githubLogin: GithubLogin,
    name: z.string().nullable(),
    role: z.enum(['owner', 'member']),
    tailscaleLogin: z.string().nullable(),
    seat: z.object({ status: z.enum(['free', 'active', 'grace', 'canceled']), foundingPrice: z.boolean() }).strict(),
    joinedAt: Timestamp,
  })
  .strict();


export const Team = z
  .object({
    id: Id,
    name: z.string().min(1),
    members: z.array(TeamMember),
    invites: z.array(Invite),
  })
  .strict();
export type Team = z.infer<typeof Team>;

/** One entry of the team's shared-machine directory, which Your computers → Team reads. */
export const SharedMachine = z
  .object({
    machineId: MachineId,
    name: z.string(),
    state: MachineState,
    owner: z.object({ accountId: Id, githubLogin: GithubLogin, name: z.string().nullable(), tailscaleLogin: z.string().nullable() }).strict(),
    tailnetHostname: z.string().nullable(),
    sharedAt: Timestamp,
  })
  .strict();
export type SharedMachine = z.infer<typeof SharedMachine>;

/** Longest a relayed connection code may stay claimable. */
export const CONNECTION_CODE_MAX_SECONDS = 900;

/**
 * A named single-use connection code the owner's Pane minted on the host for one teammate, left with
 * the service for that teammate to pick up once. The host still checks the Tailscale login on the
 * request and the owner's approval; a code alone admits no one.
 */
export const ConnectionCodeHandoff = z
  .object({ id: Id, machineId: MachineId, forAccountId: Id, expiresAt: Timestamp })
  .strict();

export const ClaimedConnectionCode = z
  .object({ machineId: MachineId, code: z.string().min(1), tailnetHostname: z.string().nullable(), expiresAt: Timestamp })
  .strict();

// ---------- Routes ----------

const pageQuery = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

export const serviceRoutes = {
  startDeviceSignIn: route({ id: 'service.startDeviceSignIn', method: 'POST', path: '/v1/auth/device', auth: false, body: z.object({}).strict(), response: DeviceCode }),
  pollDeviceSignIn: route({ id: 'service.pollDeviceSignIn', method: 'POST', path: '/v1/auth/token', auth: false, body: z.object({ deviceCode: z.string().min(1) }).strict(), response: DeviceTokenResult }),
  signOut: route({ id: 'service.signOut', method: 'POST', path: '/v1/auth/sign-out', auth: true, body: z.object({}).strict(), response: z.object({ signedOut: z.literal(true) }).strict() }),
  getAccount: route({ id: 'service.getAccount', method: 'GET', path: '/v1/account', auth: true, response: Account }),
  setTailscaleLogin: route({ id: 'service.setTailscaleLogin', method: 'PUT', path: '/v1/account/tailscale-login', auth: true, body: z.object({ tailscaleLogin: z.string().min(3).max(320) }).strict(), response: Account }),

  listMachines: route({ id: 'service.listMachines', method: 'GET', path: '/v1/machines', auth: true, response: z.object({ machines: z.array(Machine) }).strict() }),
  createMachine: route({
    id: 'service.createMachine',
    method: 'POST',
    path: '/v1/machines',
    auth: true,
    body: z.object({ name: z.string().min(1).max(64), idempotencyKey: z.string().min(8).max(128) }).strict(),
    response: MachineAction,
    status: 202,
  }),
  getMachine: route({ id: 'service.getMachine', method: 'GET', path: '/v1/machines/:machineId', auth: true, response: Machine }),
  startMachine: route({ id: 'service.startMachine', method: 'POST', path: '/v1/machines/:machineId/start', auth: true, body: z.object({}).strict(), response: MachineAction, status: 202 }),
  stopMachine: route({ id: 'service.stopMachine', method: 'POST', path: '/v1/machines/:machineId/stop', auth: true, body: z.object({}).strict(), response: MachineAction, status: 202 }),
  deleteMachine: route({ id: 'service.deleteMachine', method: 'DELETE', path: '/v1/machines/:machineId', auth: true, response: MachineAction, status: 202 }),
  requestOperation: route({
    id: 'service.requestOperation',
    method: 'POST',
    path: '/v1/machines/:machineId/operations',
    auth: true,
    body: SubmittedOperation, response: ActionLogEntry, status: 202 }),
  listActionLog: route({
    id: 'service.listActionLog',
    method: 'GET',
    path: '/v1/machines/:machineId/operations',
    auth: true,
    query: pageQuery,
    response: z.object({ entries: z.array(ActionLogEntry), nextCursor: z.string().nullable() }).strict(),
  }),
  setSharing: route({ id: 'service.setSharing', method: 'PUT', path: '/v1/machines/:machineId/sharing', auth: true, body: z.object({ shared: z.boolean() }).strict(), response: Machine }),
  leaveConnectionCode: route({
    id: 'service.leaveConnectionCode',
    method: 'POST',
    path: '/v1/machines/:machineId/connection-codes',
    auth: true,
    body: z.object({ forAccountId: Id, code: z.string().min(1).max(256), expiresAt: Timestamp }).strict(),
    response: ConnectionCodeHandoff,
    status: 201,
  }),
  claimConnectionCode: route({ id: 'service.claimConnectionCode', method: 'POST', path: '/v1/machines/:machineId/connection-codes/claim', auth: true, body: z.object({}).strict(), response: ClaimedConnectionCode }),

  getBeta: route({ id: 'service.getBeta', method: 'GET', path: '/v1/beta', auth: false, response: BetaStatus }),
  getBilling: route({ id: 'service.getBilling', method: 'GET', path: '/v1/billing', auth: true, response: BillingStatus }),

  getTeam: route({ id: 'service.getTeam', method: 'GET', path: '/v1/team', auth: true, response: Team }),
  createInvite: route({ id: 'service.createInvite', method: 'POST', path: '/v1/team/invites', auth: true, body: z.object({ githubLogin: GithubLogin }).strict(), response: Invite, status: 201 }),
  revokeInvite: route({ id: 'service.revokeInvite', method: 'DELETE', path: '/v1/team/invites/:inviteId', auth: true, response: Invite }),
  acceptInvite: route({ id: 'service.acceptInvite', method: 'POST', path: '/v1/invites/:inviteId/accept', auth: true, body: z.object({}).strict(), response: Account }),
  removeMember: route({ id: 'service.removeMember', method: 'DELETE', path: '/v1/team/members/:accountId', auth: true, response: Team }),
  listSharedMachines: route({ id: 'service.listSharedMachines', method: 'GET', path: '/v1/team/machines', auth: true, response: z.object({ machines: z.array(SharedMachine) }).strict() }),
};

/** The desktop adapter's client for the service API. */
export function createServiceClient(config: ClientConfig) {
  const r = serviceRoutes;
  return {
    startDeviceSignIn: () => callRoute(config, r.startDeviceSignIn, { body: {} }),
    pollDeviceSignIn: (deviceCode: string) => callRoute(config, r.pollDeviceSignIn, { body: { deviceCode } }),
    signOut: () => callRoute(config, r.signOut, { body: {} }),
    getAccount: () => callRoute(config, r.getAccount),
    setTailscaleLogin: (tailscaleLogin: string) => callRoute(config, r.setTailscaleLogin, { body: { tailscaleLogin } }),
    listMachines: () => callRoute(config, r.listMachines),
    createMachine: (name: string, idempotencyKey: string) => callRoute(config, r.createMachine, { body: { name, idempotencyKey } }),
    getMachine: (machineId: string) => callRoute(config, r.getMachine, { params: { machineId } }),
    startMachine: (machineId: string) => callRoute(config, r.startMachine, { params: { machineId }, body: {} }),
    stopMachine: (machineId: string) => callRoute(config, r.stopMachine, { params: { machineId }, body: {} }),
    deleteMachine: (machineId: string) => callRoute(config, r.deleteMachine, { params: { machineId } }),
    requestOperation: (machineId: string, request: UserOperationRequest) => callRoute(config, r.requestOperation, { params: { machineId }, body: request }),
    listActionLog: (machineId: string, page: { before?: string; limit?: number } = {}) => callRoute(config, r.listActionLog, { params: { machineId }, query: page }),
    setSharing: (machineId: string, shared: boolean) => callRoute(config, r.setSharing, { params: { machineId }, body: { shared } }),
    leaveConnectionCode: (machineId: string, handoff: { forAccountId: string; code: string; expiresAt: string }) =>
      callRoute(config, r.leaveConnectionCode, { params: { machineId }, body: handoff }),
    claimConnectionCode: (machineId: string) => callRoute(config, r.claimConnectionCode, { params: { machineId }, body: {} }),
    getBeta: () => callRoute(config, r.getBeta),
    getBilling: () => callRoute(config, r.getBilling),
    getTeam: () => callRoute(config, r.getTeam),
    createInvite: (githubLogin: string) => callRoute(config, r.createInvite, { body: { githubLogin } }),
    revokeInvite: (inviteId: string) => callRoute(config, r.revokeInvite, { params: { inviteId } }),
    acceptInvite: (inviteId: string) => callRoute(config, r.acceptInvite, { params: { inviteId }, body: {} }),
    removeMember: (accountId: string) => callRoute(config, r.removeMember, { params: { accountId } }),
    listSharedMachines: () => callRoute(config, r.listSharedMachines),
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
    throw new CloudApiError('operation_not_allowed', `"${operation}" is not an operation you can run on a Pane Cloud machine.`, `Use one of: ${USER_OPERATIONS.join(', ')}.`);
  }
  const parsed = UserOperationRequest.safeParse(body);
  if (!parsed.success) {
    throw new CloudApiError('invalid_request', `The parameters for ${operation} do not match the contract: ${z.prettifyError(parsed.error)}`, 'Send only the parameters the operation allows.');
  }
  return parsed.data;
}
