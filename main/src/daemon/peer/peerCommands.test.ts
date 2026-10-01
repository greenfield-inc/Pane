import { describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { PaneCommandRegistry } from '../commandRegistry';
import { registerPeerCommands } from './peerCommands';

function setup() {
  let config: RemoteDaemonConfig = createDefaultRemoteDaemonConfig();
  const registry = new PaneCommandRegistry();
  registerPeerCommands(registry, {
    readRemoteConfig: () => config,
    writeRemoteConfig: async (next) => { config = next; },
    resolveSessionId: async (selector) => {
      if (selector === 'Session B' || selector === 'session-b') return 'session-b';
      throw new Error(`Session ${selector} not found`);
    },
    resolveHostAccess: async () => ({ baseUrl: 'https://rp-bbbb.tail.ts.net', updatedAt: 'now' }),
  });
  return { registry, config: () => config };
}

describe('runpane:peers:* commands', () => {
  it('mints concurrently without losing a record, then allows, lists, denies and revokes', async () => {
    const { registry, config } = setup();
    await Promise.all([
      registry.invoke('runpane:peers:mint', [{ label: 'Session A', sessions: ['Session B'] }]),
      registry.invoke('runpane:peers:mint', [{ label: 'Session C' }]),
    ]);
    expect(config().host.clients.map(client => [client.label, client.scope, client.allowedSessionIds]))
      .toEqual([['Session A', 'peer', ['session-b']], ['Session C', 'peer', []]]);
    expect(config().host.access?.baseUrl).toBe('https://rp-bbbb.tail.ts.net');

    await registry.invoke('runpane:peers:allow', [{ peer: 'Session C', session: 'Session B' }]);
    expect(await registry.invoke('runpane:peers:list', [{ session: 'session-b' }]))
      .toMatchObject({ ok: true, peers: [{ label: 'Session A' }, { label: 'Session C' }] });
    await registry.invoke('runpane:peers:deny', [{ peer: 'Session A', session: 'Session B' }]);
    await registry.invoke('runpane:peers:revoke', [{ peer: 'Session C' }]);
    expect(await registry.invoke('runpane:peers:list', []))
      .toMatchObject({ ok: true, peers: [{ label: 'Session A', allowedSessionIds: [] }] });
  });

  it('takes the positional strings a contract daemonAction sends', async () => {
    const { registry, config } = setup();
    const minted = await registry.invoke('runpane:peers:mint', ['Session A']);
    expect(minted).toMatchObject({ ok: true, peer: { label: 'Session A', allowedSessionIds: [] } });
    expect(await registry.invoke('runpane:peers:allow', ['Session A', 'Session B']))
      .toMatchObject({ ok: true, peer: { allowedSessionIds: ['session-b'] } });
    expect(await registry.invoke('runpane:peers:list', [])).toMatchObject({ ok: true, peers: [{ label: 'Session A' }] });
    await registry.invoke('runpane:peers:revoke', ['Session A']);
    expect(config().host.clients).toEqual([]);
  });

  it('refuses an unknown Session when minting', async () => {
    const { registry, config } = setup();
    await expect(registry.invoke('runpane:peers:mint', [{ label: 'A', sessions: ['nope'] }])).rejects.toThrow(/not found/);
    expect(config().host.clients).toEqual([]);
  });
});
