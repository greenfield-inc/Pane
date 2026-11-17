import { describe, expect, it } from 'vitest';

import { pageLoad } from './pages';

describe('what a static page does with a load', () => {
  it('loads the page itself and jumps to its own anchors', () => {
    expect(pageLoad('about:blank', true)).toBe('load');
    expect(pageLoad('about:blank#packages', true)).toBe('load');
  });

  it('opens a tapped web link in the phone browser instead of inside the page', () => {
    expect(pageLoad('https://example.com/plan', true)).toBe('open');
    expect(pageLoad('http://example.com/', true)).toBe('open');
  });

  it('refuses everything else: other schemes, and anything a frame inside the page loads', () => {
    expect(pageLoad('file:///etc/hosts', true)).toBe('refuse');
    expect(pageLoad('pane://open?pane=1', true)).toBe('refuse');
    expect(pageLoad('tel:5551234', true)).toBe('refuse');
    expect(pageLoad('https://example.com/ad', false)).toBe('refuse');
  });
});

