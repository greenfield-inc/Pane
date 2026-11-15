import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRemotePwaAssetResponse, isRemotePwaPath } from './pwaStaticAssets';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('Remote PWA static assets', () => {
  it('recognizes only /app routes', () => {
    expect(isRemotePwaPath('/app')).toBe(true);
    expect(isRemotePwaPath('/app/')).toBe(true);
    expect(isRemotePwaPath('/app/assets/index.js')).toBe(true);
    expect(isRemotePwaPath('/invoke')).toBe(false);
    expect(isRemotePwaPath('/events')).toBe(false);
    expect(isRemotePwaPath('/health')).toBe(false);
  });

  it('redirects /app to /app/ so relative assets resolve under /app', async () => {
    const response = await getRemotePwaAssetResponse('/app', { distRoot: createRemoteDist() });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(308);
    expect(response.headers?.Location).toBe('/app/');
  });

  it('serves the remote entrypoint and static assets', async () => {
    const distRoot = createRemoteDist();

    const indexResponse = await getRemotePwaAssetResponse('/app/', { distRoot });
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.headers?.['Content-Type']).toContain('text/html');
    expect(indexResponse.body?.toString()).toContain('Remote Pane test');

    const assetResponse = await getRemotePwaAssetResponse('/app/assets/remote.js', { distRoot });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers?.['Content-Type']).toContain('text/javascript');
    expect(assetResponse.body?.toString()).toContain('remote asset');
  });

  it('serves every app file so no other site can frame it or add scripts to it', async () => {
    const distRoot = createRemoteDist();
    for (const pathname of ['/app/', '/app/assets/remote.js', '/app/sessions/session-1']) {
      const { headers } = await getRemotePwaAssetResponse(pathname, { distRoot });
      expect(headers).toMatchObject({
        'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
    }
  });

  it('falls back to the entrypoint for app routes', async () => {
    const response = await getRemotePwaAssetResponse('/app/sessions/session-1', { distRoot: createRemoteDist() });

    expect(response.statusCode).toBe(200);
    expect(response.headers?.['Content-Type']).toContain('text/html');
    expect(response.body?.toString()).toContain('Remote Pane test');
  });

  it('does not allow paths outside the built frontend directory', async () => {
    const response = await getRemotePwaAssetResponse('/app/..%2F..%2Fpackage.json', { distRoot: createRemoteDist() });

    expect(response.statusCode).toBe(404);
    expect(response.body?.toString()).toContain('invalid');
  });
});

function createRemoteDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-remote-pwa-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'remote.html'), '<html><body>Remote Pane test</body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'remote.js'), 'console.log("remote asset");');
  return dir;
}
