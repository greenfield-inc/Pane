import { useEffect } from 'react';
import { create } from 'zustand';
import type { ChatAgentEntry, ChatTabClient } from '../../../shared/types/chatTab';
import { olderHostAgents } from '../../../shared/chatAgentMenu';
import { ipcErrorCode, ipcErrorMessage } from '../utils/ipcErrorMessage';

/** Where the host's agent catalog comes from: desktop's chat-tab IPC, or the PWA's remote adapter. */
export type ChatAgentSource = Pick<ChatTabClient, 'agents'>;

/**
 * The agents the connected host can open as chat tabs (chat-tab:agents); `entries` is undefined
 * until read once. `error` says why the last read failed; `entries` keeps the last list.
 */
interface ChatAgentsState { entries?: ChatAgentEntry[]; error?: string }

export const useChatAgentsStore = create<ChatAgentsState>(() => ({}));

let generation = 0;
let loading = false;

/** Reads the catalog again, such as when the + menu opens; a newer read wins over an older one. */
export async function refreshChatAgents(source: ChatAgentSource): Promise<void> {
  const mine = ++generation;
  loading = true;
  let next: ChatAgentsState;
  try {
    next = { entries: await source.agents(), error: undefined };
  } catch (error) {
    // A host from before the catalog does not know the channel; it runs the older-host agents.
    if (ipcErrorCode(error) === 'ERR_UNKNOWN_CHANNEL') {
      next = { entries: olderHostAgents(), error: undefined };
    } else {
      const message = ipcErrorMessage(error, 'The host did not answer.');
      console.warn(`[ChatTabs] Could not read the host's chat agents: ${message}`);
      next = { error: `Could not read the agents on this machine: ${message}` };
    }
  } finally {
    if (mine === generation) loading = false;
  }
  if (mine === generation) useChatAgentsStore.setState(next);
}

/** The host's catalog, read once when first needed. */
export function useChatAgents(source: ChatAgentSource | undefined): ChatAgentEntry[] | undefined {
  const entries = useChatAgentsStore(state => state.entries);
  useEffect(() => {
    if (source && !useChatAgentsStore.getState().entries && !loading) void refreshChatAgents(source);
  }, [source]);
  return entries;
}
