import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController } from './workspaceHost';
import { PhonePreviewHost } from './phonePreviews';
import { createFakeTailscale, TAILNET_B } from './__fixtures__/fakeTailscale';
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
  options: { paneDir?: string; enabled?: boolean; onChange?: () => void } = {},
) {
  const workspace = new PaneWorkspaceHostController(
    new PaneCommandRegistry(),
    { getConfig: () => ({ workspaces: { enabled: options.enabled ?? true } }), on: () => ({}), off: () => ({}) },
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
    // Serve appends the visitor's path to the handler's target and signs the visitor's login.
    const target = new URL(`${(await serveTargets(tailscale))[new URL(phoneUrl).port]}/app?x=1`);
    const body = await new Promise<string>((resolve, reject) => {
      http.get({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: { host: new URL(phoneUrl).host, 'tailscale-user-login': 'owner@example.com' },
      }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });

    expect(body).toBe('dev server saw /app?x=1');
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

    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toMatch(/^https:\/\//u);
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
