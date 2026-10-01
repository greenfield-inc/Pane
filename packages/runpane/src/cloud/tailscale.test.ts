import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOUD_SESSION_TAG, createTailscaleApi, deletableNodeIds, describeForeignDevice, TailscaleApiError } from './tailscale';

const SECRET = 'fake-oauth-client-secret-value';

interface Call { url: string; method: string; body: string; auth: string }

interface FakeFetch { fetchImpl: typeof fetch; calls: Call[] }

function fakeFetch(responses: Map<string, () => Response>): FakeFetch {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    calls.push({ url, method, body: String(init?.body ?? ''), auth });
    if (url.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'at-123', expires_in: 3600 }), { status: 200 });
    }
    const key = `${method} ${url.replace('https://api.tailscale.com/api/v2', '')}`;
    const respond = responses.get(key);
    return respond ? respond() : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
  return { fetchImpl, calls };
}

test('mintAuthKey asks for a single-use, pre-authorized, tagged, non-ephemeral key', async () => {
  const { fetchImpl, calls } = fakeFetch(new Map([
    ['POST /tailnet/-/keys', () => new Response(JSON.stringify({ id: 'k1', key: 'tskey-fake-x', expires: 'soon' }), { status: 200 })],
  ]));
  const api = createTailscaleApi({ clientId: 'cid', clientSecret: `${SECRET}\n` }, fetchImpl);
  const key = await api.mintAuthKey({ description: 'runpane cloud rp-k3j9x0q2 with a description longer than fifty chars' });

  assert.deepEqual(key, { id: 'k1', key: 'tskey-fake-x', expires: 'soon' });
  const tokenCall = calls[0];
  assert.ok(tokenCall.body.includes('grant_type=client_credentials'));
  assert.ok(!tokenCall.body.includes('%0A'), 'the trailing newline of a stored secret is stripped');
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(body.capabilities.devices.create, {
    reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:rp-session'],
  });
  assert.equal(body.expirySeconds, 600);
  assert.ok(body.description.length <= 50);
  assert.equal(calls[1].auth, 'Bearer at-123');
});

test('the OAuth token is cached across calls', async () => {
  const { fetchImpl, calls } = fakeFetch(new Map([
    ['GET /tailnet/-/devices', () => new Response(JSON.stringify({ devices: [] }), { status: 200 })],
  ]));
  const api = createTailscaleApi({ clientId: 'cid', clientSecret: SECRET }, fetchImpl);
  await api.listDevices();
  await api.listDevices();
  assert.equal(calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
});

test('findDevicesByHostname matches the hostname or the MagicDNS short name', async () => {
  const { fetchImpl } = fakeFetch(new Map([
    ['GET /tailnet/-/devices', () => new Response(JSON.stringify({ devices: [
      { id: '1', nodeId: 'nA', hostname: 'rp-abc', name: 'rp-abc.tail.ts.net.', addresses: ['100.1.1.1'], tags: ['tag:rp-session'] },
      { id: '2', nodeId: 'nB', hostname: 'rp-abc', name: 'rp-abc-1.tail.ts.net', addresses: [] },
      { id: '3', nodeId: 'nC', hostname: 'box', name: 'rp-abc.other.ts.net', addresses: [] },
      { id: '4', nodeId: 'nD', hostname: 'rp-abcd', name: 'rp-abcd.tail.ts.net', addresses: [] },
    ] }), { status: 200 })],
  ]));
  const api = createTailscaleApi({ clientId: 'cid', clientSecret: SECRET }, fetchImpl);
  const found = await api.findDevicesByHostname('rp-abc');
  assert.deepEqual(found.map((device) => device.nodeId), ['nA', 'nB', 'nC']);
  assert.equal(found[0].name, 'rp-abc.tail.ts.net');
});

test('deletableNodeIds keeps the recorded node and tagged devices, never an untagged or differently tagged one', () => {
  const devices = [
    { nodeId: 'nOURS', hostname: 'rp-abc', tags: ['tag:rp-session'] },
    { nodeId: 'nMEMBER', hostname: 'rp-abc' },
    { nodeId: 'nSERVER', hostname: 'rp-abc', tags: ['tag:server'] },
  ];
  const result = deletableNodeIds(devices, [CLOUD_SESSION_TAG], 'nRECORDED');
  assert.deepEqual(result.nodeIds, ['nRECORDED', 'nOURS']);
  assert.deepEqual(result.foreign.map((device) => device.nodeId), ['nMEMBER', 'nSERVER']);
  // A recorded id that turns out to be someone else's device is not deleted either.
  assert.deepEqual(deletableNodeIds(devices, [CLOUD_SESSION_TAG], 'nMEMBER').nodeIds, ['nOURS']);
  assert.equal(describeForeignDevice(devices[1]), 'rp-abc (nMEMBER, untagged)');
});

test('deleteDevice reports an already-deleted device as false and errors carry no secrets', async () => {
  const { fetchImpl } = fakeFetch(new Map([
    ['DELETE /device/nA', () => new Response('', { status: 200 })],
    ['DELETE /device/nBAD', () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 })],
  ]));
  const api = createTailscaleApi({ clientId: 'cid', clientSecret: SECRET }, fetchImpl);
  assert.equal(await api.deleteDevice('nA'), true);
  assert.equal(await api.deleteDevice('nGONE'), false);
  const error = await api.deleteDevice('nBAD').then(() => undefined, (reason: Error) => reason);
  assert.ok(error instanceof TailscaleApiError);
  assert.equal(error.status, 403);
  assert.ok(!error.message.includes(SECRET) && !error.message.includes('at-123'));
});

test('a rejected OAuth client fails without echoing the secret', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'API token invalid' }), { status: 401 });
  const api = createTailscaleApi({ clientId: 'cid', clientSecret: SECRET }, fetchImpl);
  const error = await api.listDevices().then(() => undefined, (reason: Error) => reason);
  assert.ok(error instanceof TailscaleApiError);
  assert.equal(error.status, 401);
  assert.ok(!error.message.includes(SECRET));
});
