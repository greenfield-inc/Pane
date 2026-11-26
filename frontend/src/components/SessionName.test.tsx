import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionName } from './SessionName';
import { sessionIsUnread } from '../utils/sessionUnread';

describe('sessionIsUnread', () => {
  it('is unread only when the agent replied after the person last opened the Session', () => {
    // Never replied: nothing to read, however long ago it was opened.
    expect(sessionIsUnread({})).toBe(false);
    expect(sessionIsUnread({ openedAt: '2026-11-26T09:00:00.000Z' })).toBe(false);
    // Replied and never opened.
    expect(sessionIsUnread({ agentRepliedAt: '2026-11-26T09:00:00.000Z' })).toBe(true);
    // Replied after the last open.
    expect(sessionIsUnread({ agentRepliedAt: '2026-11-26T09:05:00.000Z', openedAt: '2026-11-26T09:00:00.000Z' })).toBe(true);
    // Opened after the reply.
    expect(sessionIsUnread({ agentRepliedAt: '2026-11-26T09:00:00.000Z', openedAt: '2026-11-26T09:05:00.000Z' })).toBe(false);
  });

  it('reads a reply in the same second as the open as read: the host stores opens to the second', () => {
    expect(sessionIsUnread({ agentRepliedAt: '2026-11-26T09:00:00.600Z', openedAt: '2026-11-26T09:00:00.000Z' })).toBe(false);
    expect(sessionIsUnread({ agentRepliedAt: '2026-11-26T09:00:01.100Z', openedAt: '2026-11-26T09:00:00.000Z' })).toBe(true);
  });

  it('ignores a time it cannot read rather than bolding forever', () => {
    expect(sessionIsUnread({ agentRepliedAt: 'not a time', openedAt: '2026-11-26T09:00:00.000Z' })).toBe(false);
  });
});

describe('SessionName', () => {
  const spanOf = (html: string) => html.match(/<span[^>]*>/)?.[0] ?? '';

  it('is bold while the Session has an agent message the person has not read', () => {
    const html = renderToStaticMarkup(<SessionName name="Unread work" session={{ agentRepliedAt: '2026-11-26T09:05:00.000Z', openedAt: '2026-11-26T09:00:00.000Z' }} />);
    expect(spanOf(html)).toContain('font-semibold');
    expect(spanOf(html)).toContain('data-unread="true"');
    expect(html).toContain('Unread work');
  });

  it('is regular weight once read, and for a Session whose agent never replied', () => {
    for (const session of [{ agentRepliedAt: '2026-11-26T09:00:00.000Z', openedAt: '2026-11-26T09:05:00.000Z' }, {}]) {
      const span = spanOf(renderToStaticMarkup(<SessionName name="Read work" session={session} />));
      expect(span).not.toMatch(/font-(semibold|bold|medium)/);
      expect(span).not.toContain('data-unread');
    }
  });
});
