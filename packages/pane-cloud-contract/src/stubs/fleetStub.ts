import { CloudApiError } from '../errors';
import {
  canonicalJson,
  type FleetEvent,
  fleetRoutes,
  type FleetVm,
  type OperationEnvelope,
  type OperationStatus,
  type PaneRelease,
  requireSealedSecrets,
  type SealedSecrets,
  verifyOperation,
} from '../fleet';
import type { GitHubTokenRecord } from '../sealing';
import { StubClone, StubSealingKeys } from './clone';
import type { RelayIdentity } from '../fleet';
import { newRelayIdentity, pairingLinkFor } from './relayKey';
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
  /** The VM's clone failing now with git's message, as a sign-in or network error does. */
  failClone(vmId: string, message: string): void;
  /** The GitHub token the stub host opened onto the VM's secrets volume, from its create or latest retry_clone. */
  secretsVolumeToken(vmId: string): GitHubTokenRecord | null;
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
  const relayKeys = new Map<string, RelayIdentity>();
  const operations = new Map<string, { status: OperationStatus; payloadJson: string; refusal: CloudApiError | null }>();
  const events: FleetEvent[] = [];
  const sealingKeys = new StubSealingKeys(hostId, now);
  const clones = new Map<string, StubClone>();
  const volumeTokens = new Map<string, GitHubTokenRecord | null>();
  let panes = 0;
  /** The VM as a read sees it: each read moves its clone one step. */
  const view = (vm: FleetVm): FleetVm => {
    const clone = clones.get(vm.vmId);
    if (clone) vm.clone = clone.read();
    return vm;
  };

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
  const runOperation = async (payload: OperationEnvelope['payload'], sealed: SealedSecrets | null): Promise<OperationStatus['result']> => {
    let result: OperationStatus['result'] = null;
    if (payload.operation === 'create') {
      const existing = vms.get(payload.vmId);
      if (existing && existing.state !== 'deleted') throw new CloudApiError('vm_exists', `VM ${payload.vmId} already exists.`, 'Use a new VM id, or start the existing VM.');
      const { sealingKeyId, repo } = payload.parameters;
      const opened = sealingKeyId ? await sealingKeys.use(sealingKeyId, 'slot', sealed?.githubToken) : null;
      const vm: FleetVm = { vmId: payload.vmId, state: 'running', stateReason: null, hostId, memoryGiB: 8, paneVersion: null, clone: null, updatedAt: iso() };
      if (repo) {
        panes += 1;
        const clone = new StubClone(repo, iso, `pane_${panes}`);
        clones.set(vm.vmId, clone);
        vm.clone = clone.status;
      }
      volumeTokens.set(vm.vmId, opened);
      vms.set(vm.vmId, vm);
      relayKeys.set(vm.vmId, newRelayIdentity('runpane.net'));
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
        case 'create_pairing_link': {
          requireState(vm, 'running', 'create_pairing_link');
          const relay = relayKeys.get(vm.vmId);
          if (!relay) throw notFound(vm.vmId);
          result = pairingLinkFor(relay, vm.vmId, now());
          break;
        }
        case 'retry_clone': {
          requireState(vm, 'running', 'retry_clone');
          const clone = clones.get(vm.vmId);
          if (!clone || clone.status.state !== 'failed') throw new CloudApiError('invalid_state', `retry_clone needs a failed clone; ${vm.vmId}'s is ${clone?.status.state ?? 'absent'}.`, 'Read the VM and retry only a failed clone.');
          const { sealingKeyId } = payload.parameters;
          if (sealingKeyId) volumeTokens.set(vm.vmId, await sealingKeys.use(sealingKeyId, `vm:${vm.vmId}`, sealed?.githubToken));
          vm.clone = clone.restart();
          break;
        }
      }
    }
    return result;
  };

  const server = createRouteServer([
    bind(fleetRoutes.reserveSealingKey, () => sealingKeys.make('slot')),
    bind(fleetRoutes.createVmSealingKey, ({ params }) => {
      const vm = requireVm(params.vmId ?? '');
      requireState(vm, 'running', 'A sealing key');
      return sealingKeys.make(`vm:${vm.vmId}`);
    }),
    bind(fleetRoutes.submitOperation, async ({ body }) => {
      const envelope = verifyOperation(body, options.trustedKeys, hostId, now());
      const { payload } = envelope;
      const payloadJson = canonicalJson(payload);
      const seen = operations.get(payload.requestId);
      if (seen) {
        if (seen.payloadJson !== payloadJson) throw new CloudApiError('invalid_request', `requestId ${payload.requestId} was already used for a different operation.`, 'Use a new requestId for each operation.');
        if (seen.refusal) throw seen.refusal;
        return seen.status;
      }
      const status: OperationStatus = { requestId: payload.requestId, vmId: payload.vmId, operation: payload.operation, status: 'succeeded', error: null, result: null, acceptedAt: iso(), finishedAt: null };
      try {
        status.result = await runOperation(payload, requireSealedSecrets(envelope));
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
      return view(vm);
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
    failClone(vmId, message) {
      const clone = clones.get(vmId);
      const vm = requireVm(vmId);
      if (!clone) throw new Error(`stub: VM ${vmId} has no clone`);
      vm.clone = clone.fail(message);
    },
    secretsVolumeToken(vmId) {
      return volumeTokens.get(vmId) ?? null;
    },
    setCpuSecondsUsed(vmId, seconds) {
      requireVm(vmId);
      cpu.set(vmId, seconds);
    },
  };
}
