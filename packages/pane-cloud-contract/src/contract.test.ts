import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, ContractViolationError, operationSigningBytes, createFleetClient, createServiceClient } from './index';
import { type FleetStub, type ServiceStub, startFleetStub, startServiceStub } from './stubs';
import { createLocalSigner, fleetContractCases, serviceContractCases } from './testing';

const emails = { member: 'member@example.test', unverified: 'unverified@example.test', waitlisted: 'waitlisted@example.test' };

describe('service stub passes the service contract', () => {
  let stub: ServiceStub;
  let clock = Date.parse('2026-11-22T12:00:00.000Z');
  beforeAll(async () => {
    stub = await startServiceStub({
      now: () => new Date(clock),
      accounts: [
        { email: emails.member, name: 'Member', invited: true },
        { email: emails.unverified, invited: true, signupState: 'needs_phone' },
        { email: emails.waitlisted, invited: false },
      ],
    });
  });
  afterAll(() => stub.close());

  const cases = serviceContractCases({
    get baseUrl() {
      return stub.url;
    },
    emails,
    timeoutMs: 2000,
    controls: {
      pauseForReview: (vmId) => stub.pauseForReview(vmId),
      setCapacity: (capacity) => stub.setCapacity(capacity),
      addMember: (who, organizationId, role) => stub.addMember(organizationId, emails[who], role),
      setPlan: (organizationId, plan) => stub.setPlan(organizationId, plan),
      setMemoryGiB: (vmId, memoryGiB) => stub.setMemoryGiB(vmId, memoryGiB),
      setClock: (at) => {
        clock = Math.max(clock, Date.parse(at));
      },
    },
    async signIn(who) {
      const client = createServiceClient({ baseUrl: stub.url });
      const { deviceCode, userCode } = await client.startDeviceSignIn();
      stub.approveDevice(userCode, emails[who]);
      const result = await client.pollDeviceSignIn(deviceCode);
      if (result.status !== 'complete') throw new Error(`sign-in ended ${result.status}`);
      return result.token;
    },
  });
  it.each(cases)('$name', (c) => c.run());
});

describe('fleet stub passes the fleet contract', () => {
  let stub: FleetStub;
  const trusted = createLocalSigner('service-key');
  const untrusted = createLocalSigner('service-key');
  const release = { version: '2.4.215', arch: 'arm64' as const, debSha256: 'b'.repeat(64) };
  beforeAll(async () => {
    stub = await startFleetStub({ trustedKeys: { 'service-key': trusted.publicKeyPem }, publishedReleases: [release] });
  });
  afterAll(() => stub.close());

  const cases = fleetContractCases({
    get baseUrl() {
      return stub.url;
    },
    token: 'stub',
    signer: trusted.signer,
    untrustedSigner: untrusted.signer,
    release,
    hostId: 'stub-host-1',
    timeoutMs: 2000,
  });
  it.each(cases)('$name', (c) => c.run());
});

describe('clients reject a server that drifts from the contract', () => {
  it('throws ContractViolationError for a response outside the schema', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ vmId: 'vm_1', state: 'teleporting' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(createFleetClient({ baseUrl, token: 't' }).getVm('vm_1')).rejects.toBeInstanceOf(ContractViolationError);
      await expect(createServiceClient({ baseUrl, token: 't' }).getAccount()).rejects.toBeInstanceOf(ContractViolationError);
    } finally {
      server.close();
    }
  });
});

describe('operation signing bytes', () => {
  it('are the domain line, then the whole payload as canonical JSON', () => {
    const payload = {
      requestId: '11111111-1111-4111-8111-111111111111',
      hostId: 'host-a',
      vmId: 'vm_1',
      operation: 'stop',
      parameters: { cause: 'user' },
      reason: 'You stopped this Session.',
      issuedAt: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:02:00.000Z',
    };
    expect(operationSigningBytes(payload).toString('utf8')).toBe(
      'pane-cloud-operation-v1\n{"expiresAt":"2027-01-01T00:02:00.000Z","hostId":"host-a","issuedAt":"2027-01-01T00:00:00.000Z","operation":"stop","parameters":{"cause":"user"},"reason":"You stopped this Session.","requestId":"11111111-1111-4111-8111-111111111111","vmId":"vm_1"}',
    );
  });
});

describe('canonical JSON, the bytes operation signatures cover', () => {
  it('sorts keys at every level, keeps array order, and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 'x', e: null }], c: true }, B: 'upper' })).toBe('{"B":"upper","a":{"c":true,"d":[2,{"e":null,"f":"x"}]},"b":1}');
  });
});
