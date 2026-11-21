import { afterEach, describe, expect, it } from 'vitest';
import { setPairingAnalytics, trackCertificateIssued, trackPairingCompleted } from './pairingAnalytics';

function recording(): Array<[string, object | undefined]> {
  const sent: Array<[string, object | undefined]> = [];
  setPairingAnalytics({ track: (name, properties) => { sent.push([name, properties]); } });
  return sent;
}

afterEach(() => setPairingAnalytics(null));

describe('pairing analytics', () => {
  it('reports a pairing with only the device kind and route', () => {
    const sent = recording();
    trackPairingCompleted('glasses', 'tailscale');
    expect(sent).toEqual([['pairing_completed', { device: 'glasses', route: 'tailscale' }]]);
  });

  it('names the CA by the issuer organization and sends nothing for any other CA', () => {
    const sent = recording();
    trackCertificateIssued("Let's Encrypt", false);
    trackCertificateIssued('Google Trust Services', true);
    trackCertificateIssued('Pebble Intermediate CA 5a1b0c', false);
    expect(sent).toEqual([
      ['certificate_issued', { ca: 'letsencrypt', renewal: false }],
      ['certificate_issued', { ca: 'google', renewal: true }],
    ]);
  });
});
