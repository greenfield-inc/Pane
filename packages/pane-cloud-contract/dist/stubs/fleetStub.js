"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startFleetStub = startFleetStub;
const errors_1 = require("../errors");
const fleet_1 = require("../fleet");
const relayKey_1 = require("./relayKey");
const server_1 = require("./server");
const notFound = (vmId) => new errors_1.CloudApiError('vm_not_found', `The fleet has no VM ${vmId}.`, 'Create the VM first, or check its id.');
/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
async function startFleetStub(options) {
    const now = options.now ?? (() => new Date());
    const iso = () => now().toISOString();
    const vms = new Map();
    const cpu = new Map();
    const hostId = options.hostId ?? 'stub-host-1';
    const relayKeys = new Map();
    const operations = new Map();
    const events = [];
    const record = (event) => events.push({ ...event, id: String(events.length + 1), at: iso() });
    const setState = (vm, state, reason, requestId = null) => {
        vm.state = state;
        vm.stateReason = reason;
        vm.updatedAt = iso();
        record({ vmId: vm.vmId, kind: 'state_changed', state, reason, requestId });
    };
    const requireVm = (vmId) => {
        const vm = vms.get(vmId);
        if (!vm || vm.state === 'deleted')
            throw notFound(vmId);
        return vm;
    };
    const requireState = (vm, state, operation) => {
        if (vm.state !== state) {
            throw new errors_1.CloudApiError('invalid_state', `${operation} needs a ${state} VM; ${vm.vmId} is ${vm.state}.`, 'Read the VM state and send the operation that fits it.');
        }
    };
    const requireRelease = (release) => {
        const published = options.publishedReleases.some((r) => (0, fleet_1.canonicalJson)(r) === (0, fleet_1.canonicalJson)(release));
        if (!published)
            throw new errors_1.CloudApiError('release_not_published', `Pane ${release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
    };
    /** Runs a checked operation; throws CloudApiError when the VM's state or the release refuses it. */
    const runOperation = (payload) => {
        let result = null;
        if (payload.operation === 'create') {
            const existing = vms.get(payload.vmId);
            if (existing && existing.state !== 'deleted')
                throw new errors_1.CloudApiError('vm_exists', `VM ${payload.vmId} already exists.`, 'Use a new VM id, or start the existing VM.');
            const vm = { vmId: payload.vmId, state: 'running', stateReason: null, hostId, memoryGiB: 8, paneVersion: null, updatedAt: iso() };
            vms.set(vm.vmId, vm);
            // Made before boot and written onto the secrets volume (PREBOOT_RELAY_FILES); returned for the service to vouch for.
            const relay = (0, relayKey_1.newRelayIdentity)('runpane.net');
            relayKeys.set(vm.vmId, relay);
            result = (0, relayKey_1.pairingLinkFor)(relay, vm.vmId, now());
            record({ vmId: vm.vmId, kind: 'state_changed', state: 'running', reason: null, requestId: payload.requestId });
        }
        else {
            const vm = requireVm(payload.vmId);
            switch (payload.operation) {
                case 'stop':
                    requireState(vm, 'running', 'stop');
                    setState(vm, 'stopped', payload.parameters.cause, payload.requestId);
                    break;
                case 'start':
                    requireState(vm, 'stopped', 'start');
                    setState(vm, 'running', null, payload.requestId);
                    break;
                case 'delete':
                    setState(vm, 'deleted', 'user', payload.requestId);
                    break;
                case 'bootstrap':
                case 'update_pane':
                    requireState(vm, 'running', payload.operation);
                    requireRelease(payload.parameters.release);
                    vm.paneVersion = payload.parameters.release.version;
                    vm.updatedAt = iso();
                    break;
                case 'prepare_to_stop':
                    requireState(vm, 'running', 'prepare_to_stop');
                    break;
                case 'collect_diagnostics':
                    requireState(vm, 'running', 'collect_diagnostics');
                    result = { files: [{ path: '/var/log/pane-cloud/guest-agent.log', bytes: 0 }], archiveKey: `diagnostics/${vm.vmId}/${payload.requestId}.tar.gz` };
                    break;
                case 'create_pairing_link': {
                    requireState(vm, 'running', 'create_pairing_link');
                    const relay = relayKeys.get(vm.vmId);
                    if (!relay)
                        throw notFound(vm.vmId);
                    result = (0, relayKey_1.pairingLinkFor)(relay, vm.vmId, now());
                    break;
                }
            }
        }
        return result;
    };
    const server = (0, server_1.createRouteServer)([
        (0, server_1.bind)(fleet_1.fleetRoutes.submitOperation, ({ body }) => {
            const { payload } = (0, fleet_1.verifyOperation)(body, options.trustedKeys, hostId, now());
            const payloadJson = (0, fleet_1.canonicalJson)(payload);
            const seen = operations.get(payload.requestId);
            if (seen) {
                if (seen.payloadJson !== payloadJson)
                    throw new errors_1.CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
                if (seen.refusal)
                    throw seen.refusal;
                return seen.status;
            }
            const status = { requestId: payload.requestId, vmId: payload.vmId, operation: payload.operation, status: 'succeeded', error: null, result: null, acceptedAt: iso(), finishedAt: null };
            try {
                status.result = runOperation(payload);
            }
            catch (error) {
                if (!(error instanceof errors_1.CloudApiError))
                    throw error;
                operations.set(payload.requestId, { status: { ...status, status: 'failed', error: { code: error.code, message: error.message, next: error.next }, finishedAt: iso() }, payloadJson, refusal: error });
                throw error;
            }
            status.finishedAt = iso();
            operations.set(payload.requestId, { status, payloadJson, refusal: null });
            record({ vmId: payload.vmId, kind: 'operation_finished', state: null, reason: null, requestId: payload.requestId });
            return status;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getOperation, ({ params }) => {
            const found = operations.get(params.requestId ?? '');
            if (!found)
                throw new errors_1.CloudApiError('operation_not_found', `No operation ${params.requestId}.`, 'Check the requestId the operation was sent with.');
            return found.status;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getVm, ({ params }) => {
            const vm = vms.get(params.vmId ?? '');
            if (!vm)
                throw notFound(params.vmId ?? '');
            return vm;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getMetrics, ({ params, query }) => {
            const vm = requireVm(params.vmId ?? '');
            const used = cpu.get(vm.vmId) ?? 0;
            return {
                vmId: vm.vmId,
                day: query.day ?? iso().slice(0, 10),
                cpuSecondsUsed: used,
                memoryResidentMiB: vm.state === 'running' ? 3072 : 0,
                diskUsedBytes: 4 * 1024 ** 3,
                egressBytes: 0,
                sampledAt: iso(),
            };
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.listEvents, ({ query }) => {
            const start = query.after ? Number(query.after) : 0;
            if (!Number.isInteger(start) || start < 0 || start > events.length)
                throw new errors_1.CloudApiError('invalid_request', `Unknown cursor ${query.after}.`, 'Pass a nextCursor from an earlier page, or no cursor to start from the beginning.');
            const page = events.slice(start, start + (query.limit ?? 100));
            const last = page.at(-1);
            return { events: page, nextCursor: last ? last.id : (query.after ?? null) };
        }),
    ]);
    const running = await (0, server_1.listen)(server);
    return {
        ...running,
        hostStop(vmId, reason) {
            const vm = requireVm(vmId);
            setState(vm, 'stopped', reason);
        },
        setCpuSecondsUsed(vmId, seconds) {
            requireVm(vmId);
            cpu.set(vmId, seconds);
        },
    };
}
