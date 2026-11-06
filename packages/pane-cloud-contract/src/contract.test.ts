import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, ContractViolationError, createFleetClient, createServiceClient } from './index';
import { type FleetStub, type ServiceStub, startFleetStub, startServiceStub } from './stubs';
import { createLocalSigner, fleetContractCases, serviceContractCases } from './testing';

const logins = { owner: 'octo-owner', teammate: 'octo-mate', outsider: 'octo-stranger' };

describe('service stub passes the service contract', () => {
  let stub: ServiceStub;
  beforeAll(async () => {
    stub = await startServiceStub({
      accounts: [
        { githubLogin: logins.owner, name: 'Owner', cohort: true },
        { githubLogin: logins.teammate, name: 'Teammate', cohort: false },
        { githubLogin: logins.outsider, cohort: false },
      ],
    });
  });
  afterAll(() => stub.close());

  const cases = serviceContractCases({
    get baseUrl() {
      return stub.url;
    },
    logins,
    timeoutMs: 2000,
    async signIn(who) {
      const client = createServiceClient({ baseUrl: stub.url });
      const { deviceCode, userCode } = await client.startDeviceSignIn();
      stub.approveDevice(userCode, logins[who]);
      const result = await client.pollDeviceSignIn(deviceCode);
      if (result.status !== 'complete') throw new Error(`sign-in ended ${result.status}`);
      return result.token;
    },
  });
  for (const c of cases) it(c.name, () => c.run());
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
  for (const c of cases) it(c.name, () => c.run());
});

describe('clients reject a server that drifts from the contract', () => {
  it('throws ContractViolationError for a response outside the schema', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ machineId: 'm_1', state: 'teleporting' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(createFleetClient({ baseUrl, token: 't' }).getMachine('m_1')).rejects.toBeInstanceOf(ContractViolationError);
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
