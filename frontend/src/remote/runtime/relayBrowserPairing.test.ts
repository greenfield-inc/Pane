import { describe, expect, it, vi } from 'vitest';

import { pairingErrorText, pairThisBrowser, takePairingSecret, type PairingPage } from './relayBrowserPairing';

function page(hash: string): PairingPage & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    location: { origin: 'https://6cphy4hwgmwpp4nl.runpane.net', pathname: '/app/', search: '', hash },
    history: { replaceState: (...args: Parameters<History['replaceState']>) => { replaced.push(String(args[2])); } },
  };
}

/** Real computer ids and their keys' fingerprints: an id is the first 80 bits of its fingerprint, in base32. */
const FINGERPRINTS = {
  '6cphy4hwgmwpp4nl': '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM',
  kqyutsssbsalgvyf: 'VDFJylIMgLNXBfifCTjEhM6xs4EiuRSX7-xqISiCiWk',
  jkbgxxed5x35pv6o: 'SoJr3IPt99fXzhVYcdF9L_FH_TlSBJ7Rv-Xy_e5b-1g',
} as const;

const computer = (id: keyof typeof FINGERPRINTS, name: string, fingerprint: string = FINGERPRINTS[id]) => ({
  id, name, domain: 'runpane.net', address: `https://${id}.runpane.net`, local: ['https://192-168-1-5.local.runpane.net'], fingerprint,
});

describe('pairing the browser app from "Continue in browser"', () => {
  it('takes the secret from #pair= and clears it from the address bar', () => {
    const opened = page('#pair=s3cret');
    expect(takePairingSecret(opened)).toBe('s3cret');
    expect(opened.replaced).toEqual(['/app/']);
  });

  it('leaves an ordinary visit alone', () => {
    const opened = page('');
    expect(takePairingSecret(opened)).toBeNull();
    expect(opened.replaced).toEqual([]);
  });

  it('trades the secret at the same origin and saves the computer and the ones linked with it', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        ok: true,
        token: 'tok-studio',
        clientId: 'client-1',
        computer: computer('6cphy4hwgmwpp4nl', 'Studio Mac'),
        linked: [{ computer: computer('kqyutsssbsalgvyf', 'Build Box'), token: 'tok-build' }],
      }),
    }));

    const profiles = await pairThisBrowser(page(''), 's3cret', { fetch, label: 'Pane PWA on iPhone', phoneId: 'runtime-1' });

    expect(fetch).toHaveBeenCalledWith('https://6cphy4hwgmwpp4nl.runpane.net/pair/exchange', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ secret: 's3cret', label: 'Pane PWA on iPhone', phoneId: 'runtime-1', capabilities: ['relay-receive-only-v1'] }),
    }));
    expect(profiles).toEqual([
      {
        id: 'relay:6cphy4hwgmwpp4nl', label: 'Studio Mac', baseUrl: 'https://6cphy4hwgmwpp4nl.runpane.net', token: 'tok-studio', transport: 'http+sse',
        relay: { computerId: '6cphy4hwgmwpp4nl', fingerprint: '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM', domain: 'runpane.net', local: ['https://192-168-1-5.local.runpane.net'] },
      },
      {
        id: 'relay:kqyutsssbsalgvyf', label: 'Build Box', baseUrl: 'https://kqyutsssbsalgvyf.runpane.net', token: 'tok-build', transport: 'http+sse',
        relay: { computerId: 'kqyutsssbsalgvyf', fingerprint: 'VDFJylIMgLNXBfifCTjEhM6xs4EiuRSX7-xqISiCiWk', domain: 'runpane.net', local: ['https://192-168-1-5.local.runpane.net'], linkedBy: 'Studio Mac' },
      },
    ]);
  });

  it('refuses an answer from a computer other than the one that served the page', async () => {
    const fetch = async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ ok: true, token: 'tok', clientId: 'c', computer: computer('jkbgxxed5x35pv6o', 'Work Mac'), linked: [] }),
    });
    await expect(pairThisBrowser(page(''), 's3cret', { fetch, label: 'x', phoneId: 'y' })).rejects.toThrow('This code didn’t work');
  });

  it('refuses an answer that names the right computer with a key other than the one its id names, and drops such linked computers', async () => {
    const answer = (scanned: ReturnType<typeof computer>, linked: Array<ReturnType<typeof computer>>) => async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ ok: true, token: 'tok', clientId: 'c', computer: scanned, linked: linked.map((grant) => ({ computer: grant, token: 'tok-linked' })) }),
    });
    const swappedKey = computer('6cphy4hwgmwpp4nl', 'Studio Mac', FINGERPRINTS.jkbgxxed5x35pv6o);
    await expect(pairThisBrowser(page(''), 's3cret', { fetch: answer(swappedKey, []), label: 'x', phoneId: 'y' })).rejects.toThrow('This code didn’t work');

    const profiles = await pairThisBrowser(page(''), 's3cret', {
      fetch: answer(computer('6cphy4hwgmwpp4nl', 'Studio Mac'), [computer('kqyutsssbsalgvyf', 'Build Box', FINGERPRINTS.jkbgxxed5x35pv6o)]), label: 'x', phoneId: 'y',
    });
    expect(profiles.map((profile) => profile.label)).toEqual(['Studio Mac']);
  });

  it('says a used code was already used', async () => {
    const fetch = async () => ({ ok: false, status: 410, body: null, json: async () => ({ ok: false, error: { code: 'ERR_PAIRING_CODE_USED', message: 'used' } }) });
    await expect(pairThisBrowser(page(''), 's3cret', { fetch, label: 'x', phoneId: 'y' }))
      .rejects.toSatisfy((error: Error) => pairingErrorText(error).startsWith('This code was already used. Each code pairs one phone.'));
  });
});
