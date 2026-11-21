import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, ContractViolationError, createFleetClient, createServiceClient } from './index';
import { type FleetStub, type ServiceStub, startFleetStub, startServiceStub } from './stubs';
import { createLocalSigner, fleetContractCases, serviceContractCases } from './testing';

const emails = { member: 'member@example.test', unverified: 'unverified@example.test', waitlisted: 'waitlisted@example.test' };

describe('service stub passes the service contract', () => {
  let stub: ServiceStub;
  beforeAll(async () => {
    stub = await startServiceStub({
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

describe('canonical JSON, the bytes operation signatures cover', () => {
  it('sorts keys at every level, keeps array order, and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 'x', e: null }], c: true }, B: 'upper' })).toBe('{"B":"upper","a":{"c":true,"d":[2,{"e":null,"f":"x"}]},"b":1}');
  });
});

describe('the service stub counts agent-hours from awake time', () => {
  it('counts 90 minutes awake at 8 GiB as 1.5 agent-hours, and a review pause keeps the Session from starting', async () => {
    let clock = Date.parse('2027-01-10T12:00:00.000Z');
    const stub = await startServiceStub({ accounts: [{ email: 'a@example.test', invited: true }], now: () => new Date(clock) });
    try {
      const anonymous = createServiceClient({ baseUrl: stub.url });
      const { deviceCode, userCode } = await anonymous.startDeviceSignIn();
      stub.approveDevice(userCode, 'a@example.test');
      const signedIn = await anonymous.pollDeviceSignIn(deviceCode);
      if (signedIn.status !== 'complete') throw new Error(signedIn.status);
      const member = createServiceClient({ baseUrl: stub.url, token: signedIn.token });
      const organizationId = signedIn.account.organizations[0]?.organizationId ?? '';

      const { vm } = await member.createVm(organizationId, 'metered', 'meter-key-0001');
      clock += 90 * 60_000;
      await member.stopVm(vm.id);
      clock += 60 * 60_000;
      expect((await member.getUsage(organizationId)).agentHours).toEqual({ used: 1.5, limit: 300 });

      stub.pauseForReview(vm.id);
      await expect(member.startVm(vm.id)).rejects.toMatchObject({ code: 'under_review' });
    } finally {
      await stub.close();
    }
  });
});
