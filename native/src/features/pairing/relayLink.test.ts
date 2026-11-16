import { describe, expect, it } from 'vitest';

import { exchangeRelayPairing, parseRelayPairingLink, RelayPairingError, relayComputerAddress } from '@shared/remoteClient';

import { redirectPairingLink, takePendingPairingCode } from './deepLink';

const QR = 'https://runpane.net/pair#s=Zm9vYmFy-secret_1&c=6cphy4hwgmwpp4nl&n=Studio%20Mac';

/** Real computer ids and their keys' fingerprints: an id is the first 80 bits of its fingerprint, in base32. */
const FINGERPRINTS = {
  '6cphy4hwgmwpp4nl': '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM',
  'kqyutsssbsalgvyf': 'VDFJylIMgLNXBfifCTjEhM6xs4EiuRSX7-xqISiCiWk',
  'jkbgxxed5x35pv6o': 'SoJr3IPt99fXzhVYcdF9L_FH_TlSBJ7Rv-Xy_e5b-1g',
  'q5j35n3lgltya74u': 'h1O-t2sy54B_lBiz16e7PmqNnHCkiRt-_yW5pJDj4C8',
  'dohp3zsqmo4uk2kn': 'G4795lBjuUVpTRcds0IPBq5CcLguVvcUvt3LbgEP4j0',
} as const;

describe('pairing QR links', () => {
  it('reads the secret, computer and name from the QR', () => {
    expect(parseRelayPairingLink(QR)).toEqual({ secret: 'Zm9vYmFy-secret_1', computerId: '6cphy4hwgmwpp4nl', name: 'Studio Mac', domain: 'runpane.net' });
  });

  it('takes the domain from any https host, so dev domains work', () => {
    const link = parseRelayPairingLink('https://relay.test:8443/pair#s=x&c=6cphy4hwgmwpp4nl&n=Box');
    expect(link?.domain).toBe('relay.test:8443');
    expect(link && relayComputerAddress(link)).toBe('https://6cphy4hwgmwpp4nl.relay.test:8443');
  });

  it('reads the landing page’s pane://pair link, on Pane’s domain unless it names one', () => {
    expect(parseRelayPairingLink('pane://pair#s=x&c=6cphy4hwgmwpp4nl&n=Box')?.domain).toBe('runpane.net');
    expect(parseRelayPairingLink('pane://pair#s=x&c=6cphy4hwgmwpp4nl&n=Box&d=relay.test')?.domain).toBe('relay.test');
  });

  it('refuses links that are not a complete pairing', () => {
    expect(parseRelayPairingLink('https://runpane.net/pair')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/pair#c=6cphy4hwgmwpp4nl')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/pair#s=x&c=../evil')).toBeNull();
    expect(parseRelayPairingLink('https://runpane.net/other#s=x&c=6cphy4hwgmwpp4nl')).toBeNull();
    expect(parseRelayPairingLink('http://runpane.net/pair#s=x&c=6cphy4hwgmwpp4nl')).toBeNull();
    expect(parseRelayPairingLink('pane-remote://eyJ2IjoxfQ')).toBeNull();
  });

  it('opens the pairing screen for a QR link and a pane://pair link, keeping the secret out of the route', () => {
    expect(redirectPairingLink(QR)).toBe('/pair');
    expect(takePendingPairingCode()).toBe(QR);
    expect(redirectPairingLink('pane://pair#s=x&c=6cphy4hwgmwpp4nl')).toBe('/pair');
    expect(takePendingPairingCode()).toBe('pane://pair#s=x&c=6cphy4hwgmwpp4nl');
    expect(redirectPairingLink('pane://pane/abc?host=x')).toBe('pane://pane/abc?host=x');
  });
});

describe('the pairing exchange', () => {
  const respond = (status: number, body: unknown) => async () => ({ ok: status < 400, status, body: null, json: async () => body as never });
  const scanned = { computerId: '6cphy4hwgmwpp4nl', domain: 'runpane.net', name: 'Studio Mac' };
  const computer = (id: string, address = `https://${id}.runpane.net`, domain = 'runpane.net') => ({ id, name: id, domain, address, local: [], fingerprint: (id in FINGERPRINTS ? FINGERPRINTS[id as keyof typeof FINGERPRINTS] : `fp-${id}`) });
  const answer = (from: ReturnType<typeof computer>, linked: Array<ReturnType<typeof computer>> = []) =>
    respond(200, { ok: true, token: 'tok', clientId: 'c', computer: from, linked: linked.map(grant => ({ computer: grant, token: `tok-${grant.id}` })) });

  it('saves the scanned computer first, then the computers linked with it', async () => {
    const profiles = await exchangeRelayPairing(answer(computer('6cphy4hwgmwpp4nl'), [computer('kqyutsssbsalgvyf')]), scanned, { secret: 's', label: 'Phone' });
    expect(profiles.map(p => [p.id, p.baseUrl, p.token])).toEqual([
      ['relay:6cphy4hwgmwpp4nl', 'https://6cphy4hwgmwpp4nl.runpane.net', 'tok'],
      ['relay:kqyutsssbsalgvyf', 'https://kqyutsssbsalgvyf.runpane.net', 'tok-kqyutsssbsalgvyf'],
    ]);
  });

  it('refuses an answer from a computer other than the scanned one', async () => {
    const other = exchangeRelayPairing(answer(computer('jkbgxxed5x35pv6o')), scanned, { secret: 's', label: 'Phone' });
    await expect(other).rejects.toThrow(RelayPairingError);
    const elsewhere = exchangeRelayPairing(answer(computer('6cphy4hwgmwpp4nl', 'https://6cphy4hwgmwpp4nl.evil.test', 'evil.test')), scanned, { secret: 's', label: 'Phone' });
    await expect(elsewhere).rejects.toThrow(RelayPairingError);
  });

  it('drops linked computers whose address is not <id>.<scanned domain>', async () => {
    const profiles = await exchangeRelayPairing(answer(computer('6cphy4hwgmwpp4nl'), [
      computer('kqyutsssbsalgvyf', 'https://kqyutsssbsalgvyf.evil.test', 'evil.test'),
      computer('jkbgxxed5x35pv6o', 'https://evil.test'),
      computer('q5j35n3lgltya74u'),
    ]), scanned, { secret: 's', label: 'Phone' });
    expect(profiles.map(p => p.baseUrl)).toEqual(['https://6cphy4hwgmwpp4nl.runpane.net', 'https://q5j35n3lgltya74u.runpane.net']);
  });

  it('refuses an answer naming the scanned computer with a key its id does not name', async () => {
    const swapped = { ...computer('6cphy4hwgmwpp4nl'), fingerprint: FINGERPRINTS.jkbgxxed5x35pv6o };
    await expect(exchangeRelayPairing(answer(swapped), scanned, { secret: 's', label: 'Phone' })).rejects.toThrow(RelayPairingError);
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
