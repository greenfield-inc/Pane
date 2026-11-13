import type { RemoteDaemonClient } from '@shared/remoteClient';
import type { AgentChatReceipt } from '@shared/types/agentChat';
import type { ChatTabClient } from '@shared/types/chatTab';
import { decodeChatAgents, decodeChatConversations, decodeChatMessages, decodeChatReceipt, decodeChatTabEvent, decodeChatTabView } from '@shared/types/chatTabDecoders';

import { invokeChannel } from '@/daemon/invoke';

/**
 * A chat tab on the paired host, over its authenticated HTTP and SSE. The agent
 * runs on that host under its own sign-in; the phone only shows the conversation
 * and sends messages (D-13, D-19).
 */
export function chatTabClient(client: RemoteDaemonClient): ChatTabClient {
  return {
    get: async (panelId, limit) => decodeChatTabView(await invokeChannel(client, 'chat-tab:get', limit === undefined ? [panelId] : [panelId, limit])),
    history: async (panelId, before, limit) => decodeChatMessages(await invokeChannel(client, 'chat-tab:history', [panelId, before, limit])),
    send: async (panelId, request) => {
      const receipt = decodeChatReceipt(await invokeChannel(client, 'chat-tab:send', [panelId, request]));
      if (!receipt) throw new Error('The computer did not confirm the message. Check delivery before sending again.');
      return receipt;
    },
    receipt: async (panelId, operationId): Promise<AgentChatReceipt | undefined> => decodeChatReceipt(await invokeChannel(client, 'chat-tab:receipt', [panelId, operationId])),
    unqueue: (panelId, operationId) => invokeChannel(client, 'chat-tab:unqueue', [panelId, operationId]),
    sendNow: (panelId, operationId) => invokeChannel(client, 'chat-tab:send-now', [panelId, operationId]),
    editQueued: (panelId, operationId, text) => invokeChannel(client, 'chat-tab:edit-queued', [panelId, operationId, text]),
    clear: panelId => invokeChannel(client, 'chat-tab:clear', [panelId]),
    stopTask: (panelId, taskId) => invokeChannel(client, 'chat-tab:stop-task', [panelId, taskId]),
    configure: (panelId, configId, value) => invokeChannel(client, 'chat-tab:configure', [panelId, configId, value]),
    cancel: panelId => invokeChannel(client, 'chat-tab:cancel', [panelId]),
    permission: (panelId, requestId, optionId) => invokeChannel(client, 'chat-tab:permission', [panelId, requestId, optionId]),
    answer: (panelId, questionId, response) => invokeChannel(client, 'chat-tab:answer', [panelId, questionId, response]),
    restart: panelId => invokeChannel(client, 'chat-tab:restart', [panelId]),
    signIn: panelId => invokeChannel(client, 'chat-tab:sign-in', [panelId]),
    conversations: async panelId => decodeChatConversations(await invokeChannel(client, 'chat-tab:conversations', [panelId])),
    resume: (panelId, sessionId) => invokeChannel(client, 'chat-tab:resume', [panelId, sessionId]),
    dismissBanner: panelId => invokeChannel(client, 'chat-tab:dismiss-banner', [panelId]),
    agents: async () => decodeChatAgents(await invokeChannel(client, 'chat-tab:agents', [])),
    onEvent: callback => client.onEvent(event => {
      if (event.type === 'daemon-event' && event.payload.channel === 'chat-tab:event') callback(decodeChatTabEvent(event.payload.args[0]));
    }),
    onState: callback => client.onEvent(event => {
      if (event.type === 'daemon-event' && event.payload.channel === 'chat-tab:state') callback(decodeChatTabView(event.payload.args[0]));
    }),
    // A reconnect (including a return from the background) reloads the newest window, then applies new events.
    onReconnect: callback => client.onStatus(state => { if (state.status === 'connected') callback(); }),
  };
}
