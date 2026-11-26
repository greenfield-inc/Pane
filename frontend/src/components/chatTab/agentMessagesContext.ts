import { createContext, useEffect, useMemo, useState } from 'react';
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

export function useAgentMessagesView(panelId: string, records: readonly AgentMessageRecord[], sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): AgentMessagesView {
  return useMemo(() => ({ panelId, byRef: new Map(records.map(record => [record.ref, record])), sentByTurn }), [panelId, records, sentByTurn]);
}
