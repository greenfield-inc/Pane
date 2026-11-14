import { describe, expect, it, vi } from 'vitest';

import { pairingErrorText, pairThisBrowser, takePairingSecret, type PairingPage } from './relayBrowserPairing';

function page(hash: string): PairingPage & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    location: { origin: 'https://abcdefghijklmnop.runpane.net', pathname: '/app/', search: '', hash },
    history: { replaceState: (...args: Parameters<History['replaceState']>) => { replaced.push(String(args[2])); } },
  };
}

const computer = (id: string, name: string) => ({
  id, name, domain: 'runpane.net', address: `https://${id}.runpane.net`, local: ['https://192-168-1-5.local.runpane.net'], fingerprint: `fp-${id}`,
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
        computer: computer('abcdefghijklmnop', 'Studio Mac'),
        linked: [{ computer: computer('qrstuvwxyzabcdef', 'Build Box'), token: 'tok-build' }],
      }),
    }));

    const profiles = await pairThisBrowser(page(''), 's3cret', { fetch, label: 'Pane PWA on iPhone', phoneId: 'runtime-1' });

    expect(fetch).toHaveBeenCalledWith('https://abcdefghijklmnop.runpane.net/pair/exchange', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ secret: 's3cret', label: 'Pane PWA on iPhone', phoneId: 'runtime-1' }),
    }));
    expect(profiles).toEqual([
      {
        id: 'relay:abcdefghijklmnop', label: 'Studio Mac', baseUrl: 'https://abcdefghijklmnop.runpane.net', token: 'tok-studio', transport: 'http+sse',
        relay: { computerId: 'abcdefghijklmnop', fingerprint: 'fp-abcdefghijklmnop', domain: 'runpane.net', local: ['https://192-168-1-5.local.runpane.net'] },
      },
      {
        id: 'relay:qrstuvwxyzabcdef', label: 'Build Box', baseUrl: 'https://qrstuvwxyzabcdef.runpane.net', token: 'tok-build', transport: 'http+sse',
        relay: { computerId: 'qrstuvwxyzabcdef', fingerprint: 'fp-qrstuvwxyzabcdef', domain: 'runpane.net', local: ['https://192-168-1-5.local.runpane.net'], linkedBy: 'Studio Mac' },
      },
    ]);
  });

  it('says a used code was already used', async () => {
    const fetch = async () => ({ ok: false, status: 410, body: null, json: async () => ({ ok: false, error: { code: 'ERR_PAIRING_CODE_USED', message: 'used' } }) });
    await expect(pairThisBrowser(page(''), 's3cret', { fetch, label: 'x', phoneId: 'y' }))
      .rejects.toSatisfy((error: Error) => pairingErrorText(error).startsWith('This code was already used. Each code pairs one phone.'));
  });
});
