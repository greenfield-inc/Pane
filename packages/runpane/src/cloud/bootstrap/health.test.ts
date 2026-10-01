import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('waitForDaemonHealth gives up at the timeout with the last status', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 502 });
  const result = await waitForDaemonHealth('https://rp-x.ts.net', { fetchImpl, intervalMs: 5, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
});
