import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { servePreviews, type PreviewFiles } from '../previewProxy';
import { RelayPreviews } from './relayPreviews';

const ID = 'abcdefghijklmnop';
const DOMAIN = 'relay.test';
const noFiles: PreviewFiles = {
  readBundleFile: async () => { throw new Error('none'); },
  resolveMediaPath: async () => { throw new Error('none'); },
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()?.(); });

function get(port: number, host: string, path: string, cookie?: string) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    }).on('error', reject);
  });
}

async function setup() {
  const dev = http.createServer((request, response) => response.end(`vite ${request.url}`));
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => dev.close(() => resolve())));
  const devPort = (dev.address() as AddressInfo).port;
  const active = new Set(['phone-1']);
  const previews = new RelayPreviews({
    id: () => ID,
    domain: () => DOMAIN,
    isForwardedPort: (port) => port === devPort,
    clientActive: (clientId) => active.has(clientId),
  });
  const proxy = await servePreviews(previews.route, noFiles);
  closers.push(() => proxy.close());
  return { previews, proxyPort: proxy.port, devPort, active };
}

describe('previews under the computer’s names', () => {
  it('trades a one-time ticket for a cookie on that name, then forwards to the dev server', async () => {
    const { previews, proxyPort, devPort } = await setup();
    const address = new URL(previews.address({ port: devPort }, 'phone-1'));
    expect(address.hostname).toBe(`p${devPort}.${ID}.${DOMAIN}`);

    const first = await get(proxyPort, address.hostname, `${address.pathname}${address.search}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = String(first.headers['set-cookie']).split(';')[0];

    const page = await get(proxyPort, address.hostname, '/src/main.ts', cookie);
    expect(page).toMatchObject({ status: 200, body: 'vite /src/main.ts' });

    // The ticket worked once.
    expect((await get(proxyPort, address.hostname, `${address.pathname}${address.search}`)).status).toBe(403);
    // The cookie belongs to that one name.
    expect((await get(proxyPort, `files.${ID}.${DOMAIN}`, '/file/x/index.html', cookie)).status).toBe(403);
  });

  it('refuses the preview address without a ticket or cookie', async () => {
    const { proxyPort, devPort } = await setup();
    expect((await get(proxyPort, `p${devPort}.${ID}.${DOMAIN}`, '/')).status).toBe(403);
  });

  it('cuts a removed phone’s previews', async () => {
    const { previews, proxyPort, devPort, active } = await setup();
    const address = new URL(previews.address({ port: devPort }, 'phone-1'));
    const cookie = String((await get(proxyPort, address.hostname, `${address.pathname}${address.search}`)).headers['set-cookie']).split(';')[0];
    active.delete('phone-1');
    expect((await get(proxyPort, address.hostname, '/', cookie)).status).toBe(403);
  });
});
