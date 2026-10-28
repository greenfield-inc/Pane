import http from 'http';
import net from 'net';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultRemoteDaemonConfig,
  type RemoteConnectionCheck,
  type RemotePaneConnectionProfile,
} from '../../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import type { WorkspaceProbeResult } from '../../services/tailnetMachines';
import { RemotePaneClientController } from './remotePaneClient';
import type { ConnectionCheckDependencies } from './connectionChecks';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TOKEN = 'check-token';

/** A real host API on loopback that accepts TOKEN and reports `paneVersion` on ready. */
async function startHost(paneVersion?: string): Promise<string> {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{ id: 'laptop', label: 'Laptop', createdAt: new Date(0).toISOString(), tokenHash: hashRemoteDaemonToken(TOKEN) }];
  const host = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), { getConfig: () => ({ remoteDaemon: config }) }, { paneVersion });
  await host.start();
  cleanups.push(() => host.stop());
  return `http://127.0.0.1:${host.getAddress()!.port}`;
}

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function profile(baseUrl: string, overrides: Partial<RemotePaneConnectionProfile> = {}): RemotePaneConnectionProfile {
  return { id: 'devbox', label: 'devbox', baseUrl, token: TOKEN, transport: 'http+sse', ...overrides };
}

function createController(dependencies: Partial<ConnectionCheckDependencies> = {}) {
  const events: Array<{ name: string; properties: object }> = [];
  const configManager = Object.assign(new EventEmitter(), {
    getConfig: () => ({ remoteDaemon: createDefaultRemoteDaemonConfig() }),
  });
  const controller = new RemotePaneClientController();
  controller.initialize({
    // SAFETY: the controller reads only getConfig and config-updated events.
    configManager: configManager as never,
    rendererEventSink: { send() {} },
    analyticsManager: { track: (name, properties) => { events.push({ name, properties: properties ?? {} }); } },
    appVersion: '2.4.202',
    checkDependencies: { listSshHosts: async () => [], runSsh: async () => {}, ...dependencies },
  });
  cleanups.push(() => controller.switchToLocalMode().then(() => undefined));
  return { controller, events };
}

function rowsOf(check: RemoteConnectionCheck | null | undefined) {
  return (check?.rows ?? []).map(({ stage, status, label, fix }) => ({ stage, status, label, fix: fix?.label }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('connection checklist', () => {
  it('passes every stage against a host on the same version and closes once the workspace loads', async () => {
    const { controller } = createController();
    await controller.activateProfile(profile(await startHost('2.4.202')));
    await waitFor(() => controller.getConnectionState().check?.outcome === 'passed');
    const check = controller.getConnectionState().check;
    expect(rowsOf(check)).toEqual([
      { stage: 'reachable', status: 'passed', label: 'Host reachable', fix: undefined },
      { stage: 'running', status: 'passed', label: 'Pane daemon running', fix: undefined },
      { stage: 'signed-in', status: 'passed', label: 'Signed in', fix: undefined },
      { stage: 'version', status: 'passed', label: 'Versions match', fix: undefined },
      { stage: 'workspace', status: 'passed', label: 'Workspace loaded', fix: undefined },
    ]);
    expect(check?.rows[0].metric).toMatch(/^\d+ ms$/);
    expect(check?.rows[3].metric).toBe('2.4.202');
    expect(controller.getConnectionState().status).toBe('connected');
  });

  it('names a refused connection as the daemon not running, offers the command, and counts it once', async () => {
    const { controller, events } = createController();
    await expect(controller.activateProfile(profile(await closedPort()))).rejects.toThrow('Pane daemon not running on devbox.');
    const check = controller.getConnectionState().check;
    expect(check?.outcome).toBe('failed');
    expect(rowsOf(check)).toEqual([
      { stage: 'reachable', status: 'passed', label: 'Host reachable', fix: undefined },
      { stage: 'running', status: 'failed', label: 'Pane daemon not running on devbox', fix: 'Copy command' },
      { stage: 'signed-in', status: 'waiting', label: 'Signed in', fix: undefined },
      { stage: 'version', status: 'waiting', label: 'Versions match', fix: undefined },
      { stage: 'workspace', status: 'waiting', label: 'Workspace loaded', fix: undefined },
    ]);
    expect(check?.rows[1].fix?.command).toBe('npx --yes runpane@latest daemon repair --yes');
    expect(controller.getConnectionState().mode).toBe('local');
    expect(events.filter((event) => event.name === 'remote_pane_client_connection_failed')).toEqual([{
      name: 'remote_pane_client_connection_failed',
      properties: expect.objectContaining({ failure_stage: 'connection_check', failed_check: 'pane_not_running' }),
    }]);
  });

  it('reads a 502 from a proxy in front of the host as the daemon not running', async () => {
    const { controller } = createController();
    const proxy = await startServer((_request, response) => { response.writeHead(502); response.end(); });
    await expect(controller.activateProfile(profile(proxy))).rejects.toThrow('Pane daemon not running on devbox.');
  });

  it('names a host that never answers as unreachable, with the address it tried', async () => {
    const { controller } = createController();
    const silent = await startServer(() => {});
    await expect(controller.activateProfile(profile(silent))).rejects.toThrow("Can't reach devbox.");
    const failed = controller.getConnectionState().check?.rows.find((row) => row.status === 'failed');
    expect(failed?.detail).toContain(new URL(silent).host);
    expect(failed?.fix).toBeUndefined();
  }, 10_000);

  it('names a rejected sign-in and offers to paste a new code', async () => {
    const { controller } = createController();
    await expect(controller.activateProfile(profile(await startHost('2.4.202'), { token: 'revoked' })))
      .rejects.toThrow("devbox rejected this computer's sign-in.");
    expect(controller.getConnectionState().check?.rows[2].fix).toEqual({ kind: 'paste-code', label: 'Paste new code' });
  });

  it('warns about a host too old to report its version and keeps the card open after connecting', async () => {
    const { controller } = createController();
    await controller.activateProfile(profile(await startHost()));
    await waitFor(() => controller.getConnectionState().check?.outcome === 'warning');
    const check = controller.getConnectionState().check;
    expect(rowsOf(check).slice(3)).toEqual([
      { stage: 'version', status: 'warning', label: 'devbox runs an older Pane (version unknown)', fix: 'Copy command' },
      { stage: 'workspace', status: 'passed', label: 'Workspace loaded', fix: undefined },
    ]);
    expect(controller.getConnectionState().status).toBe('connected');
    controller.dismissCheck(check!.id);
    expect(controller.getConnectionState().check).toBeNull();
  });

  it('closes the card of a failed switch when the connected host is chosen again', async () => {
    const { controller } = createController();
    const connected = profile(await startHost('2.4.202'));
    await controller.activateProfile(connected);
    await waitFor(() => controller.getConnectionState().check?.outcome === 'passed');
    await expect(controller.activateProfile(profile(await closedPort(), { id: 'other', label: 'other' }))).rejects.toThrow();
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'devbox', check: { profileId: 'other', outcome: 'failed' } });
    await controller.activateProfile(connected);
    expect(controller.getConnectionState().check).toBeNull();
  });

  it('offers to update this Pane when the host is newer', async () => {
    const { controller } = createController();
    await controller.activateProfile(profile(await startHost('2.4.210')));
    await waitFor(() => controller.getConnectionState().check?.outcome === 'warning');
    expect(controller.getConnectionState().check?.rows[3]).toMatchObject({
      label: 'This Pane is older than devbox (2.4.210)',
      fix: { kind: 'update-pane', label: 'Update Pane' },
    });
  });

  it('starts the daemon over the one matching SSH host, and falls back to the command when ssh fails', async () => {
    const ran: string[][] = [];
    let sshFails = false;
    const { controller } = createController({
      listSshHosts: async () => ['devbox', 'other'],
      runSsh: async (alias, command) => {
        ran.push([alias, command]);
        if (sshFails) throw new Error('Permission denied (publickey).');
      },
    });
    // A Tailscale name whose lookup falls back to the saved Tailscale IP, here loopback.
    const port = new URL(await closedPort()).port;
    const target = profile(`http://devbox.tail1.ts.net:${port}`, { tunnel: { kind: 'tailscale', selected: true, tailscaleIp: '127.0.0.1' } });
    await expect(controller.activateProfile(target)).rejects.toThrow('Pane daemon not running on devbox.');
    const check = controller.getConnectionState().check;
    const running = check?.rows.find((row) => row.stage === 'running');
    expect(running?.fix).toEqual({ kind: 'run-on-host', label: 'Start it', command: 'npx --yes runpane@latest daemon repair --yes' });
    sshFails = true;
    expect(await controller.runCheckFix(check!.id, 'running')).toBeNull();
    expect(ran).toEqual([['devbox', 'npx --yes runpane@latest daemon repair --yes']]);
    expect(controller.getConnectionState().check?.rows.find((row) => row.stage === 'running')).toMatchObject({
      status: 'failed',
      fix: { kind: 'copy-command', label: 'Copy command', command: 'npx --yes runpane@latest daemon repair --yes' },
      detail: expect.stringContaining('ssh devbox failed: Permission denied (publickey).'),
    });
  });
});

describe('connection checklist for a machine on the tailnet', () => {
  const tailnetProfile = profile('https://devbox.tail1.ts.net:8443', { token: '', tailnetMachine: 'devbox', tailnetDomain: 'tail1.ts.net' });
  const status = (backend: string, peer: { online: boolean; os?: string }) => JSON.stringify({
    BackendState: backend,
    MagicDNSSuffix: 'tail1.ts.net',
    CurrentTailnet: { Name: 'example.org' },
    Self: { DNSName: 'laptop.tail1.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.1'] },
    Peer: { a: { DNSName: 'devbox.tail1.ts.net.', UserID: 1, OS: peer.os ?? 'linux', Online: peer.online, TailscaleIPs: ['100.64.0.2'] } },
    User: { 1: { LoginName: 'me@example.org' } },
  });
  const checkWith = async (statusJson: string | null, probe: WorkspaceProbeResult, ssh: string[] = []) => {
    const { controller } = createController({
      readTailscaleStatus: async () => statusJson,
      probeWorkspace: async () => probe,
      listSshHosts: async () => ssh,
    });
    await expect(controller.activateProfile(tailnetProfile)).rejects.toThrow();
    return controller.getConnectionState().check?.rows.find((row) => row.status === 'failed');
  };

  it('starts with Tailscale on this computer', async () => {
    expect(await checkWith(JSON.stringify({ BackendState: 'NeedsLogin' }), { kind: 'unreachable' })).toMatchObject({
      stage: 'tailscale', label: 'Tailscale is signed out on this computer', fix: { kind: 'open-tailscale' },
    });
    expect(await checkWith(null, { kind: 'unreachable' })).toMatchObject({
      stage: 'tailscale', label: 'Tailscale is not installed on this computer', fix: { kind: 'download-tailscale' },
    });
  });

  it('names an offline machine, a closed Pane, a password and an owner-only machine', async () => {
    expect(await checkWith(status('Running', { online: false }), { kind: 'unreachable' }))
      .toMatchObject({ stage: 'reachable', label: 'devbox is offline on Tailscale' });
    expect(await checkWith(status('Running', { online: true }), { kind: 'unreachable' }))
      .toMatchObject({ stage: 'running', label: 'Pane is not open on devbox', detail: 'Open Pane on devbox, then retry.' });
    expect(await checkWith(status('Running', { online: true }), { kind: 'password-required' }))
      .toMatchObject({ stage: 'signed-in', label: 'devbox needs a password', fix: { kind: 'enter-password' } });
    expect(await checkWith(status('Running', { online: true }), { kind: 'refused' }))
      .toMatchObject({ stage: 'signed-in', label: "Only devbox's owner can connect", detail: 'Ask them to allow everyone on the tailnet.' });
  });

  it('opens Pane on a Mac over its SSH host', async () => {
    expect(await checkWith(status('Running', { online: true, os: 'macOS' }), { kind: 'unreachable' }, ['devbox']))
      .toMatchObject({ stage: 'running', fix: { kind: 'run-on-host', label: 'Start it', command: 'open -a Pane' } });
  });
});
