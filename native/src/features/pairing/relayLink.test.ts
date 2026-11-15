import { describe, expect, it } from 'vitest';

import { exchangeRelayPairing, parseRelayPairingLink, RelayPairingError, relayComputerAddress } from '@shared/remoteClient';

import { redirectPairingLink, takePendingPairingCode } from './deepLink';

const QR = 'https://runpane.net/pair#s=Zm9vYmFy-secret_1&c=abcdefghijklmnop&n=Studio%20Mac';

describe('pairing QR links', () => {
  it('reads the secret, computer and name from the QR', () => {
    expect(parseRelayPairingLink(QR)).toEqual({ secret: 'Zm9vYmFy-secret_1', computerId: 'abcdefghijklmnop', name: 'Studio Mac', domain: 'runpane.net' });
  });

  it('takes the domain from any https host, so dev domains work', () => {
    const link = parseRelayPairingLink('https://relay.test:8443/pair#s=x&c=abcdefghijklmnop&n=Box');
    expect(link?.domain).toBe('relay.test:8443');
    expect(link && relayComputerAddress(link)).toBe('https://abcdefghijklmnop.relay.test:8443');
  });

  it('reads the landing page’s pane://pair link, on Pane’s domain unless it names one', () => {
    expect(parseRelayPairingLink('pane://pair#s=x&c=abcdefghijklmnop&n=Box')?.domain).toBe('runpane.net');
    expect(parseRelayPairingLink('pane://pair#s=x&c=abcdefghijklmnop&n=Box&d=relay.test')?.domain).toBe('relay.test');
  });

  it('refuses links that are not a complete pairing', () => {
    expect(parseRelayPairingLink('https://runpane.net/pair')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/pair#c=abcdefghijklmnop')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/pair#s=x&c=../evil')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/other#s=x&c=abcdefghijklmnop')).toBeNull();
    expect(parseRelayPairingLink('http://runpane.net/pair#s=x&c=abcdefghijklmnop')).toBeNull();
    expect(parseRelayPairingLink('pane-remote://eyJ2IjoxfQ')).toBeNull();
  });

  it('opens the pairing screen for a QR link and a pane://pair link, keeping the secret out of the route', () => {
    expect(redirectPairingLink(QR)).toBe('/pair');
    expect(takePendingPairingCode()).toBe(QR);
    expect(redirectPairingLink('pane://pair#s=x&c=abcdefghijklmnop')).toBe('/pair');
    expect(takePendingPairingCode()).toBe('pane://pair#s=x&c=abcdefghijklmnop');
    expect(redirectPairingLink('pane://pane/abc?host=x')).toBe('pane://pane/abc?host=x');
  });
});

describe('the pairing exchange', () => {
  const respond = (status: number, body: unknown) => async () => ({ ok: status < 400, status, body: null, json: async () => body as never });
  const scanned = { computerId: 'abcdefghijklmnop', domain: 'runpane.net', name: 'Studio Mac' };
  const computer = (id: string, address = `https://${id}.runpane.net`, domain = 'runpane.net') => ({ id, name: id, domain, address, local: [], fingerprint: `fp-${id}` });
  const answer = (from: ReturnType<typeof computer>, linked: Array<ReturnType<typeof computer>> = []) =>
    respond(200, { ok: true, token: 'tok', clientId: 'c', computer: from, linked: linked.map(grant => ({ computer: grant, token: `tok-${grant.id}` })) });

  it('saves the scanned computer first, then the computers linked with it', async () => {
    const profiles = await exchangeRelayPairing(answer(computer('abcdefghijklmnop'), [computer('qrstuvwxyzabcdef')]), scanned, { secret: 's', label: 'Phone' });
    expect(profiles.map(p => [p.id, p.baseUrl, p.token])).toEqual([
      ['relay:abcdefghijklmnop', 'https://abcdefghijklmnop.runpane.net', 'tok'],
      ['relay:qrstuvwxyzabcdef', 'https://qrstuvwxyzabcdef.runpane.net', 'tok-qrstuvwxyzabcdef'],
    ]);
  });

  it('refuses an answer from a computer other than the scanned one', async () => {
    const other = exchangeRelayPairing(answer(computer('workmacworkmacwo')), scanned, { secret: 's', label: 'Phone' });
    await expect(other).rejects.toThrow(RelayPairingError);
    const elsewhere = exchangeRelayPairing(answer(computer('abcdefghijklmnop', 'https://abcdefghijklmnop.evil.test', 'evil.test')), scanned, { secret: 's', label: 'Phone' });
    await expect(elsewhere).rejects.toThrow(RelayPairingError);
  });

  it('drops linked computers whose address is not <id>.<scanned domain>', async () => {
    const profiles = await exchangeRelayPairing(answer(computer('abcdefghijklmnop'), [
      computer('qrstuvwxyzabcdef', 'https://qrstuvwxyzabcdef.evil.test', 'evil.test'),
      computer('workmacworkmacwo', 'https://evil.test'),
      computer('buildboxbuildbox'),
    ]), scanned, { secret: 's', label: 'Phone' });
    expect(profiles.map(p => p.baseUrl)).toEqual(['https://abcdefghijklmnop.runpane.net', 'https://buildboxbuildbox.runpane.net']);
  });

  it.each([
    ['ERR_PAIRING_CODE_USED', 410, 'This code was already used', true],
    ['ERR_PAIRING_CODE_EXPIRED', 410, 'This code expired', true],
    ['ERR_PAIRING_LOCKED', 429, 'Pairing is paused', false],
  ])('says %s in plain words', async (code, status, title, scanAgain) => {
    const failure = exchangeRelayPairing(respond(status, { ok: false, error: { code, message: 'x' } }), scanned, { secret: 's', label: 'Phone' });
    await expect(failure).rejects.toMatchObject({ message: title, scanAgain });
  });

  it('says it can’t reach the computer when nothing answers', async () => {
    const offline = async () => { throw new TypeError('Network request failed'); };
    const failure = exchangeRelayPairing(offline, scanned, { secret: 's', label: 'Phone' });
    await expect(failure).rejects.toThrow(RelayPairingError);
    await expect(failure).rejects.toMatchObject({ message: 'Can’t reach Studio Mac' });
  });
});
