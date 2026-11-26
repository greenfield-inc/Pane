import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { checkedChatLine, classifyChatLine, shownRefs, type ChatAgentLine, type ChatMessageRecords } from '../../../../shared/agentMessagePresentation';

/** This tab's messages (T-105), sent and received, by ref; and the ones it sent, by the turn that sent them. */
export interface AgentMessagesView extends ChatMessageRecords {
  sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>;
  /** Messages this tab received whose cards are in the loaded chat, so a reply line can point up to them. */
  shownHere: ReadonlySet<string>;
}
export const AgentMessagesContext = createContext<AgentMessagesView>({ available: false, byRef: new Map(), sentByTurn: new Map(), shownHere: new Set() });

/** A tab's message records, read again whenever any message changes. */
export interface PanelMessageRecords {
  /** False until a read succeeds, and always where the app has no records (the phone, a remote PWA). */
  available: boolean;
  records: AgentMessageRecord[];
}
const NONE: PanelMessageRecords = { available: false, records: [] };
/** forPanel's page size, and how far back one read goes (2,000 messages). */
const PAGE = 200;
const MAX_PAGES = 10;

/**
 * Newest first, page by page (`before` the oldest ref so far) until the pages reach `since`, the
 * oldest loaded turn's start, so a chat paged back still finds the messages its turns sent.
 */
export async function readRecords(forPanel: NonNullable<NonNullable<Window['electronAPI']>['agentMessages']>['forPanel'], panelId: string, since: number | undefined): Promise<AgentMessageRecord[] | undefined> {
  const records: AgentMessageRecord[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await forPanel(panelId, before ? { before } : undefined);
    if (!response.success || !response.data) return page === 0 ? undefined : records;
    records.push(...response.data);
    const oldest = response.data.at(-1);
    if (!oldest || response.data.length < PAGE || since === undefined || Date.parse(oldest.createdAt) <= since) break;
    before = oldest.ref;
  }
  return records;
}

/** A tab's message records, read again whenever any message changes, or the chat pages back to older turns (`since`). */
export function useAgentMessageRecords(panelId: string, since?: string): PanelMessageRecords {
  const [state, setState] = useState<PanelMessageRecords & { panelId?: string }>(NONE);
  const sinceAt = since ? Date.parse(since) : undefined;
  useEffect(() => {
    const api = window.electronAPI;
    const forPanel = api?.agentMessages?.forPanel;
    if (!forPanel) return;
    let live = true;
    let latest = 0;
    const load = () => {
      // Reads can overlap when messages change quickly: only the last one started is kept.
      const read = ++latest;
      void readRecords(forPanel, panelId, Number.isNaN(sinceAt) ? undefined : sinceAt).then(records => {
        if (live && read === latest && records) setState({ panelId, available: true, records });
      }, () => undefined);
    };
    load();
    const stop = api.events?.onAgentMessagesChanged?.(load);
    return () => { live = false; stop?.(); };
  }, [panelId, sinceAt]);
  // A new tab starts empty rather than showing the last tab's records while its own load.
  return state.panelId === panelId ? state : NONE;
}

/** Which turn each sent message sits in, as one string: equal while the placement is. */
function placementKey(sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>): string {
  return [...sentByTurn].map(([turn, sent]) => `${turn}:${sent.map(record => record.ref).join(',')}`).join(';');
}

/**
 * The view the chat's cards read. It changes only when the records or the placement do, not on
 * every streamed token (turns change with each one), so a turn's cards don't re-render while an agent writes.
 */
export function useAgentMessagesView(panelId: string, loaded: PanelMessageRecords, sentByTurn: ReadonlyMap<string, AgentMessageRecord[]>, routed: readonly string[]): AgentMessagesView {
  // Each routed text by its length and its end, which holds the reply line's id: cheap to build on every token.
  const key = `${placementKey(sentByTurn)}|${routed.map(text => `${text.length}:${text.slice(-120)}`).join('\u0000')}`;
  const build = (): AgentMessagesView => {
    const records = { panelId, available: loaded.available, byRef: new Map(loaded.records.map(record => [record.ref, record])) };
    return { ...records, sentByTurn, shownHere: shownRefs(routed, records) };
  };
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
