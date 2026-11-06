import { CloudApiError } from '../errors';
import {
  canonicalJson,
  type FleetEvent,
  type FleetMachine,
  fleetRoutes,
  MACHINE_LIMITS,
  type MachineMetrics,
  type OperationStatus,
  type PaneRelease,
  verifyOperation,
} from '../fleet';
import { bind, createRouteServer, listen, type RunningStub } from './server';

export interface FleetStubOptions {
  /** Service signing keys the stub trusts, by key id (PEM public keys). */
  trustedKeys: Record<string, string>;
  /** Releases update_pane and bootstrap may install. */
  publishedReleases: PaneRelease[];
  now?: () => Date;
}

export interface FleetStub extends RunningStub {
  /** The fleet stopping a machine on its own (idle, memory pressure, host maintenance). */
  hostStop(machineId: string, reason: 'idle' | 'memory_pressure' | 'host_maintenance' | 'abuse'): void;
  /** The machine's user opening its Tailscale login link. */
  joinTailnet(machineId: string): void;
  setCpuSecondsUsed(machineId: string, seconds: number): void;
}

const notFound = (machineId: string) =>
  new CloudApiError('machine_not_found', `The fleet has no machine ${machineId}.`, 'Create the machine first, or check its id.');

/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
export async function startFleetStub(options: FleetStubOptions): Promise<FleetStub> {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const machines = new Map<string, FleetMachine>();
  const cpu = new Map<string, number>();
  const operations = new Map<string, { status: OperationStatus; payloadJson: string }>();
  const events: FleetEvent[] = [];

  const record = (event: Omit<FleetEvent, 'id' | 'at'>) => events.push({ ...event, id: String(events.length + 1), at: iso() });
  const setState = (machine: FleetMachine, state: FleetMachine['state'], reason: FleetMachine['stateReason']) => {
    machine.state = state;
    machine.stateReason = reason;
    machine.updatedAt = iso();
    record({ machineId: machine.machineId, kind: 'state_changed', state, reason, requestId: null });
  };
  const requireMachine = (machineId: string) => {
    const machine = machines.get(machineId);
    if (!machine || machine.state === 'deleted') throw notFound(machineId);
    return machine;
  };
  const requireState = (machine: FleetMachine, state: FleetMachine['state'], operation: string) => {
    if (machine.state !== state) {
      throw new CloudApiError('invalid_state', `${operation} needs a ${state} machine; ${machine.machineId} is ${machine.state}.`, 'Read the machine state and send the operation that fits it.');
    }
  };
  const requireRelease = (release: PaneRelease) => {
    const published = options.publishedReleases.some((r) => canonicalJson(r) === canonicalJson(release));
    if (!published) throw new CloudApiError('release_not_published', `Pane ${release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
  };

  const server = createRouteServer([
    bind(fleetRoutes.submitOperation, ({ body }) => {
      const { payload } = verifyOperation(body, options.trustedKeys, now());
      const payloadJson = canonicalJson(payload);
      const seen = operations.get(payload.requestId);
      if (seen) {
        if (seen.payloadJson !== payloadJson) throw new CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
        return seen.status;
      }
      let result: OperationStatus['result'] = null;
      if (payload.operation === 'create') {
        const existing = machines.get(payload.machineId);
        if (existing && existing.state !== 'deleted') throw new CloudApiError('machine_exists', `Machine ${payload.machineId} already exists.`, 'Use a new machine id, or resume the existing machine.');
        const machine: FleetMachine = {
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
      } else {
        const machine = requireMachine(payload.machineId);
        switch (payload.operation) {
          case 'stop':
            requireState(machine, 'running', 'stop');
            setState(machine, 'stopped', 'user');
            break;
          case 'resume':
            requireState(machine, 'stopped', 'resume');
            setState(machine, 'running', null);
            break;
          case 'delete':
            setState(machine, 'deleted', 'user');
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
      const status: OperationStatus = {
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
    bind(fleetRoutes.getOperation, ({ params }) => {
      const found = operations.get(params.requestId ?? '');
      if (!found) throw new CloudApiError('operation_not_found', `No operation ${params.requestId}.`, 'Check the requestId the operation was sent with.');
      return found.status;
    }),
    bind(fleetRoutes.getMachine, ({ params }) => {
      const machine = machines.get(params.machineId ?? '');
      if (!machine) throw notFound(params.machineId ?? '');
      return machine;
    }),
    bind(fleetRoutes.getMetrics, ({ params, query }) => {
      const machine = requireMachine(params.machineId ?? '');
      const used = cpu.get(machine.machineId) ?? 0;
      const metrics: MachineMetrics = {
        machineId: machine.machineId,
        day: query.day ?? iso().slice(0, 10),
        cpuSecondsUsed: used,
        cpuBudgetSeconds: MACHINE_LIMITS.dailyCpuSeconds,
        throttled: used >= MACHINE_LIMITS.dailyCpuSeconds,
        memoryResidentMiB: machine.state === 'running' ? 3072 : 0,
        diskUsedBytes: 4 * 1024 ** 3,
        egressBytesThisMonth: 0,
        sampledAt: iso(),
      };
      return metrics;
    }),
    bind(fleetRoutes.listEvents, ({ query }) => {
      const start = query.after ? Number(query.after) : 0;
      const page = events.slice(start, start + (query.limit ?? 100));
      const last = page.at(-1);
      return { events: page, nextCursor: last ? last.id : (query.after ?? null) };
    }),
  ]);
  const running = await listen(server);
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
      if (before < MACHINE_LIMITS.dailyCpuSeconds && seconds >= MACHINE_LIMITS.dailyCpuSeconds) {
        record({ machineId, kind: 'budget_exhausted', state: null, reason: null, requestId: null });
      }
    },
  };
}
