import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import { chatTurnEndedWithText } from './sessionReply';

const user = (text: string): AgentChatMessage => ({ id: `u-${text}`, role: 'user', parts: [{ type: 'text', text }] });
const assistant = (id: string, parts: AgentChatMessage['parts']): AgentChatMessage => ({ id, role: 'assistant', parts });
const tool = { type: 'tool' as const, id: 't1', title: 'Bash', status: 'completed' as const };

describe('chatTurnEndedWithText', () => {
  it('is true when a turn a Pane line started ends with text the person can read', () => {
    expect(chatTurnEndedWithText([
      user('Ship it'),
      assistant('a1', [{ type: 'text', text: 'On it.' }]),
      user('[From Pane, Workers] T-12 reported ready'),
      assistant('a2', [tool, { type: 'text', text: 'T-12 is ready: PR 88 is green.' }]),
    ])).toBe(true);
  });

  it('is false for a turn of tool calls or thinking only, even after an earlier reply', () => {
    expect(chatTurnEndedWithText([
      user('Ship it'),
      assistant('a1', [{ type: 'text', text: 'On it.' }]),
      user('[From Pane, Watch] 2 events'),
      assistant('a2', [{ type: 'thought', text: 'Nothing new.' }, tool]),
    ])).toBe(false);
  });

  it('is false for an empty reply, and for a turn that wrote nothing at all', () => {
    expect(chatTurnEndedWithText([user('[From Pane, Watch] wake'), assistant('a1', [{ type: 'text', text: '  \n' }])])).toBe(false);
    expect(chatTurnEndedWithText([assistant('a0', [{ type: 'text', text: 'Earlier' }]), user('[From Pane, Watch] wake')])).toBe(false);
    expect(chatTurnEndedWithText([])).toBe(false);
  });
});
