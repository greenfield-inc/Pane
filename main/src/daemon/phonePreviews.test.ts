import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController } from './workspaceHost';
import { PhonePreviewHost } from './phonePreviews';
import { createFakeTailscale, TAILNET_B } from './__fixtures__/fakeTailscale';
import { hashWorkspacePassword } from './workspacePassword';
import type { WorkspaceAccessConfig } from '../../../shared/types/workspaceAccess';
import type { ListeningPort, ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const NO_FILES = {
  readBundleFile: async () => { throw new Error('no bundles'); },
  resolveMediaPath: async () => { throw new Error('no media'); },
};

function port(number: number, kind: ListeningPort['kind'] = 'web'): ListeningPort {
  return { port: number, pid: 100 + number, process: 'node', group: 'pane-terminal', kind };
}

function snapshot(ports: ListeningPort[]): ListeningPortsSnapshot {
  return { host: 'parsa-devbox', ports };
}

async function startHost(
  tailscale: ReturnType<typeof createFakeTailscale>,
  options: { paneDir?: string; enabled?: boolean; workspaces?: WorkspaceAccessConfig; onChange?: () => void } = {},
) {
  const workspace = new PaneWorkspaceHostController(
    new PaneCommandRegistry(),
    { getConfig: () => ({ workspaces: options.workspaces ?? { enabled: options.enabled ?? true } }), on: () => ({}), off: () => ({}) },
    true,
    tailscale.run,
  );
  const previews = new PhonePreviewHost({
    workspace,
    paneDir: options.paneDir ?? '/Users/owner/.pane',
    files: NO_FILES,
    run: tailscale.run,
    onChange: options.onChange,
  });
  await workspace.start();
  await previews.start();
  const stop = async () => {
    await previews.shutdown();
    await workspace.shutdown();
  };
  cleanups.push(stop);
  return { workspace, previews, stop };
}

/** The `Proxy` target of every web handler in the fake Serve config, by HTTPS port. */
async function serveTargets(tailscale: ReturnType<typeof createFakeTailscale>): Promise<Record<string, string>> {
  const status = await tailscale.run('tailscale', ['serve', 'status', '--json']);
  // SAFETY: the fake Tailscale writes its Serve config in this shape.
  const web = (JSON.parse(status.stdout) as { Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }> }).Web ?? {};
  return Object.fromEntries(Object.entries(web).map(([key, value]) => [key.split(':').pop(), value.Handlers['/'].Proxy]));
}

/**
 * Requests a phone address the way Serve does: the visitor's path appended to the handler's
 * target, with the visitor's login signed in.
 */
async function visit(targets: Record<string, string>, phoneUrl: string, path = '/', login = 'owner@example.com') {
  const target = new URL(`${targets[new URL(phoneUrl).port]}${path}`);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { host: new URL(phoneUrl).host, 'tailscale-user-login': login },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('phone previews', () => {
  it('gives each web port a phone address on this machine\'s tailnet name, and tcp ports none', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);

    await previews.update(snapshot([port(5173), port(5432, 'tcp')]));
    const decorated = previews.decorate(snapshot([port(5173), port(5432, 'tcp')]));

    const [web, tcp] = decorated.ports;
    expect(web.phoneUrl).toMatch(/^https:\/\/parsa-devbox\.taila5e94c\.ts\.net:\d+$/u);
    expect(tcp.phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'on', filesUrl: expect.stringMatching(/^https:\/\/parsa-devbox\.taila5e94c\.ts\.net:\d+$/u) });
    const servePort = new URL(web.phoneUrl ?? '').port;
    expect(servePort).not.toBe('5173');
    expect((await serveTargets(tailscale))[servePort]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pane-[0-9a-f]{8}\/[0-9a-f]+\/5173$/u);
  });

  it('routes a phone address through to the dev server', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((request, response) => response.end(`dev server saw ${request.url}`));
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a TCP server that is listening reports an AddressInfo.
    const devPort = (upstream.address() as AddressInfo).port;
    const { previews } = await startHost(tailscale);

    await previews.update(snapshot([port(devPort)]));
    const phoneUrl = previews.decorate(snapshot([port(devPort)])).ports[0].phoneUrl ?? '';
    const page = await visit(await serveTargets(tailscale), phoneUrl, '/app?x=1');

    expect(page.body).toBe('dev server saw /app?x=1');
  });

  it('removes a port\'s handler when the port stops listening', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173), port(3000)]));
    const before = await serveTargets(tailscale);

    await previews.update(snapshot([port(3000)]));

    const after = await serveTargets(tailscale);
    expect(Object.values(after).some(target => target.endsWith('/5173'))).toBe(false);
    expect(Object.values(after).filter(target => target.endsWith('/3000'))).toEqual(Object.values(before).filter(target => target.endsWith('/3000')));
    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toBeUndefined();
  });

  it('removes its own handlers on quit, and an earlier run\'s leftovers at launch, but no one else\'s', async () => {
    const tailscale = createFakeTailscale();
    await tailscale.run('tailscale', ['serve', '--bg', '--https=9999', 'http://127.0.0.1:9']);
    const other = await startHost(tailscale, { paneDir: '/Users/owner/.pane_test' });
    await other.previews.update(snapshot([port(4000)]));
    const crashed = await startHost(tailscale);
    await crashed.previews.update(snapshot([port(5173)]));
    const crashedTargets = Object.values(await serveTargets(tailscale)).filter(target => target.endsWith('/5173'));
    expect(crashedTargets).toHaveLength(1);
    cleanups.pop(); // Killed with kill -9: no shutdown.

    const relaunched = await startHost(tailscale);
    const afterLaunch = Object.values(await serveTargets(tailscale));
    expect(afterLaunch).not.toContain(crashedTargets[0]);
    expect(afterLaunch).toContain('http://127.0.0.1:9');
    expect(afterLaunch.some(target => target.endsWith('/4000'))).toBe(true);

    await relaunched.previews.update(snapshot([port(5173)]));
    await relaunched.stop();
    cleanups.pop();

    const afterQuit = await serveTargets(tailscale);
    expect(Object.values(afterQuit).some(target => target.endsWith('/5173'))).toBe(false);
    expect(afterQuit['9999']).toBe('http://127.0.0.1:9');
    expect(Object.values(afterQuit).some(target => target.endsWith('/4000'))).toBe(true);
  });

  it('retries a Serve change that another client\'s write rejected', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);

    tailscale.busyServe(2);
    await previews.update(snapshot([port(5173)]));

    const phoneUrl = previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '';
    expect((await serveTargets(tailscale))[new URL(phoneUrl).port]).toMatch(/\/5173$/u);
  });

  it('publishes the new phone addresses after the host switches tailnets', async () => {
    const tailscale = createFakeTailscale();
    let published = 0;
    const { workspace, previews } = await startHost(tailscale, { onChange: () => { published += 1; } });
    await previews.update(snapshot([port(5173)]));
    const before = published;

    tailscale.switchTailnet(TAILNET_B);
    await workspace.sync();
    await previews.update(snapshot([port(5173)]));

    expect(published).toBeGreaterThan(before);
    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toContain('.tail3c2c57.ts.net:');
  });

  it('stops forwarding a port the moment it stops listening, even when Serve cannot be updated', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((_request, response) => response.end('still here'));
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a TCP server that is listening reports an AddressInfo.
    const devPort = (upstream.address() as AddressInfo).port;
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(devPort)]));
    const phoneUrl = previews.decorate(snapshot([port(devPort)])).ports[0].phoneUrl ?? '';

    const targets = await serveTargets(tailscale);

    tailscale.failServeStatus('tailscaled is restarting');
    await previews.update(snapshot([]));

    expect((await visit(targets, phoneUrl)).status).toBe(404);
  });

  it('opens no phone pages on a password-protected machine, since a frame cannot send the password', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale, { workspaces: { enabled: true, password: hashWorkspacePassword('correct horse') } });

    await previews.update(snapshot([port(5173)]));

    const decorated = previews.decorate(snapshot([port(5173)]));
    expect(decorated.ports[0].phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'off', reason: expect.stringContaining('password') });
    expect(Object.values(await serveTargets(tailscale)).some(target => target.includes('/pane-'))).toBe(false);
  });

  it('removes only its own mount when someone added another route on the same Serve port', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173)]));
    const servePort = new URL(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '').port;
    await tailscale.run('tailscale', ['serve', '--bg', `--https=${servePort}`, '--set-path=/docs', 'http://127.0.0.1:8']);

    await previews.update(snapshot([]));

    // SAFETY: the fake Tailscale writes its Serve config in this shape.
    const status = JSON.parse((await tailscale.run('tailscale', ['serve', 'status', '--json'])).stdout) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
    expect(status.Web[`${tailscale.dnsName()}:${servePort}`].Handlers).toEqual({ '/docs': { Proxy: 'http://127.0.0.1:8' } });
  });

  it('gives two Pane instances updating at once different Serve ports', async () => {
    const tailscale = createFakeTailscale();
    const installed = await startHost(tailscale, { paneDir: '/Users/owner/.pane' });
    const dev = await startHost(tailscale, { paneDir: '/Users/owner/.pane_dev' });

    await Promise.all([installed.previews.update(snapshot([port(5173)])), dev.previews.update(snapshot([port(3000)]))]);

    const installedUrl = installed.previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '';
    const devUrl = dev.previews.decorate(snapshot([port(3000)])).ports[0].phoneUrl ?? '';
    const targets = await serveTargets(tailscale);
    expect(installedUrl).not.toBe(devUrl);
    expect(targets[new URL(installedUrl).port]).toMatch(/\/5173$/u);
    expect(targets[new URL(devUrl).port]).toMatch(/\/3000$/u);
  });

  it('says why phones cannot open pages while workspaces are off', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale, { enabled: false });

    await previews.update(snapshot([port(5173)]));

    const decorated = previews.decorate(snapshot([port(5173)]));
    expect(decorated.ports[0].phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'off', reason: expect.stringContaining('turned off') });
    expect(await serveTargets(tailscale)).toEqual({});
  });
});
