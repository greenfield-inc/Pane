import http from 'http';
import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController, readTailnetSelf } from './workspaceHost';
import { hashWorkspacePassword } from './workspacePassword';
import type { WorkspaceAccessConfig } from '../../../shared/types/workspaceAccess';

const running = {
  BackendState: 'Running',
  MagicDNSSuffix: 'taila5e94c.ts.net',
  CertDomains: ['parsas-macbook-pro.taila5e94c.ts.net'],
  Self: { DNSName: 'parsas-macbook-pro.taila5e94c.ts.net.', UserID: 31, Tags: null },
  Peer: {
    'nodekey:1': { DNSName: 'owner-laptop.taila5e94c.ts.net.', UserID: 31 },
    'nodekey:2': { DNSName: 'teammate-mac.taila5e94c.ts.net.', UserID: 99 },
    'nodekey:3': { DNSName: 'ci-runner.taila5e94c.ts.net.', UserID: 77, Tags: ['tag:ci'] },
    // A user this machine was shared with: in the netmap only because they may connect to it.
    'nodekey:4': { DNSName: 'guest-pc.other-tailnet.ts.net.', UserID: 55, ShareeNode: true },
  },
  User: {
    31: { LoginName: 'owner@example.com' },
    99: { LoginName: 'Teammate@Example.com' },
    77: { LoginName: 'ci@example.com' },
    55: { LoginName: 'guest@elsewhere.example' },
  },
};

describe('readTailnetSelf', () => {
  it('learns the owner and the machine name from the Self entry', () => {
    expect(readTailnetSelf(JSON.stringify(running))).toEqual({
      ok: true,
      ownerLogin: 'owner@example.com',
      machineName: 'parsas-macbook-pro',
      dnsName: 'parsas-macbook-pro.taila5e94c.ts.net',
      tailnetLogins: ['owner@example.com', 'teammate@example.com'],
    });
  });

  it('counts as tailnet members only people with untagged devices in this tailnet, not users it was shared with', () => {
    const self = readTailnetSelf(JSON.stringify(running));
    expect(self.ok && self.tailnetLogins).toEqual(['owner@example.com', 'teammate@example.com']);
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
  function setup(workspaces: WorkspaceAccessConfig = { enabled: true }) {
    const config = { workspaces };
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
    const registry = new PaneCommandRegistry();
    registry.register('runpane:machine:info', () => ({ hostname: 'devbox' }));
    const host = new PaneWorkspaceHostController(
      registry,
      { getConfig: () => config, on: () => ({}), off: () => ({}) },
      true,
      run,
    );
    /** Sends a request the way Tailscale Serve forwards it to the target it was given. */
    const request = (login: string, password?: string) => {
      const target = serveCalls.find(args => args.includes('--bg'))?.at(-1);
      if (!target) throw new Error('nothing was served');
      return new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ channel: 'runpane:machine:info', args: [] });
        const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', 'Tailscale-User-Login': login };
        if (password) headers.Authorization = `Bearer ${password}`;
        const req = http.request(`${target}/invoke`, { method: 'POST', headers }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        });
        req.once('error', reject);
        req.end(body);
      });
    };
    return { host, config, serveCalls, request, failRemoval: (fails: boolean) => { removalFails = fails; } };
  }

  it('is visible only to its owner unless told otherwise', async () => {
    const { host, request } = setup();
    await host.start();
    await expect(request('owner@example.com')).resolves.toBe(200);
    await expect(request('teammate@example.com')).resolves.toBe(403);
    expect(host.getAccess()).toMatchObject({ visibility: 'owner', passwordProtected: false, state: 'on' });
    await host.shutdown();
  });

  it('lets everyone on the tailnet in under "tailnet" visibility, and nobody from outside it', async () => {
    const { host, request } = setup({ enabled: true, visibility: 'tailnet' });
    await host.start();
    await expect(request('teammate@example.com')).resolves.toBe(200);
    await expect(request('guest@elsewhere.example')).resolves.toBe(403);
    await expect(request('ci@example.com')).resolves.toBe(403);
    await host.shutdown();
  });

  it('asks every client for the password once one is set', async () => {
    const { host, request } = setup({ enabled: true, visibility: 'tailnet', password: hashWorkspacePassword('correct horse') });
    await host.start();
    await expect(request('owner@example.com')).resolves.toBe(401);
    await expect(request('teammate@example.com', 'wrong password')).resolves.toBe(401);
    await expect(request('owner@example.com', 'correct horse')).resolves.toBe(200);
    await expect(request('teammate@example.com', 'correct horse')).resolves.toBe(200);
    expect(host.getAccess()).toMatchObject({ visibility: 'tailnet', passwordProtected: true });
    await host.shutdown();
  });

  it('applies a visibility change without restarting', async () => {
    const { host, config, request } = setup();
    await host.start();
    await expect(request('teammate@example.com')).resolves.toBe(403);
    config.workspaces = { ...config.workspaces, visibility: 'tailnet' };
    await host.sync();
    await expect(request('teammate@example.com')).resolves.toBe(200);
    await host.shutdown();
  });

  it('reports visibility "off" when turned off', async () => {
    const { host } = setup({ enabled: false, visibility: 'tailnet' });
    await host.start();
    expect(host.getAccess()).toMatchObject({ visibility: 'off', state: 'off' });
    await host.shutdown();
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
