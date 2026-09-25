import { describe, expect, it } from 'vitest';

import { redirectPairingLink } from './deepLink';

const CODE = 'pane-remote://eyJ2IjoxfQ';

describe('redirectPairingLink', () => {
  it('opens the pairing screen with a pane-remote:// code filled in', () => {
    expect(redirectPairingLink(CODE)).toBe(`/pair?code=${encodeURIComponent(CODE)}`);
  });

  it('leaves other links alone', () => {
    expect(redirectPairingLink('/pane/abc')).toBe('/pane/abc');
    expect(redirectPairingLink('pane://settings')).toBe('pane://settings');
  });
});
