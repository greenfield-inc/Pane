import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesktopConfigHosts } from './savedHosts';
import type { CloudHostProfile } from './store';

const profile = (fields: { id?: string; baseUrl?: string } = {}): CloudHostProfile => ({
  id: fields.id ?? 'cloud-abc12345xyz',
  label: 'Cloud sandbox',
  baseUrl: fields.baseUrl ?? 'https://rp-abc12345.tail1234.ts.net',
  token: 'paired-token',
  transport: 'http+sse',
  tunnel: { kind: 'tailscale', selected: true },
  cloud: { provider: 'boat', sandboxId: 'bx_1', sessionId: 'abc12345xyz', nodeId: 'n1', hostname: 'rp-abc12345', version: 1 },
});

/** A desktop dir whose config.json holds `config` (JSON text). */
function desktopDir(config: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-desktop-'));
  fs.writeFileSync(path.join(dir, 'config.json'), config, { mode: 0o600 });
  return dir;
}

const readConfig = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('upsert adds the profile and keeps everything else in config.json', async () => {
  const manual = { id: 'manual', label: 'VM', baseUrl: 'https://vm.example', token: 't', transport: 'http+sse' };
  const dir = desktopDir(JSON.stringify({ theme: 'dark', remoteDaemon: { host: { config: { enabled: false } }, client: { profiles: [manual], activeProfileId: null, mode: 'local' } } }));
  await createDesktopConfigHosts(dir).upsert(profile());
  const config = readConfig(dir);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.remoteDaemon.host, { config: { enabled: false } });
  assert.deepEqual(config.remoteDaemon.client.profiles[0], manual);
  assert.equal(config.remoteDaemon.client.profiles[1].cloud.sessionId, 'abc12345xyz');
  assert.deepEqual(config.remoteDaemon.client.profiles[1].hostKind, { label: 'cloud sandbox', icon: 'cloud' });
  // Nobody is at a sandbox's screen: its terminal must print sign-in URLs, never open a browser there.
  assert.deepEqual(config.remoteDaemon.client.profiles[1].hostTerminalEnv, [
    { name: 'BROWSER', value: 'false' },
    { name: 'GH_BROWSER', value: 'false' },
  ]);
  // Its GitHub token is set in the desktop's Settings, so a clone that needs a sign-in points there.
  assert.equal(config.remoteDaemon.client.profiles[1].githubSignIn, 'settings');
  // A sandbox's keyring can't be unlocked without someone at its screen: gh keeps the token in hosts.yml.
  assert.equal(config.remoteDaemon.client.profiles[1].ghInsecureStorage, true);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('upsert replaces the same sandbox in place and keeps the desktop\'s profile id', async () => {
  const dir = desktopDir(JSON.stringify({ remoteDaemon: { client: { profiles: [profile({ id: 'desktop-id' })], activeProfileId: 'desktop-id', mode: 'remote' } } }));
  await createDesktopConfigHosts(dir).upsert(profile({ baseUrl: 'http://rp-abc12345.tail1234.ts.net:42137' }));
  const client = readConfig(dir).remoteDaemon.client;
  assert.equal(client.profiles.length, 1);
  assert.equal(client.profiles[0].id, 'desktop-id');
  assert.equal(client.profiles[0].baseUrl, 'http://rp-abc12345.tail1234.ts.net:42137');
  assert.equal(client.activeProfileId, 'desktop-id');
});

test('remove drops the profile and sends an active desktop back to local', async () => {
  const dir = desktopDir(JSON.stringify({ remoteDaemon: { client: { profiles: [profile()], activeProfileId: 'cloud-abc12345xyz', mode: 'remote' } } }));
  await createDesktopConfigHosts(dir).remove('abc12345xyz');
  assert.deepEqual(readConfig(dir).remoteDaemon.client, { profiles: [], activeProfileId: null, mode: 'local' });
});
