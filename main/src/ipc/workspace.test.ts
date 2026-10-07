import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PaneWorkspaceHostController } from '../daemon/workspaceHost';
import { createWorkspacePasswordVerifier } from '../daemon/workspacePassword';
import type { WorkspaceAccessConfig } from '../../../shared/types/workspaceAccess';
import { registerWorkspaceCommands } from './workspace';

interface TestConfig {
  workspaces?: WorkspaceAccessConfig;
}

function setup(workspaces: WorkspaceAccessConfig = {}) {
  let config: TestConfig = { workspaces };
  const configManager = {
    getConfig: () => config,
    on: () => ({}),
    off: () => ({}),
    updateConfigWith: async (update: (current: TestConfig) => TestConfig) => {
      config = { ...config, ...update(config) };
      return config;
    },
  };
  // Tailscale is absent, so the host stays off and touches nothing on this machine.
  const host = new PaneWorkspaceHostController(new PaneCommandRegistry(), configManager, true, async () => ({ ok: false, stdout: '', stderr: '' }));
  const registry = new PaneCommandRegistry();
  registerWorkspaceCommands(registry, host, configManager, '2.5.0');
  return { registry, config: () => config.workspaces, host };
}

describe('workspace access commands', () => {
  it('defaults to "Only me" with no password', async () => {
    const { registry, host } = setup();
    await expect(registry.invoke('runpane:workspaces:access')).resolves.toMatchObject({ visibility: 'owner', passwordProtected: false });
    await host.shutdown();
  });

  it('sets visibility and a password, storing only a hash of it', async () => {
    const { registry, config, host } = setup();
    await expect(registry.invoke('runpane:workspaces:set-access', [{ visibility: 'tailnet', password: 'correct horse' }]))
      .resolves.toMatchObject({ visibility: 'tailnet', passwordProtected: true });
    const stored = config()?.password;
    expect(stored && JSON.stringify(stored)).not.toContain('correct horse');
    expect(stored && createWorkspacePasswordVerifier(stored)('correct horse', 'me@example.com')).toBe('valid');

    await expect(registry.invoke('runpane:workspaces:set-access', [{ password: null }]))
      .resolves.toMatchObject({ visibility: 'tailnet', passwordProtected: false });
    await expect(registry.invoke('runpane:workspaces:set-access', [{ visibility: 'off' }]))
      .resolves.toMatchObject({ visibility: 'off' });
    expect(config()).toMatchObject({ enabled: false, visibility: 'tailnet' });
    await host.shutdown();
  });

  it('refuses a short password', async () => {
    const { registry, host } = setup();
    await expect(registry.invoke('runpane:workspaces:set-access', [{ password: 'short' }])).rejects.toThrow('at least 8 characters');
    await host.shutdown();
  });

  it('never lets a remote client change who may connect', async () => {
    const { registry, config, host } = setup();
    await expect(registry.invokeRemote('runpane:workspaces:set-access', [{ visibility: 'tailnet' }])).rejects.toThrow('only on the machine itself');
    await expect(registry.invokeRemote('runpane:workspaces:set-enabled', [{ enabled: false }])).rejects.toThrow('only on the machine itself');
    expect(config()).toEqual({});
    await host.shutdown();
  });

  it('hands a phone the list of computers it can see, so the phone needs no Tailscale CLI', async () => {
    const { host } = setup();
    const registry = new PaneCommandRegistry();
    const status = {
      BackendState: 'Running', MagicDNSSuffix: 'tail1.ts.net',
      Self: { DNSName: 'devbox.tail1.ts.net.', UserID: 1, OS: 'windows' },
      Peer: { a: { DNSName: 'studio-mac.tail1.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.2'] } },
      User: { 1: { LoginName: 'me@example.com' } },
    };
    registerWorkspaceCommands(registry, host, { getConfig: () => ({}), updateConfigWith: async () => ({}) }, '2.5.0', {
      readStatus: async () => JSON.stringify(status),
      probe: async () => ({ kind: 'outdated' }),
    });
    await expect(registry.invoke('runpane:workspaces:machines')).resolves.toMatchObject({
      ok: true,
      domain: 'tail1.ts.net',
      machines: [{ name: 'studio-mac', url: 'https://studio-mac.tail1.ts.net:8443', state: 'outdated' }],
    });
    await host.shutdown();
  });
});
