import { describe, expect, it } from 'vitest';

import { LINK_ACTION_LABELS, linkActions } from './linkActions';

const labels = (url: string, paneId?: string) => linkActions(url, paneId).map(action => LINK_ACTION_LABELS[action]);

describe('linkActions', () => {
  it('offers the desktop popover’s three actions for a web link in a Pane', () => {
    expect(labels('https://example.com/docs', 'pane-1')).toEqual(['Open in Pane', 'Open in browser', 'Copy link']);
    expect(labels('http://localhost:5173/', 'pane-1')).toEqual(['Open in Pane', 'Open in browser', 'Copy link']);
    expect(labels('file:///Users/you/plan.html', 'pane-1')).toEqual(['Open in Pane', 'Open in browser', 'Copy link']);
  });

  it('leaves out Open in Pane outside a Pane', () => {
    expect(labels('https://example.com/docs')).toEqual(['Open in browser', 'Copy link']);
  });

  it('leaves out Open in Pane for a scheme Pane’s browser tab refuses', () => {
    expect(labels('mailto:someone@example.com', 'pane-1')).toEqual(['Open in browser', 'Copy link']);
  });

  it('only copies a relative link', () => {
    expect(labels('./notes.md', 'pane-1')).toEqual(['Copy link']);
  });
});
