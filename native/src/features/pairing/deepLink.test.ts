import { describe, expect, it } from 'vitest';

import { redirectPairingLink, takePendingPairingCode } from './deepLink';

const CODE = 'pane-remote://eyJ2IjoxfQ';

describe('pairing links', () => {
  it('opens the pairing screen without putting the code in the route', () => {
    expect(redirectPairingLink(CODE)).toBe('/pair');
  });

  it('hands the code to the pairing screen exactly once', () => {
    redirectPairingLink(CODE);
    expect(takePendingPairingCode()).toBe(CODE);
    expect(takePendingPairingCode()).toBeNull();
  });

  it('leaves other links alone', () => {
    expect(redirectPairingLink('/pane/abc')).toBe('/pane/abc');
    expect(redirectPairingLink('pane://settings')).toBe('pane://settings');
    expect(takePendingPairingCode()).toBeNull();
  });
});
