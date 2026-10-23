import { describe, expect, it, vi } from 'vitest';

import type { AgentChatEvent, AgentChatView } from '@shared/types/agentChat';
import { decodeAgentChatView } from '@shared/types/agentChatDecoders';

import { DraftStore } from '../composer/draftStore';

import { ChatSession } from './chatSession';

function fixture() {
  let host: AgentChatView = {
    panelId: 'panel-a', available: true, setupRequired: false, running: false, permissions: [],
    conversation: { panelId: 'panel-a', workspaceId: 'pane-a', provider: 'claude', nativeSessionId: 'exact-id', generation: 2, active: 'chat', preferred: 'chat' },
    transcript: { panelId: 'panel-a', generation: 2, revision: 0, messages: [] },
  };
  const transport = {
    get: vi.fn(async () => decodeAgentChatView(structuredClone(host))),
    send: vi.fn(async () => ({ operationId: 'send-a', generation: 2, fingerprint: 'same', state: 'accepted' as const })),
    receipt: vi.fn(async () => ({ operationId: 'send-a', generation: 2, fingerprint: 'same', state: 'completed' as const })),
  };
  const session = new ChatSession('panel-a', transport);
  return { session, transport, setHost: (next: AgentChatView) => { host = next; }, getHost: () => host };
}

describe('native Chat viewer', () => {
  it('retains host identification requirements and native startup through snapshot and event decoding', async () => {
    const { session, setHost, getHost } = fixture();
    setHost({ ...getHost(), identificationRequired: true, identificationSocketRequired: false });
    await session.refresh();
    expect(session.snapshot().view?.identificationSocketRequired).toBe(false);
    session.receiveState(decodeAgentChatView({ ...getHost(), conversation: { ...getHost().conversation!, nativeStartup: true } }));
    expect(session.snapshot().view?.conversation?.nativeStartup).toBe(true);
  });
  it('loads the new generation when a handoff overtakes an older snapshot', async () => {
    const { session, transport, getHost } = fixture();
    let resolve: ((view: AgentChatView) => void) | undefined;
    transport.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = session.refresh();
    session.receiveState({ ...getHost(), transcript: undefined });
    resolve?.({ ...getHost(), conversation: { ...getHost().conversation!, generation: 1, active: 'terminal' }, transcript: undefined });
    await refresh;
    expect(transport.get).toHaveBeenCalledTimes(2);
    expect(session.snapshot().view?.transcript?.generation).toBe(2);
  });
  it('does not let a delayed snapshot overwrite newer host state', async () => {
    const { session, transport, getHost } = fixture();
    await session.refresh();
    let resolve: ((view: AgentChatView) => void) | undefined;
    transport.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = session.refresh();
    session.receiveState({ ...getHost(), running: true, transcript: undefined });
    resolve?.(structuredClone(getHost()));
    await refresh;
    expect(session.snapshot().view?.running).toBe(true);
  });
  it('keeps an uncertain send identity until an explicit receipt check, without replay on reconnect', async () => {
    const { session, transport } = fixture();
    await session.refresh();
    transport.send.mockRejectedValueOnce(new Error('Connection dropped before confirmation'));
    const request = { operationId: 'send-a', generation: 2, text: 'Keep this exact turn' };
    await session.send(request);
    expect(session.snapshot().pendingDelivery).toEqual(request);
    expect(session.snapshot().error).toContain('Check delivery');
    await session.refresh();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(session.snapshot().pendingDelivery).toEqual(request);
    await session.checkDelivery(false);
    expect(transport.receipt).toHaveBeenCalledWith('panel-a', 'send-a');
    expect(session.snapshot().pendingDelivery).toBeUndefined();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the attached draft across navigation and prevents retry while its receipt is pending', async () => {
    const { session, transport } = fixture();
    const detach = session.subscribe(() => undefined);
    await session.refresh();
    const image = { mimeType: 'image/png', data: 'fixture-image' };
    session.setAttachment(image);
    let release: (() => void) | undefined;
    transport.send.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      throw new Error('Lost response');
    });
    const delivery = session.send({ operationId: 'send-a', generation: 2, text: '', images: [image] });
    await session.checkDelivery(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
    detach();
    expect(session.snapshot().attachment).toEqual(image);
    release?.();
    await delivery;
    expect(session.snapshot().delivering).toBe(false);
    expect(session.snapshot().pendingDelivery?.images).toEqual([image]);
  });

  it('replays events received during a snapshot and repairs a missing revision', async () => {
    const { session, transport, setHost, getHost } = fixture();
    let resolve: ((view: AgentChatView) => void) | undefined;
    transport.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = session.refresh();
    const event: AgentChatEvent = { panelId: 'panel-a', generation: 2, revision: 1, change: { type: 'append', id: 'answer', role: 'assistant', part: { type: 'text', text: 'Live reply' } } };
    session.receiveEvent(event);
    resolve?.(structuredClone(getHost()));
    await refresh;
    expect(session.snapshot().view?.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Live reply' }]);
    setHost({ ...getHost(), transcript: { panelId: 'panel-a', generation: 2, revision: 3, messages: [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Repaired full answer' }] }] } });
    session.receiveEvent({ ...event, revision: 3 });
    await session.refresh();
    expect(session.snapshot().view?.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Repaired full answer' }]);
  });

  it('retries only the explicitly selected uncertain operation and keeps it when leaving the viewer', async () => {
    const { session, transport } = fixture();
    const detach = session.subscribe(() => undefined);
    await session.refresh();
    transport.send.mockRejectedValueOnce(new Error('Lost response'));
    const request = { operationId: 'send-a', generation: 2, text: 'One operation' };
    await session.send(request);
    detach();
    expect(session.snapshot().view?.transcript).toBeUndefined();
    expect(session.snapshot().pendingDelivery).toEqual(request);
    await session.refresh();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(session.snapshot().view?.transcript).toBeUndefined();
    await session.checkDelivery(true);
    expect(transport.send).toHaveBeenNthCalledWith(2, 'panel-a', request);
    expect(session.snapshot().pendingDelivery).toBeUndefined();
  });

  it('ignores an old generation and preserves the transcript on host state-only updates', async () => {
    const { session, getHost } = fixture();
    await session.refresh();
    session.receiveEvent({ panelId: 'panel-a', generation: 2, revision: 1, change: { type: 'append', id: 'answer', role: 'assistant', part: { type: 'text', text: 'Current conversation' } } });
    session.receiveState({ ...getHost(), transcript: undefined, running: true });
    expect(session.snapshot().view?.running).toBe(true);
    expect(session.snapshot().view?.transcript?.revision).toBe(1);
    session.receiveState({ ...getHost(), conversation: { ...getHost().conversation!, generation: 1, active: 'terminal' } });
    expect(session.snapshot().view?.conversation?.generation).toBe(2);
    expect(session.snapshot().view?.conversation?.active).toBe('chat');
  });
});

for (const reconciliation of ['send', 'receipt', 'retry']) for (const editOrigin of [false, true]) it(`confirms only the originating draft after navigation; reconciliation=${reconciliation}, editOrigin=${editOrigin}`, async () => {
  const { session, transport } = fixture();
  await session.refresh();
  const persisted = new Map([['A', 'send A'], ['B', 'keep B']]);
  const drafts = new DraftStore({ read: key => persisted.get(key) ?? '', write: (key, text) => { persisted.set(key, text); } });
  const original = drafts.read('A');
  let release: (() => void) | undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  if (reconciliation !== 'send') transport.send.mockRejectedValueOnce(new Error('Lost receipt'));
  else transport.send.mockImplementationOnce(async () => { await hold; return { operationId: 'send-a', generation: 2, fingerprint: 'same', state: 'accepted' }; });
  const send = session.send({ operationId: 'send-a', generation: 2, text: original.text }, () => drafts.confirm(original));
  if (reconciliation !== 'send') await send;
  if (reconciliation === 'retry') transport.send.mockImplementationOnce(async () => { await hold; return { operationId: 'send-a', generation: 2, fingerprint: 'same', state: 'accepted' }; });
  transport.receipt.mockImplementationOnce(async () => { await hold; return { operationId: 'send-a', generation: 2, fingerprint: 'same', state: 'completed' }; });
  const completion = reconciliation === 'send' ? send : session.checkDelivery(reconciliation === 'retry');
  drafts.update('B', 'edited B');
  if (editOrigin) drafts.update('A', 'newer A draft');
  // A second check cannot race the pending confirmation or create a new send.
  await session.checkDelivery(true);
  release?.();
  await completion;
  expect(persisted.get('A')).toBe(editOrigin ? 'newer A draft' : '');
  expect(persisted.get('B')).toBe('edited B');
});
