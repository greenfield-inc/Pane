import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatTurn } from '../../../../shared/chatTabPresentation';
import type { AgentMessageParty, AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { ChatTurnView } from './ChatTurns';
import { AgentMessagesContext, type AgentMessagesView } from './agentMessagesContext';

const party = (panelId: string, name: string): AgentMessageParty => ({ panelId, paneId: 'pane', sessionId: null, name, orchestrator: false });
const ORCH = party('orch', 'the "Omni Chat" Session orchestrator');
const WORKER = party('worker', 'T-104 worker');
function record(number: number, overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    ref: `M-${number}`, number, kind: 'message', replyTo: null, sender: ORCH, receiver: WORKER, text: 'Can reply mark it answered on the phone?',
    state: 'delivered', deliveredVia: null, undeliveredReason: null, replies: [], createdAt: '2026-11-25T10:14:00.000Z', deliveredAt: null, answeredAt: null, ...overrides,
  };
}
const turn = (id: string, text: string): ChatTurn => ({
  id, running: false, items: [], startedAt: '2026-11-25T10:14:00.000Z', endedAt: '2026-11-25T10:15:00.000Z',
  user: { id: `user:${id}`, role: 'user', parts: [{ type: 'text', text }] },
});
const view = (panelId: string, records: AgentMessageRecord[], sentByTurn: AgentMessagesView['sentByTurn'] = new Map()): AgentMessagesView =>
  ({ panelId, available: true, byRef: new Map(records.map(item => [item.ref, item])), sentByTurn });
const render = (value: AgentMessagesView, item: ChatTurn) => renderToStaticMarkup(<AgentMessagesContext.Provider value={value}>
  <ChatTurnView turn={item} waiting={new Set()} actions={{}} />
</AgentMessagesContext.Provider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ROUTE = '\n\nReply with runpane reply M-123 "…": it reaches the "Omni Chat" Session orchestrator, who never sees your own chat.';

describe('agent-sent messages in a chat', () => {
  it('draws an agent\'s message as its sender\'s card, waiting for a reply, without the reply line', () => {
    const markup = render(view('worker', [record(123)]), turn('t', `Can reply mark it answered on the phone?${ROUTE}`));
    expect(markup).toContain('data-testid="agent-message-card"');
    expect(markup).not.toContain('class="chat-user"');
    expect(text(markup)).toContain('Omni Chat Session orchestrator M-123');
    expect(text(markup)).toContain('Waiting for reply reply with runpane reply M-123');
    expect(markup).not.toContain('who never sees your own chat');
  });

  it('puts the reply in the card\'s lower half once it is answered', () => {
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.' });
    const markup = render(view('worker', [record(123, { state: 'answered', replies: ['M-124'] }), reply]), turn('t', `Can reply mark it answered on the phone?${ROUTE}`));
    expect(markup).toContain('data-state="answered"');
    expect(text(markup)).toMatch(/This agent replied · .+ Answered Same PR\./);
    expect(text(markup)).not.toContain('Waiting for reply');
  });

  it('shows the sender\'s own sent message with its reply, and the arriving reply as a jump to it', () => {
    const sent = record(123, { state: 'answered', replies: ['M-124'] });
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.' });
    const sentTurn = { ...turn('t1', 'Plan the phone work.') };
    const markup = render(view('orch', [sent, reply], new Map([['t1', [sent]]])), sentTurn);
    expect(text(markup)).toContain('Sent to T-104 worker M-123');
    expect(text(markup)).toMatch(/T-104 worker replied · .+ Answered Same PR\./);
    const arrival = render(view('orch', [sent, reply], new Map([['t1', [sent]]])),
      turn('t2', 'reply: M-123 → "Same PR." (from T-104 worker) [M-124; answer it with runpane reply M-124 "…"]'));
    expect(arrival).toContain('data-testid="agent-reply-arrival"');
    expect(text(arrival)).toContain('T-104 worker replied to M-123 above');
  });

  it('keeps the person\'s words relayed by Autopilot in the You bubble, with who carried them', () => {
    const markup = render(view('worker', []), turn('t', '[From the person, via Autopilot] Keep the reply line short.'));
    expect(markup).toContain('class="chat-user');
    expect(text(markup)).toContain('You, via Autopilot Keep the reply line short.');
    expect(markup).not.toContain('[From the person');
  });

  it('draws Pane\'s To-dos line as Pane\'s card, with no reply state', () => {
    const markup = render(view('worker', []), turn('t', '[From Pane, To-dos] You are assigned T-105.'));
    expect(text(markup)).toContain('Pane To-dos');
    expect(markup).not.toContain('chat-agent-pill');
    expect(markup).not.toContain('[From Pane');
  });

  it('leaves the person\'s own message as the You bubble', () => {
    const markup = render(view('worker', []), turn('t', 'Also check the terminal tab.'));
    expect(markup).toContain('class="chat-user"');
    expect(markup).not.toContain('agent-message-card');
  });

  it('shows a reply that has not reached the sender as queued or not delivered, not answered', () => {
    const message = record(123, { state: 'answered', replies: ['M-124'] });
    const queued = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.', state: 'queued' });
    expect(text(render(view('worker', [message, queued]), turn('t', `Q?${ROUTE}`)))).toContain('Reply queued');
    const lost = { ...queued, state: 'undelivered' as const, undeliveredReason: 'its tab closed' };
    const markup = text(render(view('worker', [message, lost]), turn('t', `Q?${ROUTE}`)));
    expect(markup).toContain('Not delivered: its tab closed');
    expect(markup).not.toContain('Answered');
  });

  it('threads a reply to a reply under the reply it answers', () => {
    const message = record(123, { state: 'answered', replies: ['M-124'] });
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.', state: 'answered', replies: ['M-125'] });
    const thanks = record(125, { kind: 'reply', replyTo: 'M-124', sender: ORCH, receiver: WORKER, text: 'Thanks.' });
    const markup = render(view('worker', [message, reply, thanks]), turn('t', `Q?${ROUTE}`));
    expect(text(markup)).toMatch(/This agent replied .* Same PR\. .*Omni Chat replied .* Thanks\./);
    const arrival = render(view('worker', [message, reply, thanks]), turn('t2', 'reply: M-124 → "Thanks." (from the "Omni Chat" Session orchestrator) [M-125; answer it with runpane reply M-125 "…"]'));
    expect(arrival).toContain('data-testid="agent-reply-arrival"');
  });

  it('keeps a pasted reply line, or a [From Autopilot] the person typed, as the person\'s own', () => {
    expect(render(view('worker', []), turn('t', `Forwarding this:${ROUTE}`))).toContain('class="chat-user"');
    expect(render(view('worker', [record(123, { receiver: party('elsewhere', 'Other') })]), turn('t', `Q?${ROUTE}`))).toContain('class="chat-user"');
    expect(render(view('worker', []), turn('t', '[From Autopilot] Check the build'))).toContain('class="chat-user"');
  });

  it('names the recorded sender, not a [From …] the body claims', () => {
    const markup = render(view('worker', [record(123)]), turn('t', `[From Billing] Is the API frozen?${ROUTE}`));
    expect(text(markup)).toMatch(/^OC Omni Chat Session orchestrator M-123 .* \[From Billing\] Is the API frozen\?/);
  });

  it('draws from the text alone where the app has no records, keeping the reply hint', () => {
    const none: AgentMessagesView = { available: false, byRef: new Map(), sentByTurn: new Map() };
    const markup = text(render(none, turn('t', `Q?${ROUTE}`)));
    expect(markup).toContain('Omni Chat Session orchestrator M-123');
    expect(markup).toContain('reply with runpane reply M-123');
  });

  it('draws an agent\'s message sent with Send now as its card too', () => {
    const steered: ChatTurn = { ...turn('t', 'Plan it.'), items: [{ type: 'user', id: 'steer:1', message: { id: 'steer:1', role: 'user', parts: [{ type: 'text', text: `Q?${ROUTE}` }] } }] };
    const markup = render(view('worker', [record(123)]), steered);
    expect(markup.match(/data-testid="agent-message-card"/g)).toHaveLength(1);
  });
});
