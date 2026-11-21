/**
 * The fleet API: what the Pane Cloud service calls on the fleet (the host agent).
 *
 * Every change to a Session VM is one signed operation sent to POST /v1/operations. The fleet runs
 * only the operations named in FLEET_OPERATIONS, each with the fixed parameters its schema allows,
 * and refuses an envelope whose signature, lifetime or parameters do not check out.
 */
import { createVerify } from 'node:crypto';
import { z } from 'zod';
import { CloudApiError } from './errors';
import { callRoute, type ClientConfig, route } from './http';

/** A Session VM's memory. Every VM is created at 8 GiB; growing to 16 GiB comes later (resize). */
export const VmMemoryGiB = z.union([z.literal(8), z.literal(16)]);
export type VmMemoryGiB = z.infer<typeof VmMemoryGiB>;

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

export const VmId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
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
 * Why the service stops a VM; the fleet records it as the VM's stateReason. `user`: its creator
 * stopped it. `review`: paused for review, automatically or by a person's Suspend (one state, D-68).
 * Stops the fleet makes on its own (host maintenance, host loss) set their own reason.
 */
export const StopCause = z.enum(['user', 'review']);
const StopParameters = z.object({ cause: StopCause }).strict();

/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the VM through
 * the guest agent. Nothing else exists: no shell command, no file write, no access grant. `create`
 * makes an 8 GiB, 4 vCPU VM and starts it; `stop` keeps its disk; `start` boots it from that disk.
 */
export const FLEET_OPERATIONS = {
  create: { runsOn: 'host', parameters: NoParameters },
  start: { runsOn: 'host', parameters: NoParameters },
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
  vmId: VmId,
  /** Why the operation runs, shown to the VM's creator in its action log. */
  reason: z.string().min(1).max(500),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
};

function payloadFor<N extends FleetOperationName, P extends (typeof FLEET_OPERATIONS)[N]['parameters']>(name: N, parameters: P) {
  return z.object({ ...payloadFields, operation: z.literal(name), parameters }).strict();
}

export const OperationPayload = z.discriminatedUnion('operation', [
  payloadFor('create', FLEET_OPERATIONS.create.parameters),
  payloadFor('start', FLEET_OPERATIONS.start.parameters),
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

export const FleetVmState = z.enum(['creating', 'running', 'stopping', 'stopped', 'starting', 'deleting', 'deleted', 'error']);

/** Why a VM last stopped or failed; null while it runs normally. */
export const StateReason = z.enum(['user', 'review', 'host_maintenance', 'host_lost', 'failed']);

export const FleetVm = z
  .object({
    vmId: VmId,
    state: FleetVmState,
    stateReason: StateReason.nullable(),
    hostId: z.string().nullable(),
    memoryGiB: VmMemoryGiB,
    paneVersion: z.string().nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type FleetVm = z.infer<typeof FleetVm>;

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
    vmId: VmId,
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

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One VM's resource use for a UTC day, for the abuse signals and the per-VM graphs. */
export const VmMetrics = z
  .object({
    vmId: VmId,
    /** UTC day, YYYY-MM-DD. */
    day: Day,
    cpuSecondsUsed: z.number().nonnegative(),
    /** Host-side resident memory. */
    memoryResidentMiB: z.number().nonnegative(),
    diskUsedBytes: z.number().int().nonnegative(),
    /** Bytes the VM sent out to the internet this UTC day. */
    egressBytes: z.number().int().nonnegative(),
    sampledAt: Timestamp,
  })
  .strict();
export type VmMetrics = z.infer<typeof VmMetrics>;

/**
 * What the fleet did, in order: every state change (with its time, the service meters agent-hours
 * from these) and every finished operation, including stops the fleet made on its own.
 */
export const FleetEvent = z
  .object({
    /** Monotonic cursor; pass the last one seen as `after`. */
    id: z.string(),
    vmId: VmId,
    kind: z.enum(['state_changed', 'operation_finished']),
    state: FleetVmState.nullable(),
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
  getVm: route({ id: 'fleet.getVm', method: 'GET', path: '/v1/vms/:vmId', auth: true, response: FleetVm }),
  getMetrics: route({
    id: 'fleet.getMetrics',
    method: 'GET',
    path: '/v1/vms/:vmId/metrics',
    auth: true,
    query: z.object({ day: Day.optional() }).strict(),
    response: VmMetrics,
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
    getVm: (vmId: string) => callRoute(config, fleetRoutes.getVm, { params: { vmId } }),
    getMetrics: (vmId: string, day?: string) => callRoute(config, fleetRoutes.getMetrics, { params: { vmId }, query: { day } }),
    listEvents: (after?: string, limit?: number) => callRoute(config, fleetRoutes.listEvents, { query: { after, limit } }),
  };
}
export type FleetClient = ReturnType<typeof createFleetClient>;
