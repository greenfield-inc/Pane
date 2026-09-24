import { afterEach, describe, expect, it } from 'vitest';
import {
  decodePaneRemoteConnection,
  remoteImportPayloadToProfile,
  type RemoteDaemonConfig,
} from '../../../shared/types/remoteDaemon';
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
