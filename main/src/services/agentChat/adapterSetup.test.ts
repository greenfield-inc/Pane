import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { createServer } from 'http';
import { once } from 'events';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { adapterEntry, installAdapter } from './adapterSetup';

it('provisions the pinned adapter with bundled npm and shares simultaneous host setup', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-adapter-registry-'));
  const packageName = '@agentclientprotocol/codex-acp';
  mkdirSync(path.join(directory, 'dist'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, version: '2.2.2' }));
  writeFileSync(path.join(directory, 'dist', 'index.js'), '// controlled registry package');
  const npm = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
  await promisify(execFile)(process.execPath, [npm, 'pack', '--ignore-scripts', '--json'], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const tarball = readFileSync(path.join(directory, 'agentclientprotocol-codex-acp-2.2.2.tgz'));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  let downloads = 0;
  let registry = '';
  const server = createServer((request, response) => {
    if (request.url?.endsWith('.tgz')) { downloads++; response.end(tarball); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: packageName, 'dist-tags': { latest: '2.2.2' }, versions: { '2.2.2': { name: packageName, version: '2.2.2', dist: { tarball: `${registry}/adapter.tgz`, integrity } } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  registry = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('npm_config_registry', registry);
  vi.stubEnv('npm_config_cache', path.join(directory, 'cache'));
  try {
    expect(adapterEntry('codex')).toBeUndefined();
    await Promise.all([installAdapter('codex'), installAdapter('codex')]);
    expect(downloads).toBe(1);
    expect(adapterEntry('codex')).toMatch(/codex-acp[/\\]dist[/\\]index\.js$/);
    await installAdapter('codex');
    expect(downloads).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
