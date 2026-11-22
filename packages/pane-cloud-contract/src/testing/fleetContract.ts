import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  createFleetClient,
  type FleetEvent,
  type FleetVm,
  type OperationEnvelope,
  type OperationPayload,
  type OperationSigner,
  operationSigningBytes,
  type PaneRelease,
  signOperation,
} from '../fleet';
import { type ContractCase, expectError, waitFor } from './cases';

export interface LocalSigner {
  signer: OperationSigner;
  publicKeyPem: string;
}

/** A P-256 signing key held in memory, standing in for the service's KMS key in tests. */
export function createLocalSigner(keyId = 'local-test-key'): LocalSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    signer: { keyId, sign: async (bytes) => sign('sha256', bytes, privateKey) },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export interface FleetContractTarget {
  baseUrl: string;
  /** Credential for the fleet API (the service role's in production). */
  token: string;
  /** A key the fleet trusts. */
  signer: OperationSigner;
  /** A key the fleet does not trust. */
  untrustedSigner: OperationSigner;
  /** A published release the fleet will install. */
  release: PaneRelease;
  /** The id of the host under test; operations are signed for it. */
  hostId: string;
  /** How long to wait for a VM or operation to settle. Default 120 s. */
  timeoutMs?: number;
}

/** The fleet API contract: what the host agent must do for the service. */
export function fleetContractCases(target: FleetContractTarget): ContractCase[] {
  // Read baseUrl at call time, so a target can name a server that starts after the cases are built.
  const fleet = createFleetClient({ get baseUrl() { return target.baseUrl; }, token: target.token });
  const timeoutMs = target.timeoutMs ?? 120_000;

  const payload = (vmId: string, operation: OperationPayload['operation'], extra: Partial<OperationPayload> = {}): OperationPayload => {
    const issuedAt = new Date();
    const parameters = operation === 'bootstrap' || operation === 'update_pane' ? { release: target.release } : operation === 'stop' ? { cause: 'user' } : {};
    // SAFETY: parameters match `operation` (a release for bootstrap and update_pane, a cause for stop, none otherwise); signOperation parses it again.
    return {
      requestId: randomUUID(),
      hostId: target.hostId,
      vmId,
      reason: `contract test: ${operation}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
      operation,
      parameters,
      ...extra,
    } as OperationPayload;
  };
  const run = async (vmId: string, operation: OperationPayload['operation']) => {
    const accepted = await fleet.submitOperation(await signOperation(payload(vmId, operation), target.signer));
    assert.equal(accepted.vmId, vmId);
    assert.equal(accepted.operation, operation);
    const finished = await waitFor(() => fleet.getOperation(accepted.requestId), (s) => s.status === 'succeeded' || s.status === 'failed', `${operation} to finish`, timeoutMs);
    assert.equal(finished.status, 'succeeded', `${operation} failed: ${finished.error?.message ?? ''}`);
    return finished;
  };
  const vmIn = (vmId: string, state: FleetVm['state']) =>
    waitFor(() => fleet.getVm(vmId), (m) => m.state === state, `VM ${vmId} to be ${state}`, timeoutMs);
  /** Signs raw bytes, skipping signOperation's own check, to send what a compromised caller might. */
  const signRaw = async (body: Parameters<typeof operationSigningBytes>[0]): Promise<OperationEnvelope> => {
    const signature = await target.signer.sign(operationSigningBytes(body));
    // SAFETY: deliberately outside the contract; the case checks the fleet refuses it.
    return { payload: body, signature: { keyId: target.signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } } as OperationEnvelope;
  };
  const newVm = async () => {
    const vmId = `contract-${randomUUID().slice(0, 8)}`;
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
        assert.equal(booted.paneVersion, target.release.version);
        await run(vmId, 'prepare_to_stop');
        await run(vmId, 'stop');
        assert.equal((await vmIn(vmId, 'stopped')).stateReason, 'user');
        await run(vmId, 'start');
        const started = await vmIn(vmId, 'running');
        assert.equal(started.memoryGiB, 8);
        const reviewStop = await fleet.submitOperation(await signOperation({ ...payload(vmId, 'stop'), operation: 'stop', parameters: { cause: 'review' } }, target.signer));
        await waitFor(() => fleet.getOperation(reviewStop.requestId), (s) => s.status === 'succeeded', 'the review stop', timeoutMs);
        assert.equal((await vmIn(vmId, 'stopped')).stateReason, 'review', 'a service stop records its cause');
        await run(vmId, 'delete');
        await vmIn(vmId, 'deleted');
      },
    },
    {
      name: 'fleet: sending the same signed operation twice runs it once',
      async run() {
        const vmId = `contract-${randomUUID().slice(0, 8)}`;
        const envelope = await signOperation(payload(vmId, 'create'), target.signer);
        const first = await fleet.submitOperation(envelope);
        const second = await fleet.submitOperation(envelope);
        assert.equal(second.requestId, first.requestId);
        await vmIn(vmId, 'running');
        await run(vmId, 'delete');
      },
    },
    {
      name: 'fleet: refuses an operation signed by an untrusted key, or with any signed field changed after signing',
      async run() {
        const vmId = `contract-${randomUUID().slice(0, 8)}`;
        await expectError('signature_invalid', async () => fleet.submitOperation(await signOperation(payload(vmId, 'create'), target.untrustedSigner)));
        const create = await signOperation(payload(vmId, 'create'), target.signer);
        const tampered = (change: Record<string, unknown>) => ({ ...create, payload: { ...create.payload, ...change } }) as OperationEnvelope;
        const later = new Date(Date.parse(create.payload.expiresAt) + 1000).toISOString();
        for (const change of [{ reason: 'changed after signing' }, { vmId: `${vmId}-other` }, { requestId: randomUUID() }, { expiresAt: later }, { operation: 'delete' }]) {
          await expectError('signature_invalid', () => fleet.submitOperation(tampered(change)));
        }
        const stop = await signOperation(payload(vmId, 'stop'), target.signer);
        await expectError('signature_invalid', () => fleet.submitOperation({ ...stop, payload: { ...stop.payload, operation: 'stop', parameters: { cause: 'review' } } }));
        await expectError('vm_not_found', () => fleet.getVm(vmId));
      },
    },
    {
      name: 'fleet: refuses an operation signed for another host, and runs nothing',
      async run() {
        const vmId = `contract-${randomUUID().slice(0, 8)}`;
        await expectError('wrong_host', async () => fleet.submitOperation(await signOperation(payload(vmId, 'create', { hostId: `${target.hostId}-other` }), target.signer)));
        await expectError('vm_not_found', () => fleet.getVm(vmId));
      },
    },
    {
      name: 'fleet: a resent requestId gets its first outcome, a refusal included, and a new payload under it is refused',
      async run() {
        const vmId = await newVm();
        const start = await signOperation(payload(vmId, 'start'), target.signer);
        await expectError('invalid_state', () => fleet.submitOperation(start));
        assert.equal((await fleet.getOperation(start.payload.requestId)).status, 'failed');
        await run(vmId, 'stop');
        await vmIn(vmId, 'stopped');
        await expectError('invalid_state', () => fleet.submitOperation(start));
        assert.equal((await fleet.getVm(vmId)).state, 'stopped', 'a replayed refusal runs nothing');
        const reused = await signOperation({ ...payload(vmId, 'delete'), requestId: start.payload.requestId }, target.signer);
        await expectError('invalid_request', () => fleet.submitOperation(reused));
        await run(vmId, 'delete');
      },
    },
    {
      name: 'fleet: refuses an operation outside its time window: expired, too long-lived, or issued in the future',
      async run() {
        const vmId = `contract-${randomUUID().slice(0, 8)}`;
        const past = Date.now() - 600_000;
        const stale = payload(vmId, 'create', { issuedAt: new Date(past).toISOString(), expiresAt: new Date(past + 120_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(stale, target.signer)));
        const nowMs = Date.now();
        const tooLong = payload(vmId, 'create', { issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 600_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(tooLong, target.signer)));
        const future = payload(vmId, 'create', { issuedAt: new Date(nowMs + 120_000).toISOString(), expiresAt: new Date(nowMs + 240_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(future, target.signer)));
        await expectError('vm_not_found', () => fleet.getVm(vmId));
      },
    },
    {
      name: 'fleet: runs nothing outside the allow-list or its fixed parameters',
      async run() {
        const vmId = await newVm();
        const base = payload(vmId, 'collect_diagnostics');
        await expectError('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'run_script', parameters: { script: 'id' } })));
        await expectError('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'write_file', parameters: { path: '/etc/passwd', content: '' } })));
        await expectError('invalid_request', async () => fleet.submitOperation(await signRaw({ ...base, parameters: { files: ['/home/pane/.ssh/id_ed25519'] } })));
        const otherChecksum = { ...target.release, debSha256: target.release.debSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
        await expectError('release_not_published', async () => fleet.submitOperation(await signOperation({ ...payload(vmId, 'update_pane'), operation: 'update_pane', parameters: { release: otherChecksum } }, target.signer)));
        const diagnostics = await run(vmId, 'collect_diagnostics');
        assert.ok(diagnostics.result, 'collect_diagnostics returns what it collected');
        await run(vmId, 'delete');
      },
    },
    {
      name: "fleet: reports a VM's daily metrics, and every state change as an event with a cursor",
      async run() {
        const vmId = await newVm();
        const day = new Date().toISOString().slice(0, 10);
        assert.equal((await fleet.getMetrics(vmId, day)).day, day);
        const readAll = async () => {
          const events: FleetEvent[] = [];
          let cursor: string | null = null;
          for (;;) {
            const page = await fleet.listEvents(cursor ?? undefined, 500);
            if (page.events.length === 0) return { events, cursor: page.nextCursor ?? cursor };
            events.push(...page.events);
            cursor = page.nextCursor;
          }
        };
        const seen = await waitFor(readAll, (p) => p.events.some((e) => e.vmId === vmId && e.kind === 'state_changed' && e.state === 'running'), `a running event for ${vmId}`, timeoutMs);
        assert.ok(seen.cursor, 'a feed with events has a cursor');
        assert.equal(new Set(seen.events.map((e) => e.id)).size, seen.events.length, 'paging never repeats an event');
        const after = await fleet.listEvents(seen.cursor ?? undefined);
        assert.ok(after.events.every((e) => !seen.events.some((old) => old.id === e.id)), 'events after the cursor are new');
        await run(vmId, 'delete');
      },
    },
  ];
}
