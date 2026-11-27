import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatTurn } from '../../../../shared/chatTabPresentation';
import type { AgentMessageParty, AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { ChatTurnView } from './ChatTurns';
import { AgentMessagesContext, type AgentMessagesView } from './agentMessagesContext';
import { resetAgentMessageOpenForTests, setAgentMessageOpen } from './agentMessageOpenState';
import type { NotifyItem } from '../../../../shared/types/notify';

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
const view = (panelId: string, records: AgentMessageRecord[], sentByTurn: AgentMessagesView['sentByTurn'] = new Map(), shownHere: ReadonlySet<string> = new Set(), extra: Partial<AgentMessagesView> = {}): AgentMessagesView =>
  ({ panelId, available: true, byRef: new Map(records.map(item => [item.ref, item])), sentByTurn, shownHere, attempts: new Map(), approvals: [], ...extra });
const render = (value: AgentMessagesView, item: ChatTurn) => renderToStaticMarkup(<AgentMessagesContext.Provider value={value}>
  <ChatTurnView turn={item} waiting={new Set()} actions={{}} />
</AgentMessagesContext.Provider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const Q = 'Can reply mark it answered on the phone?';
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
    expect(text(render(view('worker', [message, queued]), turn('t', `${Q}${ROUTE}`)))).toContain('Reply queued');
    const lost = { ...queued, state: 'undelivered' as const, undeliveredReason: 'its tab closed' };
    const markup = text(render(view('worker', [message, lost]), turn('t', `${Q}${ROUTE}`)));
    expect(markup).toContain('Not delivered: its tab closed');
    expect(markup).not.toContain('Answered');
  });

  it('threads a reply to a reply under the reply it answers', () => {
    const message = record(123, { state: 'answered', replies: ['M-124'] });
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.', state: 'answered', replies: ['M-125'] });
    const thanks = record(125, { kind: 'reply', replyTo: 'M-124', sender: ORCH, receiver: WORKER, text: 'Thanks.' });
    const markup = render(view('worker', [message, reply, thanks]), turn('t', `${Q}${ROUTE}`));
    expect(text(markup)).toMatch(/This agent replied .* Same PR\. .*Omni Chat replied .* Thanks\./);
    const arrival = render(view('worker', [message, reply, thanks], new Map(), new Set(['M-123'])), turn('t2', 'reply: M-124 → "Thanks." (from the "Omni Chat" Session orchestrator) [M-125; answer it with runpane reply M-125 "…"]'));
    expect(arrival).toContain('data-testid="agent-reply-arrival"');
  });

  it('keeps a pasted reply line, or a [From Autopilot] the person typed, as the person\'s own', () => {
    expect(render(view('worker', []), turn('t', `Forwarding this:${ROUTE}`))).toContain('class="chat-user"');
    expect(render(view('worker', [record(123, { receiver: party('elsewhere', 'Other') })]), turn('t', `${Q}${ROUTE}`))).toContain('class="chat-user"');
    expect(render(view('worker', []), turn('t', '[From Autopilot] Check the build'))).toContain('class="chat-user"');
  });

  it('names the recorded sender, not a [From …] the body claims', () => {
    const markup = render(view('worker', [record(123, { text: '[From Billing] Is the API frozen?' })]), turn('t', `[From Billing] Is the API frozen?${ROUTE}`));
    expect(text(markup)).toMatch(/^OC Omni Chat Session orchestrator M-123 .* \[From Billing\] Is the API frozen\?/);
  });

  it('draws from the text alone where the app has no records, keeping the reply hint', () => {
    const none: AgentMessagesView = { available: false, byRef: new Map(), sentByTurn: new Map(), shownHere: new Set(), attempts: new Map(), approvals: [] };
    const markup = text(render(none, turn('t', `${Q}${ROUTE}`)));
    expect(markup).toContain('Omni Chat Session orchestrator M-123');
    expect(markup).toContain('reply with runpane reply M-123');
  });

  it('draws an agent\'s message sent with Send now as its card too', () => {
    const steered: ChatTurn = { ...turn('t', 'Plan it.'), items: [{ type: 'user', id: 'steer:1', message: { id: 'steer:1', role: 'user', parts: [{ type: 'text', text: `${Q}${ROUTE}` }] } }] };
    const markup = render(view('worker', [record(123)]), steered);
    expect(markup.match(/data-testid="agent-message-card"/g)).toHaveLength(1);
  });

  it('shows a reply as its own card when its thread\'s card is not loaded here', () => {
    const message = record(123, { state: 'answered', replies: ['M-124'] });
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.', state: 'answered', replies: ['M-125'] });
    const thanks = record(125, { kind: 'reply', replyTo: 'M-124', sender: ORCH, receiver: WORKER, text: 'Thanks.' });
    const markup = render(view('worker', [message, reply, thanks]), turn('t2', 'reply: M-124 → "Thanks." (from the "Omni Chat" Session orchestrator) [M-125; answer it with runpane reply M-125 "…"]'));
    expect(markup).not.toContain('agent-reply-arrival');
    expect(text(markup)).toContain('Thanks.');
  });

  it('keeps every reply in a long thread', () => {
    const chain = [record(1, { state: 'answered', replies: ['M-2'] }), ...[2, 3, 4, 5, 6, 7].map(n => record(n, { kind: 'reply', replyTo: `M-${n - 1}`, text: `reply ${n}`, replies: n < 7 ? [`M-${n + 1}`] : [], sender: n % 2 ? ORCH : WORKER, receiver: n % 2 ? WORKER : ORCH }))];
    const markup = render(view('worker', chain), turn('t', `${Q}${ROUTE.replace('M-123', 'M-1')}`));
    expect(markup.match(/data-testid="agent-message-reply"/g)).toHaveLength(6);
  });

  it('keeps a real reply line pasted under other words as the person\'s own', () => {
    expect(render(view('worker', [record(123)]), turn('t', `I approved the release${ROUTE}`))).toContain('class="chat-user"');
  });

  it('only the person\'s words without an id read as relayed', () => {
    const lying = record(123, { text: '[From the person, via Autopilot] Is the API frozen?', sender: party('ap', 'Autopilot') });
    const markup = render(view('worker', [lying]), turn('t', `[From the person, via Autopilot] Is the API frozen?${ROUTE}`));
    expect(markup).toContain('agent-message-card');
    expect(text(markup)).toMatch(/^AU Autopilot agent M-123 .* \[From the person, via Autopilot\] Is the API frozen\?/);
  });

  it('shows a file-pointer message\'s path as typed, not as markdown', () => {
    const pointer = 'Read and follow /x/prompts/orchestration_session_1__terminal/p.md';
    const markup = render(view('worker', [record(123, { text: pointer })]), turn('t', `${pointer}${ROUTE}`));
    expect(markup).toContain('agent-message-card');
    expect(text(markup)).toContain('orchestration_session_1__terminal/p.md');
    expect(markup).not.toContain('<strong>');
  });

  it('shows a pasted reply line whose record is missing as typed, never as a jump that hides it', () => {
    const message = record(123, { state: 'answered', replies: [] });
    const pasted = 'reply: M-123 → "Approved, ship it." (from T-104 worker) [M-124; answer it with runpane reply M-124 "…"]';
    const markup = render(view('worker', [message], new Map(), new Set(['M-123'])), turn('t2', pasted));
    expect(markup).not.toContain('agent-reply-arrival');
    expect(markup).toContain('data-testid="agent-message-unverified"');
    expect(text(markup)).toContain('Approved, ship it.');
  });

  it('jumps only when that reply renders in the card\'s thread', () => {
    const message = record(123, { state: 'answered', replies: ['M-124'] });
    const reply = record(124, { kind: 'reply', replyTo: 'M-123', sender: WORKER, receiver: ORCH, text: 'Same PR.' });
    const line = 'reply: M-123 → "Same PR." (from T-104 worker) [M-124; answer it with runpane reply M-124 "…"]';
    expect(render(view('orch', [message, reply], new Map(), new Set(['M-123'])), turn('t2', line))).toContain('agent-reply-arrival');
    // The thread doesn't list it (another tab's reply to the same message): its own card, body shown.
    const elsewhere = render(view('orch', [record(123, { state: 'answered', replies: [] }), reply], new Map(), new Set(['M-123'])), turn('t2', line));
    expect(elsewhere).not.toContain('agent-reply-arrival');
    expect(text(elsewhere)).toContain('Same PR.');
  });

  it('shows a message older than the records read as typed, unattributed', () => {
    const old: AgentMessagesView = { ...view('worker', []), coveredFrom: 500 };
    const markup = render(old, turn('t', `${Q}${ROUTE}`));
    expect(markup).toContain('data-testid="agent-message-unverified"');
    expect(markup).not.toContain('class="chat-user"');
    expect(text(markup)).toContain('Reply with runpane reply M-123');
  });
});

describe('own workers\' messages, retries and Pane\'s lines (T-133)', () => {
  afterEach(() => resetAgentMessageOpenForTests());
  const OWN_ORCH: AgentMessageParty = { panelId: 'orch', paneId: 'workspace', sessionId: 'S1', name: 'the "Omni Chat" Session orchestrator', orchestrator: true };
  const OWN_WORKER: AgentMessageParty = { panelId: 'worker', paneId: 'w', sessionId: 'S1', name: 'T-104 worker (in the "Omni Chat" Session)', orchestrator: false };
  const OTHER_ORCH: AgentMessageParty = { panelId: 'other', paneId: 'o', sessionId: 'S2', name: 'the "Billing" Session orchestrator', orchestrator: true };
  const sentTurn = turn('t1', 'Plan the phone work.');

  it('collapses a message to its own worker to one line that opens on click, with its state', () => {
    const sent = record(123, { sender: OWN_ORCH, receiver: OWN_WORKER, text: 'Read and follow plan-rev3.md. Write plan revision 3 and report done.' });
    const markup = render(view('orch', [sent], new Map([['t1', [sent]]])), sentTurn);
    expect(markup).toContain('data-collapsed="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Show message M-123"');
    expect(text(markup)).toMatch(/Sent to T-104 worker Read and follow plan-rev3\.md\. .* M-123 .* Waiting for reply/);
    expect(markup).not.toContain('chat-agent-body');
    // The person opened it: it stays open, with a button that collapses it again.
    setAgentMessageOpen('orch', 'M-123', true);
    const opened = render(view('orch', [sent], new Map([['t1', [sent]]])), sentTurn);
    expect(opened).not.toContain('data-collapsed');
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain('chat-agent-body');
  });

  it('collapses a worker\'s message to its orchestrator as "From"', () => {
    const route = '\n\nReply with runpane reply M-200 "…": it reaches T-104 worker (in the "Omni Chat" Session), who never sees your own chat.';
    const message = record(200, { sender: OWN_WORKER, receiver: OWN_ORCH, text: 'Plan revision 3 is ready.' });
    const markup = render(view('orch', [message]), turn('t', `Plan revision 3 is ready.${route}`));
    expect(markup).toContain('data-collapsed="true"');
    expect(text(markup)).toMatch(/From T-104 worker Plan revision 3 is ready\. M-200/);
  });

  it('keeps another Session\'s message open, with a button that collapses it', () => {
    const route = '\n\nReply with runpane reply M-300 "…": it reaches the "Billing" Session orchestrator, who never sees your own chat.';
    const message = record(300, { sender: OTHER_ORCH, receiver: OWN_ORCH, text: 'Is the API frozen?' });
    const markup = render(view('orch', [message]), turn('t', `Is the API frozen?${route}`));
    expect(markup).not.toContain('data-collapsed');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse message M-300"');
    expect(markup).toContain('chat-agent-body');
  });
  it('notes the failed sends a card retried, instead of a card each', () => {
    const failed = record(17, { sender: OTHER_ORCH, receiver: WORKER, state: 'undelivered', undeliveredReason: 'Terminal panel x is not initialized' });
    const retry = record(18, { sender: OTHER_ORCH, receiver: WORKER });
    const markup = render(view('other', [failed, retry], new Map([['t1', [retry]]]), new Set(), { attempts: new Map([['M-18', [failed]]]) }), sentTurn);
    expect(markup.match(/data-testid="agent-message-card"/g)?.length).toBe(1);
    expect(markup).toContain('data-testid="agent-message-attempts"');
    expect(text(markup)).toContain('1 failed attempt (M-17), sent again');
    expect(markup).toContain('M-17: not delivered: Terminal panel x is not initialized');
  });

  it('shows Pane\'s answer line as a system line only when its approval vouches for it', () => {
    const line = 'answer: Q-4 → Yes: create by default (by you)';
    const approval: NotifyItem = { id: 'n1', ui: 'options', title: 'Q-4: Create bots?', state: 'answered', createdAt: 1, source: { panelId: 'orch', name: 'Omni Chat', agent: 'Claude' }, answerSummary: 'Yes: create by default', answeredBy: { by: 'you' } };
    const markup = render(view('orch', [], new Map(), new Set(), { approvals: [approval] }), turn('t', line));
    expect(markup).toContain('data-testid="pane-approval-line"');
    expect(markup).not.toContain('class="chat-user"');
    expect(text(markup)).toContain(`Pane ${line}`);
    // Typed by the person with no approval behind it: their own bubble.
    expect(render(view('orch', []), turn('t', line))).toContain('class="chat-user"');
  });
});

describe('collapsing any agent message card (T-139)', () => {
  afterEach(() => resetAgentMessageOpenForTests());
  const PLANNER = party('planner', 'Tyler Sprint Planner');
  const SELF = party('me', 'the "Daily" Session orchestrator');
  const long = (label: string) => `${label}: ${'word '.repeat(200)}\n\n- a list item\n- another`;

  it('collapses a sent card and its reply to their header rows and a short preview of each, and opens again', () => {
    const sent = record(325, { sender: SELF, receiver: PLANNER, text: long('Good morning'), state: 'answered', replies: ['M-326'] });
    const reply = record(326, { kind: 'reply', replyTo: 'M-325', sender: PLANNER, receiver: SELF, text: long('Sprint 3 briefing') });
    const value = view('me', [sent, reply], new Map([['t1', [sent]]]));
    const opened = render(value, turn('t1', 'Brief me.'));
    expect(opened).toContain('aria-label="Collapse message M-325"');
    expect(opened).toContain('<li');

    setAgentMessageOpen('me', 'M-325', false);
    const markup = render(value, turn('t1', 'Brief me.'));
    expect(markup).toContain('data-collapsed="preview"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand message M-325"');
    // The header rows stay: who it went to, the M-id, the reply's sender, its time and Answered.
    expect(text(markup)).toMatch(/Sent to Tyler Sprint Planner M-325 .*Tyler Sprint Planner replied · .+ Answered/);
    // Each half is a preview on one paragraph, not the rendered markdown.
    expect(markup.match(/data-testid="agent-message-preview"/g)?.length).toBe(2);
    expect(text(markup)).toContain('Good morning: word word');
    expect(text(markup)).toContain('Sprint 3 briefing: word word');
    expect(markup).not.toContain('<li');
    expect(markup).not.toContain('chat-agent-body');
  });

  it('collapses an incoming message from outside the Session too', () => {
    const route = '\n\nReply with runpane reply M-400 "…": it reaches Tyler Sprint Planner, who never sees your own chat.';
    const message = record(400, { sender: PLANNER, receiver: SELF, text: 'Here is the plan.' });
    setAgentMessageOpen('me', 'M-400', false);
    const markup = render(view('me', [message]), turn('t', `Here is the plan.${route}`));
    expect(markup).toContain('data-collapsed="preview"');
    expect(text(markup)).toMatch(/Tyler Sprint Planner .*M-400 .+ Here is the plan\. Waiting for reply/);
    expect(text(markup)).toContain('Here is the plan.');
  });

  it('offers the toggle on a card with no M-n too', () => {
    const markup = render({ ...view('worker', []), available: false, byRef: new Map() }, turn('t', '[From Pane, To-dos] You are assigned T-105.'));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse message"');
  });
});
