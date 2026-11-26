import { describe, expect, it } from 'vitest';
import { classifyChatLine, messageStatus, senderInitials, senderOfName, sentMessagesByTurn } from '../../../../shared/agentMessagePresentation';
import type { AgentMessageParty, AgentMessageRecord } from '../../../../shared/types/agentMessages';

const route = (ref: string, name: string) => `\n\nReply with runpane reply ${ref} "…": it reaches ${name}, who never sees your own chat.`;

const party = (panelId: string, name: string): AgentMessageParty => ({ panelId, paneId: 'pane', sessionId: null, name, orchestrator: false });
function record(number: number, overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    ref: `M-${number}`, number, kind: 'message', replyTo: null, sender: party('sender', 'the "Omni Chat" Session orchestrator'),
    receiver: party('receiver', 'T-104 worker'), text: 'Is the API frozen?', state: 'delivered', deliveredVia: null,
    undeliveredReason: null, replies: [], createdAt: '2026-11-25T10:00:00.000Z', deliveredAt: null, answeredAt: null, ...overrides,
  };
}

describe('classifyChatLine', () => {
  it('keeps the person\'s own message as theirs', () => {
    expect(classifyChatLine('Also check how a reply looks in a terminal tab.')).toBeUndefined();
    expect(classifyChatLine('[From a brain-dump to Sessions] notes')).toBeUndefined();
  });

  it('reads an agent\'s message by its reply line, without showing that line', () => {
    expect(classifyChatLine(`Is the contract change on main?${route('M-12', 'the "Omni Chat" Session orchestrator')}`)).toEqual({
      type: 'message', ref: 'M-12', body: 'Is the contract change on main?', sender: { name: 'Omni Chat', kind: 'Session orchestrator' },
    });
  });

  it('names a Pane in a Session and a plain Pane', () => {
    expect(classifyChatLine(`Done.${route('M-3', 'Billing worker (in the "Omni Chat" Session)')}`)).toMatchObject({ sender: { name: 'Billing worker', kind: 'in Omni Chat' } });
    expect(classifyChatLine(`Done.${route('M-4', 'agent-reply')}`)).toMatchObject({ sender: { name: 'agent-reply', kind: 'agent' } });
  });

  it('reads Pane\'s To-dos lines as Pane\'s, with no id', () => {
    expect(classifyChatLine('[From Pane, To-dos] You are assigned T-105 "Mock-ups".')).toEqual({
      type: 'message', ref: undefined, body: 'You are assigned T-105 "Mock-ups".', sender: { name: 'Pane', kind: 'To-dos', system: 'todos' },
    });
    expect(classifyChatLine('[From Billing orchestrator, via To-dos T-1] Looks good.')).toMatchObject({ type: 'message', sender: { name: 'Billing orchestrator', kind: 'via To-dos T-1' } });
    expect(classifyChatLine('[From To-dos T-4, asked by its orchestrator] Which branch?\nReply with runpane todos comment T-4 "…".'))
      .toMatchObject({ type: 'message', sender: { name: 'To-dos T-4', system: 'todos' }, body: 'Which branch?\nReply with runpane todos comment T-4 "…".' });
  });

  it('reads Autopilot\'s own lines as Autopilot\'s, keeping their id', () => {
    expect(classifyChatLine(`[From Autopilot] Still working on T-104?${route('M-9', 'Autopilot')}`)).toEqual({
      type: 'message', ref: 'M-9', body: 'Still working on T-104?', sender: { name: 'Autopilot', kind: '', system: 'autopilot' },
    });
  });

  it('keeps the person\'s relayed words as theirs, saying who carried them', () => {
    expect(classifyChatLine('[From the person, via Autopilot] Keep the reply line short.')).toEqual({ type: 'relayed', via: 'Autopilot', body: 'Keep the reply line short.', ref: undefined });
    expect(classifyChatLine('[From the person, via To-dos T-2]\nShip it.')).toEqual({ type: 'relayed', via: 'To-dos T-2', body: 'Ship it.', ref: undefined });
    expect(classifyChatLine(`[From the person, via Autopilot] Short.${route('M-5', 'Autopilot')}`)).toMatchObject({ type: 'relayed', ref: 'M-5', body: 'Short.' });
  });

  it('reads a reply arriving at the sender', () => {
    const text = 'reply: M-12 → "Same PR. "Quoted" words stay." (from the "Billing" Session orchestrator) [M-13; answer it with runpane reply M-13 "…"]';
    expect(classifyChatLine(text)).toEqual({ type: 'reply', replyTo: 'M-12', ref: 'M-13', body: 'Same PR. "Quoted" words stay.', sender: { name: 'Billing', kind: 'Session orchestrator' } });
  });

  it('leaves a message that only quotes a reply line alone', () => {
    expect(classifyChatLine('Why did I get reply: M-12 → "x" in my tab?')).toBeUndefined();
  });
});

describe('senders', () => {
  it('gives two-letter initials', () => {
    expect(senderInitials('Omni Chat')).toBe('OC');
    expect(senderInitials('T-104 worker')).toBe('TW');
    expect(senderInitials('Billing')).toBe('BI');
    expect(senderInitials('')).toBe('·');
  });
  it('calls a reply typed outside any tab the person\'s', () => {
    expect(senderOfName('the person')).toEqual({ name: 'You', kind: '' });
  });
});

describe('messageStatus', () => {
  it('is waiting until a reply comes, then answered with it', () => {
    const reply = record(13, { kind: 'reply', replyTo: 'M-12', state: 'delivered' });
    expect(messageStatus(record(12), new Map())).toEqual({ state: 'waiting' });
    expect(messageStatus(record(12, { state: 'answered', replies: ['M-13'] }), new Map([['M-13', reply]]))).toEqual({ state: 'answered', replies: [reply] });
    expect(messageStatus(record(12, { state: 'undelivered', undeliveredReason: 'its tab closed' }), new Map())).toEqual({ state: 'undelivered', reason: 'its tab closed' });
  });
});

describe('sentMessagesByTurn', () => {
  const turns = [
    { id: 't1', startedAt: '2026-11-25T10:00:00.000Z', endedAt: '2026-11-25T10:05:00.000Z' },
    { id: 't2', startedAt: '2026-11-25T10:06:00.000Z', endedAt: '2026-11-25T10:09:00.000Z' },
    { id: 't3' },
  ];
  it('puts each message this tab sent in the turn that sent it', () => {
    const placed = sentMessagesByTurn(turns, [
      record(1, { sender: party('me', 'x'), createdAt: '2026-11-25T10:02:00.000Z' }),
      record(2, { sender: party('me', 'x'), createdAt: '2026-11-25T10:07:00.000Z' }),
      record(3, { sender: party('me', 'x'), createdAt: '2026-11-25T10:10:00.000Z' }),
      record(4, { sender: party('other', 'x'), createdAt: '2026-11-25T10:02:00.000Z' }),
      record(5, { sender: party('me', 'x'), kind: 'reply', replyTo: 'M-1', createdAt: '2026-11-25T10:02:00.000Z' }),
      record(6, { sender: party('me', 'x'), createdAt: '2026-11-25T09:00:00.000Z' }),
    ], 'me');
    expect([...placed].map(([turn, sent]) => [turn, sent.map(item => item.ref)])).toEqual([['t1', ['M-1']], ['t2', ['M-2']], ['t3', ['M-3']]]);
  });
});
