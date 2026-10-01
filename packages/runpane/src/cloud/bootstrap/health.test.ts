import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteRequestError, type RemoteHttpTransport } from '../../remote/remoteDaemonClient';
import { interpretHealthBody, waitForDaemonHealth } from './health';

test('interpretHealthBody accepts the legacy payload and the readiness payload', () => {
  assert.deepEqual(interpretHealthBody({ ok: true, status: 'ready' }),
    { ok: true, version: undefined, readiness: 'ready' });
  assert.equal(interpretHealthBody({ ok: true, status: 'ready', version: '2.4.141', readiness: { state: 'starting' } }).ok, false);
  assert.deepEqual(interpretHealthBody({ ok: true, status: 'ready', version: '2.4.141', readiness: { state: 'degraded' } }),
    { ok: true, version: '2.4.141', readiness: 'degraded' });
  assert.equal(interpretHealthBody({ ok: false, status: 'ready' }).ok, false);
});

test('waitForDaemonHealth treats a malformed body as not ready', async () => {
  const fetchImpl: typeof fetch = async () => new Response('"nope"', { status: 200 });
  const result = await waitForDaemonHealth('https://rp-x.ts.net', { fetchImpl, intervalMs: 5, timeoutMs: 10 });
  assert.equal(result.ok, false);
});

test('waitForDaemonHealth polls until ready', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), 'https://rp-x.ts.net/health');
    if (calls === 1) throw new Error('connect ECONNREFUSED');
    if (calls === 2) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ ok: true, status: 'ready', version: '9.9.9' }), { status: 200 });
  };
  const result = await waitForDaemonHealth('https://rp-x.ts.net/', { fetchImpl, intervalMs: 1, timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.equal(result.version, '9.9.9');
  assert.equal(calls, 3);
});

// The token goes through the transport that keeps a plain-HTTP token on the tailnet (R6), never plain fetch.
test('waitForDaemonHealth sends the paired token through the tailnet-guarded transport', async () => {
  const sent: (string | undefined)[] = [];
  let fetched = 0;
  const transport: RemoteHttpTransport = async (request) => {
    sent.push(request.headers.Authorization);
    return { status: 200, body: JSON.stringify({ ok: true, status: 'ready', version: '9.9.9', readiness: { state: 'ready' } }) };
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetched += 1;
    assert.equal(new Headers(init?.headers).get('authorization'), null, 'plain fetch never carries the token');
    return new Response(JSON.stringify({ ok: true, status: 'ready' }), { status: 200 });
  };
  const withToken = await waitForDaemonHealth('http://rp-x.ts.net:8080', { fetchImpl, transport, token: 'tok' });
  assert.deepEqual([withToken.ok, withToken.version, withToken.readiness], [true, '9.9.9', 'ready']);
  assert.deepEqual(sent, ['Bearer tok']);
  assert.equal(fetched, 0);
  await waitForDaemonHealth('https://rp-x.ts.net', { fetchImpl, transport });
  assert.equal(fetched, 1);
});

test('waitForDaemonHealth falls back to an unauthenticated probe when the route would leave the tailnet', async () => {
  const refused: RemoteHttpTransport = async () => {
    throw new RemoteRequestError('Refusing to send a token over plain HTTP', 0, 'ERR_PLAIN_HTTP_OFF_TAILNET');
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response(JSON.stringify({ ok: true, status: 'ready' }), { status: 200 });
  };
  const result = await waitForDaemonHealth('http://100.64.0.9:8080', { fetchImpl, transport: refused, token: 'tok' });
  assert.equal(result.ok, true);
  assert.equal(result.version, undefined);
});

test('waitForDaemonHealth gives up at the timeout with the last status', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 502 });
  const result = await waitForDaemonHealth('https://rp-x.ts.net', { fetchImpl, intervalMs: 5, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
});
