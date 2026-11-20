import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGlassesPairingCode, encodeGlassesPairingCode } from '../../shared/types/glasses';
import { voiceStreamUrl } from '../src/voice';

/**
 * The Even app blocks every request whose origin isn't in app.json's network whitelist, and the
 * WebView reports a block only as a network error. Even Hub doesn't document how it matches an
 * entry, so this encodes the assumed rule: the scheme and port must match (no port means 443), and
 * `*.` stands for any subdomain. Real G2 glasses have confirmed it only for `*.ts.net:8443`.
 */
const whitelist: string[] = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
  .permissions.find((permission: { name: string }) => permission.name === 'network').whitelist;

function allowed(address: string): boolean {
  const target = new URL(address);
  return whitelist.some((entry) => {
    const wildcard = entry.includes('*.');
    const rule = new URL(entry.replace('*.', 'wildcard.'));
    const host = wildcard ? rule.hostname.slice('wildcard'.length) : rule.hostname;
    const hostMatches = wildcard ? target.hostname.endsWith(host) : target.hostname === host;
    return rule.protocol === target.protocol && rule.port === target.port && hostMatches;
  });
}

describe('app.json network whitelist', () => {
  // The two address forms the phone app puts in a pairing code (docs/EVEN_G2_GLASSES.md).
  const addresses = ['https://studio.tail1234.ts.net:8443', 'https://k7qd2m4xbn.runpane.net'];

  it.each(addresses)('lets the glasses reach %s and its voice stream', (url) => {
    const code = encodeGlassesPairingCode({ v: 1, expiresAt: '2026-11-16T00:10:00Z', computers: [{ name: 'studio-mac', url, secret: 'pgs_studio' }] });
    expect(decodeGlassesPairingCode(code).computers[0]?.url).toBe(url);
    expect(allowed(`${url}/invoke`)).toBe(true);
    expect(allowed(voiceStreamUrl(url))).toBe(true);
  });

  it('allows nothing else', () => {
    expect(allowed('https://example.com')).toBe(false);
    expect(allowed('https://studio.tail1234.ts.net')).toBe(false);
    expect(allowed('http://k7qd2m4xbn.runpane.net')).toBe(false);
  });
});
