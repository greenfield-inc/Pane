import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTailscaleApi, deleteOwnedDevices, type TailscaleDevice } from './tailscale';

function fakeTailscale(handler: (method: string, path: string, body: string) => { status: number; body?: unknown }) {
  const calls: Array<{ method: string; path: string; body: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input).replace('https://api.tailscale.com/api/v2', '');
    const body = init?.body ? String(init.body) : '';
    calls.push({ method: init?.method ?? 'GET', path, body, authorization: new Headers(init?.headers).get('authorization') });
    const response = handler(init?.method ?? 'GET', path, body);
    return new Response(response.body === undefined ? '' : JSON.stringify(response.body), { status: response.status });
  };
  return { calls, api: createTailscaleApi({ clientId: 'client-id', clientSecret: 'client-secret' }, fetchImpl) };
}

const device = (nodeId: string, hostname: string, tags: string[]): TailscaleDevice => ({
  nodeId, id: nodeId, hostname, name: `${hostname}.tail1234.ts.net`, addresses: [], tags,
});

test('mints a single-use, preauthorized key tagged tag:rp-session with an OAuth token', async () => {
  const { calls, api } = fakeTailscale((method, path) => {
    if (path === '/oauth/token') return { status: 200, body: { access_token: 'oauth-access', expires_in: 3600 } };
    return { status: 200, body: { id: 'k1', key: 'tskey-fake-k1-SECRET' } };
  });
  const key = await api.mintAuthKey({ description: 'runpane cloud rp-abc12345' });
  assert.equal(key.id, 'k1');
  assert.equal(calls[1].path, '/tailnet/-/keys');
  assert.equal(calls[1].authorization, 'Bearer oauth-access');
  assert.deepEqual(JSON.parse(calls[1].body).capabilities.devices.create, {
    reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:rp-session'],
  });
});

test('a failed OAuth exchange names the status, never the client secret', async () => {
  const { api } = fakeTailscale(() => ({ status: 401, body: { message: 'invalid client' } }));
  await assert.rejects(api.listDevices(), (error: Error) => {
    assert.match(error.message, /HTTP 401/u);
    assert.doesNotMatch(error.message, /client-secret/u);
    return true;
  });
});

test('getDevice reads one node by id and answers null when the tailnet says 404', async () => {
  const { calls, api } = fakeTailscale((_method, path) => {
    if (path === '/oauth/token') return { status: 200, body: { access_token: 'fake-access', expires_in: 3600 } };
    if (path === '/device/n-live') return { status: 200, body: { nodeId: 'n-live', id: 'n-live', hostname: 'rp-a', name: 'rp-a.tail1234.ts.net.', tags: ['tag:rp-session'] } };
    return { status: 404 };
  });
  assert.deepEqual(await api.getDevice('n-live'), {
    nodeId: 'n-live', id: 'n-live', hostname: 'rp-a', name: 'rp-a.tail1234.ts.net', addresses: [], tags: ['tag:rp-session'], lastSeen: undefined,
  });
  assert.equal(await api.getDevice('n-gone'), null);
  assert.deepEqual(calls.filter((call) => call.path.startsWith('/device/')).map((call) => `${call.method} ${call.path}`), ['GET /device/n-live', 'GET /device/n-gone']);
});

test('deleteOwnedDevices deletes tagged devices under the name and leaves a member\'s machine alone', async () => {
  const deleted: string[] = [];
  const warnings: string[] = [];
  const tailnet = {
    findDevicesByHostname: async () => [device('n-ours', 'rp-abc12345', ['tag:rp-session']), device('n-laptop', 'rp-abc12345', [])],
    deleteDevice: async (nodeId: string) => {
      deleted.push(nodeId);
      return true;
    },
  };
  assert.deepEqual(await deleteOwnedDevices(tailnet, 'rp-abc12345', 'n-ours', (line) => warnings.push(line)), ['n-ours']);
  assert.deepEqual(deleted, ['n-ours']);
  assert.match(warnings[0], /left rp-abc12345\.tail1234\.ts\.net \(n-laptop, untagged\) alone/u);
});
