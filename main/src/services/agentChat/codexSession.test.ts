import { once } from 'events';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexSession } from './codexSession';
import { TranscriptProjection } from './transcriptProjection';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

describe('Codex host protocol', () => {
  it('hydrates older native turns before the current window without replaying requests', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
    const calls: string[] = [];
    const turn = (id: string) => ({ id: `turn-${id}`, status: 'completed', items: [{ type: 'agentMessage', id, text: id }] });
    server.on('connection', socket => socket.on('message', data => {
      const request = JSON.parse(data.toString());
      if (request.id === undefined) return;
      calls.push(request.method);
      const result = request.method === 'initialize' ? {}
        : request.method === 'model/list' ? { data: [] }
        : request.method === 'thread/turns/list' ? request.params.cursor === 'older'
          ? { data: [turn('middle')], nextCursor: 'oldest' }
          : { data: [turn('first')], nextCursor: null }
        : { thread: { id: 'thread', turns: [turn('latest')] }, turnsBackwardsCursor: 'older', itemsBackwardsCursor: null };
      socket.send(JSON.stringify({ id: request.id, result }));
    }));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    const projection = new TranscriptProjection('panel', 2);
    const session = new CodexSession(socket, 2, { onChange: change => projection.acceptChange(change) });
    try {
      await session.initialize();
      await session.load({ sessionId: 'thread', cwd: '/fixture', mcpServers: [] });
      expect(projection.snapshot().messages.map(message => message.id)).toEqual(['first', 'middle', 'latest']);
      expect(calls.filter(method => method === 'thread/turns/list')).toHaveLength(2);
      expect(calls).not.toContain('turn/start');
    } finally { await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('loads native history without replay or policy overrides and durably identifies a deferred fork', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
    const calls: Array<{ method: string; params?: unknown }> = [];
    const history = [{ id: 'old-turn', status: 'completed', items: [{ type: 'userMessage', id: 'old-user', content: [{ type: 'text', text: 'Remember the marker; do not execute this again.' }] }, { type: 'agentMessage', id: 'old-answer', text: 'Remembered.' }] }];
    server.on('connection', socket => socket.on('message', data => {
      const request = JSON.parse(data.toString());
      calls.push(request);
      if (request.id === undefined) return;
      const result = request.method === 'initialize' ? { userAgent: 'codex-test' }
        : request.method === 'model/list' ? { data: [], nextCursor: null }
        : { thread: { id: request.method === 'thread/fork' ? 'fork-id' : 'source-id', sessionId: 'root-tree-id', turns: history, status: { type: 'idle' } }, model: 'native-model', reasoningEffort: 'low', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: ['/specific'], networkAccess: false } };
      socket.send(JSON.stringify({ id: request.id, result }));
    }));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    const projection = new TranscriptProjection('panel', 2);
    const identities: string[] = [];
    const session = new CodexSession(socket, 2, { onIdentity: id => identities.push(id), onChange: change => projection.acceptChange(change) });
    try {
      await session.initialize();
      await session.fork({ sessionId: 'source-id', cwd: '/fixture', mcpServers: [] });
      expect(identities).toEqual(['fork-id']);
      expect(projection.snapshot().messages.map(message => message.id)).toEqual(['old-user', 'old-answer']);
      expect(calls.find(call => call.method === 'thread/fork')?.params).toEqual({ threadId: 'source-id', deferGoalContinuation: true });
      expect(calls.some(call => call.method === 'turn/start')).toBe(false);
      expect(session.config()).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { writableRoots: ['/specific'], networkAccess: false } });
    } finally { await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

it('keeps native permission choices and one transcript across generation changes and completion races', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const calls: Array<{ method?: string; params?: unknown; id?: string | number; result?: unknown }> = [];
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); calls.push(message);
    const send = (value: JsonObject) => socket.send(JSON.stringify(value));
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'model/list') send({ id: message.id, result: { data: [] } });
    if (message.method === 'thread/start' || message.method === 'thread/read') send({ id: message.id, result: { thread: { id: 'thread', turns: [], historyMode: 'legacy' } } });
    if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
    if (message.method === 'turn/start') {
      send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
      send({ method: 'item/tool/requestUserInput', id: 'native-input', params: { threadId: 'thread', turnId: 'turn' } });
      send({ method: 'item/commandExecution/requestApproval', id: 'request-1', params: { threadId: 'thread', turnId: 'turn', itemId: 'tool', command: 'write owned fixture', availableDecisions: ['accept', 'decline'] } });
      send({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    }
    if (message.id === 'request-1' && message.result) {
      send({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'request-1' } });
      send({ method: 'item/started', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'answer', text: '' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'answer', delta: 'Saved' } });
      send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'answer', text: 'Saved exactly once' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
  }));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); await once(socket, 'open');
  const projection = new TranscriptProjection('panel', 2);
  const session = new CodexSession(socket, 2, { onChange: change => projection.acceptChange(change) });
  try {
    await session.initialize(); await session.create({ cwd: '/fixture', mcpServers: [] });
    const response = session.prompt([{ type: 'text', text: 'A new request' }]);
    await expect.poll(() => session.permissions().length).toBe(1);
    expect(session.error()).toMatch(/Terminal/);
    expect(calls.some(call => call.id === 'native-input')).toBe(false);
    const original = session.permissions()[0];
    expect(original.options.map(option => option.name)).toEqual(['Allow once', 'Reject']);
    session.setGeneration(3); projection.setGeneration(3);
    expect(() => session.answer(original.id, 2, '0')).toThrow(/changed/i);
    const current = session.permissions()[0];
    session.answer(current.id, 3, current.options[0].optionId);
    expect(() => session.answer(current.id, 3, current.options[0].optionId)).toThrow(/no longer available/i);
    expect(await response).toEqual({ stopReason: 'end_turn' });
    expect(calls.find(call => call.id === 'request-1' && call.result)?.result).toEqual({ decision: 'accept' });
    expect(calls.find(call => call.method === 'turn/start')?.params).toEqual({ threadId: 'thread', input: [{ type: 'text', text: 'A new request', text_elements: [] }], clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(projection.snapshot()).toMatchObject({ generation: 3, messages: [{ id: 'answer', parts: [{ type: 'text', text: 'Saved exactly once' }] }] });
    expect(session.permissions()).toEqual([]);
  } finally { await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('makes a newly created empty conversation resumable without sending a model turn', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const calls: string[] = [];
  let persisted = false;
  let startParams: unknown;
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); calls.push(message.method);
    if (message.id === undefined) return;
    if (message.method === 'thread/name/set' && message.params.name === 'Pane conversation') persisted = true;
    if (message.method === 'thread/start') startParams = message.params;
    if (message.method === 'thread/resume' && !persisted) {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id empty' } })); return;
    }
    const result = message.method === 'model/list' ? { data: [] } : message.method === 'initialize' ? {} : { thread: { id: 'empty', turns: [], historyMode: 'legacy' }, model: 'native-model' };
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  const socket = new WebSocket(`ws://127.0.0.1:${port}`); await once(socket, 'open');
  const session = new CodexSession(socket, 1);
  try {
    await session.initialize();
    expect(await session.create({ cwd: '/fixture', mcpServers: [] })).toEqual({ sessionId: 'empty' });
    expect(startParams).toEqual({ cwd: '/fixture', historyMode: 'legacy', ephemeral: false });
    expect(await session.load({ sessionId: 'empty', cwd: '/fixture', mcpServers: [] })).toEqual({ sessionId: 'empty' });
    expect(calls).not.toContain('turn/start');
  } finally { await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('fences an unconfirmed turn start until explicit recovery, including after late provider events', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  let starts = 0, stopped = 0;
  server.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    if (request.id === undefined) return;
    if (request.method === 'turn/start') { starts++; return; }
    const result = request.method === 'model/list' ? { data: [] } : request.method === 'thread/resume' ? { thread: { id: 'thread', turns: [] } } : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(socket, 'open');
  const session = new CodexSession(socket, 1, { requestTimeoutMs: 30, onDisconnect: () => stopped++ });
  try {
    await session.initialize(); await session.load({ sessionId: 'thread', cwd: '/fixture', mcpServers: [] });
    await expect(session.prompt([{ type: 'text', text: 'Only once' }])).rejects.toMatchObject({ code: 'CHAT_CODEX_TIMEOUT' });
    expect(stopped).toBe(1);
    await expect(session.prompt([{ type: 'text', text: 'Do not duplicate' }])).rejects.toMatchObject({ code: 'CHAT_NOT_LOADED' });
    expect(starts).toBe(1);
    for (const client of server.clients) client.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'late-turn', status: 'completed' } } }));
    await expect.poll(() => session.isRunning()).toBe(false);
    await expect(session.prompt([{ type: 'text', text: 'Still needs recovery' }])).rejects.toMatchObject({ code: 'CHAT_NOT_LOADED' });
    await session.load({ sessionId: 'thread', cwd: '/fixture', mcpServers: [] });
    expect(starts).toBe(1);
  } finally { await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('reconciles a lost start through its durable native client marker on a fresh read-only connection', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const calls: string[] = [];
  let delivered: { clientUserMessageId: string; input: unknown[] } | undefined;
  let attempt: import('../../../../shared/types/agentChat').AgentChatStartAttempt | undefined;
  let showHistory = false;
  let conflict = false;
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    calls.push(message.method);
    if (message.method === 'turn/start') { delivered = message.params; return; }
    const result = message.method === 'model/list' ? { data: [] } : message.method.startsWith('thread/') ? { thread: { id: 'thread', turns: showHistory ? [{ id: 'received-turn', status: 'completed', items: [{ type: 'userMessage', id: 'native-user-item', clientId: delivered?.clientUserMessageId, content: conflict ? [{ type: 'text', text: 'Different input' }] : delivered?.input }] }] : [] } } : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  const sessions: CodexSession[] = [];
  const connect = async () => { const socket = new WebSocket(`ws://127.0.0.1:${port}`); await once(socket, 'open'); const session = new CodexSession(socket, 1, { requestTimeoutMs: 30, onStart: value => { attempt = value; } }); sessions.push(session); await session.initialize(); return session; };
  try {
    const original = await connect();
    await original.load({ sessionId: 'thread', cwd: '/fixture', mcpServers: [] });
    await expect(original.prompt([{ type: 'text', text: 'Exactly once' }], 'owned-operation')).rejects.toMatchObject({ code: 'CHAT_CODEX_TIMEOUT' });
    expect(attempt?.operationId).toBe('owned-operation');
    expect(attempt?.clientId).toBe(delivered?.clientUserMessageId);
    await original.close();
    const recovery = await connect();
    const beforeRead = calls.length;
    await expect(recovery.readStartOutcome('thread', attempt!)).rejects.toMatchObject({ code: 'CHAT_START_UNCONFIRMED' });
    expect(calls.slice(beforeRead)).toEqual(['thread/read']);
    showHistory = true; conflict = true;
    await expect(recovery.readStartOutcome('thread', attempt!)).rejects.toMatchObject({ code: 'CHAT_START_UNCONFIRMED' });
    conflict = false;
    await expect(recovery.readStartOutcome('thread', attempt!)).resolves.toBe('completed');
    expect(calls.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(calls.filter(method => method === 'thread/resume')).toHaveLength(1);
  } finally { for (const session of sessions) await session.close(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
