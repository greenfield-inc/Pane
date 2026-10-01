import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoatProvider } from './boat';

/** Request bodies the adapter sends, as the tests read them back. */
interface SentBody {
  path?: string;
  content?: string;
}

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: SentBody | undefined;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init?.method} ${String(input)}`);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  };
  return { calls, impl };
}

interface SandboxOverrides {
  id?: string;
  name?: string;
  state?: string;
}

const sandbox = (overrides: SandboxOverrides = {}) => ({
  id: 'bx_abcdefgh', name: '', state: 'idle', type: 'large', desktopAvailable: false, snapshotAvailable: true, ...overrides,
});

function provider(responses: Array<{ status: number; body?: unknown }>) {
  const fetch = fakeFetch(responses);
  return { fetch, boat: createBoatProvider({ apiKey: 'boat_test', fetchImpl: fetch.impl, sleep: async () => undefined }) };
}

test('create sends the Idempotency-Key, never sends env, then names the sandbox', async () => {
  const { fetch, boat } = provider([
    { status: 202, body: { ok: true, type: 'sandbox.created', sandbox: sandbox() } },
    { status: 200, body: { ok: true, sandbox: sandbox({ name: 'rp-abc12345' }) } },
  ]);
  const created = await boat.create({ name: 'rp-abc12345', size: 'large', fromSnapshot: 'rp-golden', idempotencyKey: 'runpane-cloud-new-abc' });

  assert.equal(created.id, 'bx_abcdefgh');
  assert.equal(created.name, 'rp-abc12345');
  assert.equal(created.state, 'running');
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://boat.dev/api/v1/sandboxes');
  assert.equal(fetch.calls[0].headers['idempotency-key'], 'runpane-cloud-new-abc');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer boat_test');
  assert.deepEqual(fetch.calls[0].body, { type: 'large', ttlSeconds: null, noEnv: true, from: 'rp-golden' });
  assert.equal(fetch.calls[1].method, 'PATCH');
  assert.deepEqual(fetch.calls[1].body, { name: 'rp-abc12345' });
});

test('create retries naming the sandbox and returns it unnamed rather than losing it', async () => {
  const { fetch, boat } = provider([
    { status: 202, body: { ok: true, type: 'sandbox.created', sandbox: sandbox() } },
    ...Array.from({ length: 4 }, () => ({ status: 503, body: { code: 'unavailable', message: 'busy' } })),
  ]);
  const created = await boat.create({ name: 'rp-abc12345', size: 'large', idempotencyKey: 'k1' });
  assert.equal(created.id, 'bx_abcdefgh');
  assert.equal(created.name, '');
  assert.equal(fetch.calls.filter((call) => call.method === 'PATCH').length, 4);
});

test('create retries a 5xx with the same Idempotency-Key', async () => {
  const { fetch, boat } = provider([
    { status: 503, body: { code: 'no_ready_machine', message: 'busy' } },
    { status: 202, body: { sandbox: sandbox({ name: 'rp-x' }) } },
  ]);
  await boat.create({ name: 'rp-x', size: 'default', idempotencyKey: 'k1' });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].headers['idempotency-key'], 'k1');
});

test('stop is not retried, and errors carry boat\'s code without the key', async () => {
  const { fetch, boat } = provider([{ status: 500, body: { error: { code: 'internal', message: 'oops' } } }]);
  await assert.rejects(boat.stop('bx_abcdefgh'), (error: Error) => {
    assert.match(error.message, /boat POST \/sandboxes\/bx_abcdefgh\/stop failed with HTTP 500 \(internal\): oops/u);
    assert.doesNotMatch(error.message, /boat_test/u);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('get maps boat states and treats 404 as gone', async () => {
  const { boat } = provider([
    { status: 200, body: { sandbox: sandbox({ state: 'archived' }) } },
    { status: 200, body: { sandbox: sandbox({ state: 'cloning' }) } },
    { status: 200, body: { sandbox: sandbox({ state: 'archiving' }) } },
    { status: 404, body: { code: 'not_found' } },
  ]);
  assert.equal((await boat.get('bx_abcdefgh')).state, 'stopped');
  assert.equal((await boat.get('bx_abcdefgh')).state, 'starting');
  assert.equal((await boat.get('bx_abcdefgh')).state, 'stopping');
  const gone = await boat.get('bx_abcdefgh');
  assert.equal(gone.state, 'gone');
});

test('destroy sends the delete confirmation header and accepts 404', async () => {
  const { fetch, boat } = provider([{ status: 202, body: { operation: { id: 'bdop_x' } } }, { status: 404 }]);
  await boat.destroy('bx_abcdefgh');
  await boat.destroy('bx_abcdefgh');
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].headers['x-ascii-confirm-delete'], 'bx_abcdefgh');
});

test('resume passes a size change; stop sends an empty body', async () => {
  const { fetch, boat } = provider([{ status: 202, body: {} }, { status: 202, body: {} }]);
  await boat.resume('bx_abcdefgh', { size: 'small' });
  await boat.stop('bx_abcdefgh');
  assert.deepEqual(fetch.calls[0].body, { type: 'small' });
  assert.deepEqual(fetch.calls[1].body, {});
});

test('runScript uploads the script as a file, runs it with bash, and deletes it', async () => {
  const { fetch, boat } = provider([
    { status: 200, body: { ok: true, type: 'file.written', success: true } },
    { status: 200, body: { ok: true, type: 'command.finished', exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false } },
  ]);
  const result = await boat.handle('bx_abcdefgh').runScript('echo "multi\nline"', { timeoutSeconds: 9999 });

  assert.deepEqual(result, { exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false });
  const upload = fetch.calls[0];
  assert.equal(upload.method, 'PUT');
  const filePath = String(upload.body?.path);
  assert.match(filePath, /^\/home\/user\/\.runpane-cloud\/run-[0-9a-f]{12}\.sh$/u);
  assert.equal(Buffer.from(String(upload.body?.content), 'base64').toString('utf8'), 'echo "multi\nline"');
  assert.deepEqual(fetch.calls[1].body, { command: `bash ${filePath}; rc=$?; rm -f ${filePath}; exit $rc`, timeoutSeconds: 600 });
});

test('list follows cursors', async () => {
  const { fetch, boat } = provider([
    { status: 200, body: { sandboxes: [sandbox({ id: 'bx_aaaaaaaa', name: 'rp-a' })], nextCursor: 'c2' } },
    { status: 200, body: { sandboxes: [sandbox({ id: 'bx_bbbbbbbb', name: 'rp-b', state: 'archived' })] } },
  ]);
  const listed = await boat.list();
  assert.deepEqual(listed.map((entry) => [entry.id, entry.state]), [['bx_aaaaaaaa', 'running'], ['bx_bbbbbbbb', 'stopped']]);
  assert.match(fetch.calls[1].url, /cursor=c2/u);
});
