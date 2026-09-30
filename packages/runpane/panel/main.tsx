import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { boundary, decodeBoundary } from '../src/boundaryDecoder';
import { callTool, connect, onHostContextChanged, onToolResult, updateModelContext, type HostContext, type ToolResult } from './bridge';
import './panel.css';

const agentSchema = boundary.object({
  paneId: boundary.string,
  panelId: boundary.string,
  name: boundary.string,
  status: boundary.enumeration('working', 'ready', 'blocked', 'idle', 'exited', 'unknown', 'gone'),
  lastLine: boundary.string,
});
const panelDataSchema = boundary.object({ chat: boundary.string, agents: boundary.array(agentSchema) });
const sendOutputSchema = boundary.object({ delivered: boundary.optional(boundary.boolean) });
type Agent = ReturnType<typeof agentSchema.decode>;
type PanelData = ReturnType<typeof panelDataSchema.decode>;

const REFRESH_MS = 4_000;

const STATUS_LABEL = {
  working: 'Working',
  ready: 'Ready',
  blocked: 'Needs input',
  idle: 'Idle',
  exited: 'Exited',
  unknown: 'Running',
  gone: 'Closed',
} satisfies Record<Agent['status'], string>;

/** The panel's data from an agents_panel result, or undefined for any other tool's result. */
function panelData(result: ToolResult): PanelData | undefined {
  try {
    return decodeBoundary(result.structuredContent, panelDataSchema);
  } catch {
    return undefined;
  }
}

function applyHostContext(context: HostContext): void {
  const root = document.documentElement;
  if (context.theme) root.dataset.theme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (value !== null) root.style.setProperty(name, String(value));
  }
}

function errorText(result: ToolResult, fallback: string): string {
  return result.content?.find((block) => block.type === 'text')?.text ?? fallback;
}

/** agents_send reports `delivered: false` when Pane cannot verify the agent took the message. */
function sendFailure(result: ToolResult): string {
  const text = errorText(result, '');
  try {
    if (decodeBoundary(JSON.parse(text), sendOutputSchema).delivered === false) {
      return 'Pane could not confirm delivery. Check the agent in Pane.';
    }
  } catch {
    // Not JSON: Pane refused the message and said why.
  }
  return text || 'Send failed.';
}

function App() {
  const [data, setData] = useState<PanelData>();
  const [connected, setConnected] = useState(false);
  const lastContext = useRef('');

  useEffect(() => {
    onToolResult((result) => {
      const next = panelData(result);
      if (next) setData(next);
    });
    onHostContextChanged(applyHostContext);
    connect().then((context) => {
      applyHostContext(context);
      setConnected(true);
    }, () => setConnected(true));
  }, []);

  const refresh = useCallback(async (chat: string) => {
    const next = panelData(await callTool('agents_panel_status', { chat }));
    if (next) setData(next);
  }, []);

  const chat = data?.chat;
  useEffect(() => {
    if (!chat) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(chat).catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [chat, refresh]);

  useEffect(() => {
    if (!data) return;
    const text = data.agents.length === 0
      ? 'The Pane panel shows no agents for this chat yet.'
      : `The Pane panel shows the agents this chat started:\n${data.agents.map((agent) => `- ${agent.name} (pane ${agent.paneId}): ${STATUS_LABEL[agent.status]}`).join('\n')}`;
    if (text === lastContext.current) return;
    lastContext.current = text;
    void updateModelContext(text).catch(() => undefined);
  }, [data]);

  if (!data) {
    return <main className="panel"><p className="muted">{connected ? 'Loading agents…' : 'Connecting to Pane…'}</p></main>;
  }

  return (
    <main className="panel">
      <header className="panel-header">
        <h1>Chat agents</h1>
        <span className="muted">{data.agents.length === 1 ? '1 agent' : `${data.agents.length} agents`}</span>
      </header>
      {data.agents.length === 0 ? (
        <section className="empty">
          <p>No agents in this chat yet.</p>
          <p className="muted">Ask ChatGPT to start one, for example “Start a Codex agent in my web repo to fix the flaky login test.”</p>
        </section>
      ) : (
        <ul className="agents">
          {[...data.agents].reverse().map((agent) => (
            <AgentRow key={agent.paneId} agent={agent} onSent={() => void refresh(data.chat)} />
          ))}
        </ul>
      )}
    </main>
  );
}

function AgentRow({ agent, onSent }: { agent: Agent; onSent: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'open'>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const live = agent.status !== 'gone' && agent.status !== 'exited';

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setBusy('send');
    setNotice(undefined);
    try {
      const result = await callTool('agents_send', { panel: agent.panelId, text, yes: true });
      if (result.isError || result.structuredContent?.delivered !== true) {
        setNotice({ kind: 'error', text: sendFailure(result) });
      } else {
        setDraft('');
        setNotice({ kind: 'ok', text: 'Sent' });
        onSent();
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Send failed.' });
    } finally {
      setBusy(undefined);
    }
  }

  async function open() {
    setBusy('open');
    setNotice(undefined);
    try {
      const result = await callTool('agents_panel_open', { paneId: agent.paneId, panelId: agent.panelId });
      setNotice(result.isError ? { kind: 'error', text: errorText(result, 'Pane did not open.') } : { kind: 'ok', text: 'Opened in Pane' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Open failed.' });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <li className="agent">
      <div className="agent-top">
        <span className={`status status-${agent.status}`}>
          <span className="dot" aria-hidden="true" />
          {STATUS_LABEL[agent.status]}
        </span>
        <span className="agent-name" title={agent.name}>{agent.name}</span>
        <button type="button" className="secondary" onClick={() => void open()} disabled={busy !== undefined || agent.status === 'gone'}>
          {busy === 'open' ? 'Opening…' : 'Open in Pane'}
        </button>
      </div>
      <p className="screen" title={agent.lastLine}>{agent.lastLine || ' '}</p>
      <form className="send" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={live ? `Message ${agent.name}` : 'This agent has stopped'}
          aria-label={`Message ${agent.name}`}
          disabled={!live || busy !== undefined}
        />
        <button type="submit" disabled={!live || busy !== undefined || draft.trim() === ''}>
          {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
      </form>
      <p className={`notice ${notice?.kind ?? ''}`} role="status">{notice?.text ?? ' '}</p>
    </li>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
