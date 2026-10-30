import { describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { WorkspaceProbe } from '../services/tailnetMachines';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { GLASSES_COMMANDS } from '../../../shared/types/glasses';
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

function setup(options: { invoke?: (channel: string, args?: PaneCommandValue[]) => Promise<PaneCommandValue>; readStatus?: () => Promise<string | null> } = {}) {
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
    { invoke: options.invoke ?? (async () => null) },
    { readStatus: options.readStatus ?? (async () => JSON.stringify(status)), probe, call: async () => ({ kind: 'unreachable', detail: 'not used' }) },
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

describe('revoking glasses on all my computers from Settings', () => {
  it('can be sent again after discovery failed, once the row is gone, without pairing anything back', async () => {
    let devices = [{ id: 'g2', label: 'Even G2', phoneId: 'pane-native-a', createdAt: '2026-10-29T08:00:00.000Z' }];
    const revokedPhoneIds: string[] = [];
    let tailscaleUp = false;
    const { call } = setup({
      readStatus: async () => (tailscaleUp ? JSON.stringify(status) : null),
      invoke: async (channel, args) => {
        if (channel === GLASSES_COMMANDS.list) return { devices, revokedPhoneIds };
        if (channel === GLASSES_COMMANDS.revoke) {
          devices = devices.filter((device) => device.id !== decodeBoundary(args?.[0] ?? null, boundary.object({ id: boundary.string })).id);
          revokedPhoneIds.push('pane-native-a');
          return { revoked: true };
        }
        if (channel === 'runpane:workspaces:access') return { machineName: 'devbox' };
        throw new Error(`unexpected ${channel}`);
      },
    });

    const first = await call('remote-daemon:revoke-glasses-everywhere', 'pane-native-a');
    expect(first).toMatchObject({ success: false, error: expect.stringContaining('revoked the glasses on this computer only') });
    expect(devices).toEqual([]);

    tailscaleUp = true;
    await expect(call('remote-daemon:revoke-glasses-everywhere', 'pane-native-a')).resolves.toEqual({
      success: true,
      data: { revoked: ['devbox'], notReached: [{ name: 'my-mac', reason: 'needs its password' }] },
    });
    expect(devices).toEqual([]);
    expect(revokedPhoneIds).toEqual(['pane-native-a']);
  });

  it('refuses a phone that was never paired or revoked here', async () => {
    const { call } = setup({ invoke: async () => ({ devices: [], revokedPhoneIds: [] }) });
    await expect(call('remote-daemon:revoke-glasses-everywhere', 'pane-native-z')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('No glasses from this phone are paired or revoked here'),
    });
  });
});
