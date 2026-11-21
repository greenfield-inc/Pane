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
/** The fleet API contract: what the host agent must do for the service. */
function fleetContractCases(target) {
    // Read baseUrl at call time, so a target can name a server that starts after the cases are built.
    const fleet = (0, fleet_1.createFleetClient)({ get baseUrl() { return target.baseUrl; }, token: target.token });
    const timeoutMs = target.timeoutMs ?? 120_000;
    const payload = (vmId, operation, extra = {}) => {
        const issuedAt = new Date();
        const parameters = operation === 'bootstrap' || operation === 'update_pane' ? { release: target.release } : operation === 'stop' ? { cause: 'user' } : {};
        // SAFETY: parameters match `operation` (a release for bootstrap and update_pane, a cause for stop, none otherwise); signOperation parses it again.
        return {
            requestId: (0, node_crypto_1.randomUUID)(),
            vmId,
            reason: `contract test: ${operation}`,
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
            operation,
            parameters,
            ...extra,
        };
    };
    const run = async (vmId, operation) => {
        const accepted = await fleet.submitOperation(await (0, fleet_1.signOperation)(payload(vmId, operation), target.signer));
        strict_1.default.equal(accepted.vmId, vmId);
        strict_1.default.equal(accepted.operation, operation);
        const finished = await (0, cases_1.waitFor)(() => fleet.getOperation(accepted.requestId), (s) => s.status === 'succeeded' || s.status === 'failed', `${operation} to finish`, timeoutMs);
        strict_1.default.equal(finished.status, 'succeeded', `${operation} failed: ${finished.error?.message ?? ''}`);
        return finished;
    };
    const vmIn = (vmId, state) => (0, cases_1.waitFor)(() => fleet.getVm(vmId), (m) => m.state === state, `VM ${vmId} to be ${state}`, timeoutMs);
    /** Signs raw bytes, skipping signOperation's own check, to send what a compromised caller might. */
    const signRaw = async (body) => {
        const signature = await target.signer.sign((0, fleet_1.operationSigningBytes)(body));
        // SAFETY: deliberately outside the contract; the case checks the fleet refuses it.
        return { payload: body, signature: { keyId: target.signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } };
    };
    const newVm = async () => {
        const vmId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
        await run(vmId, 'create');
        await vmIn(vmId, 'running');
        return vmId;
    };
    return [
        {
            name: 'fleet: create, bootstrap, stop, start and delete a VM, each as one signed operation, and a stop records its cause',
            async run() {
                const vmId = await newVm();
                await run(vmId, 'bootstrap');
                const booted = await fleet.getVm(vmId);
                strict_1.default.equal(booted.paneVersion, target.release.version);
                await run(vmId, 'prepare_to_stop');
                await run(vmId, 'stop');
                strict_1.default.equal((await vmIn(vmId, 'stopped')).stateReason, 'user');
                await run(vmId, 'start');
                const started = await vmIn(vmId, 'running');
                strict_1.default.equal(started.memoryGiB, 8);
                const reviewStop = await fleet.submitOperation(await (0, fleet_1.signOperation)({ ...payload(vmId, 'stop'), operation: 'stop', parameters: { cause: 'review' } }, target.signer));
                await (0, cases_1.waitFor)(() => fleet.getOperation(reviewStop.requestId), (s) => s.status === 'succeeded', 'the review stop', timeoutMs);
                strict_1.default.equal((await vmIn(vmId, 'stopped')).stateReason, 'review', 'a service stop records its cause');
                await run(vmId, 'delete');
                await vmIn(vmId, 'deleted');
            },
        },
        {
            name: 'fleet: sending the same signed operation twice runs it once',
            async run() {
                const vmId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                const envelope = await (0, fleet_1.signOperation)(payload(vmId, 'create'), target.signer);
                const first = await fleet.submitOperation(envelope);
                const second = await fleet.submitOperation(envelope);
                strict_1.default.equal(second.requestId, first.requestId);
                await vmIn(vmId, 'running');
                await run(vmId, 'delete');
            },
        },
        {
            name: 'fleet: refuses an operation signed by an untrusted key, or changed after signing',
            async run() {
                const vmId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                await (0, cases_1.expectError)('signature_invalid', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(payload(vmId, 'create'), target.untrustedSigner)));
                const envelope = await (0, fleet_1.signOperation)(payload(vmId, 'create'), target.signer);
                await (0, cases_1.expectError)('signature_invalid', () => fleet.submitOperation({ ...envelope, payload: { ...envelope.payload, reason: 'changed after signing' } }));
                await (0, cases_1.expectError)('vm_not_found', () => fleet.getVm(vmId));
            },
        },
        {
            name: 'fleet: refuses an operation outside its time window: expired, too long-lived, or issued in the future',
            async run() {
                const vmId = `contract-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
                const past = Date.now() - 600_000;
                const stale = payload(vmId, 'create', { issuedAt: new Date(past).toISOString(), expiresAt: new Date(past + 120_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(stale, target.signer)));
                const nowMs = Date.now();
                const tooLong = payload(vmId, 'create', { issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 600_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(tooLong, target.signer)));
                const future = payload(vmId, 'create', { issuedAt: new Date(nowMs + 120_000).toISOString(), expiresAt: new Date(nowMs + 240_000).toISOString() });
                await (0, cases_1.expectError)('operation_expired', async () => fleet.submitOperation(await (0, fleet_1.signOperation)(future, target.signer)));
                await (0, cases_1.expectError)('vm_not_found', () => fleet.getVm(vmId));
            },
        },
        {
            name: 'fleet: runs nothing outside the allow-list or its fixed parameters',
            async run() {
                const vmId = await newVm();
                const base = payload(vmId, 'collect_diagnostics');
                await (0, cases_1.expectError)('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'run_script', parameters: { script: 'id' } })));
                await (0, cases_1.expectError)('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'write_file', parameters: { path: '/etc/passwd', content: '' } })));
                await (0, cases_1.expectError)('invalid_request', async () => fleet.submitOperation(await signRaw({ ...base, parameters: { files: ['/home/pane/.ssh/id_ed25519'] } })));
                const otherChecksum = { ...target.release, debSha256: target.release.debSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
                await (0, cases_1.expectError)('release_not_published', async () => fleet.submitOperation(await (0, fleet_1.signOperation)({ ...payload(vmId, 'update_pane'), operation: 'update_pane', parameters: { release: otherChecksum } }, target.signer)));
                const diagnostics = await run(vmId, 'collect_diagnostics');
                strict_1.default.ok(diagnostics.result, 'collect_diagnostics returns what it collected');
                await run(vmId, 'delete');
            },
        },
        {
            name: "fleet: reports a VM's daily metrics, and every state change as an event with a cursor",
            async run() {
                const vmId = await newVm();
                const day = new Date().toISOString().slice(0, 10);
                strict_1.default.equal((await fleet.getMetrics(vmId, day)).day, day);
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
                const seen = await (0, cases_1.waitFor)(readAll, (p) => p.events.some((e) => e.vmId === vmId && e.kind === 'state_changed' && e.state === 'running'), `a running event for ${vmId}`, timeoutMs);
                strict_1.default.ok(seen.cursor, 'a feed with events has a cursor');
                strict_1.default.equal(new Set(seen.events.map((e) => e.id)).size, seen.events.length, 'paging never repeats an event');
                const after = await fleet.listEvents(seen.cursor ?? undefined);
                strict_1.default.ok(after.events.every((e) => !seen.events.some((old) => old.id === e.id)), 'events after the cursor are new');
                await run(vmId, 'delete');
            },
        },
    ];
}
