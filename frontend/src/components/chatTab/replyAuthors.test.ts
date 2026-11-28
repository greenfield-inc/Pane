import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import type { ChatDividerContent } from '../../../../shared/types/chatTab';
import { chatTurns } from '../../../../shared/chatTabPresentation';
import { replyAuthors } from './replyAuthors';

const user = (id: string, text: string): AgentChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const say = (id: string, text: string): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const end = (id: string): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'content', content: { type: 'pane_turn', stopReason: 'end_turn', startedAt: '2026-11-27T10:00:00.000Z', endedAt: '2026-11-27T10:00:05.000Z' } }] });
const divider = (id: string, profiles: Pick<ChatDividerContent, 'profile' | 'previous'>): AgentChatMessage => ({
  id, role: 'assistant', parts: [{ type: 'content', content: { type: 'pane_divider', text: 'Switched', at: '2026-11-27T10:01:00.000Z', ...profiles } }],
});

/** Each reply's author, in order, as `text → ref`; `none` where no photo shows. */
function authors(messages: AgentChatMessage[], current: string | undefined): string[] {
  const turns = chatTurns(messages, { running: false });
  const byTurn = replyAuthors(turns, current);
  return turns.filter(turn => !turn.divider).map(turn => {
    const text = turn.items.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
    return `${text} → ${byTurn.get(turn.id) ?? 'none'}`;
  });
}

describe('replyAuthors (T-63 round 5: each reply keeps the photo of the profile that wrote it)', () => {
  it('gives every reply the current profile when the profile never changed', () => {
    expect(authors([user('u1', 'Hi'), say('a1', 'One.'), end('t1'), user('u2', 'More'), say('a2', 'Two.')], 'greenfield/orchestrator'))
      .toEqual(['One. → greenfield/orchestrator', 'Two. → greenfield/orchestrator']);
  });

  it('keeps replies before a switch on the profile that wrote them, and those after on the new one', () => {
    const messages = [user('u1', 'Hi'), say('a1', 'Before.'), end('t1'), divider('d1', { profile: 'greenfield/business', previous: 'greenfield/orchestrator' }), user('u2', 'Refunds'), say('a2', 'After.')];
    expect(authors(messages, 'greenfield/business')).toEqual(['Before. → greenfield/orchestrator', 'After. → greenfield/business']);
  });

  it('follows several switches, each segment taking the profile its divider names', () => {
    const messages = [
      user('u1', 'a'), say('a1', 'A.'), end('t1'),
      divider('d1', { profile: 'lab/two', previous: 'lab/one' }), user('u2', 'b'), say('a2', 'B.'), end('t2'),
      divider('d2', { profile: 'lab/three', previous: 'lab/two' }), user('u3', 'c'), say('a3', 'C.'),
    ];
    expect(authors(messages, 'lab/three')).toEqual(['A. → lab/one', 'B. → lab/two', 'C. → lab/three']);
  });

  it('shows no photo, rather than a guess, on replies before a divider saved without its profiles', () => {
    const messages = [user('u1', 'Hi'), say('a1', 'Old.'), end('t1'), divider('d1', {}), user('u2', 'Next'), say('a2', 'New.')];
    // After the last divider the tab's own profile is known; before it, nothing says who wrote them.
    expect(authors(messages, 'greenfield/business')).toEqual(['Old. → none', 'New. → greenfield/business']);
  });

  it('without a trusted current profile (restarting, or paged back), replies after the last divider take that divider\'s profile', () => {
    // QA #1789 findings 1 and 2: a restart publishes the new launch before its divider arrives, and an
    // older page stops short of the newest divider; neither may give old replies the live profile.
    const messages = [user('u1', 'Hi'), say('a1', 'Old.'), end('t1'), divider('d1', { profile: 'lab/two', previous: 'lab/one' }), user('u2', 'Next'), say('a2', 'Two.')];
    expect(authors(messages, undefined)).toEqual(['Old. → lab/one', 'Two. → lab/two']);
    expect(authors([user('u1', 'Hi'), say('a1', 'Unknown.')], undefined)).toEqual(['Unknown. → none']);
  });

  it('trusts the last divider over a tab profile that has moved on before the divider arrived', () => {
    // QA #1789 round 2: a Switch publishes the new launch before the replayed transcript (with its divider) arrives.
    const messages = [user('u1', 'Hi'), say('a1', 'Old.'), end('t1'), divider('d1', { profile: 'lab/two', previous: 'lab/one' }), user('u2', 'Next'), say('a2', 'Two.')];
    expect(authors(messages, 'lab/three')).toEqual(['Old. → lab/one', 'Two. → lab/two']);
  });

  it('shows no photo when the tab has no profile to show', () => {
    expect(authors([user('u1', 'Hi'), say('a1', 'One.')], undefined)).toEqual(['One. → none']);
  });
});
