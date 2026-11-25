import { beforeEach, describe, expect, it } from 'vitest';

import type { RemoteDaemonTransport } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { isReadOnlyProfile, useAccessStore, withAccessNoted } from './access';

const tyler: RemotePaneConnectionProfile = { id: 'relay:tyler', label: 'Tyler', baseUrl: 'https://tyler.runpane.net', token: 'read-token', transport: 'http+sse', access: 'read' };
const mine: RemotePaneConnectionProfile = { ...tyler, id: 'relay:mine', access: undefined };

/** One connect to a computer whose ready event carries `data`. */
async function connect(profile: RemotePaneConnectionProfile, data: string): Promise<boolean[]> {
  const transport: RemoteDaemonTransport = {
    invokeRequest: () => ({ headers: {}, body: '' }),
    openEventStream: async context => context.onEvent({ event: 'ready', data }),
  };
  const whenClientSawReady: boolean[] = [];
  await withAccessNoted(profile, transport).openEventStream({
    baseUrl: profile.baseUrl, token: profile.token, runtimeId: 'r', clientLabel: 'Pane', signal: new AbortController().signal,
    onOpen: () => undefined,
    onEvent: () => whenClientSawReady.push(isReadOnlyProfile(profile)),
  });
  return whenClientSawReady;
}

beforeEach(() => useAccessStore.setState({ levels: {} }));

describe('a computer’s access level', () => {
  it('comes from its pairing until it answers', () => {
    expect(isReadOnlyProfile(tyler)).toBe(true);
    expect(isReadOnlyProfile(mine)).toBe(false);
  });

  it('is what the ready event says, known before the client restores', async () => {
    expect(await connect(mine, '{"access":"read"}')).toEqual([true]);
  });

  it('is full again on a connect whose ready event names no level', async () => {
    await connect(mine, '{"access":"read"}');
    expect(await connect(mine, '{"deduplicatesRequestIds":true}')).toEqual([false]);
    expect(await connect(tyler, '{}')).toEqual([false]);
  });

  it('starts over when the computer is paired again', async () => {
    await connect(tyler, '{"access":"read"}');
    expect(isReadOnlyProfile({ ...tyler, token: 'full-token', access: undefined })).toBe(false);
  });
});
