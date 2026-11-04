import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { RemoteDaemonClient } from '@shared/remoteClient';
import { chatTabViewer } from '@shared/chatTabViewer';
import type { ChatTabClient } from '@shared/types/chatTab';

import { useDaemon } from '@/daemon';

import { chatTabClient } from './chatTabClient';

const clients = new WeakMap<RemoteDaemonClient, ChatTabClient>();

function clientFor(client: RemoteDaemonClient): ChatTabClient {
  let chat = clients.get(client);
  if (!chat) { chat = chatTabClient(client); clients.set(client, chat); }
  return chat;
}

/** One chat tab's host state on this phone. Leaving the screen never stops the agent. */
export function useChatTab(panelId: string) {
  const { client, connection } = useDaemon();
  const chat = clientFor(client);
  const viewer = chatTabViewer(chat, panelId);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  // Back from the background: the event stream did not replay, so read the window again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void viewer.refresh(); });
    return () => subscription.remove();
  }, [viewer]);
  return { chat, viewer, snapshot, connected: connection.status === 'connected' };
}
