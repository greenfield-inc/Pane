"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fleetRoutes = exports.FleetEvent = exports.MachineMetrics = exports.OperationStatus = exports.OperationError = exports.FleetMachine = exports.TailnetStatus = exports.StateReason = exports.FleetMachineState = exports.SubmittedEnvelope = exports.OperationEnvelope = exports.OperationSignature = exports.OperationPayload = exports.FleetOperationName = exports.FLEET_OPERATIONS = exports.PaneRelease = exports.MachineId = exports.CLOCK_SKEW_SECONDS = exports.MAX_OPERATION_LIFETIME_SECONDS = exports.DIAGNOSTIC_FILES = exports.MACHINE_LIMITS = void 0;
exports.canonicalJson = canonicalJson;
exports.operationSigningBytes = operationSigningBytes;
exports.signOperation = signOperation;
exports.verifyOperation = verifyOperation;
exports.createFleetClient = createFleetClient;
/**
 * The fleet API: what the Pane Cloud service calls on the fleet (the host agent and scheduler).
 *
 * Every change to a machine is one signed operation sent to POST /v1/operations. The fleet runs only
 * the operations named in FLEET_OPERATIONS, each with the fixed parameters its schema allows, and
 * refuses an envelope whose signature, lifetime or parameters do not check out (D-6).
 */
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const errors_1 = require("./errors");
const http_1 = require("./http");
/** D-13's fair-use ceilings, the same for every machine. */
exports.MACHINE_LIMITS = {
    vcpu: 8,
    memoryMiB: 16_384,
    diskGiB: 50,
    /** 12 vCPU-hours per UTC day; past it the machine runs at 0.5 vCPU until the next UTC midnight. */
    dailyCpuSeconds: 43_200,
    throttledVcpu: 0.5,
    monthlyEgressBytes: 100 * 1024 ** 3,
};
/**
 * The only files collect_diagnostics reads, on the guest. Globs match file names only. Nothing under
 * a user's home other than Pane's own logs is read.
 */
exports.DIAGNOSTIC_FILES = [
    '/var/log/pane-cloud/guest-agent.log',
    '/var/log/pane-cloud/bootstrap.log',
    '/home/pane/.pane/logs/pane-*.log',
];
/** Longest time between an operation's issuedAt and expiresAt. */
exports.MAX_OPERATION_LIFETIME_SECONDS = 300;
/** Allowed clock difference between the service and a host when checking issuedAt. */
exports.CLOCK_SKEW_SECONDS = 30;
exports.MachineId = zod_1.z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Timestamp = zod_1.z.iso.datetime({ offset: true });
/** A published Pane release. update_pane and bootstrap install exactly this .deb, or refuse. */
exports.PaneRelease = zod_1.z
    .object({
    version: zod_1.z.string().regex(/^\d+\.\d+\.\d+$/),
    arch: zod_1.z.literal('arm64'),
    debSha256: zod_1.z.string().regex(/^[0-9a-f]{64}$/),
})
    .strict();
const NoParameters = zod_1.z.object({}).strict();
const ReleaseParameters = zod_1.z.object({ release: exports.PaneRelease }).strict();
/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the machine
 * through the guest agent. Nothing else exists: no shell command, no file write, no access grant.
 */
exports.FLEET_OPERATIONS = {
    create: { runsOn: 'host', parameters: NoParameters },
    resume: { runsOn: 'host', parameters: NoParameters },
    stop: { runsOn: 'host', parameters: NoParameters },
    delete: { runsOn: 'host', parameters: NoParameters },
    bootstrap: { runsOn: 'guest', parameters: ReleaseParameters },
    update_pane: { runsOn: 'guest', parameters: ReleaseParameters },
    prepare_to_stop: { runsOn: 'guest', parameters: NoParameters },
    collect_diagnostics: { runsOn: 'guest', parameters: NoParameters },
};
// SAFETY: Object.keys of a non-empty object literal lists exactly its keys.
const operationNames = Object.keys(exports.FLEET_OPERATIONS);
exports.FleetOperationName = zod_1.z.enum(operationNames);
const payloadFields = {
    /** Chosen by the service; sending the same requestId again returns the first result. */
    requestId: zod_1.z.uuid(),
    machineId: exports.MachineId,
    /** Why the operation runs, shown to the machine's user in its action log. */
    reason: zod_1.z.string().min(1).max(500),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
};
function payloadFor(name) {
    return zod_1.z
        .object({ ...payloadFields, operation: zod_1.z.literal(name), parameters: exports.FLEET_OPERATIONS[name].parameters })
        .strict();
}
exports.OperationPayload = zod_1.z.discriminatedUnion('operation', [
    payloadFor('create'),
    payloadFor('resume'),
    payloadFor('stop'),
    payloadFor('delete'),
    payloadFor('bootstrap'),
    payloadFor('update_pane'),
    payloadFor('prepare_to_stop'),
    payloadFor('collect_diagnostics'),
]);
exports.OperationSignature = zod_1.z
    .object({
    /** Which service signing key made the signature (a KMS key id or alias). */
    keyId: zod_1.z.string().min(1),
    algorithm: zod_1.z.literal('ECDSA_SHA_256'),
    /** Base64 DER ECDSA P-256 signature over operationSigningBytes(payload), as AWS KMS Sign returns it. */
    value: zod_1.z.base64(),
})
    .strict();
exports.OperationEnvelope = zod_1.z.object({ payload: exports.OperationPayload, signature: exports.OperationSignature }).strict();
/**
 * What POST /v1/operations accepts before verifyOperation checks it: any operation name, so an
 * unknown one is refused as operation_not_allowed rather than as a malformed request.
 */
exports.SubmittedEnvelope = zod_1.z.object({ payload: zod_1.z.looseObject({ operation: zod_1.z.string() }), signature: zod_1.z.looseObject({}) }).strict();
/**
 * JSON with object keys sorted at every level and no whitespace: the bytes both sides sign and check.
 * Keys sort by UTF-16 code unit, as JavaScript's default sort does.
 */
function canonicalJson(value) {
    return JSON.stringify(value, (_key, entry) => entry !== null && Object.getPrototypeOf(entry) === Object.prototype
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : entry);
}
const SIGNING_DOMAIN = 'pane-cloud-operation-v1\n';
/** The exact bytes the service signs for an operation: a domain line, then the payload's canonical JSON. */
function operationSigningBytes(payload) {
    return Buffer.from(SIGNING_DOMAIN + canonicalJson(payload), 'utf8');
}
async function signOperation(payload, signer) {
    const checked = exports.OperationPayload.parse(payload);
    const signature = await signer.sign(operationSigningBytes(checked));
    return { payload: checked, signature: { keyId: signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } };
}
/**
 * The host agent's check of an envelope it received, before it runs anything. Throws CloudApiError:
 * operation_not_allowed or invalid_request for a payload outside the allow-list, signature_invalid
 * for an unknown key or a bad signature, operation_expired outside the payload's time window.
 */
function verifyOperation(envelope, trustedKeys, now = new Date()) {
    const operation = envelope.payload.operation;
    if (!exports.FleetOperationName.safeParse(operation).success) {
        throw new errors_1.CloudApiError('operation_not_allowed', `"${operation}" is not an allow-listed fleet operation.`, `Use one of: ${Object.keys(exports.FLEET_OPERATIONS).join(', ')}.`);
    }
    const parsed = exports.OperationEnvelope.safeParse(envelope);
    if (!parsed.success) {
        throw new errors_1.CloudApiError('invalid_request', `The operation envelope does not match the contract: ${zod_1.z.prettifyError(parsed.error)}`, 'Send only the fixed parameters the operation allows.');
    }
    const { payload, signature } = parsed.data;
    const publicKeyPem = trustedKeys[signature.keyId];
    const verifier = (0, node_crypto_1.createVerify)('SHA256');
    verifier.update(operationSigningBytes(payload));
    if (!publicKeyPem || !verifier.verify(publicKeyPem, Buffer.from(signature.value, 'base64'))) {
        throw new errors_1.CloudApiError('signature_invalid', 'The operation is not signed by a trusted service key.', 'Sign the payload with the service signing key; the host ran nothing.');
    }
    const issued = Date.parse(payload.issuedAt);
    const expires = Date.parse(payload.expiresAt);
    const nowMs = now.getTime();
    if (expires <= issued ||
        expires - issued > exports.MAX_OPERATION_LIFETIME_SECONDS * 1000 ||
        issued > nowMs + exports.CLOCK_SKEW_SECONDS * 1000 ||
        expires <= nowMs) {
        throw new errors_1.CloudApiError('operation_expired', 'The operation is outside its signed time window.', `Sign a new operation that expires within ${exports.MAX_OPERATION_LIFETIME_SECONDS} seconds of issuedAt.`);
    }
    return parsed.data;
}
exports.FleetMachineState = zod_1.z.enum(['creating', 'running', 'stopping', 'stopped', 'resuming', 'deleting', 'deleted', 'error']);
/** Why a machine last stopped or failed; null while it runs normally. */
exports.StateReason = zod_1.z.enum(['user', 'idle', 'memory_pressure', 'host_maintenance', 'host_lost', 'abuse', 'billing', 'end_of_beta', 'failed']);
/** The machine's place on the user's tailnet. It joins only from a login link its user opens. */
exports.TailnetStatus = zod_1.z
    .object({
    status: zod_1.z.enum(['awaiting_login', 'joined']),
    /** The `tailscale up` login link, shown only to the machine's owner, until the machine joins. */
    loginUrl: zod_1.z.url().nullable(),
    /** The machine's MagicDNS name once it has joined. */
    hostname: zod_1.z.string().nullable(),
})
    .strict();
exports.FleetMachine = zod_1.z
    .object({
    machineId: exports.MachineId,
    state: exports.FleetMachineState,
    stateReason: exports.StateReason.nullable(),
    hostId: zod_1.z.string().nullable(),
    paneVersion: zod_1.z.string().nullable(),
    tailnet: exports.TailnetStatus,
    updatedAt: Timestamp,
})
    .strict();
exports.OperationError = zod_1.z.object({ code: zod_1.z.string(), message: zod_1.z.string(), next: zod_1.z.string() }).strict();
const DiagnosticsResult = zod_1.z
    .object({
    files: zod_1.z.array(zod_1.z.object({ path: zod_1.z.string(), bytes: zod_1.z.number().int().nonnegative() }).strict()),
    /** Object key of the collected archive in the fleet's diagnostics bucket. */
    archiveKey: zod_1.z.string(),
})
    .strict();
exports.OperationStatus = zod_1.z
    .object({
    requestId: zod_1.z.uuid(),
    machineId: exports.MachineId,
    operation: exports.FleetOperationName,
    status: zod_1.z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: exports.OperationError.nullable(),
    /** Set for a finished collect_diagnostics; null for every other operation. */
    result: DiagnosticsResult.nullable(),
    acceptedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
})
    .strict();
exports.MachineMetrics = zod_1.z
    .object({
    machineId: exports.MachineId,
    /** UTC day, YYYY-MM-DD. */
    day: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cpuSecondsUsed: zod_1.z.number().nonnegative(),
    cpuBudgetSeconds: zod_1.z.literal(exports.MACHINE_LIMITS.dailyCpuSeconds),
    throttled: zod_1.z.boolean(),
    /** Host-side resident memory, which F4's reclaim rules act on. */
    memoryResidentMiB: zod_1.z.number().nonnegative(),
    diskUsedBytes: zod_1.z.number().int().nonnegative(),
    egressBytesThisMonth: zod_1.z.number().int().nonnegative(),
    sampledAt: Timestamp,
})
    .strict();
/** Things the fleet did or saw on its own (an idle stop, a memory-pressure stop, a host loss). */
exports.FleetEvent = zod_1.z
    .object({
    /** Monotonic cursor; pass the last one seen as `after`. */
    id: zod_1.z.string(),
    machineId: exports.MachineId,
    kind: zod_1.z.enum(['state_changed', 'operation_finished', 'budget_exhausted', 'budget_reset']),
    state: exports.FleetMachineState.nullable(),
    reason: exports.StateReason.nullable(),
    requestId: zod_1.z.uuid().nullable(),
    at: Timestamp,
})
    .strict();
exports.fleetRoutes = {
    submitOperation: (0, http_1.route)({
        id: 'fleet.submitOperation',
        method: 'POST',
        path: '/v1/operations',
        auth: true,
        body: exports.SubmittedEnvelope,
        response: exports.OperationStatus,
        status: 202,
    }),
    getOperation: (0, http_1.route)({ id: 'fleet.getOperation', method: 'GET', path: '/v1/operations/:requestId', auth: true, response: exports.OperationStatus }),
    getMachine: (0, http_1.route)({ id: 'fleet.getMachine', method: 'GET', path: '/v1/machines/:machineId', auth: true, response: exports.FleetMachine }),
    getMetrics: (0, http_1.route)({
        id: 'fleet.getMetrics',
        method: 'GET',
        path: '/v1/machines/:machineId/metrics',
        auth: true,
        query: zod_1.z.object({ day: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
        response: exports.MachineMetrics,
    }),
    listEvents: (0, http_1.route)({
        id: 'fleet.listEvents',
        method: 'GET',
        path: '/v1/events',
        auth: true,
        query: zod_1.z.object({ after: zod_1.z.string().optional(), limit: zod_1.z.coerce.number().int().min(1).max(500).optional() }).strict(),
        response: zod_1.z.object({ events: zod_1.z.array(exports.FleetEvent), nextCursor: zod_1.z.string().nullable() }).strict(),
    }),
};
/** The service's client for the fleet API. */
function createFleetClient(config) {
    return {
        submitOperation: (envelope) => (0, http_1.callRoute)(config, exports.fleetRoutes.submitOperation, { body: envelope }),
        getOperation: (requestId) => (0, http_1.callRoute)(config, exports.fleetRoutes.getOperation, { params: { requestId } }),
        getMachine: (machineId) => (0, http_1.callRoute)(config, exports.fleetRoutes.getMachine, { params: { machineId } }),
        getMetrics: (machineId, day) => (0, http_1.callRoute)(config, exports.fleetRoutes.getMetrics, { params: { machineId }, query: { day } }),
        listEvents: (after, limit) => (0, http_1.callRoute)(config, exports.fleetRoutes.listEvents, { query: { after, limit } }),
    };
}
