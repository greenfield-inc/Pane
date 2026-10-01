import assert from 'node:assert/strict';
import dns, { type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import os from 'node:os';
import { afterEach, describe, it, mock } from 'node:test';
import { nodeHttpTransport, RemoteRequestError } from './remoteDaemonClient';
import { assertTailnetRoute, hasLocalTailnetInterface, isTailscaleAddress, tailnetOnlyLookup, TailnetRouteError } from './tailnetRoute';

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function iface(address: string): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/32` };
}

const ON_TAILNET: Interfaces = { lo: [iface('127.0.0.1')], tailscale0: [iface('100.101.102.103')], eth0: [iface('192.168.1.5')] };
// Carrier-grade NAT hands the LTE modem a 100.64.0.0/10 address; Tailscale is off.
const CGNAT_ONLY: Interfaces = { lo: [iface('127.0.0.1')], wwan0: [iface('100.72.9.14')] };

function fakeLookup(addresses: LookupAddress[]): LookupFunction {
  return (_host, _options, callback) => callback(null, addresses);
}

function lookupOnce(lookup: ReturnType<typeof tailnetOnlyLookup>, host: string, all: boolean): Promise<{ error: Error | null; address: string | LookupAddress[] }> {
  return new Promise((resolve) => {
    lookup(host, { all }, (error, address) => resolve({ error, address }));
  });
}

afterEach(() => mock.restoreAll());

describe('plain HTTP only inside the tailnet', () => {
  it('knows Tailscale addresses from carrier-grade NAT neighbours and the internet', () => {
    for (const address of ['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0:ab12::5]']) assert.ok(isTailscaleAddress(address), address);
    for (const address of ['100.63.255.255', '100.128.0.1', '93.184.216.34', '192.168.1.5', 'fd00::1', 'example.ts.net']) assert.ok(!isTailscaleAddress(address), address);
  });

  it('counts this machine on a tailnet only when a Tailscale interface carries a Tailscale address', () => {
    assert.equal(hasLocalTailnetInterface(ON_TAILNET), true);
    assert.equal(hasLocalTailnetInterface({ utun4: [iface('100.90.1.2')] }), true);
    assert.equal(hasLocalTailnetInterface({ Tailscale: [iface('100.90.1.2')] }), true);
    assert.equal(hasLocalTailnetInterface(CGNAT_ONLY), false);
    assert.equal(hasLocalTailnetInterface({ tailscale0: [iface('10.0.0.2')] }), false);
  });

  it('lets https and loopback through, and refuses plain HTTP off the tailnet or to a non-Tailscale address', () => {
    for (const url of ['https://rp-a.tail.ts.net', 'http://127.0.0.1:42137', 'http://localhost:1', 'http://[::1]:2']) {
      assertTailnetRoute(new URL(url), () => CGNAT_ONLY);
    }
    assertTailnetRoute(new URL('http://rp-a.tail.ts.net:42137'), () => ON_TAILNET);
    assertTailnetRoute(new URL('http://100.90.1.2:42137'), () => ON_TAILNET);
    assert.throws(() => assertTailnetRoute(new URL('http://100.90.1.2:42137'), () => CGNAT_ONLY), { code: 'ERR_PLAIN_HTTP_OFF_TAILNET', message: /not on a tailnet/u });
    // A name is decided by the lookup, once its addresses are known.
    assertTailnetRoute(new URL('http://rp-a.tail.ts.net:42137'), () => CGNAT_ONLY);
    assert.throws(() => assertTailnetRoute(new URL('http://93.184.216.34:42137'), () => ON_TAILNET), { name: 'TailnetRouteError', message: /not a Tailscale address/u });
  });

  it('resolves a name only to Tailscale addresses (all of them, on a tailnet) or to this machine', async () => {
    const tailnetAddresses = fakeLookup([{ address: '100.90.1.2', family: 4 }, { address: 'fd7a:115c:a1e0::2', family: 6 }]);
    const good = tailnetOnlyLookup(tailnetAddresses, () => ON_TAILNET);
    assert.deepEqual(await lookupOnce(good, 'rp-a.tail.ts.net', false), { error: null, address: '100.90.1.2' });
    assert.equal((await lookupOnce(good, 'rp-a.tail.ts.net', true)).address.length, 2);

    const offTailnet = await lookupOnce(tailnetOnlyLookup(tailnetAddresses, () => CGNAT_ONLY), 'rp-a.tail.ts.net', false);
    assert.ok(offTailnet.error instanceof TailnetRouteError);
    assert.match(offTailnet.error.message, /not on a tailnet/u);

    const hijacked = tailnetOnlyLookup(fakeLookup([{ address: '100.90.1.2', family: 4 }, { address: '93.184.216.34', family: 4 }]), () => ON_TAILNET);
    const refused = await lookupOnce(hijacked, 'rp-a.tail.ts.net', false);
    assert.ok(refused.error instanceof TailnetRouteError);
    assert.match(refused.error.message, /93\.184\.216\.34 is not a Tailscale address/u);

    // The token never leaves this machine: a name that resolves to loopback is fine even off the tailnet.
    const local = tailnetOnlyLookup(fakeLookup([{ address: '127.0.0.1', family: 4 }]), () => CGNAT_ONLY);
    assert.deepEqual(await lookupOnce(local, 'pane.test.ts.net', false), { error: null, address: '127.0.0.1' });
  });

  it('never sends the token: the transport refuses before connecting', async () => {
    mock.method(os, 'networkInterfaces', () => CGNAT_ONLY);
    const request = { method: 'POST' as const, headers: { Authorization: 'Bearer secret' }, body: '{}', connectTimeoutMs: 1_000, timeoutMs: 1_000 };
    await assert.rejects(nodeHttpTransport({ ...request, url: 'http://100.90.1.2:9/invoke' }), (error: Error) => (
      error instanceof RemoteRequestError && error.code === 'ERR_PLAIN_HTTP_OFF_TAILNET'
    ));
    mock.method(os, 'networkInterfaces', () => ON_TAILNET);
    const lookups = mock.method(dns, 'lookup', fakeLookup([{ address: '93.184.216.34', family: 4 }]));
    await assert.rejects(nodeHttpTransport({ ...request, url: 'http://rp-a.tail.ts.net:9/invoke' }), (error: Error) => (
      error instanceof RemoteRequestError && error.code === 'ERR_PLAIN_HTTP_OFF_TAILNET' && /93\.184\.216\.34 is not a Tailscale address/u.test(error.message)
    ));
    assert.equal(lookups.mock.callCount(), 1);
  });
});
