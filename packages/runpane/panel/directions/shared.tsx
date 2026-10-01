import { ArrowUpRight, GitPullRequest } from 'lucide-react';
import { useState } from 'react';
import { isLive, type Agent } from '../model';
import { Button } from '../primitives';
import type { AgentActions } from './types';

/** Open in Pane, plus Open PR when the branch has one: at most two actions, per the inline-card rules. */
export function AgentButtons({ agent, actions, primaryOpen = true }: { agent: Agent; actions: AgentActions; primaryOpen?: boolean }) {
  const busy = actions.busy[agent.paneId];
  return (
    <div className="actions">
      <Button primary={primaryOpen} onClick={() => actions.open(agent)} disabled={busy !== undefined || agent.status === 'gone'}>
        <ArrowUpRight className="icon" aria-hidden="true" />
        {busy === 'open' ? 'Opening…' : 'Open in Pane'}
      </Button>
      {agent.pr?.url && (
        <Button onClick={() => actions.openPr(agent)}>
          <GitPullRequest className="icon" aria-hidden="true" />
          PR #{agent.pr.number}
        </Button>
      )}
    </div>
  );
}

export function NoticeLine({ agent, actions }: { agent: Agent; actions: AgentActions }) {
  const notice = actions.notices[agent.paneId];
  return <p className={`notice ${notice?.kind ?? ''}`} role="status">{notice?.text ?? ' '}</p>;
}

/** A message box for one agent. Sending is a human click; the agent gets the text as typed. */
export function Composer({ agent, actions, prompt = false }: { agent: Agent; actions: AgentActions; prompt?: boolean }) {
  const [draft, setDraft] = useState('');
  const live = agent.status !== 'gone' && agent.status !== 'exited';
  const busy = actions.busy[agent.paneId] !== undefined;
  const placeholder = !live ? 'This agent has stopped' : agent.status === 'blocked' ? `Answer ${agent.name}` : `Message ${agent.name}`;
  return (
    <form
      className={prompt ? 'composer composer-prompt' : 'composer'}
      onSubmit={(event) => {
        event.preventDefault();
        const text = draft.trim();
        if (text) void actions.send(agent, text).then((sent) => { if (sent) setDraft(''); });
      }}
    >
      {prompt && <span className="prompt-mark" aria-hidden="true">›</span>}
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder} aria-label={placeholder} disabled={!live || busy} />
      <Button primary submit disabled={!live || busy || draft.trim() === ''} label={`Send to ${agent.name}`}>
        {actions.busy[agent.paneId] === 'send' ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}

export function EmptyPanel() {
  return (
    <section className="empty">
      <p className="empty-title">No agents in this chat yet.</p>
      <p className="faint">Ask ChatGPT to start one: “Start a Codex agent in web to fix the flaky login test.”</p>
    </section>
  );
}

export function ErrorBanner({ text }: { text: string }) {
  return <p className="error-banner" role="alert">{text}</p>;
}

export function liveCount(agents: Agent[]): string {
  const live = agents.filter((agent) => isLive(agent.status) && agent.status !== 'unknown').length;
  const blocked = agents.filter((agent) => agent.status === 'blocked').length;
  const parts = [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`];
  if (blocked > 0) parts.push(`${blocked} need${blocked === 1 ? 's' : ''} you`);
  else if (live > 0) parts.push(`${live} working`);
  return parts.join(' · ');
}
