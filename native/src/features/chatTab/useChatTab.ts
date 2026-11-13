import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { RemoteRequestError, type RemoteDaemonClient } from '@shared/remoteClient';
import { olderHostAgents } from '@shared/chatAgentMenu';
import { ChatTabViewerRegistry, type ChatTabViewer } from '@shared/chatTabViewer';
import type { ChatAgentEntry, ChatTabClient } from '@shared/types/chatTab';

import { useDaemon, useDaemonQueryKey } from '@/daemon';

import { chatTabClient } from './chatTabClient';

const clients = new WeakMap<RemoteDaemonClient, ChatTabClient>();
const viewers = new ChatTabViewerRegistry();

function clientFor(client: RemoteDaemonClient): ChatTabClient {
  let chat = clients.get(client);
  if (!chat) { chat = chatTabClient(client); clients.set(client, chat); }
  return chat;
}

/**
 * The viewer for a panel on a saved host. DaemonProvider replaces its client on
 * host A→B→A and on a new URL or token; the viewer, with its draft and unconfirmed
 * send, stays with the host and moves to the new client.
 */
export function chatTabViewerFor(hostId: string, panelId: string, client: RemoteDaemonClient): { chat: ChatTabClient; viewer: ChatTabViewer } {
  const chat = clientFor(client);
  return { chat, viewer: viewers.forPanel(hostId, panelId, chat) };
}

/** One chat tab's host state on this phone. Leaving the screen never stops the agent. */
export function useChatTab(panelId: string) {
  const { client, profile, connection } = useDaemon();
  const { chat, viewer } = chatTabViewerFor(profile.id, panelId, client);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  // Back from the background: the event stream did not replay, so read the window again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void viewer.refresh(); });
    return () => subscription.remove();
  }, [viewer]);
  return { chat, viewer, snapshot, connected: connection.status === 'connected' };
}

/** How long the phone reuses the host's agent catalog; the new-tab sheet reads it again on every open. */
const CHAT_AGENTS_STALE_MS = 5 * 60_000;

/**
 * The agents the host can open as chats (chat-tab:agents); undefined until read once. A host from
 * before the catalog does not know the channel and runs the older-host agents. On any other error
 * the last list stays. `fresh` reads the catalog again on mount, so a newly installed agent shows at once.
 */
export function useChatAgents(fresh = false): ChatAgentEntry[] | undefined {
  const { client } = useDaemon();
  const queryKey = useDaemonQueryKey('chat-tab:agents');
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await clientFor(client).agents();
      } catch (error) {
        if (error instanceof RemoteRequestError && error.code === 'ERR_UNKNOWN_CHANNEL') return olderHostAgents();
        throw error;
      }
    },
    staleTime: CHAT_AGENTS_STALE_MS,
    refetchOnMount: fresh ? 'always' : true,
    retry: false,
  }).data;
}
