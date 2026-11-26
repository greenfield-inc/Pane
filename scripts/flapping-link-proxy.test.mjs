import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { start } from './flapping-link-proxy.mjs';

/** @type {http.Server} */
let target;
before(async () => {
  // Answers POST /echo with its body; upgrades become a raw echo, like a WebSocket.
  target = http.createServer((req, res) => req.pipe(res));
  target.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.on('error', () => {}).pipe(socket);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
});
after(() => {
  target.closeAllConnections();
  target.close();
});

const proxyFor = (options = {}) =>
  start({ targetHost: '127.0.0.1', targetPort: /** @type {net.AddressInfo} */ (target.address()).port, manual: true, longDropMs: 300, refuseMs: 200, ...options });

/** Opens an upgraded echo connection through the proxy; resolves once the 101 arrives. */
async function echoConnection(port, { wait = true } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  const state = { socket, received: '', closed: false, error: /** @type {Error | null} */ (null) };
  socket.on('data', (chunk) => (state.received += chunk));
  socket.on('error', (error) => (state.error = error));
  socket.on('close', () => (state.closed = true));
  socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
  if (wait) await until(() => state.received.includes('\r\n\r\n'));
  return state;
}

async function until(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(10);
  }
}

test('HTTP requests pass through while UP', async () => {
  const proxy = await proxyFor();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'hello' });
  assert.equal(await res.text(), 'hello');
  await proxy.close();
});

test('a short drop hangs open and new connections, then delivers their bytes', async () => {
  const proxy = await proxyFor();
  const open = await echoConnection(proxy.port);
  proxy.forceDown();
  open.socket.write('ping');
  const opened = await echoConnection(proxy.port, { wait: false });
  await sleep(150);
  assert.equal(open.received.endsWith('ping'), false);
  assert.equal(opened.received, '');
  assert.equal(open.closed || opened.closed, false);

  proxy.forceUp();
  await until(() => open.received.endsWith('ping') && opened.received.includes('101 Switching Protocols'));
  assert.equal(open.closed || opened.closed, false);
  await proxy.close();
});

test('a long drop resets held connections', async () => {
  const proxy = await proxyFor();
  const open = await echoConnection(proxy.port);
  proxy.forceDown(350);
  open.socket.write('ping');
  await until(() => open.closed);
  assert.equal(open.received.endsWith('ping'), false);
  assert.equal(/** @type {NodeJS.ErrnoException} */ (open.error)?.code, 'ECONNRESET');
  await proxy.close();
});

test('new connections are reset in the window after DOWN, then accepted', async () => {
  const proxy = await proxyFor();
  proxy.forceDown();
  proxy.forceUp();
  assert.equal(proxy.phase(), 'refusing');
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'x' }));

  await until(() => proxy.phase() === 'up');
  const res = await fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'back' });
  assert.equal(await res.text(), 'back');
  await proxy.close();
});

test('a seeded schedule repeats and cycles UP, DOWN, REFUSING', async () => {
  const run = async () => {
    const seen = [];
    const proxy = await proxyFor({ manual: false, seed: 7, scale: 0.002, onPhase: (e) => seen.push([e.phase, Math.round(e.durationMs ?? -1)]) });
    await until(() => seen.length >= 5, 3000);
    await proxy.close();
    return seen.slice(0, 5);
  };
  const first = await run();
  assert.deepEqual(first.map(([phase]) => phase), ['up', 'down', 'refusing', 'up', 'down']);
  assert.deepEqual(await run(), first);
});

test('latency holds each direction for half the round trip and keeps byte order', async () => {
  const proxy = await proxyFor({ latencyMs: 120 });
  const open = await echoConnection(proxy.port);
  const sent = Date.now();
  for (const part of ['a', 'b', 'c', 'd']) open.socket.write(part);
  await until(() => open.received.endsWith('abcd'));
  const roundTrip = Date.now() - sent;
  assert.ok(roundTrip >= 110, `round trip ${roundTrip} ms is at least the 120 ms latency (less timer slack)`);
  assert.ok(roundTrip < 400, `round trip ${roundTrip} ms stays near the 120 ms latency`);
  await proxy.close();
});

test('latency and a short drop together still deliver every byte in order', async () => {
  const proxy = await proxyFor({ latencyMs: 100 });
  const open = await echoConnection(proxy.port);
  open.socket.write('1');
  await sleep(10);
  proxy.forceDown();
  open.socket.write('2');
  await sleep(150);
  open.socket.write('3');
  proxy.forceUp();
  await until(() => open.received.endsWith('123'));
  assert.equal(open.closed, false);
  await proxy.close();
});

test('counts the bytes that cross the link each way', async () => {
  const proxy = await proxyFor();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'x'.repeat(1000) });
  assert.equal((await res.text()).length, 1000);
  await until(() => proxy.bytes().toClient >= 1000);
  const { toTarget, toClient } = proxy.bytes();
  assert.ok(toTarget >= 1000 && toTarget < 1400, `toTarget ${toTarget} is the body plus request headers`);
  assert.ok(toClient >= 1000 && toClient < 1400, `toClient ${toClient} is the body plus response headers`);
  proxy.resetBytes();
  assert.deepEqual(proxy.bytes(), { toTarget: 0, toClient: 0 });
  await proxy.close();
});

test('latency charges a new connection one round trip to open, as a TCP handshake does', async (t) => {
  const proxy = await proxyFor({ latencyMs: 120 });
  t.after(() => proxy.close());
  const sent = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'hello' });
  assert.equal(await res.text(), 'hello');
  const firstAnswer = Date.now() - sent;
  assert.ok(firstAnswer >= 230, `a fresh connection's first answer took ${firstAnswer} ms: the handshake's round trip plus the request's (240 ms, less timer slack)`);
  assert.ok(firstAnswer < 600, `a fresh connection's first answer took ${firstAnswer} ms, near two round trips`);
});

test('says when it last delivered bytes each way', async (t) => {
  const proxy = await proxyFor();
  t.after(() => proxy.close());
  assert.deepEqual(proxy.lastDelivered?.(), { toTarget: null, toClient: null });
  const before = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/echo`, { method: 'POST', body: 'hi' });
  await res.text();
  const { toTarget, toClient } = proxy.lastDelivered();
  assert.ok(toTarget !== null && toTarget >= before && toTarget <= Date.now(), `toTarget ${toTarget} is during the request`);
  assert.ok(toClient !== null && toClient >= toTarget && toClient <= Date.now(), `toClient ${toClient} is the answer's, after the request`);
});
