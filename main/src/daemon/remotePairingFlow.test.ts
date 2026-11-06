import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePaneRemoteConnection,
  remoteImportPayloadToProfile,
  type PaneRemoteConnectionImportPayload,
  type RemoteDaemonConfig,
} from '../../../shared/types/remoteDaemon';
import { claimConnectionCode } from '../../../shared/remoteClient/pairing';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { registerRemoteDaemonHandlers } from '../ipc/remoteDaemon';
import { RemotePaneClient } from './client/remotePaneClient';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { setupRemoteHost } from './setupRemoteHost';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('remote pairing flow', () => {
  it('connects a client from a fresh connection code and runs a command on the host', async () => {
    let writtenRemoteDaemon: RemoteDaemonConfig | undefined;
    const setup = await setupRemoteHost({
      label: 'Office host',
      preferTunnel: 'ssh',
      installService: false,
      autoSelectListenPort: true,
      existingConfig: { anthropicApiKey: undefined },
      writeConfig: async (config) => {
        writtenRemoteDaemon = config.remoteDaemon;
      },
    });
    if (!writtenRemoteDaemon) throw new Error('Expected setup to write the host config');
    const remoteDaemon = writtenRemoteDaemon;

    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1', name: 'Fix remote pane' }]);
    const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon }) });
    await server.start();
    cleanups.push(() => server.stop());

    const client = new RemotePaneClient(
      remoteImportPayloadToProfile(decodePaneRemoteConnection(setup.connectionCode)),
    );
    await client.connect();
    cleanups.push(() => client.disconnect());

    await expect(client.invoke('sessions:get-all', [])).resolves.toEqual([
      { id: 'session-1', name: 'Fix remote pane' },
    ]);
  });
});

describe('named single-use connection codes', () => {
  /** A host reachable over an SSH tunnel, with its config kept in memory as Pane keeps it on disk. */
  async function startHost() {
    let remoteDaemon: RemoteDaemonConfig | undefined;
    await setupRemoteHost({
      label: 'Office host',
      preferTunnel: 'ssh',
      installService: false,
      autoSelectListenPort: true,
      existingConfig: { anthropicApiKey: undefined },
      writeConfig: async (config) => {
        remoteDaemon = config.remoteDaemon;
      },
    });
    const configManager = {
      getConfig: () => ({ remoteDaemon }),
      updateConfig: async (updates: { remoteDaemon?: RemoteDaemonConfig }) => {
        remoteDaemon = updates.remoteDaemon;
        return { remoteDaemon };
      },
    };
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1', name: 'Fix remote pane' }]);
    registerRemoteDaemonHandlers({ handle: () => undefined }, { configManager }, registry);
    const server = new PaneRemoteHttpApiServer(registry, configManager);
    await server.start();
    cleanups.push(() => server.stop());

    const mint = async (person: string) => decodeBoundary(
      await registry.invoke('runpane:host:code', [person]),
      boundary.object({ connectionCode: boundary.string, person: boundary.string, expiresAt: boundary.string }),
    );
    return { server, mint };
  }

  function claim(payload: PaneRemoteConnectionImportPayload, device = 'Ada laptop') {
    return claimConnectionCode(payload, (profile, channel, args) => new RemotePaneClient(profile).invoke(channel, args), device);
  }

  it('works once for the person it names, who then shows as connected', async () => {
    const { server, mint } = await startHost();
    const before = Date.now();
    const minted = await mint('Ada');
    expect(minted.person).toBe('Ada');
    expect(Date.parse(minted.expiresAt) - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(Date.parse(minted.expiresAt) - before).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const code = decodePaneRemoteConnection(minted.connectionCode);

    const claimed = await claim(code);
    expect(claimed.token).not.toBe(code.token);
    expect(claimed.claim).toBeUndefined();

    const client = new RemotePaneClient(remoteImportPayloadToProfile(claimed));
    await client.connect();
    cleanups.push(() => client.disconnect());
    await expect(client.invoke('sessions:get-all', [])).resolves.toEqual([{ id: 'session-1', name: 'Fix remote pane' }]);
    expect(server.getConnectedClients()).toEqual([expect.objectContaining({ person: 'Ada' })]);

    await expect(claim(code, 'Someone else')).rejects.toMatchObject({
      code: 'ERR_REMOTE_DAEMON_CODE_USED',
      message: expect.stringContaining('already used on Ada laptop'),
    });
  });

  it('is not a password: an older Pane that sends the code itself is told to update', async () => {
    const { mint } = await startHost();
    const code = decodePaneRemoteConnection((await mint('Ada')).connectionCode);

    const response = await fetch(new URL('invoke', `${code.baseUrl}/`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${code.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'sessions:get-all', args: [] }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'ERR_REMOTE_DAEMON_CODE_UNCLAIMED', next: expect.stringContaining('Update Pane') },
    });
  });

  it('stops working 15 minutes after it was made', async () => {
    const { mint } = await startHost();
    const code = decodePaneRemoteConnection((await mint('Ada')).connectionCode);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await expect(claim(code)).rejects.toMatchObject({ code: 'ERR_REMOTE_DAEMON_CODE_EXPIRED' });
    } finally {
      vi.useRealTimers();
    }
  });
});
