import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController, readTailnetSelf } from './workspaceHost';

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
      ok: false, reason: 'Tailscale is signed out', fix: expect.stringContaining('sign in'),
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
