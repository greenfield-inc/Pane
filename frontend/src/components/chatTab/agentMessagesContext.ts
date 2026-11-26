import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { checkedChatLine, classifyChatLine, type ChatAgentLine, type ChatMessageRecords } from '../../../../shared/agentMessagePresentation';

/** This tab's messages (T-105), sent and received, by ref; and the ones it sent, by the turn that sent them. */
export interface AgentMessagesView extends ChatMessageRecords {
  sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>;
}
export const AgentMessagesContext = createContext<AgentMessagesView>({ available: false, byRef: new Map(), sentByTurn: new Map() });

/** A tab's message records, read again whenever any message changes. */
export interface PanelMessageRecords {
  /** False until a read succeeds, and always where the app has no records (the phone, a remote PWA). */
  available: boolean;
  records: AgentMessageRecord[];
}
const NONE: PanelMessageRecords = { available: false, records: [] };

export function useAgentMessageRecords(panelId: string): PanelMessageRecords {
  const [state, setState] = useState<PanelMessageRecords>(NONE);
  useEffect(() => {
    setState(NONE);
    const api = window.electronAPI;
    const forPanel = api?.agentMessages?.forPanel;
    if (!forPanel) return;
    let live = true;
    const load = () => {
      void forPanel(panelId).then(response => {
        if (live && response.success && response.data) setState({ available: true, records: response.data });
      }, () => undefined);
    };
    load();
    const stop = api.events?.onAgentMessagesChanged?.(load);
    return () => { live = false; stop?.(); };
  }, [panelId]);
  return state;
}

/** Which turn each sent message sits in, as one string: equal while the placement is. */
function placementKey(sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): string {
  return [...sentByTurn].map(([turn, sent]) => `${turn}:${sent.map(record => record.ref).join(',')}`).join(';');
}

/**
 * The view the chat's cards read. It changes only when the records or the placement do, not on
 * every streamed token (turns change with each one), so a turn's cards don't re-render while an agent writes.
 */
export function useAgentMessagesView(panelId: string, loaded: PanelMessageRecords, sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): AgentMessagesView {
  const key = placementKey(sentByTurn);
  const build = (): AgentMessagesView => ({ panelId, available: loaded.available, byRef: new Map(loaded.records.map(record => [record.ref, record])), sentByTurn });
  const [held, setHeld] = useState(() => ({ panelId, loaded, key, view: build() }));
  if (held.panelId === panelId && held.loaded === loaded && held.key === key) return held.view;
  // Adjusting state while rendering (react.dev "storing information from previous renders"): the new view is used now.
  const next = { panelId, loaded, key, view: build() };
  setHeld(next);
  return next.view;
}

/** How a message typed into this tab reads: an agent's, Pane's, a reply, the person's relayed words, or (undefined) the person's own. */
export function useChatLine(text: string): ChatAgentLine | undefined {
  const records = useContext(AgentMessagesContext);
  return useMemo(() => checkedChatLine(classifyChatLine(text), records), [text, records]);
}
