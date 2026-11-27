import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentMessageParty, AgentMessageRecord } from '../../shared/types/agentMessages';
import { AgentLineView, SentMessageCards } from '../src/components/chatTab/AgentMessageCard';
import { AgentMessagesContext, type AgentMessagesView } from '../src/components/chatTab/agentMessagesContext';
import '../src/index.css';
import '../src/components/agentChat/agentChat.css';
import '../src/components/chatTab/chatTab.css';

// Agent-message cards collapsing (T-139): the real cards, with the records a tab would read.
// ?tab=none renders them with no tab id, as a chat outside a panel does.
const params = new URLSearchParams(location.search);
const panelId = params.get('tab') === 'none' ? undefined : 'daily';

const party = (id: string, name: string): AgentMessageParty => ({ panelId: id, paneId: `${id}-pane`, sessionId: id, name, orchestrator: true });
const DAILY = party('daily', 'the "Daily" Session orchestrator');
const PLANNER = party('planner', 'the "Sprint Planner" Session orchestrator');
const long = (label: string) => `${label}: ${'more words about the sprint '.repeat(40)}`;
const at = '2026-11-27T12:29:00.000Z';
const sent: AgentMessageRecord = {
  ref: 'M-1', number: 1, kind: 'message', replyTo: null, sender: DAILY, receiver: PLANNER, text: long('Good morning'), state: 'answered',
  deliveredVia: null, undeliveredReason: null, replies: ['M-2'], createdAt: at, deliveredAt: at, answeredAt: at,
};
const reply: AgentMessageRecord = { ...sent, ref: 'M-2', number: 2, kind: 'reply', replyTo: 'M-1', sender: PLANNER, receiver: DAILY, text: long('Sprint 3 briefing'), replies: [], state: 'delivered', deliveredVia: 'tab' };

const view: AgentMessagesView = {
  panelId, available: true, byRef: new Map([[sent.ref, sent], [reply.ref, reply]]), sentByTurn: new Map([['t1', [sent]]]),
  shownHere: new Set(), attempts: new Map(), approvals: [],
};
const renderText = (text: string): ReactNode => <div className="chat-markdown"><p>{text}</p></div>;

createRoot(document.getElementById('root')!).render(
  <AgentMessagesContext.Provider value={view}>
    <div className="chat-tab" style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
      <SentMessageCards turnId="t1" renderText={renderText} />
      {/* Filler, so the jump below has to scroll back up to the card. */}
      <div style={{ height: 1600 }} />
      <AgentLineView line={{ type: 'reply', replyTo: 'M-1', ref: 'M-2', body: reply.text, sender: { name: 'the "Sprint Planner" Session orchestrator', kind: '' } }}
        anchorId="arrival" text={reply.text} renderText={renderText} />
      <AgentLineView line={{ type: 'message', sender: { name: 'Pane', kind: 'To-dos', system: 'todos' }, body: long('You are assigned T-139') }}
        anchorId="todos-line" text="You are assigned T-139" renderText={renderText} />
    </div>
  </AgentMessagesContext.Provider>,
);
