"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startFleetStub = startFleetStub;
const errors_1 = require("../errors");
const fleet_1 = require("../fleet");
const server_1 = require("./server");
const notFound = (machineId) => new errors_1.CloudApiError('machine_not_found', `The fleet has no machine ${machineId}.`, 'Create the machine first, or check its id.');
/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
async function startFleetStub(options) {
    const now = options.now ?? (() => new Date());
    const iso = () => now().toISOString();
    const machines = new Map();
    const cpu = new Map();
    const operations = new Map();
    const events = [];
    const record = (event) => events.push({ ...event, id: String(events.length + 1), at: iso() });
    const setState = (machine, state, reason, requestId = null) => {
        machine.state = state;
        machine.stateReason = reason;
        machine.updatedAt = iso();
        record({ machineId: machine.machineId, kind: 'state_changed', state, reason, requestId });
    };
    const requireMachine = (machineId) => {
        const machine = machines.get(machineId);
        if (!machine || machine.state === 'deleted')
            throw notFound(machineId);
        return machine;
    };
    const requireState = (machine, state, operation) => {
        if (machine.state !== state) {
            throw new errors_1.CloudApiError('invalid_state', `${operation} needs a ${state} machine; ${machine.machineId} is ${machine.state}.`, 'Read the machine state and send the operation that fits it.');
        }
    };
    const requireRelease = (release) => {
        const published = options.publishedReleases.some((r) => (0, fleet_1.canonicalJson)(r) === (0, fleet_1.canonicalJson)(release));
        if (!published)
            throw new errors_1.CloudApiError('release_not_published', `Pane ${release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
    };
    const server = (0, server_1.createRouteServer)([
        (0, server_1.bind)(fleet_1.fleetRoutes.submitOperation, ({ body }) => {
            const { payload } = (0, fleet_1.verifyOperation)(body, options.trustedKeys, now());
            const payloadJson = (0, fleet_1.canonicalJson)(payload);
            const seen = operations.get(payload.requestId);
            if (seen) {
                if (seen.payloadJson !== payloadJson)
                    throw new errors_1.CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
                return seen.status;
            }
            let result = null;
            if (payload.operation === 'create') {
                const existing = machines.get(payload.machineId);
                if (existing && existing.state !== 'deleted')
                    throw new errors_1.CloudApiError('machine_exists', `Machine ${payload.machineId} already exists.`, 'Use a new machine id, or resume the existing machine.');
                const machine = {
                    machineId: payload.machineId,
                    state: 'running',
                    stateReason: null,
                    hostId: 'stub-host-1',
                    paneVersion: null,
                    tailnet: { status: 'awaiting_login', loginUrl: null, hostname: null },
                    updatedAt: iso(),
                };
                machines.set(machine.machineId, machine);
                record({ machineId: machine.machineId, kind: 'state_changed', state: 'running', reason: null, requestId: payload.requestId });
            }
            else {
                const machine = requireMachine(payload.machineId);
                switch (payload.operation) {
                    case 'stop':
                        requireState(machine, 'running', 'stop');
                        setState(machine, 'stopped', payload.parameters.cause, payload.requestId);
                        break;
                    case 'resume':
                        requireState(machine, 'stopped', 'resume');
                        setState(machine, 'running', null, payload.requestId);
                        break;
                    case 'delete':
                        setState(machine, 'deleted', 'user', payload.requestId);
                        break;
                    case 'bootstrap':
                    case 'update_pane':
                        requireState(machine, 'running', payload.operation);
                        requireRelease(payload.parameters.release);
                        machine.paneVersion = payload.parameters.release.version;
                        if (payload.operation === 'bootstrap' && machine.tailnet.status === 'awaiting_login') {
                            machine.tailnet.loginUrl = `https://login.tailscale.com/a/stub-${machine.machineId}`;
                        }
                        machine.updatedAt = iso();
                        break;
                    case 'prepare_to_stop':
                        requireState(machine, 'running', 'prepare_to_stop');
                        break;
                    case 'collect_diagnostics':
                        requireState(machine, 'running', 'collect_diagnostics');
                        result = { files: [{ path: '/var/log/pane-cloud/guest-agent.log', bytes: 0 }], archiveKey: `diagnostics/${machine.machineId}/${payload.requestId}.tar.gz` };
                        break;
                }
            }
            const status = {
                requestId: payload.requestId,
                machineId: payload.machineId,
                operation: payload.operation,
                status: 'succeeded',
                error: null,
                result,
                acceptedAt: iso(),
                finishedAt: iso(),
            };
            operations.set(payload.requestId, { status, payloadJson });
            record({ machineId: payload.machineId, kind: 'operation_finished', state: null, reason: null, requestId: payload.requestId });
            return status;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getOperation, ({ params }) => {
            const found = operations.get(params.requestId ?? '');
            if (!found)
                throw new errors_1.CloudApiError('operation_not_found', `No operation ${params.requestId}.`, 'Check the requestId the operation was sent with.');
            return found.status;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getMachine, ({ params }) => {
            const machine = machines.get(params.machineId ?? '');
            if (!machine)
                throw notFound(params.machineId ?? '');
            return machine;
        }),
        (0, server_1.bind)(fleet_1.fleetRoutes.getMetrics, ({ params, query }) => {
            const machine = requireMachine(params.machineId ?? '');
            const used = cpu.get(machine.machineId) ?? 0;
            const metrics = {
                machineId: machine.machineId,
                day: query.day ?? iso().slice(0, 10),
                cpuSecondsUsed: used,
                cpuBudgetSeconds: fleet_1.MACHINE_LIMITS.dailyCpuSeconds,
                throttled: used >= fleet_1.MACHINE_LIMITS.dailyCpuSeconds,
                memoryResidentMiB: machine.state === 'running' ? 3072 : 0,
                diskUsedBytes: 4 * 1024 ** 3,
                egressBytesThisMonth: 0,
                sampledAt: iso(),
            };
            return metrics;
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
        hostStop(machineId, reason) {
            const machine = requireMachine(machineId);
            setState(machine, 'stopped', reason);
        },
        joinTailnet(machineId) {
            const machine = requireMachine(machineId);
            machine.tailnet = { status: 'joined', loginUrl: null, hostname: `pane-${machineId}.tailnet.ts.net` };
            machine.updatedAt = iso();
        },
        setCpuSecondsUsed(machineId, seconds) {
            requireMachine(machineId);
            const before = cpu.get(machineId) ?? 0;
            cpu.set(machineId, seconds);
            if (before < fleet_1.MACHINE_LIMITS.dailyCpuSeconds && seconds >= fleet_1.MACHINE_LIMITS.dailyCpuSeconds) {
                record({ machineId, kind: 'budget_exhausted', state: null, reason: null, requestId: null });
            }
        },
    };
}
