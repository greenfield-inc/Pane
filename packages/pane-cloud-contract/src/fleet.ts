/**
 * The fleet API: what the Pane Cloud service calls on the fleet (the host agent and scheduler).
 *
 * Every change to a machine is one signed operation sent to POST /v1/operations. The fleet runs only
 * the operations named in FLEET_OPERATIONS, each with the fixed parameters its schema allows, and
 * refuses an envelope whose signature, lifetime or parameters do not check out (D-6).
 */
import { createVerify } from 'node:crypto';
import { z } from 'zod';
import { CloudApiError } from './errors';
import { callRoute, type ClientConfig, route } from './http';

/** D-13's fair-use ceilings, the same for every machine. */
export const MACHINE_LIMITS = {
  vcpu: 8,
  memoryMiB: 16_384,
  diskGiB: 50,
  /** 12 vCPU-hours per UTC day; past it the machine runs at 0.5 vCPU until the next UTC midnight. */
  dailyCpuSeconds: 43_200,
  throttledVcpu: 0.5,
  monthlyEgressBytes: 100 * 1024 ** 3,
} as const;

/**
 * The only files collect_diagnostics reads, on the guest. Globs match file names only. Nothing under
 * a user's home other than Pane's own logs is read.
 */
export const DIAGNOSTIC_FILES = [
  '/var/log/pane-cloud/guest-agent.log',
  '/var/log/pane-cloud/bootstrap.log',
  '/home/pane/.pane/logs/pane-*.log',
] as const;

/** Longest time between an operation's issuedAt and expiresAt. */
export const MAX_OPERATION_LIFETIME_SECONDS = 300;
/** Allowed clock difference between the service and a host when checking issuedAt. */
export const CLOCK_SKEW_SECONDS = 30;

export const MachineId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Timestamp = z.iso.datetime({ offset: true });

/** A published Pane release. update_pane and bootstrap install exactly this .deb, or refuse. */
export const PaneRelease = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    arch: z.literal('arm64'),
    debSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PaneRelease = z.infer<typeof PaneRelease>;

const NoParameters = z.object({}).strict();
const ReleaseParameters = z.object({ release: PaneRelease }).strict();

/**
 * Why the service stops a machine; the fleet records it as the machine's stateReason. Stops the
 * fleet makes on its own (idle, memory pressure, host maintenance, host loss) set their own reason.
 */
export const StopCause = z.enum(['user', 'billing', 'end_of_beta', 'abuse']);
const StopParameters = z.object({ cause: StopCause }).strict();

/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the machine
 * through the guest agent. Nothing else exists: no shell command, no file write, no access grant.
 */
export const FLEET_OPERATIONS = {
  create: { runsOn: 'host', parameters: NoParameters },
  resume: { runsOn: 'host', parameters: NoParameters },
  stop: { runsOn: 'host', parameters: StopParameters },
  delete: { runsOn: 'host', parameters: NoParameters },
  bootstrap: { runsOn: 'guest', parameters: ReleaseParameters },
  update_pane: { runsOn: 'guest', parameters: ReleaseParameters },
  prepare_to_stop: { runsOn: 'guest', parameters: NoParameters },
  collect_diagnostics: { runsOn: 'guest', parameters: NoParameters },
} as const;

export type FleetOperationName = keyof typeof FLEET_OPERATIONS;
// SAFETY: Object.keys of a non-empty object literal lists exactly its keys.
const operationNames = Object.keys(FLEET_OPERATIONS) as [FleetOperationName, ...FleetOperationName[]];
export const FleetOperationName = z.enum(operationNames);

const payloadFields = {
  /** Chosen by the service; sending the same requestId again returns the first result. */
  requestId: z.uuid(),
  machineId: MachineId,
  /** Why the operation runs, shown to the machine's user in its action log. */
  reason: z.string().min(1).max(500),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
};

function payloadFor<N extends FleetOperationName, P extends (typeof FLEET_OPERATIONS)[N]['parameters']>(name: N, parameters: P) {
  return z.object({ ...payloadFields, operation: z.literal(name), parameters }).strict();
}

export const OperationPayload = z.discriminatedUnion('operation', [
  payloadFor('create', FLEET_OPERATIONS.create.parameters),
  payloadFor('resume', FLEET_OPERATIONS.resume.parameters),
  payloadFor('stop', FLEET_OPERATIONS.stop.parameters),
  payloadFor('delete', FLEET_OPERATIONS.delete.parameters),
  payloadFor('bootstrap', FLEET_OPERATIONS.bootstrap.parameters),
  payloadFor('update_pane', FLEET_OPERATIONS.update_pane.parameters),
  payloadFor('prepare_to_stop', FLEET_OPERATIONS.prepare_to_stop.parameters),
  payloadFor('collect_diagnostics', FLEET_OPERATIONS.collect_diagnostics.parameters),
]);
export type OperationPayload = z.infer<typeof OperationPayload>;

export const OperationSignature = z
  .object({
    /** Which service signing key made the signature (a KMS key id or alias). */
    keyId: z.string().min(1),
    algorithm: z.literal('ECDSA_SHA_256'),
    /** Base64 DER ECDSA P-256 signature over operationSigningBytes(payload), as AWS KMS Sign returns it. */
    value: z.base64(),
  })
  .strict();

export const OperationEnvelope = z.object({ payload: OperationPayload, signature: OperationSignature }).strict();
export type OperationEnvelope = z.infer<typeof OperationEnvelope>;

/**
 * What POST /v1/operations accepts before verifyOperation checks it: any operation name, so an
 * unknown one is refused as operation_not_allowed rather than as a malformed request.
 */
export const SubmittedEnvelope = z.object({ payload: z.looseObject({ operation: z.string() }), signature: z.looseObject({}) }).strict();
export type SubmittedEnvelope = z.infer<typeof SubmittedEnvelope>;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * JSON with object keys sorted at every level and no whitespace: the bytes both sides sign and check.
 * Keys sort by UTF-16 code unit, as JavaScript's default sort does.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, entry) =>
    entry !== null && Object.getPrototypeOf(entry) === Object.prototype
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

const SIGNING_DOMAIN = 'pane-cloud-operation-v1\n';

/** The exact bytes the service signs for an operation: a domain line, then the payload's canonical JSON. */
export function operationSigningBytes(payload: JsonObject): Buffer {
  return Buffer.from(SIGNING_DOMAIN + canonicalJson(payload), 'utf8');
}

/** Something that signs bytes with a service key: AWS KMS in S1, a local key in tests. */
export interface OperationSigner {
  keyId: string;
  sign(bytes: Buffer): Promise<Buffer>;
}

export async function signOperation(payload: OperationPayload, signer: OperationSigner): Promise<OperationEnvelope> {
  const checked = OperationPayload.parse(payload);
  const signature = await signer.sign(operationSigningBytes(checked));
  return { payload: checked, signature: { keyId: signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } };
}

/**
 * The host agent's check of an envelope it received, before it runs anything. Throws CloudApiError:
 * operation_not_allowed or invalid_request for a payload outside the allow-list, signature_invalid
 * for an unknown key or a bad signature, operation_expired outside the payload's time window.
 */
export function verifyOperation(envelope: SubmittedEnvelope, trustedKeys: Readonly<Record<string, string>>, now: Date = new Date()): OperationEnvelope {
  const operation = envelope.payload.operation;
  if (!FleetOperationName.safeParse(operation).success) {
    throw new CloudApiError('operation_not_allowed', `"${operation}" is not an allow-listed fleet operation.`, `Use one of: ${Object.keys(FLEET_OPERATIONS).join(', ')}.`);
  }
  const parsed = OperationEnvelope.safeParse(envelope);
  if (!parsed.success) {
    throw new CloudApiError('invalid_request', `The operation envelope does not match the contract: ${z.prettifyError(parsed.error)}`, 'Send only the fixed parameters the operation allows.');
  }
  const { payload, signature } = parsed.data;
  const publicKeyPem = trustedKeys[signature.keyId];
  const verifier = createVerify('SHA256');
  verifier.update(operationSigningBytes(payload));
  if (!publicKeyPem || !verifier.verify(publicKeyPem, Buffer.from(signature.value, 'base64'))) {
    throw new CloudApiError('signature_invalid', 'The operation is not signed by a trusted service key.', 'Sign the payload with the service signing key; the host ran nothing.');
  }
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  const nowMs = now.getTime();
  if (
    expires <= issued ||
    expires - issued > MAX_OPERATION_LIFETIME_SECONDS * 1000 ||
    issued > nowMs + CLOCK_SKEW_SECONDS * 1000 ||
    expires <= nowMs
  ) {
    throw new CloudApiError('operation_expired', 'The operation is outside its signed time window.', `Sign a new operation that expires within ${MAX_OPERATION_LIFETIME_SECONDS} seconds of issuedAt.`);
  }
  return parsed.data;
}

export const FleetMachineState = z.enum(['creating', 'running', 'stopping', 'stopped', 'resuming', 'deleting', 'deleted', 'error']);

/** Why a machine last stopped or failed; null while it runs normally. */
export const StateReason = z.enum(['user', 'idle', 'memory_pressure', 'host_maintenance', 'host_lost', 'abuse', 'billing', 'end_of_beta', 'failed']);

/** The machine's place on the user's tailnet. It joins only from a login link its user opens. */
export const TailnetStatus = z
  .object({
    status: z.enum(['awaiting_login', 'joined']),
    /** The `tailscale up` login link, shown only to the machine's owner, until the machine joins. */
    loginUrl: z.url().nullable(),
    /** The machine's MagicDNS name once it has joined. */
    hostname: z.string().nullable(),
  })
  .strict();

export const FleetMachine = z
  .object({
    machineId: MachineId,
    state: FleetMachineState,
    stateReason: StateReason.nullable(),
    hostId: z.string().nullable(),
    paneVersion: z.string().nullable(),
    tailnet: TailnetStatus,
    updatedAt: Timestamp,
  })
  .strict();
export type FleetMachine = z.infer<typeof FleetMachine>;

export const OperationError = z.object({ code: z.string(), message: z.string(), next: z.string() }).strict();

const DiagnosticsResult = z
  .object({
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict()),
    /** Object key of the collected archive in the fleet's diagnostics bucket. */
    archiveKey: z.string(),
  })
  .strict();

export const OperationStatus = z
  .object({
    requestId: z.uuid(),
    machineId: MachineId,
    operation: FleetOperationName,
    status: z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: OperationError.nullable(),
    /** Set for a finished collect_diagnostics; null for every other operation. */
    result: DiagnosticsResult.nullable(),
    acceptedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
  })
  .strict();
export type OperationStatus = z.infer<typeof OperationStatus>;

export const MachineMetrics = z
  .object({
    machineId: MachineId,
    /** UTC day, YYYY-MM-DD. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cpuSecondsUsed: z.number().nonnegative(),
    cpuBudgetSeconds: z.literal(MACHINE_LIMITS.dailyCpuSeconds),
    throttled: z.boolean(),
    /** Host-side resident memory, which F4's reclaim rules act on. */
    memoryResidentMiB: z.number().nonnegative(),
    diskUsedBytes: z.number().int().nonnegative(),
    egressBytesThisMonth: z.number().int().nonnegative(),
    sampledAt: Timestamp,
  })
  .strict();
export type MachineMetrics = z.infer<typeof MachineMetrics>;

/** Things the fleet did or saw on its own (an idle stop, a memory-pressure stop, a host loss). */
export const FleetEvent = z
  .object({
    /** Monotonic cursor; pass the last one seen as `after`. */
    id: z.string(),
    machineId: MachineId,
    kind: z.enum(['state_changed', 'operation_finished', 'budget_exhausted', 'budget_reset']),
    state: FleetMachineState.nullable(),
    reason: StateReason.nullable(),
    requestId: z.uuid().nullable(),
    at: Timestamp,
  })
  .strict();
export type FleetEvent = z.infer<typeof FleetEvent>;

export const fleetRoutes = {
  submitOperation: route({
    id: 'fleet.submitOperation',
    method: 'POST',
    path: '/v1/operations',
    auth: true,
    body: SubmittedEnvelope,
    response: OperationStatus,
    status: 202,
  }),
  getOperation: route({ id: 'fleet.getOperation', method: 'GET', path: '/v1/operations/:requestId', auth: true, response: OperationStatus }),
  getMachine: route({ id: 'fleet.getMachine', method: 'GET', path: '/v1/machines/:machineId', auth: true, response: FleetMachine }),
  getMetrics: route({
    id: 'fleet.getMetrics',
    method: 'GET',
    path: '/v1/machines/:machineId/metrics',
    auth: true,
    query: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
    response: MachineMetrics,
  }),
  listEvents: route({
    id: 'fleet.listEvents',
    method: 'GET',
    path: '/v1/events',
    auth: true,
    query: z.object({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict(),
    response: z.object({ events: z.array(FleetEvent), nextCursor: z.string().nullable() }).strict(),
  }),
};

/** The service's client for the fleet API. */
export function createFleetClient(config: ClientConfig) {
  return {
    submitOperation: (envelope: OperationEnvelope) => callRoute(config, fleetRoutes.submitOperation, { body: envelope }),
    getOperation: (requestId: string) => callRoute(config, fleetRoutes.getOperation, { params: { requestId } }),
    getMachine: (machineId: string) => callRoute(config, fleetRoutes.getMachine, { params: { machineId } }),
    getMetrics: (machineId: string, day?: string) => callRoute(config, fleetRoutes.getMetrics, { params: { machineId }, query: { day } }),
    listEvents: (after?: string, limit?: number) => callRoute(config, fleetRoutes.listEvents, { query: { after, limit } }),
  };
}
export type FleetClient = ReturnType<typeof createFleetClient>;
