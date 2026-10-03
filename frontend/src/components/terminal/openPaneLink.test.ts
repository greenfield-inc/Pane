import { describe, expect, it } from 'vitest';
import { parsePaneLink, PANE_LINK_REGEX } from './paneLink';

const paneUrl = 'pane://open?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547&panel=5d7f9f91-8301-4ba9-842c-7dcad54c92f1';

describe('Pane terminal links', () => {
  it('recognizes CLI link targets in terminal output', () => {
    expect(`Open: ${paneUrl} (Pane)`.match(PANE_LINK_REGEX)?.[0]).toBe(paneUrl);
    expect(parsePaneLink(paneUrl)).toBe(true);
    expect(parsePaneLink('pane://open?repo=42')).toBe(true);
    expect(parsePaneLink('pane://open?session=my-session')).toBe(true);
  });

  it('rejects invalid navigation links', () => {
    expect(parsePaneLink('pane://delete?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547')).toBe(false);
    expect(parsePaneLink('pane://open?repo=42&pane=abc')).toBe(false);
    expect(parsePaneLink('pane://open?pane=abc&archive=1')).toBe(false);
    expect(parsePaneLink('https://example.com')).toBe(false);
  });
});
