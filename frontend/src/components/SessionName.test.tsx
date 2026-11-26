import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionName } from './SessionName';
import { sessionIsUnread } from '../../../shared/sessionUnread';

describe('sessionIsUnread', () => {
  it('is unread only when the host recorded a reply after the last view', () => {
    // Never replied: nothing to read.
    expect(sessionIsUnread({})).toBe(false);
    expect(sessionIsUnread({ readState: { clock: 1, viewed: 1, replied: 0 } })).toBe(false);
    // A reply after the last view, or never viewed.
    expect(sessionIsUnread({ readState: { clock: 3, viewed: 2, replied: 3 } })).toBe(true);
    expect(sessionIsUnread({ readState: { clock: 1, viewed: 0, replied: 1 } })).toBe(true);
    // Viewed after the reply.
    expect(sessionIsUnread({ readState: { clock: 3, viewed: 3, replied: 2 } })).toBe(false);
  });
});

describe('SessionName', () => {
  const spanOf = (html: string) => html.match(/<span[^>]*>/)?.[0] ?? '';

  it('is bold while the Session has an agent message the person has not read', () => {
    const html = renderToStaticMarkup(<SessionName name="Unread work" session={{ readState: { clock: 2, viewed: 1, replied: 2 } }} />);
    expect(spanOf(html)).toContain('font-semibold');
    expect(spanOf(html)).toContain('data-unread="true"');
    expect(html).toContain('Unread work');
  });

  it('is regular weight once read, and for a Session whose agent never replied', () => {
    for (const session of [{ readState: { clock: 2, viewed: 2, replied: 1 } }, {}]) {
      const span = spanOf(renderToStaticMarkup(<SessionName name="Read work" session={session} />));
      expect(span).not.toMatch(/font-(semibold|bold|medium)/);
      expect(span).not.toContain('data-unread');
    }
  });
});
