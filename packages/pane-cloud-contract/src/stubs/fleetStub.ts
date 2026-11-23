import { CloudApiError } from '../errors';
import {
  canonicalJson,
  type FleetEvent,
  fleetRoutes,
  type FleetVm,
  type OperationEnvelope,
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
  /** This host's id; operations signed for another host are refused with wrong_host. Default `stub-host-1`. */
  hostId?: string;
  now?: () => Date;
}

export interface FleetStub extends RunningStub {
  /** The fleet stopping a VM on its own (host maintenance or host loss). */
  hostStop(vmId: string, reason: 'host_maintenance' | 'host_lost'): void;
  setCpuSecondsUsed(vmId: string, seconds: number): void;
}

const notFound = (vmId: string) => new CloudApiError('vm_not_found', `The fleet has no VM ${vmId}.`, 'Create the VM first, or check its id.');

/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
export async function startFleetStub(options: FleetStubOptions): Promise<FleetStub> {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const vms = new Map<string, FleetVm>();
  const cpu = new Map<string, number>();
  const hostId = options.hostId ?? 'stub-host-1';
  const operations = new Map<string, { status: OperationStatus; payloadJson: string; refusal: CloudApiError | null }>();
  const events: FleetEvent[] = [];

  const record = (event: Omit<FleetEvent, 'id' | 'at'>) => events.push({ ...event, id: String(events.length + 1), at: iso() });
  const setState = (vm: FleetVm, state: FleetVm['state'], reason: FleetVm['stateReason'], requestId: string | null = null) => {
    vm.state = state;
    vm.stateReason = reason;
    vm.updatedAt = iso();
    record({ vmId: vm.vmId, kind: 'state_changed', state, reason, requestId });
  };
  const requireVm = (vmId: string) => {
    const vm = vms.get(vmId);
    if (!vm || vm.state === 'deleted') throw notFound(vmId);
    return vm;
  };
  const requireState = (vm: FleetVm, state: FleetVm['state'], operation: string) => {
    if (vm.state !== state) {
      throw new CloudApiError('invalid_state', `${operation} needs a ${state} VM; ${vm.vmId} is ${vm.state}.`, 'Read the VM state and send the operation that fits it.');
    }
  };
  const requireRelease = (release: PaneRelease) => {
    const published = options.publishedReleases.some((r) => canonicalJson(r) === canonicalJson(release));
    if (!published) throw new CloudApiError('release_not_published', `Pane ${release.version} with that checksum is not a published release.`, 'Name a published release and its exact .deb checksum.');
  };

  /** Runs a checked operation; throws CloudApiError when the VM's state or the release refuses it. */
  const runOperation = (payload: OperationEnvelope['payload']): OperationStatus['result'] => {
    let result: OperationStatus['result'] = null;
    if (payload.operation === 'create') {
      const existing = vms.get(payload.vmId);
      if (existing && existing.state !== 'deleted') throw new CloudApiError('vm_exists', `VM ${payload.vmId} already exists.`, 'Use a new VM id, or start the existing VM.');
      const vm: FleetVm = { vmId: payload.vmId, state: 'running', stateReason: null, hostId, memoryGiB: 8, paneVersion: null, updatedAt: iso() };
      vms.set(vm.vmId, vm);
      record({ vmId: vm.vmId, kind: 'state_changed', state: 'running', reason: null, requestId: payload.requestId });
    } else {
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
      }
    }
    return result;
  };

  const server = createRouteServer([
    bind(fleetRoutes.submitOperation, ({ body }) => {
      const { payload } = verifyOperation(body, options.trustedKeys, hostId, now());
      const payloadJson = canonicalJson(payload);
      const seen = operations.get(payload.requestId);
      if (seen) {
        if (seen.payloadJson !== payloadJson) throw new CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
        if (seen.refusal) throw seen.refusal;
        return seen.status;
      }
      const status: OperationStatus = { requestId: payload.requestId, vmId: payload.vmId, operation: payload.operation, status: 'succeeded', error: null, result: null, acceptedAt: iso(), finishedAt: null };
      try {
        status.result = runOperation(payload);
      } catch (error) {
        if (!(error instanceof CloudApiError)) throw error;
        operations.set(payload.requestId, { status: { ...status, status: 'failed', error: { code: error.code, message: error.message, next: error.next }, finishedAt: iso() }, payloadJson, refusal: error });
        throw error;
      }
      status.finishedAt = iso();
      operations.set(payload.requestId, { status, payloadJson, refusal: null });
      record({ vmId: payload.vmId, kind: 'operation_finished', state: null, reason: null, requestId: payload.requestId });
      return status;
    }),
    bind(fleetRoutes.getOperation, ({ params }) => {
      const found = operations.get(params.requestId ?? '');
      if (!found) throw new CloudApiError('operation_not_found', `No operation ${params.requestId}.`, 'Check the requestId the operation was sent with.');
      return found.status;
    }),
    bind(fleetRoutes.getVm, ({ params }) => {
      const vm = vms.get(params.vmId ?? '');
      if (!vm) throw notFound(params.vmId ?? '');
      return vm;
    }),
    bind(fleetRoutes.getMetrics, ({ params, query }) => {
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
    bind(fleetRoutes.listEvents, ({ query }) => {
      const start = query.after ? Number(query.after) : 0;
      if (!Number.isInteger(start) || start < 0 || start > events.length) throw new CloudApiError('invalid_request', `Unknown cursor ${query.after}.`, 'Pass a nextCursor from an earlier page, or no cursor to start from the beginning.');
      const page = events.slice(start, start + (query.limit ?? 100));
      const last = page.at(-1);
      return { events: page, nextCursor: last ? last.id : (query.after ?? null) };
    }),
  ]);
  const running = await listen(server);
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
