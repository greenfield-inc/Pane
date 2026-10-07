import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController, readTailnetSelf } from './workspaceHost';
import { createFakeTailscale, TAILNET_A, TAILNET_B } from './__fixtures__/fakeTailscale';

const running = {
  BackendState: 'Running',
  CertDomains: ['parsas-macbook-pro.taila5e94c.ts.net'],
  Self: { DNSName: 'parsas-macbook-pro.taila5e94c.ts.net.', UserID: 31, Tags: null },
  User: { 31: { LoginName: 'owner@example.com' }, 99: { LoginName: 'teammate@example.com' } },
};

describe('readTailnetSelf', () => {
  it('learns the owner and the machine name from the Self entry', () => {
    expect(readTailnetSelf(JSON.stringify(running))).toEqual({
      ok: true,
      ownerLogin: 'owner@example.com',
      machineName: 'parsas-macbook-pro',
      dnsName: 'parsas-macbook-pro.taila5e94c.ts.net',
    });
  });

  it('names the one step that fixes a signed-out Tailscale or a tailnet without HTTPS certificates', () => {
    expect(readTailnetSelf(JSON.stringify({ ...running, BackendState: 'NeedsLogin' }))).toMatchObject({
      ok: false, reason: expect.stringContaining('Tailscale is signed out'), fix: expect.stringContaining('sign in'),
    });
    expect(readTailnetSelf(JSON.stringify({ ...running, BackendState: 'Stopped' }))).toMatchObject({
      ok: false, reason: expect.stringContaining('disconnected'), fix: 'Open Tailscale and click Connect (or run "tailscale up"); Pane retries within a minute.',
    });
    expect(readTailnetSelf(JSON.stringify({ ...running, CertDomains: null }))).toMatchObject({
      ok: false, reason: expect.stringContaining('HTTPS certificates'), fix: expect.stringContaining('https://login.tailscale.com/admin/dns'),
    });
  });

  it('has no owner on a tagged machine', () => {
    expect(readTailnetSelf(JSON.stringify({ ...running, Self: { ...running.Self, Tags: ['tag:server'] } }))).toMatchObject({
      ok: false, reason: expect.stringContaining('tagged'),
    });
  });
});

describe('PaneWorkspaceHostController', () => {
  function setup() {
    const config = { workspaces: { enabled: true } };
    const serveCalls: string[][] = [];
    let removalFails = false;
    const run = async (_command: string, args: string[]) => {
      if (args[0] === 'status') return { ok: true, stdout: JSON.stringify(running), stderr: '' };
      if (args[0] === 'serve') {
        serveCalls.push(args);
        if (args.includes('off') && removalFails) return { ok: false, stdout: '', stderr: 'serve config denied' };
      }
      return { ok: true, stdout: '', stderr: '' };
    };
    const host = new PaneWorkspaceHostController(
      new PaneCommandRegistry(),
      { getConfig: () => config, on: () => ({}), off: () => ({}) },
      true,
      run,
    );
    return { host, config, serveCalls, failRemoval: (fails: boolean) => { removalFails = fails; } };
  }

  it('moves its 8443 handler and URL to the new tailnet within a minute of a switch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tailscale = createFakeTailscale({ tailnet: TAILNET_A });
    const host = new PaneWorkspaceHostController(
      new PaneCommandRegistry(),
      { getConfig: () => ({ workspaces: { enabled: true } }), on: () => ({}), off: () => ({}) },
      true,
      tailscale.run,
    );
    try {
      await host.start();
      expect(host.getStatus()).toMatchObject({ state: 'on', url: 'https://parsa-devbox.taila5e94c.ts.net:8443' });

      tailscale.switchTailnet(TAILNET_B);
      const servesBefore = tailscale.serveCalls().length;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(host.getStatus()).toMatchObject({ state: 'on', url: 'https://parsa-devbox.tail3c2c57.ts.net:8443' });
      expect(tailscale.serveCalls().slice(servesBefore).map(call => call.args.slice(0, 3)))
        .toEqual([['serve', '--bg', '--https=8443']]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(tailscale.serveCalls().slice(servesBefore)).toHaveLength(1);
    } finally {
      await host.shutdown();
      vi.useRealTimers();
    }
  });

  it('names the step that fixes a stopped Tailscale or a refused Serve change', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const tailscale = createFakeTailscale({ tailnet: TAILNET_A });
    const host = new PaneWorkspaceHostController(
      new PaneCommandRegistry(),
      { getConfig: () => ({ workspaces: { enabled: true } }), on: () => ({}), off: () => ({}) },
      true,
      tailscale.run,
    );
    try {
      tailscale.failStatus('failed to connect to local tailscaled; it doesn\'t appear to be running');
      await host.sync();
      expect(host.getStatus()).toEqual({
        state: 'off',
        reason: 'Tailscale is installed but not running, so other devices can\'t reach this Pane',
        fix: 'Open the Tailscale app and make sure it is connected; Pane retries within a minute.',
      });

      tailscale.failStatus('');
      tailscale.failServe('serve config denied');
      await host.sync();
      expect(host.getStatus()).toMatchObject({
        state: 'off',
        reason: 'tailscale serve couldn\'t publish this Pane on port 8443: serve config denied',
        fix: expect.stringMatching(/^Run "tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:\d+\/\w+" in a terminal to see the full error, fix what it reports; Pane retries within a minute\.$/),
      });
    } finally {
      await host.shutdown();
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('reports a handler it could not remove, and removes it on a later sync', async () => {
    const { host, config, serveCalls, failRemoval } = setup();
    await host.start();
    expect(host.getStatus()).toMatchObject({ state: 'on', machineName: 'parsas-macbook-pro' });

    config.workspaces.enabled = false;
    failRemoval(true);
    await host.sync();
    expect(host.getStatus()).toMatchObject({ state: 'off', reason: expect.stringContaining('could not remove') });

    failRemoval(false);
    await host.sync();
    expect(host.getStatus()).toMatchObject({ state: 'off', reason: 'turned off with runpane workspace disable' });
    expect(serveCalls.filter(args => args.includes('off'))).toHaveLength(2);
    await host.shutdown();
  });
});
