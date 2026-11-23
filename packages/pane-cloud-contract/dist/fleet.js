"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fleetRoutes = exports.FleetEvent = exports.VmMetrics = exports.OperationStatus = exports.PrebootPairing = exports.PREBOOT_RELAY_FILES = exports.PairingLink = exports.RelayIdentity = exports.OperationError = exports.FleetVm = exports.StateReason = exports.FleetVmState = exports.SubmittedEnvelope = exports.OperationEnvelope = exports.OperationSignature = exports.OperationPayload = exports.FleetOperationName = exports.FLEET_OPERATIONS = exports.StopCause = exports.PaneRelease = exports.VmId = exports.CLOCK_SKEW_SECONDS = exports.MAX_OPERATION_LIFETIME_SECONDS = exports.DIAGNOSTIC_FILES = exports.VmMemoryGiB = void 0;
exports.canonicalJson = canonicalJson;
exports.operationSigningBytes = operationSigningBytes;
exports.signOperation = signOperation;
exports.verifyOperation = verifyOperation;
exports.relayComputerIdOf = relayComputerIdOf;
exports.createFleetClient = createFleetClient;
/**
 * The fleet API: what the Pane Cloud service calls on the fleet (the host agent).
 *
 * Every change to a Session VM is one signed operation sent to POST /v1/operations. The fleet runs
 * only the operations named in FLEET_OPERATIONS, each with the fixed parameters its schema allows,
 * and refuses an envelope whose signature, lifetime or parameters do not check out.
 */
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const errors_1 = require("./errors");
const http_1 = require("./http");
/** A Session VM's memory. Every VM is created at 8 GiB; growing to 16 GiB comes later (resize). */
exports.VmMemoryGiB = zod_1.z.union([zod_1.z.literal(8), zod_1.z.literal(16)]);
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
exports.VmId = zod_1.z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
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
 * Why the service stops a VM; the fleet records it as the VM's stateReason. `user`: its creator
 * stopped it. `review`: paused for review, automatically or by a person's Suspend (one state, D-68).
 * Stops the fleet makes on its own (host maintenance, host loss) set their own reason.
 */
exports.StopCause = zod_1.z.enum(['user', 'review']);
const StopParameters = zod_1.z.object({ cause: exports.StopCause }).strict();
/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the VM through
 * the guest agent. Nothing else exists: no shell command, no file write, no access grant. `create`
 * makes an 8 GiB, 4 vCPU VM and starts it; `stop` keeps its disk; `start` boots it from that disk.
 * `create` also makes the VM's relay identity and a first one-time pairing link before the VM boots
 * (PREBOOT_RELAY_FILES) and returns them, so the service can vouch while the VM boots (D-104).
 * `create_pairing_link` asks the running VM's Pane for another link, for a later pairing.
 */
exports.FLEET_OPERATIONS = {
    create: { runsOn: 'host', parameters: NoParameters },
    start: { runsOn: 'host', parameters: NoParameters },
    stop: { runsOn: 'host', parameters: StopParameters },
    delete: { runsOn: 'host', parameters: NoParameters },
    bootstrap: { runsOn: 'guest', parameters: ReleaseParameters },
    update_pane: { runsOn: 'guest', parameters: ReleaseParameters },
    prepare_to_stop: { runsOn: 'guest', parameters: NoParameters },
    collect_diagnostics: { runsOn: 'guest', parameters: NoParameters },
    create_pairing_link: { runsOn: 'guest', parameters: NoParameters },
};
// SAFETY: Object.keys of a non-empty object literal lists exactly its keys.
const operationNames = Object.keys(exports.FLEET_OPERATIONS);
exports.FleetOperationName = zod_1.z.enum(operationNames);
const payloadFields = {
    /**
     * Chosen by the service. The host records it once the signature and time window check out, before
     * running anything, so a resend answers with the first outcome, a refusal included.
     */
    requestId: zod_1.z.uuid(),
    /** The host that should run the operation; every other host refuses it with wrong_host. */
    hostId: zod_1.z.string().min(1).max(64),
    vmId: exports.VmId,
    /** Why the operation runs, shown to the VM's creator in its action log. */
    reason: zod_1.z.string().min(1).max(500),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
};
function payloadFor(name, parameters) {
    return zod_1.z.object({ ...payloadFields, operation: zod_1.z.literal(name), parameters }).strict();
}
exports.OperationPayload = zod_1.z.discriminatedUnion('operation', [
    payloadFor('create', exports.FLEET_OPERATIONS.create.parameters),
    payloadFor('start', exports.FLEET_OPERATIONS.start.parameters),
    payloadFor('stop', exports.FLEET_OPERATIONS.stop.parameters),
    payloadFor('delete', exports.FLEET_OPERATIONS.delete.parameters),
    payloadFor('bootstrap', exports.FLEET_OPERATIONS.bootstrap.parameters),
    payloadFor('update_pane', exports.FLEET_OPERATIONS.update_pane.parameters),
    payloadFor('prepare_to_stop', exports.FLEET_OPERATIONS.prepare_to_stop.parameters),
    payloadFor('collect_diagnostics', exports.FLEET_OPERATIONS.collect_diagnostics.parameters),
    payloadFor('create_pairing_link', exports.FLEET_OPERATIONS.create_pairing_link.parameters),
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
 * for an unknown key or a bad signature, operation_expired outside the payload's time window, and
 * wrong_host for an operation signed for another host.
 */
function verifyOperation(envelope, trustedKeys, hostId, now = new Date()) {
    const operation = envelope.payload.operation;
    if (!exports.FleetOperationName.safeParse(operation).success) {
        throw new errors_1.CloudApiError('operation_not_allowed', `"${operation}" is not an allow-listed fleet operation.`, `Use one of: ${Object.keys(exports.FLEET_OPERATIONS).join(', ')}.`);
    }
    const parsed = exports.OperationEnvelope.safeParse(envelope);
    if (!parsed.success) {
        throw new errors_1.CloudApiError('invalid_request', `The operation envelope does not match the contract: ${zod_1.z.prettifyError(parsed.error)}`, 'Send only the fixed parameters the operation allows.');
    }
    const { payload, signature } = parsed.data;
    const publicKeyPem = Object.hasOwn(trustedKeys, signature.keyId) ? trustedKeys[signature.keyId] : undefined;
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
    if (payload.hostId !== hostId) {
        throw new errors_1.CloudApiError('wrong_host', `The operation is signed for host ${payload.hostId}, and this is ${hostId}.`, 'Send it to the host it names; this host ran nothing.');
    }
    return parsed.data;
}
exports.FleetVmState = zod_1.z.enum(['creating', 'running', 'stopping', 'stopped', 'starting', 'deleting', 'deleted', 'error']);
/** Why a VM last stopped or failed; null while it runs normally. */
exports.StateReason = zod_1.z.enum(['user', 'review', 'host_maintenance', 'host_lost', 'failed']);
exports.FleetVm = zod_1.z
    .object({
    vmId: exports.VmId,
    state: exports.FleetVmState,
    stateReason: exports.StateReason.nullable(),
    hostId: zod_1.z.string().nullable(),
    memoryGiB: exports.VmMemoryGiB,
    paneVersion: zod_1.z.string().nullable(),
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
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The relay computer id a key fingerprint names: its first 80 bits in lowercase base32 (Pane's relay/PROTOCOL.md). */
function relayComputerIdOf(fingerprint) {
    let value = 0;
    let bits = 0;
    let id = '';
    for (const char of fingerprint.slice(0, 16)) {
        value = ((value << 6) | BASE64URL.indexOf(char)) & 0x7ff;
        bits += 6;
        while (bits >= 5 && id.length < 16) {
            id += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return id;
}
/**
 * A Session VM's relay identity: the name clients reach it at, `https://<computerId>.<domain>`, and
 * the key they pin. The VM's Pane makes the key on first use and keeps it on the Session disk.
 */
exports.RelayIdentity = zod_1.z
    .object({
    computerId: zod_1.z.string().regex(/^[a-z2-7]{16}$/),
    /** Base64url SHA-256 of the VM's relay public key (SubjectPublicKeyInfo DER). */
    fingerprint: zod_1.z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    /** The relay domain, `host[:port]`: runpane.net in production. */
    domain: zod_1.z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/),
})
    .strict()
    .refine((relay) => relayComputerIdOf(relay.fingerprint) === relay.computerId, { message: 'computerId is not the id the fingerprint names', path: ['computerId'] });
/**
 * A one-time link a device trades for its token on the VM (`https://<domain>/pair#s=…&c=<computerId>&n=…`),
 * with the identity the VM's Pane reported. The link works once, within 10 minutes. The fleet keeps
 * it only to answer a retried request, never in a log or an event.
 */
exports.PairingLink = zod_1.z
    .object({
    relay: exports.RelayIdentity,
    link: zod_1.z.url({ protocol: /^https$/ }),
    expiresAt: Timestamp,
})
    .strict();
/**
 * What the host writes onto a new VM's secrets volume at assignment, before the first boot (D-104),
 * as paths under the volume's root (the guest's PANE_SECRETS_DIR). Pane uses this key as its relay
 * key and accepts this one-time secret as a pairing link, so pairing needs no step after the
 * daemon's socket appears. The host keeps the private key only on the volume, and the secret only
 * as its hash there and in `create`'s result for the service.
 *
 * Ownership: both files and the `relay/` directory belong to the guest's Pane user (`pane`), the
 * files with mode 0600 and the directory with mode 0700, written complete before the first boot. Pane
 * treats a key file it can't read, or an empty one, as an error naming the file and never makes a
 * key of its own in its place; only an absent file means "no host-made key".
 */
exports.PREBOOT_RELAY_FILES = {
    /** The VM's relay key: a P-256 private key, PKCS#8 PEM. Its public key's fingerprint is the identity `create` returns. */
    key: 'relay/computer-key.pem',
    /** The first pairing link's secret, as PrebootPairing JSON. */
    pairing: 'relay/pairing.json',
};
/** `relay/pairing.json`: the SHA-256 (hex) of the one-time secret in `create`'s link, and when the link expires. */
exports.PrebootPairing = zod_1.z.object({ sha256: zod_1.z.string().regex(/^[0-9a-f]{64}$/), expiresAt: Timestamp }).strict();
exports.OperationStatus = zod_1.z
    .object({
    requestId: zod_1.z.uuid(),
    vmId: exports.VmId,
    operation: exports.FleetOperationName,
    status: zod_1.z.enum(['accepted', 'running', 'succeeded', 'failed']),
    error: exports.OperationError.nullable(),
    /** Set for a finished create (the pre-boot identity and first link), collect_diagnostics or create_pairing_link; null for every other operation. */
    result: zod_1.z.union([DiagnosticsResult, exports.PairingLink]).nullable(),
    acceptedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
})
    .strict();
const Day = zod_1.z.iso.date();
/** One VM's resource use for a UTC day, for the abuse signals and the per-VM graphs. */
exports.VmMetrics = zod_1.z
    .object({
    vmId: exports.VmId,
    /** UTC day, YYYY-MM-DD. */
    day: Day,
    cpuSecondsUsed: zod_1.z.number().nonnegative(),
    /** Host-side resident memory. */
    memoryResidentMiB: zod_1.z.number().nonnegative(),
    diskUsedBytes: zod_1.z.number().int().nonnegative(),
    /** Bytes the VM sent out to the internet this UTC day. */
    egressBytes: zod_1.z.number().int().nonnegative(),
    sampledAt: Timestamp,
})
    .strict();
/**
 * What the fleet did, in order: every state change (with its time, the service meters agent-hours
 * from these) and every finished operation, including stops the fleet made on its own.
 */
exports.FleetEvent = zod_1.z
    .object({
    /** Monotonic cursor; pass the last one seen as `after`. */
    id: zod_1.z.string(),
    vmId: exports.VmId,
    kind: zod_1.z.enum(['state_changed', 'operation_finished']),
    state: exports.FleetVmState.nullable(),
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
    getVm: (0, http_1.route)({ id: 'fleet.getVm', method: 'GET', path: '/v1/vms/:vmId', auth: true, response: exports.FleetVm }),
    getMetrics: (0, http_1.route)({
        id: 'fleet.getMetrics',
        method: 'GET',
        path: '/v1/vms/:vmId/metrics',
        auth: true,
        query: zod_1.z.object({ day: Day.optional() }).strict(),
        response: exports.VmMetrics,
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
        getVm: (vmId) => (0, http_1.callRoute)(config, exports.fleetRoutes.getVm, { params: { vmId } }),
        getMetrics: (vmId, day) => (0, http_1.callRoute)(config, exports.fleetRoutes.getMetrics, { params: { vmId }, query: { day } }),
        listEvents: (after, limit) => (0, http_1.callRoute)(config, exports.fleetRoutes.listEvents, { query: { after, limit } }),
    };
}
