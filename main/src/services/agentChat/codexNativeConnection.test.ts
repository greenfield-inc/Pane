import { once } from 'events';
import { expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { CodexNativeConnection } from './codexNativeConnection';

it('confirms the native client resume response, rejects read-only fallback, and invalidates closed clients', async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstream, 'listening');
  const { port } = decodeBoundary(upstream.address(), boundary.object({ port: boundary.number }));
  upstream.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    socket.send(JSON.stringify(request.params.threadId === 'blocked' && request.method === 'thread/resume'
      ? { id: request.id, error: { message: 'Active writer elsewhere' } }
      : { id: request.id, result: { thread: { id: request.params.threadId } } }));
  }));
  const bridge = new CodexNativeConnection('owned-token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(socket, 'open'); return socket;
  });
  const clients: WebSocket[] = [];
  try {
    const endpoint = await bridge.start();
    const denied = new WebSocket(endpoint); clients.push(denied);
    await expect(once(denied, 'error')).resolves.toMatchObject([expect.objectContaining({ message: expect.stringContaining('401') })]);
    const native = new WebSocket(endpoint, { headers: { Authorization: 'Bearer owned-token' } }); clients.push(native);
    await once(native, 'open');
    const send = async (id: number, method: string, threadId: string) => { const response = once(native, 'message'); native.send(JSON.stringify({ id, method, params: { threadId } })); await response; };
    await send(1, 'thread/resume', 'blocked');
    await send(2, 'thread/read', 'blocked');
    expect(bridge.confirms('blocked')).toBe(false);
    await send(3, 'thread/resume', 'exact-id');
    await expect.poll(() => bridge.confirms('exact-id')).toBe(true);
    expect(bridge.confirms('different-id')).toBe(false);
    const closed = once(native, 'close'); native.close(); await closed;
    await expect.poll(() => bridge.confirms('exact-id')).toBe(false);
  } finally { for (const client of clients) client.terminate(); await bridge.close(); for (const client of upstream.clients) client.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
