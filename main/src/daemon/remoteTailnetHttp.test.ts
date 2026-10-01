import { describe, expect, it } from 'vitest';
import { decodePaneRemoteConnection, encodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';

function code(baseUrl: string): string {
  return encodePaneRemoteConnection({ v: 1, label: 'Cloud', baseUrl, token: 'token-value', transport: 'http+sse' });
}

describe('plain HTTP connection codes over the tailnet', () => {
  it('accepts http to a MagicDNS name or a Tailscale address (WireGuard already encrypts it)', () => {
    // A cloud Session whose Serve has no TLS certificate (Let's Encrypt limit) serves TCP on 42137.
    for (const baseUrl of [
      'http://rp-a1b2c3d4.tailnet-example.ts.net:42137',
      'http://100.64.0.10:42137',
      'http://[fd7a:115c:a1e0::10]:42137',
    ]) {
      expect(decodePaneRemoteConnection(code(baseUrl)).baseUrl).toBe(baseUrl);
    }
  });

  it('still refuses http to anything else', () => {
    for (const baseUrl of ['http://192.168.1.50:42137', 'http://example.com:42137', 'http://100.128.0.1:42137', 'http://ts.net.example.com']) {
      expect(() => decodePaneRemoteConnection(code(baseUrl))).toThrow(/HTTP remote base URLs must use a loopback or Tailscale host/);
    }
  });
});
