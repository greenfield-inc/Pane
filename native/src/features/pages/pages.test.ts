import { describe, expect, it } from 'vitest';

import { pageLoad, withNoNetwork } from './pages';

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

describe('a file page loads nothing from the network', () => {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">';

  it('puts the policy first in the head', () => {
    expect(withNoNetwork('<!doctype html><html><head><title>Plan</title></head><body>x</body></html>'))
      .toBe(`<!doctype html><html><head>${policy}<title>Plan</title></head><body>x</body></html>`);
  });

  it('puts it after the doctype of a page with no head, so the page keeps its standards mode', () => {
    expect(withNoNetwork('<!doctype html><h1>Plan</h1>')).toBe(`<!doctype html>${policy}<h1>Plan</h1>`);
  });

  it('puts it first in a fragment', () => {
    expect(withNoNetwork('<p>Plan</p>')).toBe(`${policy}<p>Plan</p>`);
  });
});
