import { describe, expect, it } from 'vitest';
import { linkDestination } from './openLink';

describe('linkDestination', () => {
  it('opens a web link from a Pane in a Pane tab by default', () => {
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1' })).toBe('pane');
    expect(linkDestination('http://localhost:5173/', { paneId: 'pane-1', openIn: 'pane' })).toBe('pane');
  });

  it('sends every link to the system browser when Settings > Links says so', () => {
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1', openIn: 'system' })).toBe('system');
  });

  it('sends a link that is not http or https to the system', () => {
    for (const url of ['mailto:team@example.com', 'zoommtg://zoom.us/join?confno=1', 'file:///etc/hosts', 'not a url']) {
      expect(linkDestination(url, { paneId: 'pane-1' })).toBe('system');
    }
  });

  it('sends a link with no Pane, such as one from Pane\'s own menus, to the system browser', () => {
    expect(linkDestination('https://runpane.com/docs', {})).toBe('system');
  });
});
