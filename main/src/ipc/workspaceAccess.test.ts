import { describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { WorkspaceProbe } from '../services/tailnetMachines';
import { registerWorkspaceAccessHandlers } from './workspaceAccess';

type Handler = (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>;

const status = {
  BackendState: 'Running',
  MagicDNSSuffix: 'tail1.ts.net',
  CurrentTailnet: { Name: 'example.org' },
  Self: { DNSName: 'devbox.tail1.ts.net.', UserID: 1, OS: 'windows', Online: true },
  Peer: { a: { DNSName: 'my-mac.tail1.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.2'] } },
  User: { 1: { LoginName: 'me@example.org' } },
};

interface TestConfig {
  remoteDaemon?: RemoteDaemonConfig;
}

function setup() {
  const handlers = new Map<string, Handler>();
  let config: TestConfig = { remoteDaemon: createDefaultRemoteDaemonConfig() };
  const secretsSeen: Array<string | undefined> = [];
  const probe: WorkspaceProbe = async (_machine, secret) => {
    secretsSeen.push(secret);
    return secret === 'correct horse'
      ? { kind: 'described', description: { machineName: 'my-mac', visibility: 'owner', passwordProtected: true, paneVersion: '2.5.0' } }
      : { kind: 'password-required' };
  };
  registerWorkspaceAccessHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    {
      configManager: {
        getConfig: () => config,
        updateConfig: async (updates) => {
          config = { ...config, ...updates };
          return config;
        },
      },
    },
    { invoke: async () => null },
    { readStatus: async () => JSON.stringify(status), probe },
  );
  const call = (channel: string, ...args: PaneCommandValue[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender: {} }, ...args);
  };
  return { call, config: () => config, secretsSeen };
}

describe('codeless machine connections', () => {
  it('saves a machine with its password and uses that password when listing it again', async () => {
    const { call, config, secretsSeen } = setup();
    await expect(call('remote-daemon:list-tailnet-machines')).resolves.toMatchObject({
      success: true,
      data: { machines: [{ name: 'my-mac', state: 'password-required' }] },
    });

    await expect(call('remote-daemon:save-tailnet-machine', { name: 'my-mac', password: 'correct horse' })).resolves.toEqual({
      success: true,
      data: {
        id: 'tailnet-tail1.ts.net-my-mac',
        label: 'my-mac',
        baseUrl: 'https://my-mac.tail1.ts.net:8443',
        token: 'correct horse',
        transport: 'http+sse',
        tailnetMachine: 'my-mac',
        tailnetDomain: 'tail1.ts.net',
      },
    });
    expect(config().remoteDaemon?.client.profiles).toHaveLength(1);

    await expect(call('remote-daemon:list-tailnet-machines')).resolves.toMatchObject({
      success: true,
      data: { machines: [{ name: 'my-mac', state: 'available', profileId: 'tailnet-tail1.ts.net-my-mac' }] },
    });
    expect(secretsSeen).toEqual([undefined, 'correct horse']);
  });

  it('saves a machine with no password as a codeless profile that has no token', async () => {
    const { call, config } = setup();
    await call('remote-daemon:save-tailnet-machine', { name: 'my-mac' });
    expect(config().remoteDaemon?.client.profiles).toEqual([expect.objectContaining({ id: 'tailnet-tail1.ts.net-my-mac', token: '', tailnetMachine: 'my-mac', tailnetDomain: 'tail1.ts.net' })]);
  });

  it('refuses to save a machine that is not on the current tailnet', async () => {
    const { call } = setup();
    await expect(call('remote-daemon:save-tailnet-machine', { name: 'gone' })).resolves.toEqual({
      success: false,
      error: 'gone is not on your current tailnet (example.org).',
    });
  });
});
