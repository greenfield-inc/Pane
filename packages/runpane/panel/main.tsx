import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { callTool, connect, onHostContextChanged, onToolResult, openLink, updateModelContext, type HostContext } from './bridge';
import * as cards from './directions/cards';
import * as sidebar from './directions/sidebar';
import * as terminal from './directions/terminal';
import type { AgentActions, Notice } from './directions/types';
import { sendFailure, STATUS_WORD, textOf, useCard, usePoll, viewOf, type Agent, type PanelData, type View } from './model';
import './panel.css';

declare const __PANEL_DIRECTION__: string;
const DIRECTIONS = { sidebar, cards, terminal };
const direction = DIRECTIONS[__PANEL_DIRECTION__ === 'cards' || __PANEL_DIRECTION__ === 'terminal' ? __PANEL_DIRECTION__ : 'sidebar'];

const PANEL_REFRESH_MS = 4_000;

function applyHostContext(context: HostContext): void {
  const root = document.documentElement;
  if (context.theme) root.dataset.theme = context.theme;
  if (context.displayMode) root.dataset.mode = context.displayMode;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (value !== null) root.style.setProperty(name, String(value));
  }
}

/** Send, Open in Pane, and Open PR, with a per-agent notice and busy state. */
function useActions(onChanged: () => void): AgentActions {
  const [notices, setNotices] = useState<Record<string, Notice | undefined>>({});
  const [busy, setBusy] = useState<Record<string, 'send' | 'open' | undefined>>({});
  const run = useCallback(async (agent: Agent, kind: 'send' | 'open', work: () => Promise<Notice>) => {
    setBusy((current) => ({ ...current, [agent.paneId]: kind }));
    setNotices((current) => ({ ...current, [agent.paneId]: undefined }));
    let notice: Notice;
    try {
      notice = await work();
    } catch (error) {
      notice = { kind: 'error', text: error instanceof Error ? error.message : 'Pane did not answer.' };
    }
    setNotices((current) => ({ ...current, [agent.paneId]: notice }));
    setBusy((current) => ({ ...current, [agent.paneId]: undefined }));
    return notice.kind === 'ok';
  }, []);
  return useMemo(() => ({
    notices,
    busy,
    send: (agent, text) => run(agent, 'send', async () => {
      const result = await callTool('agents_send', { panel: agent.panelId, text, yes: true });
      if (result.isError || result.structuredContent?.delivered !== true) return { kind: 'error', text: sendFailure(result) };
      onChanged();
      return { kind: 'ok', text: `Sent to ${agent.name}` };
    }),
    open: (agent) => void run(agent, 'open', async () => {
      const result = await callTool('agents_panel_open', { paneId: agent.paneId, panelId: agent.panelId });
      return result.isError ? { kind: 'error', text: textOf(result) || 'Pane did not open.' } : { kind: 'ok', text: 'Opened in Pane' };
    }),
    openPr: (agent) => {
      if (agent.pr?.url) void openLink(agent.pr.url).catch(() => undefined);
    },
  }), [notices, busy, run, onChanged]);
}

function describeAgent(agent: Agent): string {
  const pr = agent.pr ? `, PR #${agent.pr.number} ${agent.pr.state ?? 'open'}` : '';
  const last = agent.screen.at(-1);
  return `${agent.name} (pane ${agent.paneId}${agent.repo ? `, repo ${agent.repo}` : ''}): ${STATUS_WORD[agent.status]}${pr}${last ? `. Last line: ${last}` : ''}`;
}

function PanelView({ initial }: { initial: PanelData }) {
  const [data, setData] = useState(initial);
  const [selected, setSelected] = useState<string | undefined>(initial.focus);
  const appliedFocus = useRef(initial.focus);
  const refresh = useCallback(async () => {
    const view = viewOf(await callTool('agents_panel_status', { chat: data.chat }));
    if (view?.kind === 'panel') setData(view.data);
  }, [data.chat]);
  usePoll(true, PANEL_REFRESH_MS, refresh);
  const onChanged = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  const actions = useActions(onChanged);

  // The model steers the panel with agents_panel_focus; each new choice selects that agent once.
  useEffect(() => {
    if (data.focus && data.focus !== appliedFocus.current) {
      appliedFocus.current = data.focus;
      setSelected(data.focus);
    }
  }, [data.focus]);

  // Tell the model what the user is looking at; the host replaces the previous context each time.
  const lastContext = useRef('');
  useEffect(() => {
    const current = data.agents.find((agent) => agent.paneId === selected) ?? data.agents.at(-1);
    const text = data.agents.length === 0
      ? 'The Pane panel shows no agents for this chat yet.'
      : [
        `The user has the Pane panel open${current ? ` on ${current.name}` : ''}. Agents this chat started:`,
        ...data.agents.map((agent) => `- ${describeAgent(agent)}`),
      ].join('\n');
    if (text === lastContext.current) return;
    lastContext.current = text;
    void updateModelContext(text).catch(() => undefined);
  }, [data, selected]);

  return <direction.Panel data={data} selected={selected} onSelect={setSelected} actions={actions} />;
}

function CardView({ view }: { view: Extract<View, { kind: 'card' | 'cardRef' }> }) {
  const { data, failed, refresh } = useCard(view);
  const onChanged = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  const actions = useActions(onChanged);
  return <div className="inline"><direction.Card data={data} failed={failed} actions={actions} /></div>;
}

function App() {
  const [view, setView] = useState<View>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    onToolResult((result) => {
      const next = viewOf(result);
      if (next) setView(next);
    });
    onHostContextChanged(applyHostContext);
    connect().then((context) => {
      applyHostContext(context);
      setConnected(true);
    }, () => setConnected(true));
  }, []);

  if (!view) {
    return (
      <main className="panel">
        <div className="skeleton" aria-busy="true" aria-label={connected ? 'Loading agents' : 'Connecting to Pane'}>
          <span className="skeleton-line wide" />
          <span className="skeleton-line" />
          <span className="skeleton-block" />
        </div>
      </main>
    );
  }
  return view.kind === 'panel' ? <PanelView initial={view.data} /> : <CardView view={view} />;
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
