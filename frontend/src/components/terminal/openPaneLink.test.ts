import { describe, expect, it } from 'vitest';
import { parsePaneLink, PANE_LINK_REGEX } from './paneLink';

const paneUrl = 'pane://open?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547&panel=5d7f9f91-8301-4ba9-842c-7dcad54c92f1';

describe('Pane terminal links', () => {
  it('recognizes the CLI link and its pane and panel targets', () => {
    expect(PANE_LINK_REGEX.exec(`Open it: ${paneUrl} (Pane)`)?.[0]).toBe(paneUrl);
    expect(parsePaneLink(paneUrl)).toEqual({
      paneId: 'fd3f9b5a-17ef-4385-917e-e5e8039fb547',
      panelId: '5d7f9f91-8301-4ba9-842c-7dcad54c92f1',
    });
  });

  it('rejects links outside the Pane open route', () => {
    expect(parsePaneLink('pane://delete?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547')).toBeNull();
    expect(parsePaneLink('https://example.com')).toBeNull();
  });
});
