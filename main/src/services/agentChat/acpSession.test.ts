import { agent, methods, type AnyMessage } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from 'vitest';
import { AcpSession } from './acpSession';

describe('host ACP session', () => {
  it('can continue an explicitly allowed partial import with an honest history notice and no replay', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const server = agent().onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.load, () => ({}))
      .connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 2);
    try {
      await host.initialize();
      await host.load({ sessionId: 'saved-empty', cwd: '/workspace', mcpServers: [] }, { allowIncompleteHistory: true });
      expect(host.historyNotice()).toMatch(/did not return.*history/i);
      expect(host.updates()).toEqual([]);
    } finally { await host.close(); server.close(); }
  });
  it('forks stored history without prompting and directs subsequent input only to the fork', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const prompts: string[] = [];
    const identities: string[] = [];
    const server = agent().onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    })).onRequest(methods.agent.session.fork, ({ params }) => {
      expect(params.sessionId).toBe('original');
      return { sessionId: 'fork' };
    }).onRequest(methods.agent.session.load, async ({ params, client }) => {
      expect(identities).toEqual(['fork']);
      expect(params.sessionId).toBe('fork');
      await client.notify(methods.client.session.update, { sessionId: 'fork', update: {
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'An old request, already handled' },
      } });
      return {};
    }).onRequest(methods.agent.session.prompt, ({ params }) => {
      expect(params.sessionId).toBe('fork');
      prompts.push(...params.prompt.flatMap(part => part.type === 'text' ? [part.text] : []));
      return { stopReason: 'end_turn' };
    }).connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 2, { onIdentity: id => { identities.push(id); } });
    try {
      await host.initialize();
      expect(await host.fork({ sessionId: 'original', cwd: '/workspace', mcpServers: [] })).toMatchObject({ sessionId: 'fork' });
      expect(host.updates()).toHaveLength(1);
      expect(prompts).toEqual([]);
      await host.prompt([{ type: 'text', text: 'A new request' }]);
      expect(prompts).toEqual(['A new request']);
    } finally { await host.close(); server.close(); }
  });
  it('bounds an unresponsive adapter preflight without submitting or creating a conversation', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const server = agent().onRequest(methods.agent.initialize, () => new Promise(() => undefined))
      .connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 1, { requestTimeoutMs: 20 });
    try { await expect(host.initialize()).rejects.toMatchObject({ code: 'CHAT_ADAPTER_TIMEOUT' }); }
    finally { await host.close(); server.close(); }
  });
  it('creates a new conversation only on an explicit fresh request and retains the returned identity', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const server = agent().onRequest(methods.agent.initialize, () => ({ protocolVersion: 1 }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'new-native-a' }))
      .onRequest(methods.agent.session.prompt, ({ params }) => {
        expect(params.sessionId).toBe('new-native-a');
        return { stopReason: 'end_turn' };
      }).connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 1);
    try {
      await host.initialize();
      expect(await host.create({ cwd: '/workspace', mcpServers: [] })).toMatchObject({ sessionId: 'new-native-a' });
      await host.prompt([{ type: 'text', text: 'First turn' }]);
      await expect(host.create({ cwd: '/workspace', mcpServers: [] })).rejects.toMatchObject({ code: 'CHAT_ALREADY_LOADED' });
    } finally { await host.close(); server.close(); }
  });
  it('withdraws pending approvals on cancellation and rejects a late viewer answer', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const server = agent().onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.load, async ({ params, client }) => {
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'History' } } });
        return {};
      }).onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const outcome = await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId, toolCall: { toolCallId: 'edit' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }],
        });
        expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
        return { stopReason: 'cancelled' };
      }).onNotification(methods.agent.session.cancel, () => undefined)
      .connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 1);
    try {
      await host.initialize();
      await host.load({ sessionId: 'native-a', cwd: '/workspace', mcpServers: [] });
      const response = host.prompt([{ type: 'text', text: 'Edit' }]);
      await new Promise(resolve => setTimeout(resolve, 0));
      const id = host.permissions()[0].id;
      await host.cancel();
      expect(() => host.answer(id, 1, 'yes')).toThrow(/withdrawn/i);
      expect(await response).toMatchObject({ stopReason: 'cancelled' });
    } finally { await host.close(); server.close(); }
  });

  it('does not turn an empty successful load into a usable or replacement conversation', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    const conversations = new Set(['native-a']);
    const server = agent().onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1, agentCapabilities: { loadSession: true },
    })).onRequest(methods.agent.session.load, () => ({}))
      .onRequest(methods.agent.session.new, () => { conversations.add('replacement'); return { sessionId: 'replacement' }; })
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
      .connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 1);
    try {
      await host.initialize();
      await expect(host.load({ sessionId: 'native-a', cwd: '/workspace', mcpServers: [] })).rejects.toMatchObject({ code: 'CHAT_HISTORY_UNVERIFIED' });
      await expect(host.prompt([{ type: 'text', text: 'Should not be sent' }])).rejects.toMatchObject({ code: 'CHAT_NOT_LOADED' });
      expect([...conversations]).toEqual(['native-a']);
    } finally { await host.close(); server.close(); }
  });

  it('loads the exact history, sends only new content, and arbitrates one permission answer across viewers', async () => {
    const toAgent = new TransformStream<AnyMessage>();
    const toHost = new TransformStream<AnyMessage>();
    let receivedPrompt: unknown;
    const server = agent().onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
    })).onRequest(methods.agent.session.load, async ({ params, client }) => {
      expect(params.sessionId).toBe('native-a');
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: {
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Prior native conversation' },
      } });
      return {};
    }).onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      receivedPrompt = params.prompt;
      const result = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId, toolCall: { toolCallId: 'edit-a', title: 'Edit source' },
        options: [{ optionId: 'only-this', kind: 'allow_once', name: 'Allow this edit once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject this edit' }],
      });
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'only-this' } });
      return { stopReason: 'end_turn' };
    }).onRequest(methods.agent.session.close, () => ({})).connect({ readable: toAgent.readable, writable: toHost.writable });
    const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 4);
    try {
      await host.initialize();
      await host.load({ sessionId: 'native-a', cwd: '/workspace', mcpServers: [] });
      expect(host.updates()).toHaveLength(1);
      const prompting = host.prompt([{ type: 'text', text: 'New follow-up' }]);
      await new Promise(resolve => setTimeout(resolve, 0));
      const permission = host.permissions()[0];
      expect(permission.request.options[0].name).toBe('Allow this edit once');
      expect(() => host.answer(permission.id, 3, 'only-this')).toThrow(/changed/i);
      expect(() => host.answer(permission.id, 4, 'allow-all')).toThrow(/advertised/i);
      host.answer(permission.id, 4, 'only-this');
      expect(() => host.answer(permission.id, 4, 'deny')).toThrow(/answered/i);
      await prompting;
      expect(receivedPrompt).toEqual([{ type: 'text', text: 'New follow-up' }]);
      expect(host.permissions()).toEqual([]);
    } finally {
      await host.close();
      server.close();
    }
  });
});

it('applies only advertised configuration choices to the loaded conversation', async () => {
  const toAgent = new TransformStream<AnyMessage>();
  const toHost = new TransformStream<AnyMessage>();
  let value = 'default';
  const config = () => [{ id: 'mode', name: 'Permissions', type: 'select' as const, currentValue: value, options: [{ value: 'default', name: 'Ask' }, { value: 'plan', name: 'Plan' }] }];
  const server = agent().onRequest(methods.agent.initialize, () => ({ protocolVersion: 1 }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: 'configured-native', configOptions: config() }))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => { expect(params.sessionId).toBe('configured-native'); value = params.value; return { configOptions: config() }; })
    .connect({ readable: toAgent.readable, writable: toHost.writable });
  const host = new AcpSession({ readable: toHost.readable, writable: toAgent.writable }, 1);
  try {
    await host.initialize();
    await host.create({ cwd: '/workspace', mcpServers: [] });
    await expect(host.configure('mode', 'invented')).rejects.toThrow();
    expect(value).toBe('default');
    await host.configure('mode', 'plan');
    expect(host.controls()?.[0].currentValue).toBe('plan');
  } finally { await host.close(); server.close(); }
});
