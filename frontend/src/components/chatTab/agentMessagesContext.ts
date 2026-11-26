import { createContext, useEffect, useState } from 'react';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';

/** This tab's messages (T-105), sent and received, by ref; and the ones it sent, by the turn that sent them. */
export interface AgentMessagesView {
  panelId?: string;
  byRef: ReadonlyMap<string, AgentMessageRecord>;
  sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>;
}
export const AgentMessagesContext = createContext<AgentMessagesView>({ byRef: new Map(), sentByTurn: new Map() });

/** A tab's message records, read again whenever any message changes. Empty where the app has no records (the phone, a remote PWA). */
export function useAgentMessageRecords(panelId: string): AgentMessageRecord[] {
  const [records, setRecords] = useState<AgentMessageRecord[]>([]);
  useEffect(() => {
    const api = window.electronAPI;
    const forPanel = api?.agentMessages?.forPanel;
    if (!forPanel) return;
    let live = true;
    const load = () => {
      void forPanel(panelId).then(response => {
        if (live && response.success && response.data) setRecords(response.data);
      }, () => undefined);
    };
    load();
    const stop = api.events?.onAgentMessagesChanged?.(load);
    return () => { live = false; stop?.(); };
  }, [panelId]);
  return records;
}

/** Which turn each sent message sits in, as one string: equal while the placement is. */
function placementKey(sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): string {
  return [...sentByTurn].map(([turn, sent]) => `${turn}:${sent.map(record => record.ref).join(',')}`).join(';');
}

/**
 * The view the chat's cards read. It changes only when the records or the placement do, not on
 * every streamed token (turns change with each one), so a turn's cards don't re-render while an agent writes.
 */
export function useAgentMessagesView(panelId: string, records: readonly AgentMessageRecord[], sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): AgentMessagesView {
  const key = placementKey(sentByTurn);
  const build = (): AgentMessagesView => ({ panelId, byRef: new Map(records.map(record => [record.ref, record])), sentByTurn });
  const [held, setHeld] = useState(() => ({ panelId, records, key, view: build() }));
  if (held.panelId === panelId && held.records === records && held.key === key) return held.view;
  // Adjusting state while rendering (react.dev "storing information from previous renders"): the new view is used now.
  const next = { panelId, records, key, view: build() };
  setHeld(next);
  return next.view;
}
