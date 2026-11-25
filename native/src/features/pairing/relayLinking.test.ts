import { describe, expect, it } from 'vitest';

import { fetchNewRelayProfiles, linkRelayComputers, relayProfile, RemoteRequestError, type RelayLinkPeer } from '@shared/remoteClient';
import { readOnlyToken } from '@shared/types/accessLevel';
import type { RelayComputer } from '@shared/types/relay';

/** Real computer ids and their keys' fingerprints: an id is the first 80 bits of its fingerprint, in base32. */
const FINGERPRINTS = {
  '6cphy4hwgmwpp4nl': '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM',
  'kqyutsssbsalgvyf': 'VDFJylIMgLNXBfifCTjEhM6xs4EiuRSX7-xqISiCiWk',
  'jkbgxxed5x35pv6o': 'SoJr3IPt99fXzhVYcdF9L_FH_TlSBJ7Rv-Xy_e5b-1g',
  'q5j35n3lgltya74u': 'h1O-t2sy54B_lBiz16e7PmqNnHCkiRt-_yW5pJDj4C8',
  'dohp3zsqmo4uk2kn': 'G4795lBjuUVpTRcds0IPBq5CcLguVvcUvt3LbgEP4j0',
} as const;

function computer(id: string): RelayComputer {
  return { id, name: id, domain: 'runpane.net', address: `https://${id}.runpane.net`, local: [], fingerprint: (id in FINGERPRINTS ? FINGERPRINTS[id as keyof typeof FINGERPRINTS] : `fp-${id}`) };
}

/** A computer that mints `<self>-for-<peer>` tokens and records the links it saves. */
function fakeComputer(id: string, { offline = false, linkedWith = [] as string[] } = {}) {
  const saved: Array<{ peer: string; token: string }> = [];
  const peer: RelayLinkPeer = {
    computer: computer(id),
    client: {
      async invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
        if (offline) throw new TypeError('Network request failed');
        const [arg] = args as [{ peer: RelayComputer; token?: string }];
        if (channel === 'relay:client:mint-link' && linkedWith.includes(arg.peer.id)) throw new RemoteRequestError(`${arg.peer.id} is already linked`, 409, 'ERR_RELAY_ALREADY_LINKED');
        if (channel === 'relay:client:mint-link') return { token: `${id}-for-${arg.peer.id}` } as T;
        if (channel === 'relay:client:save-link') { saved.push({ peer: arg.peer.id, token: arg.token ?? '' }); return null as T; }
        throw new Error(`unexpected ${channel}`);
      },
    },
  };
  return { peer, saved };
}

describe('linking a newly paired computer with the phone’s others', () => {
  it('gives each side a token minted by the other', async () => {
    const added = fakeComputer('new');
    const a = fakeComputer('a');
    const b = fakeComputer('b');

    expect(await linkRelayComputers(added.peer, [a.peer, b.peer])).toEqual([]);

    expect(added.saved).toEqual(expect.arrayContaining([{ peer: 'a', token: 'a-for-new' }, { peer: 'b', token: 'b-for-new' }]));
    expect(a.saved).toEqual([{ peer: 'new', token: 'new-for-a' }]);
    expect(b.saved).toEqual([{ peer: 'new', token: 'new-for-b' }]);
  });

  it('links the computers that answer and reports the one that is off', async () => {
    const added = fakeComputer('new');
    const a = fakeComputer('a');
    const asleep = fakeComputer('asleep', { offline: true });

    expect(await linkRelayComputers(added.peer, [asleep.peer, a.peer])).toEqual(['asleep']);
    expect(a.saved).toEqual([{ peer: 'new', token: 'new-for-a' }]);
    expect(added.saved).toEqual([{ peer: 'a', token: 'a-for-new' }]);
  });

  it('leaves a pair that is already linked as it is, and counts it as linked', async () => {
    const added = fakeComputer('new', { linkedWith: ['a'] });
    const a = fakeComputer('a', { linkedWith: ['new'] });

    expect(await linkRelayComputers(added.peer, [a.peer])).toEqual([]);
    expect(added.saved).toEqual([]);
    expect(a.saved).toEqual([]);
  });

  it('never links a computer with itself', async () => {
    const added = fakeComputer('new');
    expect(await linkRelayComputers(added.peer, [fakeComputer('new').peer])).toEqual([]);
    expect(added.saved).toEqual([]);
  });
});

describe('"Your computers"', () => {
  it('tells a computer it only watches nothing of the others it reaches, but the ones that computer shared', async () => {
    const tyler = relayProfile({ computer: { ...computer('tyler'), name: 'Tyler' }, token: readOnlyToken('t') });
    const saved = [
      tyler,
      relayProfile({ computer: computer('tyler2'), token: readOnlyToken('t2') }, 'Tyler'),
      relayProfile({ computer: computer('mine'), token: 't' }),
      // A computer of this phone's own that happens to be linked by the same name.
      relayProfile({ computer: computer('mine2'), token: 't' }, 'Tyler'),
    ];
    const asked: unknown[] = [];
    const client = { invoke: async <T>(_channel: string, args?: unknown[]) => { asked.push(args?.[0]); return [] as T; } };
    await fetchNewRelayProfiles(client, tyler, saved);
    await fetchNewRelayProfiles(client, { ...tyler, token: 'full' }, saved);
    expect(asked).toEqual([{ known: ['tyler2'] }, { known: ['mine', 'mine2'] }]);
  });

  it('adds only computers at <id>.<domain> on the asking computer’s domain, with the key their id names', async () => {
    const from = relayProfile({ computer: computer('dohp3zsqmo4uk2kn'), token: 'tok-studio' });
    const grants = [
      { computer: computer('q5j35n3lgltya74u'), token: 'tok-build' },
      { computer: { ...computer('kqyutsssbsalgvyf'), fingerprint: FINGERPRINTS.jkbgxxed5x35pv6o }, token: 'swapped key' },
      { computer: { ...computer('evil'), domain: 'evil.test', address: 'https://evil.evil.test' }, token: 'x' },
      { computer: { ...computer('spoof'), address: 'https://evil.test' }, token: 'y' },
    ];
    const client = { invoke: async <T>() => grants as T };
    const added = await fetchNewRelayProfiles(client, from, [from]);
    expect(added.map(p => p.baseUrl)).toEqual(['https://q5j35n3lgltya74u.runpane.net']);
  });
});
