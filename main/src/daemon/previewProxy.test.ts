import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';
import type { ToolPanel } from '../../../shared/types/panels';
import { createPreviewFiles, startPreviewProxy, type PreviewFiles as PreviewProxyFiles, type PreviewGate, type PreviewProxy } from './previewProxy';

const DNS_NAME = 'devbox.taila5e94c.ts.net';
const BASE = '/pane-1a2b3c4d/s3cret';
const OWNER = 'owner@example.com';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Echo {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

/** A dev server that answers every request with what it received. */
async function startUpstream(
  host = 'localhost',
  respond: (request: http.IncomingMessage, response: http.ServerResponse) => void = (request, response) => {
    const echo: Echo = { method: request.method, url: request.url, headers: request.headers };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(echo));
  },
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(respond);
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  // SAFETY: a TCP server that is listening reports an AddressInfo.
  return { server, port: (server.address() as AddressInfo).port };
}

async function startProxy(gate: Partial<PreviewGate> & { ports: number[] }, files?: PreviewProxyFiles): Promise<PreviewProxy> {
  const proxy = await startPreviewProxy({
    basePath: BASE,
    gate: () => ({
      dnsName: DNS_NAME,
      machineName: 'devbox',
      ownerLogin: OWNER,
      admits: login => login === OWNER,
      ...gate,
      ports: new Set(gate.ports),
    }),
    files: files ?? {
      readBundleFile: async () => { throw new Error('no bundles'); },
      resolveMediaPath: async () => { throw new Error('no media'); },
    },
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

function get(proxy: PreviewProxy, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      path,
      headers: { host: `${DNS_NAME}:44300`, 'tailscale-user-login': OWNER, ...headers },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('preview proxy', () => {
  it('forwards an admitted request to the dev server as if it came from localhost', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ ports: [upstream.port] });

    const response = await get(proxy, `${BASE}/${upstream.port}/app/page?x=1`, {
      'tailscale-user-name': 'Owner',
      'x-custom': 'kept',
    });

    expect(response.status).toBe(200);
    // SAFETY: the upstream above answers with an Echo.
    const echo = JSON.parse(response.body) as Echo;
    expect(echo.url).toBe('/app/page?x=1');
    expect(echo.headers.host).toBe(`localhost:${upstream.port}`);
    expect(echo.headers['x-forwarded-host']).toBe(`${DNS_NAME}:44300`);
    expect(echo.headers['x-forwarded-proto']).toBe('https');
    expect(echo.headers['x-custom']).toBe('kept');
    expect(echo.headers['tailscale-user-login']).toBeUndefined();
    expect(echo.headers['tailscale-user-name']).toBeUndefined();
  });

  it('refuses a request without the secret, for another host, or for a port with no handler', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ ports: [upstream.port] });

    expect((await get(proxy, `/pane-1a2b3c4d/wrong/${upstream.port}/`)).status).toBe(403);
    expect((await get(proxy, `/${upstream.port}/`)).status).toBe(403);
    expect((await get(proxy, `${BASE}/${upstream.port}/`, { host: 'evil.example:44300' })).status).toBe(403);
    expect((await get(proxy, `${BASE}/${upstream.port + 1}/`)).status).toBe(404);
  });

  it('shows a login that "Who can connect" refuses which device to open the page from', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ ports: [upstream.port] });

    const refused = await get(proxy, `${BASE}/${upstream.port}/`, { 'tailscale-user-login': 'guest@elsewhere.example' });
    expect(refused.status).toBe(403);
    expect(refused.headers['content-type']).toContain('text/html');
    expect(refused.body).toContain('This page runs on devbox. Open it from a device signed in as owner@example.com.');

    const unsigned = await get(proxy, `${BASE}/${upstream.port}/`, { 'tailscale-user-login': '' });
    expect(unsigned.status).toBe(403);
  });

  it('lets a phone frame pages that forbid framing', async () => {
    const upstream = await startUpstream('localhost', (_request, response) => {
      response.writeHead(200, {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src *",
      }).end('ok');
    });
    const proxy = await startProxy({ ports: [upstream.port] });

    const response = await get(proxy, `${BASE}/${upstream.port}/`);
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; img-src *");
  });

  it('carries a live-reload WebSocket through to the dev server', async () => {
    const upstream = await startUpstream();
    const wss = new WebSocketServer({ server: upstream.server });
    const seen = { host: '', protocol: '' };
    wss.on('connection', (socket, request) => {
      seen.host = request.headers.host ?? '';
      seen.protocol = socket.protocol;
      socket.on('message', data => socket.send(`echo:${String(data)}`));
    });
    cleanups.push(() => new Promise<void>(resolve => wss.close(() => resolve())));
    const proxy = await startProxy({ ports: [upstream.port] });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}${BASE}/${upstream.port}/?token=abc`, 'vite-hmr', {
      headers: { host: `${DNS_NAME}:44300`, 'tailscale-user-login': OWNER },
    });
    cleanups.push(() => client.close());
    const reply = await new Promise<string>((resolve, reject) => {
      client.once('open', () => client.send('ping'));
      client.once('message', data => resolve(String(data)));
      client.once('error', reject);
    });

    expect(reply).toBe('echo:ping');
    expect(seen).toEqual({ host: `localhost:${upstream.port}`, protocol: 'vite-hmr' });
  });

  it('refuses a WebSocket from a login "Who can connect" refuses', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ ports: [upstream.port] });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}${BASE}/${upstream.port}/`, {
      headers: { host: `${DNS_NAME}:44300`, 'tailscale-user-login': 'guest@elsewhere.example' },
    });
    const status = await new Promise<number>(resolve => {
      client.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      client.once('error', () => resolve(-1));
    });
    expect(status).toBe(403);
  });

  it('reaches a dev server that listens only on IPv6 loopback, as Vite does by default', async () => {
    const upstream = await startUpstream('::1');
    const proxy = await startProxy({ ports: [upstream.port] });

    const response = await get(proxy, `${BASE}/${upstream.port}/`);
    expect(response.status).toBe(200);
  });

  it('serves files beside a browser panel\'s HTML page and refuses any outside its folder', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'preview-proxy-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'report'));
    await fs.writeFile(path.join(root, 'report', 'index.html'), '<link rel="stylesheet" href="style.css">');
    await fs.writeFile(path.join(root, 'report', 'style.css'), 'body{color:red}');
    await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
    // SAFETY: the bundle reader reads only the type and the entry URL of a panel.
    const panel = {
      id: 'panel-1',
      type: 'browser',
      state: { customState: { currentUrl: pathToFileURL(path.join(root, 'report', 'index.html')).href } },
    } as ToolPanel;
    const proxy = await startProxy({ ports: [] }, createPreviewFiles({
      getPanel: id => (id === panel.id ? panel : undefined),
      resolvePath: async () => { throw new Error('no media'); },
    }));

    const inside = await get(proxy, `${BASE}/files/file/panel-1/style.css`);
    expect(inside).toMatchObject({ status: 200, body: 'body{color:red}' });
    expect(inside.headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await get(proxy, `${BASE}/files/file/panel-1/index.html`)).headers['content-type']).toBe('text/html; charset=utf-8');
    expect((await get(proxy, `${BASE}/files/file/panel-1/../secret.txt`)).status).toBe(403);
    expect((await get(proxy, `${BASE}/files/file/panel-1/%2e%2e%2fsecret.txt`)).status).toBe(403);
    expect((await get(proxy, `${BASE}/files/file/panel-2/style.css`)).status).toBe(403);
  });

  it('streams the requested byte range of a media file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-proxy-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'clip.mp4'), '0123456789');
    const proxy = await startProxy({ ports: [] }, {
      readBundleFile: async () => { throw new Error('no bundles'); },
      resolveMediaPath: async (sessionId, filePath) => {
        if (sessionId !== 'session-1' || filePath !== 'media/clip.mp4') throw new Error('outside');
        return path.join(root, 'clip.mp4');
      },
    });

    const response = await get(proxy, `${BASE}/files/media/session-1/media/clip.mp4`, { range: 'bytes=4-6' });
    expect(response).toMatchObject({ status: 206, body: '456' });
    expect(response.headers['content-range']).toBe('bytes 4-6/10');
    expect(response.headers['content-type']).toBe('video/mp4');
  });
});
