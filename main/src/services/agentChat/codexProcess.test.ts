import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import { once } from 'events';
import { CodexProcess } from './codexProcess';
import type { ArchiveProcessIdentity } from '../archiveProcessTracker';

it.each([false, true])('releases its authenticated owned server even when graceful cancellation fails=%s', async cancelFails => {
  const directory = mkdtempSync(join(tmpdir(), 'pane-codex-server-'));
  const fixture = join(directory, 'server.cjs');
  writeFileSync(fixture, `const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))}); const crypto=require('crypto'); const args=process.argv.slice(2);const endpoint=args[args.indexOf('--listen')+1];const digest=args[args.indexOf('--ws-token-sha256')+1];const server=new WebSocketServer({port:Number(new URL(endpoint).port),host:'127.0.0.1',verifyClient:({req})=>crypto.createHash('sha256').update((req.headers.authorization||'').replace(/^Bearer /,'')).digest('hex')===digest});server.on('listening',()=>process.stderr.write('codex app-server (WebSockets)\\n  listening on: ws://127.0.0.1:'+server.address().port+'\\n'));server.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data);if(m.id===undefined)return;socket.send(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[]}: {userAgent:'fixture'}}));}));`);
  let identities: ArchiveProcessIdentity[] = [];
  const runtime = new CodexProcess({ executable: process.execPath, configArgs: [fixture], cwd: directory, env: process.env, directory, generation: 1, save: value => { identities = value; } });
  try {
    await runtime.start();
    expect(identities.length).toBeGreaterThan(0);
    const denied = new WebSocket(runtime.endpoint);
    const error = once(denied, 'error');
    await expect(error).resolves.toMatchObject([expect.objectContaining({ message: expect.stringContaining('401') })]);
    denied.terminate();
    await runtime.session.initialize();
    if (cancelFails) vi.spyOn(runtime.session, 'cancel').mockRejectedValue(new Error('Interrupt acknowledgement timed out'));
    await runtime.release(cancelFails);
    expect(identities).toEqual([]);
  } finally { await runtime.release(); rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('closes its raw proxy while preserving the borrowed provider server', async () => {
  const { WebSocketServer } = await import('ws');
  const { boundary, decodeBoundary } = await import('../../../../shared/validation/boundaryDecoder');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'model/list' ? { data: [] } : message.method === 'thread/loaded/list' ? { data: ['existing-id'] } : {} }));
  }));
  const directory = mkdtempSync(join(tmpdir(), 'pane-codex-proxy-'));
  const executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\nconst socket=require('net').connect({host:'127.0.0.1',port:${port}});process.stdin.pipe(socket).pipe(process.stdout);process.stdin.on('end',()=>socket.end());socket.on('close',()=>process.exit(0));`, { mode: 0o700 });
  let identities: ArchiveProcessIdentity[] = [];
  const runtime = new CodexProcess({ executable, configArgs: [], cwd: directory, env: process.env, directory, socketPath: join(directory, 'original.sock'), generation: 1, save: value => { identities = value; } });
  try {
    await runtime.start(); await runtime.session.initialize();
    await runtime.session.verifyLoaded('existing-id');
    await expect(runtime.session.verifyLoaded('other-id')).rejects.toMatchObject({ code: 'CHAT_IDENTITY_UNAVAILABLE' });
    await runtime.release();
    expect(identities).toEqual([]);
    const independent = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(independent, 'open'); independent.close();
  } finally {
    await runtime.release();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it('reconciles a borrowed start after proxy closure without replaying or killing the external owner', async () => {
  const { WebSocketServer } = await import('ws');
  const { boundary, decodeBoundary } = await import('../../../../shared/validation/boundaryDecoder');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  let attempt: import('../../../../shared/types/agentChat').AgentChatStartAttempt | undefined;
  let input: unknown[] = [];
  let clientId = '', starts = 0, visible = false;
  server.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    if (request.id === undefined) return;
    if (request.method === 'turn/start') { starts++; input = request.params.input; clientId = request.params.clientUserMessageId; return; }
    const result = request.method === 'model/list' ? { data: [] } : request.method.startsWith('thread/') ? { thread: { id: 'original', turns: visible ? [{ id: 'accepted-turn', status: 'completed', items: [{ type: 'userMessage', id: 'message', clientId, content: input }] }] : [] } } : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const runtime = new CodexProcess({ executable: process.execPath, configArgs: [], cwd: process.cwd(), env: process.env, directory: process.cwd(), remote: { endpoint: `ws://127.0.0.1:${port}` }, generation: 1, requestTimeoutMs: 30, save: () => {}, onStart: value => { attempt = value; } });
  try {
    await runtime.start(); await runtime.session.initialize(); await runtime.session.load({ sessionId: 'original', cwd: process.cwd(), mcpServers: [] });
    await expect(runtime.session.prompt([{ type: 'text', text: 'One request' }], 'operation')).rejects.toMatchObject({ code: 'CHAT_CODEX_TIMEOUT' });
    await expect(runtime.release()).rejects.toMatchObject({ code: 'CHAT_START_UNCONFIRMED' });
    expect(runtime.session.isConnected()).toBe(false);
    await expect(runtime.reconcileStart('original', attempt!)).rejects.toMatchObject({ code: 'CHAT_START_UNCONFIRMED' });
    visible = true;
    await expect(runtime.reconcileStart('original', attempt!)).resolves.toBe('completed');
    await runtime.release();
    expect(starts).toBe(1);
    expect(server.address()).not.toBeNull();
  } finally { await runtime.release(false); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
