import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatTabConversation } from '../../../../shared/types/chatTab';
import { canPick, conversationTime, filterConversations, firstPickable, stepPickable } from './pickerRows';
import { ConversationPickerView } from './ConversationPicker';

const now = new Date('2026-11-08T15:00:00');
const rows: ChatTabConversation[] = [
  { sessionId: 'a', title: 'Orchestrate Pane UI/UX improvements', updatedAt: '2026-11-08T14:58:00', current: true },
  { sessionId: 'b', title: 'Review PR #1274', updatedAt: '2026-11-08T14:48:00', openIn: { panelId: 'p2', title: 'Review' } },
  { sessionId: 'c', title: 'Plan the approvals inbox', updatedAt: '2026-11-07T10:00:00' },
  { sessionId: 'd', updatedAt: '2026-11-03T10:00:00' },
];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');
const view = (props: Partial<Parameters<typeof ConversationPickerView>[0]> = {}) => renderToStaticMarkup(<ConversationPickerView rows={rows} filter="" selected={0} busy={false}
  onFilter={() => undefined} onSelect={() => undefined} onOpen={() => undefined} onCancel={() => undefined} onKey={() => undefined} now={now} {...props} />);

describe('the conversation picker (D-277, D-282)', () => {
  it('never picks a conversation open in another tab', () => {
    expect(canPick(rows[1])).toBe(false);
    expect(canPick(rows[0])).toBe(true);
    expect(canPick(rows[2])).toBe(true);
    // Arrow keys skip it both ways.
    expect(stepPickable(rows, 0, 1)).toBe(2);
    expect(stepPickable(rows, 2, -1)).toBe(0);
    expect(firstPickable([rows[1], rows[2]])).toBe(1);
    expect(firstPickable([rows[1]])).toBe(-1);
  });

  it('filters by title, case-insensitively', () => {
    expect(filterConversations(rows, 'APPROVALS').map(row => row.sessionId)).toEqual(['c']);
    expect(filterConversations(rows, '  ')).toEqual(rows);
  });

  it('says when each one changed', () => {
    expect(conversationTime('2026-11-08T14:58:00', now)).toBe('2 min ago');
    expect(conversationTime('2026-11-08T14:59:40', now)).toBe('Just now');
    expect(conversationTime('2026-11-08T11:00:00', now)).toBe('4 h ago');
    expect(conversationTime('2026-11-07T10:00:00', now)).toBe('Yesterday');
    expect(conversationTime('2026-11-03T10:00:00', now)).toBe('Nov 3');
    expect(conversationTime('2025-11-03T10:00:00', now)).toBe('Nov 3, 2025');
    expect(conversationTime(undefined, now)).toBe('');
  });

  it('shows the header, the current one as open here, and others\' tabs as tags it can\'t open', () => {
    const html = view();
    expect(text(html)).toContain('Continue a past conversation');
    expect(text(html)).toContain('Conversations in this folder, newest first. Picking one reloads this chat on it.');
    expect(text(html)).toContain('2 min ago · open here');
    expect(html).toContain('Open in tab “Review”');
    expect(html).toMatch(/aria-disabled="true"[^>]*>[^]*?Review PR #1274/);
    expect(html).toContain('placeholder="Filter by title"');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('>Open<');
  });

  it('has an empty state, a no-match state, and shows a refusal inline', () => {
    expect(text(view({ rows: [] }))).toContain('No past conversations in this folder yet.');
    expect(text(view({ filter: 'zzz' }))).toContain('No conversation matches “zzz”.');
    expect(text(view({ error: 'Claude is in the middle of a turn. Stop it or wait, then pick again.' }))).toContain('Claude is in the middle of a turn. Stop it or wait, then pick again.');
    expect(text(view({ rows: undefined }))).toContain('Loading conversations…');
  });

  it('can\'t Open while the selection is a row open elsewhere', () => {
    expect(view({ selected: 1 })).toMatch(/<button[^>]*disabled=""[^>]*>Open</);
  });
});
