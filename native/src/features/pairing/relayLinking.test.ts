import { describe, expect, it } from 'vitest';

import { linkRelayComputers, type RelayLinkPeer } from '@shared/remoteClient';
import type { RelayComputer } from '@shared/types/relay';

function computer(id: string): RelayComputer {
  return { id, name: id, domain: 'runpane.net', address: `https://${id}.runpane.net`, local: [], fingerprint: `fp-${id}` };
}

/** A computer that mints `<self>-for-<peer>` tokens and records the links it saves. */
function fakeComputer(id: string, { offline = false } = {}) {
  const saved: Array<{ peer: string; token: string }> = [];
  const peer: RelayLinkPeer = {
    computer: computer(id),
    client: {
      async invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
        if (offline) throw new TypeError('Network request failed');
        const [arg] = args as [{ peer: RelayComputer; token?: string }];
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

  it('never links a computer with itself', async () => {
    const added = fakeComputer('new');
    expect(await linkRelayComputers(added.peer, [fakeComputer('new').peer])).toEqual([]);
    expect(added.saved).toEqual([]);
  });
});
