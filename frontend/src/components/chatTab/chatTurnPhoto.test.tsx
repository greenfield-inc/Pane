import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import { chatTurns } from '../../../../shared/chatTabPresentation';
import { ChatTurnView } from './ChatTurns';
import type { ChatPhoto } from './chatRendering';

const user = (id: string, text: string): AgentChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const say = (id: string, text: string): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const divider: AgentChatMessage = { id: 'divider:1', role: 'assistant', parts: [{ type: 'content', content: { type: 'pane_divider', text: 'Switched to Business · conversation kept', at: '2026-11-27T10:00:00.000Z', profile: 'greenfield/business', previous: 'greenfield/orchestrator' } }] };
const photo: ChatPhoto = { current: 'greenfield/business', avatar: (ref, size) => <i data-photo={ref} data-size={size} />, heading: null };
const none = new Set<string>();

describe('the agent photo in chat turns (T-63 round 5)', () => {
  it('puts the author\'s 28 px photo beside a reply', () => {
    const [turn] = chatTurns([user('u1', 'Hi'), say('a1', 'Hello.')], { running: false });
    const html = renderToStaticMarkup(<ChatTurnView turn={turn} waiting={none} actions={{}} photo={photo} author="greenfield/orchestrator" />);
    expect(html).toContain('class="chat-reply-photo"');
    expect(html).toContain('data-photo="greenfield/orchestrator" data-size="28"');
  });

  it('shows the new profile\'s photo on the divider', () => {
    const [line] = chatTurns([divider], { running: false });
    const html = renderToStaticMarkup(<ChatTurnView turn={line} waiting={none} actions={{}} photo={photo} />);
    expect(html).toContain('data-photo="greenfield/business" data-size="16"');
    expect(html).toContain('Switched to Business · conversation kept');
  });

  it('draws no photo without one, as with Profiles off', () => {
    const turns = chatTurns([user('u1', 'Hi'), say('a1', 'Hello.'), divider], { running: false });
    const html = turns.map(turn => renderToStaticMarkup(<ChatTurnView turn={turn} waiting={none} actions={{}} author="greenfield/orchestrator" />)).join('');
    expect(html).not.toContain('chat-reply-photo');
    expect(html).not.toContain('data-photo');
  });

  it('draws no photo beside a reply nothing names', () => {
    const [turn] = chatTurns([user('u1', 'Hi'), say('a1', 'Hello.')], { running: false });
    expect(renderToStaticMarkup(<ChatTurnView turn={turn} waiting={none} actions={{}} photo={photo} />)).not.toContain('chat-reply-photo');
  });
});
