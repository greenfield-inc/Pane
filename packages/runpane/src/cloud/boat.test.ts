import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoatProvider } from './boat';

interface Recorded {
  method: string;
  url: string;
  headers: Map<string, string>;
  body: unknown;
}

function fakeBoat(responses: Array<{ status: number; body?: unknown }>, org?: string) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Map<string, string>();
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init?.method} ${String(input)}`);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  };
  return { calls, boat: createBoatProvider({ apiKey: 'boat_test', org, fetchImpl, sleep: async () => undefined }) };
}

const sandbox = (fields: { name?: string; state?: string; team?: { id: string; name: string } | null } = {}) => ({
  id: 'bx_abcdefgh', name: '', state: 'idle', type: 'default', ...fields,
});

test('create bills the given wallet, sends an Idempotency-Key and no env, then names the sandbox', async () => {
  const { calls, boat } = fakeBoat([
    { status: 202, body: { sandbox: sandbox({ team: { id: 'team_1', name: 'test' } }) } },
    { status: 200, body: { sandbox: sandbox({ name: 'rp-abc12345' }) } },
  ], 'team_1');
  const created = await boat.create({ name: 'rp-abc12345', size: 'default', org: 'team_1', idempotencyKey: 'runpane-cloud-new-abc' });

  assert.equal(created.name, 'rp-abc12345');
  assert.equal(created.state, 'running');
  assert.deepEqual(created.org, { id: 'team_1', name: 'test' });
  assert.equal(calls[0].url, 'https://boat.dev/api/v1/sandboxes');
  assert.equal(calls[0].headers.get('idempotency-key'), 'runpane-cloud-new-abc');
  assert.equal(calls[0].headers.get('x-boat-org'), 'team_1');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer boat_test');
  assert.deepEqual(calls[0].body, { type: 'default', ttlSeconds: null, noEnv: true, org: 'team_1' });
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body, { name: 'rp-abc12345' });
});

test('maps boat states and treats 404 as gone', async () => {
  const { boat } = fakeBoat([
    { status: 200, body: { sandbox: sandbox({ state: 'archived', team: null }) } },
    { status: 200, body: { sandbox: sandbox({ state: 'provisioning' }) } },
    { status: 404, body: { code: 'not_found' } },
  ]);
  const stopped = await boat.get('bx_abcdefgh');
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.org, { id: 'personal', name: 'Personal' });
  assert.equal((await boat.get('bx_abcdefgh')).state, 'starting');
  assert.equal((await boat.get('bx_abcdefgh')).state, 'gone');
});

test('getWithoutWallet asks boat without the wallet header, so another wallet\'s sandbox shows', async () => {
  const { calls, boat } = fakeBoat([
    { status: 404, body: { code: 'not_found' } },
    { status: 200, body: { sandbox: sandbox() } },
  ], 'team_test');
  assert.equal((await boat.get('bx_abcdefgh')).state, 'gone');
  assert.equal((await boat.getWithoutWallet('bx_abcdefgh')).state, 'running');
  assert.equal(calls[0].headers.get('x-boat-org'), 'team_test');
  assert.equal(calls[1].headers.has('x-boat-org'), false);
});

test('destroy confirms the delete and counts a 404 as deleted', async () => {
  const { calls, boat } = fakeBoat([{ status: 404 }]);
  await boat.destroy('bx_abcdefgh');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].headers.get('x-ascii-confirm-delete'), 'bx_abcdefgh');
});

test('runScript uploads the script as a file and runs it with bash, then removes it', async () => {
  const { calls, boat } = fakeBoat([
    { status: 200, body: { ok: true } },
    { status: 200, body: { result: { exitCode: 0, stdout: 'RP_RESULT {"ok":true}\n', stderr: '' } } },
  ]);
  const result = await boat.handle('bx_abcdefgh').runScript('echo secret-free', { timeoutSeconds: 9_999 });
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[1].url, /\/sandboxes\/bx_abcdefgh\/commands$/u);
  assert.match(JSON.stringify(calls[1].body), /^\{"command":"bash \/home\/user\/\.runpane-cloud\/run-[0-9a-f]+\.sh; rc=\$\?; rm -f [^"]+","timeoutSeconds":600\}$/u);
});

test('errors name the call and boat\'s code, never the API key', async () => {
  const { boat } = fakeBoat([{ status: 429, body: { error: { code: 'rate_limited', message: 'Rate limit hit' } } }]);
  await assert.rejects(boat.resume('bx_abcdefgh'), (error: Error) => {
    assert.match(error.message, /boat POST \/sandboxes\/bx_abcdefgh\/resume failed with HTTP 429 \(rate_limited\): Rate limit hit/u);
    assert.doesNotMatch(error.message, /boat_test/u);
    return true;
  });
});
