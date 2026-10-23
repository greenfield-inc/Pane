import { useEffect, useSyncExternalStore } from 'react';

import type { RemoteDaemonClient } from '@shared/remoteClient';
import type { AgentChatPermission, AgentChatReceipt, AgentChatSend, AgentInterface } from '@shared/types/agentChat';
import { decodeAgentChatEvent, decodeAgentChatView } from '@shared/types/agentChatDecoders';

import { invokeChannel, useDaemon, useDaemonEvent } from '@/daemon';

import { ChatSessionRegistry } from './chatSessionRegistry';

const sessions = new ChatSessionRegistry<RemoteDaemonClient>(client => ({
  get: async id => decodeAgentChatView(await invokeChannel(client, 'agent-chat:get', [id])),
  send: (id, request) => invokeChannel<AgentChatReceipt>(client, 'agent-chat:send', [id, request]),
  receipt: (id, operationId) => invokeChannel<AgentChatReceipt | undefined>(client, 'agent-chat:receipt', [id, operationId]),
}));

/** Host-owned Chat commands and projection; no local model or transcript replay. */
export function useAgentChat(panelId: string) {
  const { client, connection, profile } = useDaemon();
  const session = sessions.forPanel(profile.id, panelId, client);
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);

  useDaemonEvent('agent-chat:event', event => {
    try { session.receiveEvent(decodeAgentChatEvent(event.args[0])); }
    catch (error) { session.setError(error instanceof Error ? error.message : String(error)); }
  });
  useDaemonEvent('agent-chat:state', event => {
    try { session.receiveState(decodeAgentChatView(event.args[0])); }
    catch (error) { session.setError(error instanceof Error ? error.message : String(error)); }
  });
  useEffect(() => {
    if (connection.status === 'connected') void session.refresh();
  }, [session, client, connection.status]);

  const connected = connection.status === 'connected';
  const generation = snapshot.view?.conversation?.generation ?? 0;
  const perform = async (channel: string, args: unknown[]): Promise<void> => {
    if (!connected) { session.setError('The host is disconnected. Reconnect before changing this conversation.'); return; }
    let failure: string | undefined;
    try {
      await invokeChannel(client, channel, args);
      session.setError(undefined);
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    // A lost response may still have changed the host. Refetch, never replay.
    await session.refresh();
    if (failure) session.setError(failure);
  };

  return {
    ...snapshot, connected,
    readingPosition: session.readingPosition,
    saveReadingPosition: (offset: number, atBottom: boolean) => { session.readingPosition = { offset, atBottom }; },
    refresh: () => session.refresh(),
    send: (request: AgentChatSend, confirmed?: () => void) => {
      if (!connected) { session.setError('The host is disconnected. Reconnect before sending.'); return Promise.resolve(undefined); }
      return session.send(request, confirmed);
    },
    checkDelivery: (retry: boolean) => session.checkDelivery(retry),
    setError: (error?: string) => session.setError(error),
    setAttachment: (image?: NonNullable<AgentChatSend['images']>[number]) => session.setAttachment(image),
    setup: () => perform('agent-chat:setup', []),
    identify: (nativeId: string, socketPath: string) => perform('agent-chat:identify', [panelId, nativeId, socketPath]),
    switch: (mode: AgentInterface) => perform('agent-chat:switch', [panelId, mode, generation]),
    recover: () => perform('agent-chat:recover', [panelId, 'terminal', generation]),
    cancel: () => perform('agent-chat:cancel', [panelId, generation]),
    configure: (id: string, value: string) => perform('agent-chat:configure', [panelId, generation, id, value]),
    permission: (permission: AgentChatPermission, optionId: string) => perform('agent-chat:permission', [panelId, permission.generation, permission.id, optionId]),
  };
}
