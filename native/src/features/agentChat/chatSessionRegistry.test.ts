import { expect, it, vi } from 'vitest';

import type { AgentChatReceipt, AgentChatView } from '@shared/types/agentChat';

import { ChatSessionRegistry } from './chatSessionRegistry';

function client() {
  const host: AgentChatView = { panelId: 'panel', available: true, setupRequired: false, running: false, permissions: [], conversation: { panelId: 'panel', workspaceId: 'pane', nativeSessionId: 'native', provider: 'claude', active: 'chat', preferred: 'chat', generation: 2 }, transcript: { panelId: 'panel', generation: 2, revision: 0, messages: [] } };
  return {
    host,
    get: vi.fn(async () => structuredClone(host)),
    send: vi.fn(async (): Promise<AgentChatReceipt> => ({ operationId: 'op', generation: 2, fingerprint: 'same', state: 'accepted' })),
    receipt: vi.fn(async (): Promise<AgentChatReceipt | undefined> => undefined),
  };
}

it('retains an uncertain image operation through host switching and credential replacement while isolating identical panel IDs', async () => {
  const registry = new ChatSessionRegistry<ReturnType<typeof client>>(transport => transport);
  const first = client();
  first.send.mockRejectedValue(new Error('Response lost after acceptance'));
  const session = registry.forPanel('host-A', 'panel', first);
  const detach = session.subscribe(() => undefined);
  await session.refresh();
  const image = { mimeType: 'image/png', data: 'image' };
  session.setAttachment(image);
  session.readingPosition = { conversationId: 'native', atBottom: false, anchor: { messageId: 'reading', withinItemOffset: 21, fallbackIndex: 3 } };
  const request = { operationId: 'op', generation: 2, text: 'Exactly once', images: [image] };
  await session.send(request);
  detach();
  const other = registry.forPanel('host-B', 'panel', client());
  expect(other.snapshot().pendingDelivery).toBeUndefined();
  expect(other.snapshot().attachment).toBeUndefined();
  const returnedClient = client();
  const returned = registry.forPanel('host-A', 'panel', returnedClient);
  expect(returned).toBe(session);
  returned.subscribe(() => undefined);
  await returned.refresh();
  expect(returned.snapshot().pendingDelivery).toEqual(request);
  expect(returned.snapshot().attachment).toEqual(image);
  expect(returned.readingPosition.anchor).toEqual({ messageId: 'reading', withinItemOffset: 21, fallbackIndex: 3 });
  await returned.send({ ...request, operationId: 'duplicate' });
  expect(returnedClient.send).not.toHaveBeenCalled();
  const renewedCredentialClient = client();
  const renewed = registry.forPanel('host-A', 'panel', renewedCredentialClient);
  await renewed.refresh();
  await renewed.checkDelivery(false);
  expect(renewedCredentialClient.receipt).toHaveBeenCalledWith('panel', 'op');
  expect(renewed.snapshot().pendingDelivery).toEqual(request);
  await renewed.checkDelivery(true);
  expect(renewedCredentialClient.send).toHaveBeenCalledExactlyOnceWith('panel', request);
  expect(first.send).toHaveBeenCalledTimes(1);
  expect(returnedClient.send).not.toHaveBeenCalled();
});

it('repairs an old-client snapshot after rebinding and refuses retry against a different conversation', async () => {
  const registry = new ChatSessionRegistry<ReturnType<typeof client>>(transport => transport);
  const first = client();
  const session = registry.forPanel('host', 'panel', first);
  await session.refresh();
  first.send.mockRejectedValueOnce(new Error('Lost response'));
  await session.send({ operationId: 'op', generation: 2, text: 'Original conversation only' });
  let release: ((view: AgentChatView) => void) | undefined;
  first.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const refresh = session.refresh();
  const replacement = client();
  replacement.host.conversation!.nativeSessionId = 'different-native';
  registry.forPanel('host', 'panel', replacement);
  const earlyRetry = session.checkDelivery(true);
  expect(replacement.send).not.toHaveBeenCalled();
  expect(session.snapshot().pendingDelivery?.operationId).toBe('op');
  release?.(first.host);
  await Promise.all([refresh, earlyRetry]);
  expect(session.snapshot().view?.conversation?.nativeSessionId).toBe('different-native');
  await session.checkDelivery(true);
  expect(replacement.send).not.toHaveBeenCalled();
  expect(session.snapshot().pendingDelivery?.operationId).toBe('op');
});
