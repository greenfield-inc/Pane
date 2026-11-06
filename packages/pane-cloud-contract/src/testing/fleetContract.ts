import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  createFleetClient,
  type FleetEvent,
  type FleetMachine,
  MACHINE_LIMITS,
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
  /** How long to wait for a machine or operation to settle. Default 120 s. */
  timeoutMs?: number;
}

/** The fleet API contract: what F2's host agent and scheduler must do for the service. */
export function fleetContractCases(target: FleetContractTarget): ContractCase[] {
  // Read baseUrl at call time, so a target can name a server that starts after the cases are built.
  const fleet = createFleetClient({ get baseUrl() { return target.baseUrl; }, token: target.token });
  const timeoutMs = target.timeoutMs ?? 120_000;

  const payload = (machineId: string, operation: OperationPayload['operation'], extra: Partial<OperationPayload> = {}): OperationPayload => {
    const issuedAt = new Date();
    const parameters = operation === 'bootstrap' || operation === 'update_pane' ? { release: target.release } : operation === 'stop' ? { cause: 'user' } : {};
    // SAFETY: parameters match `operation` (a release for bootstrap and update_pane, a cause for stop, none otherwise); signOperation parses it again.
    return {
      requestId: randomUUID(),
      machineId,
      reason: `contract test: ${operation}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
      operation,
      parameters,
      ...extra,
    } as OperationPayload;
  };
  const run = async (machineId: string, operation: OperationPayload['operation']) => {
    const accepted = await fleet.submitOperation(await signOperation(payload(machineId, operation), target.signer));
    assert.equal(accepted.machineId, machineId);
    assert.equal(accepted.operation, operation);
    const finished = await waitFor(() => fleet.getOperation(accepted.requestId), (s) => s.status === 'succeeded' || s.status === 'failed', `${operation} to finish`, timeoutMs);
    assert.equal(finished.status, 'succeeded', `${operation} failed: ${finished.error?.message ?? ''}`);
    return finished;
  };
  const machineIn = (machineId: string, state: FleetMachine['state']) =>
    waitFor(() => fleet.getMachine(machineId), (m) => m.state === state, `machine ${machineId} to be ${state}`, timeoutMs);
  /** Signs raw bytes, skipping signOperation's own check, to send what a compromised caller might. */
  const signRaw = async (body: Parameters<typeof operationSigningBytes>[0]): Promise<OperationEnvelope> => {
    const signature = await target.signer.sign(operationSigningBytes(body));
    // SAFETY: deliberately outside the contract; the case checks the fleet refuses it.
    return { payload: body, signature: { keyId: target.signer.keyId, algorithm: 'ECDSA_SHA_256', value: signature.toString('base64') } } as OperationEnvelope;
  };
  const newMachine = async () => {
    const machineId = `contract-${randomUUID().slice(0, 8)}`;
    await run(machineId, 'create');
    await machineIn(machineId, 'running');
    return machineId;
  };

  return [
    {
      name: 'fleet: create, bootstrap, stop, resume and delete a machine, each as one signed operation, and a stop records its cause',
      async run() {
        const machineId = await newMachine();
        await run(machineId, 'bootstrap');
        const booted = await fleet.getMachine(machineId);
        assert.equal(booted.paneVersion, target.release.version);
        await run(machineId, 'prepare_to_stop');
        await run(machineId, 'stop');
        assert.equal((await machineIn(machineId, 'stopped')).stateReason, 'user');
        await run(machineId, 'resume');
        await machineIn(machineId, 'running');
        const billingStop = await fleet.submitOperation(await signOperation({ ...payload(machineId, 'stop'), operation: 'stop', parameters: { cause: 'billing' } }, target.signer));
        await waitFor(() => fleet.getOperation(billingStop.requestId), (s) => s.status === 'succeeded', 'the billing stop', timeoutMs);
        assert.equal((await machineIn(machineId, 'stopped')).stateReason, 'billing', 'a service stop records its cause');
        await run(machineId, 'delete');
        await machineIn(machineId, 'deleted');
      },
    },
    {
      name: 'fleet: sending the same signed operation twice runs it once',
      async run() {
        const machineId = `contract-${randomUUID().slice(0, 8)}`;
        const envelope = await signOperation(payload(machineId, 'create'), target.signer);
        const first = await fleet.submitOperation(envelope);
        const second = await fleet.submitOperation(envelope);
        assert.equal(second.requestId, first.requestId);
        await machineIn(machineId, 'running');
        await run(machineId, 'delete');
      },
    },
    {
      name: 'fleet: refuses an operation signed by an untrusted key, or changed after signing',
      async run() {
        const machineId = `contract-${randomUUID().slice(0, 8)}`;
        await expectError('signature_invalid', async () => fleet.submitOperation(await signOperation(payload(machineId, 'create'), target.untrustedSigner)));
        const envelope = await signOperation(payload(machineId, 'create'), target.signer);
        await expectError('signature_invalid', () => fleet.submitOperation({ ...envelope, payload: { ...envelope.payload, reason: 'changed after signing' } }));
        await expectError('machine_not_found', () => fleet.getMachine(machineId));
      },
    },
    {
      name: 'fleet: refuses an operation outside its time window: expired, too long-lived, or issued in the future',
      async run() {
        const machineId = `contract-${randomUUID().slice(0, 8)}`;
        const past = Date.now() - 600_000;
        const stale = payload(machineId, 'create', { issuedAt: new Date(past).toISOString(), expiresAt: new Date(past + 120_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(stale, target.signer)));
        const nowMs = Date.now();
        const tooLong = payload(machineId, 'create', { issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 600_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(tooLong, target.signer)));
        const future = payload(machineId, 'create', { issuedAt: new Date(nowMs + 120_000).toISOString(), expiresAt: new Date(nowMs + 240_000).toISOString() });
        await expectError('operation_expired', async () => fleet.submitOperation(await signOperation(future, target.signer)));
        await expectError('machine_not_found', () => fleet.getMachine(machineId));
      },
    },
    {
      name: 'fleet: runs nothing outside the allow-list or its fixed parameters',
      async run() {
        const machineId = await newMachine();
        const base = payload(machineId, 'collect_diagnostics');
        await expectError('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'run_script', parameters: { script: 'id' } })));
        await expectError('operation_not_allowed', async () => fleet.submitOperation(await signRaw({ ...base, operation: 'write_file', parameters: { path: '/etc/passwd', content: '' } })));
        await expectError('invalid_request', async () => fleet.submitOperation(await signRaw({ ...base, parameters: { files: ['/home/pane/.ssh/id_ed25519'] } })));
        const otherChecksum = { ...target.release, debSha256: target.release.debSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
        await expectError('release_not_published', async () => fleet.submitOperation(await signOperation({ ...payload(machineId, 'update_pane'), operation: 'update_pane', parameters: { release: otherChecksum } }, target.signer)));
        const diagnostics = await run(machineId, 'collect_diagnostics');
        assert.ok(diagnostics.result, 'collect_diagnostics returns what it collected');
        await run(machineId, 'delete');
      },
    },
    {
      name: 'fleet: reports metrics against the daily CPU budget, and events with a cursor',
      async run() {
        const machineId = await newMachine();
        const metrics = await fleet.getMetrics(machineId);
        assert.equal(metrics.cpuBudgetSeconds, MACHINE_LIMITS.dailyCpuSeconds);
        assert.equal(metrics.throttled, metrics.cpuSecondsUsed >= MACHINE_LIMITS.dailyCpuSeconds);
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
        const seen = await waitFor(readAll, (p) => p.events.some((e) => e.machineId === machineId), `an event for ${machineId}`, timeoutMs);
        assert.ok(seen.cursor, 'a feed with events has a cursor');
        assert.equal(new Set(seen.events.map((e) => e.id)).size, seen.events.length, 'paging never repeats an event');
        const after = await fleet.listEvents(seen.cursor ?? undefined);
        assert.ok(after.events.every((e) => !seen.events.some((old) => old.id === e.id)), 'events after the cursor are new');
        await run(machineId, 'delete');
      },
    },
  ];
}
