"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocalSigner = createLocalSigner;
exports.fleetContractCases = fleetContractCases;
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const fleet_1 = require("../fleet");
const cases_1 = require("./cases");
/** A P-256 signing key held in memory, standing in for the service's KMS key in tests. */
function createLocalSigner(keyId = 'local-test-key') {
    const { privateKey, publicKey } = (0, node_crypto_1.generateKeyPairSync)('ec', { namedCurve: 'P-256' });
    return {
        signer: { keyId, sign: async (bytes) => (0, node_crypto_1.sign)('sha256', bytes, privateKey) },
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
}
/** The fleet API contract: what F2's host agent and scheduler must do for the service. */
function fleetContractCases(target) {
    // Read baseUrl at call time, so a target can name a server that starts after the cases are built.
    const fleet = (0, fleet_1.createFleetClient)({ get baseUrl() { return target.baseUrl; }, token: target.token });
    const timeoutMs = target.timeoutMs ?? 120_000;
    const payload = (machineId, operation, extra = {}) => {
        const issuedAt = new Date();
        const parameters = operation === 'bootstrap' || operation === 'update_pane' ? { release: target.release } : {};
        // SAFETY: parameters match `operation` (a release for bootstrap and update_pane, none otherwise); signOperation parses it again.
        return {
            requestId: (0, node_crypto_1.randomUUID)(),
            machineId,
            reason: `contract test: ${operation}`,
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
            operation,
            parameters,
            ...extra,
        };
    };
    const run = async (machineId, operation) => {
        const accepted = await fleet.submitOperation(await (0, fleet_1.signOperation)(payload(machineId, operation), target.signer));
        strict_1.default.equal(accepted.machineId, machineId);
        strict_1.default.equal(accepted.operation, operation);
        const finished = await (0, cases_1.waitFor)(() => fleet.getOperation(accepted.requestId), (s) => s.status === 'succeeded' || s.status === 'failed', `${operation} to finish`, timeoutMs);
        strict_1.default.equal(finished.status, 'succeeded', `${operation} failed: ${finished.error?.message ?? ''}`);
        return finished;
    };
    const machineIn = (machineId, state) => (0, cases_1.waitFor)(() => fleet.getMachine(machineId), (m) => m.state === state, `machine ${machineId} to be ${state}`, timeoutMs);
    /** Signs raw bytes, skipping signOperation's own check, to send what a compromised caller might. */
    const signRaw = async (body) => {
        const signature = await target.signer.sign((0, fleet_1.operationSigningBytes)(body));
        // SAFETY: deliberately outside the contract; the case checks the fleet refuses it.
        return { payload: body, signature: { keyId: target.signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } };
    };
    const newMachine = async () => {
        const machineId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
        await run(machineId, 'create');
        await machineIn(machineId, 'running');
        return machineId;
    };
    return [
        {
            name: 'fleet: create, bootstrap, stop, resume and delete a machine, each as one signed operation',
            async run() {
                const machineId = await newMachine();
                await run(machineId, 'bootstrap');
                const booted = await fleet.getMachine(machineId);
                strict_1.default.equal(booted.paneVersion, target.release.version);
                await run(machineId, 'prepare_to_stop');
                await run(machineId, 'stop');
                strict_1.default.equal((await machineIn(machineId, 'stopped')).stateReason, 'user');
                await run(machineId, 'resume');
                await machineIn(machineId, 'running');
                await run(machineId, 'delete');
                await machineIn(machineId, 'deleted');
            },
        },
        {
            name: 'fleet: sending the same signed operation twice runs it once',
            async run() {
                const machineId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                const envelope = await (0, fleet_1.signOperation)(payload(machineId, 'create'), target.signer);
                const first = await fleet.submitOperation(envelope);
                const second = await fleet.submitOperation(envelope);
                strict_1.default.equal(second.requestId, first.requestId);
                await machineIn(machineId, 'running');
                await run(machineId, 'delete');
            },
        },
        {
            name: 'fleet: refuses an operation signed by an untrusted key, or changed after signing',
            async run() {
                const machineId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                await (0, cases_1.expectError)('signature_invalid', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(payload(machineId, 'create'), target.untrustedSigner)));
                const envelope = await (0, fleet_1.signOperation)(payload(machineId, 'create'), target.signer);
                await (0, cases_1.expectError)('signature_invalid', () => fleet.submitOperation({ ...envelope, payload: { ...envelope.payload, reason: 'changed after signing' } }));
                await (0, cases_1.expectError)('machine_not_found', () => fleet.getMachine(machineId));
            },
        },
        {
            name: 'fleet: refuses an operation outside its time window: expired, too long-lived, or issued in the future',
            async run() {
                const machineId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                const past = Date.now() - 600_000;
                const stale = payload(machineId, 'create', { issuedAt: new Date(past).toISOString(), expiresAt: new Date(past + 120_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(stale, target.signer)));
                const nowMs = Date.now();
                const tooLong = payload(machineId, 'create', { issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 600_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(tooLong, target.signer)));
                const future = payload(machineId, 'create', { issuedAt: new Date(nowMs + 120_000).toISOString(), expiresAt: new Date(nowMs + 240_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(future, target.signer)));
                await (0, cases_1.expectError)('machine_not_found', () => fleet.getMachine(machineId));
            },
        },
        {
            name: 'fleet: runs nothing outside the allow-list or its fixed parameters',
            async run() {
                const machineId = await newMachine();
                const base = payload(machineId, 'collect_diagnostics');
                await (0, cases_1.expectError)('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'run_script', parameters: { script: 'id' } })));
                await (0, cases_1.expectError)('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'write_file', parameters: { path: '/etc/passwd', content: '' } })));
                await (0, cases_1.expectError)('invalid_request', async () => fleet.submitOperation(await signRaw({ ...base, parameters: { files: ['/home/pane/.ssh/id_ed25519'] } })));
                const otherChecksum = { ...target.release, debSha256: target.release.debSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
                await (0, cases_1.expectError)('release_not_published', async () => fleet.submitOperation(await (0, fleet_1.signOperation)({ ...payload(machineId, 'update_pane'), operation: 'update_pane', parameters: { release: otherChecksum } }, target.signer)));
                const diagnostics = await run(machineId, 'collect_diagnostics');
                strict_1.default.ok(diagnostics.result, 'collect_diagnostics returns what it collected');
                await run(machineId, 'delete');
            },
        },
        {
            name: 'fleet: reports metrics against the daily CPU budget, and events with a cursor',
            async run() {
                const machineId = await newMachine();
                const metrics = await fleet.getMetrics(machineId);
                strict_1.default.equal(metrics.cpuBudgetSeconds, fleet_1.MACHINE_LIMITS.dailyCpuSeconds);
                strict_1.default.equal(metrics.throttled, metrics.cpuSecondsUsed >= fleet_1.MACHINE_LIMITS.dailyCpuSeconds);
                const readAll = async () => {
                    const events = [];
                    let cursor = null;
                    for (;;) {
                        const page = await fleet.listEvents(cursor ?? undefined, 500);
                        if (page.events.length === 0)
                            return { events, cursor: page.nextCursor ?? cursor };
                        events.push(...page.events);
                        cursor = page.nextCursor;
                    }
                };
                const seen = await (0, cases_1.waitFor)(readAll, (p) => p.events.some((e) => e.machineId === machineId), `an event for ${machineId}`, timeoutMs);
                strict_1.default.ok(seen.cursor, 'a feed with events has a cursor');
                strict_1.default.equal(new Set(seen.events.map((e) => e.id)).size, seen.events.length, 'paging never repeats an event');
                const after = await fleet.listEvents(seen.cursor ?? undefined);
                strict_1.default.ok(after.events.every((e) => !seen.events.some((old) => old.id === e.id)), 'events after the cursor are new');
                await run(machineId, 'delete');
            },
        },
    ];
}
