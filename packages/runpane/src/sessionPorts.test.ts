import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonObject, JsonValue } from './boundaryDecoder';
import { parseRunpaneArgs } from './commands';
import { CLOUD_PORT_USAGE, parsePortsArgv, PORT_USAGE, runPortsCommand } from './sessionPorts';
import { parseCloudArgs } from './cloud/args';
import { runCloudCommand } from './cloud/commands';
import { createTestHarness } from './cloud/__tests__/fakes';

const HOST = 'rp-a1b2c3d4.tail-example.ts.net';

function port(overrides: JsonObject = {}): JsonObject {
  return {
    name: 'site', port: 8787, httpsPort: 8787, url: `https://${HOST}:8787/`, scheme: 'https', path: '/',
    source: 'user', createdAt: '2026-09-30T23:00:00.000Z', status: 'serving', ...overrides,
  };
}

function listResult(ports: JsonObject[]): JsonObject {
  return {
    ok: true, available: true, host: HOST, scheme: 'https', autoOpen: false, ports,
    suggested: [{ port: 5173, address: '127.0.0.1', process: 'node', pid: 42, detectedAt: '2026-09-30T23:00:00.000Z' }],
    manifests: [{ repo: '/home/user/app', ok: true, count: 1 }],
  };
}

test('runpane port: parses open, list, close and auto-open', () => {
  assert.deepEqual(parsePortsArgv(['open', '8787', '--name', 'site', '--https-port=8443', '--path', '/s/x', '--yes', '--json'], { withHost: false, usage: PORT_USAGE }), {
    host: undefined,
    command: { sub: 'open', request: { name: 'site', httpsPort: 8443, path: '/s/x', yes: true, port: 8787 }, json: true },
  });
  assert.deepEqual(parsePortsArgv(['list', '--verify'], { withHost: false, usage: PORT_USAGE }).command, { sub: 'list', verify: true, json: false });
  assert.deepEqual(parsePortsArgv(['close', 'site'], { withHost: false, usage: PORT_USAGE }).command, { sub: 'close', target: 'site', json: false });
  assert.deepEqual(parsePortsArgv(['close', '8787'], { withHost: false, usage: PORT_USAGE }).command, { sub: 'close', target: 8787, json: false });
  assert.deepEqual(parsePortsArgv(['auto-open', 'on'], { withHost: false, usage: PORT_USAGE }).command, { sub: 'auto-open', autoOpen: true, json: false });
  assert.deepEqual(parsePortsArgv(['open', 'rp-x', '3000'], { withHost: true, usage: CLOUD_PORT_USAGE }).host, 'rp-x');
  assert.throws(() => parsePortsArgv(['open', '70000'], { withHost: false, usage: PORT_USAGE }), /1-65535/u);
  assert.throws(() => parsePortsArgv(['list', '--yes'], { withHost: false, usage: PORT_USAGE }), /only applies to port open/u);
  assert.throws(() => parsePortsArgv(['open', '1', '--scheme', 'ftp'], { withHost: false, usage: PORT_USAGE }), /--scheme/u);
  assert.throws(() => parsePortsArgv(['open'], { withHost: true, usage: CLOUD_PORT_USAGE }), /needs a host/u);
});

test('runpane port: the shared parser keeps --host and --pane-dir for the daemon target', () => {
  const parsed = parseRunpaneArgs(['--host', 'rp-a1b2c3d4', 'port', 'list', '--json']);
  assert.equal(parsed.command, 'port list');
  assert.equal(parsed.host, 'rp-a1b2c3d4');
  assert.deepEqual(parsed.portArgv, ['list', '--json']);
  const local = parseRunpaneArgs(['port', 'open', '8787', '--pane-dir', '/tmp/p', '--yes']);
  assert.equal(local.paneDir, '/tmp/p');
  assert.deepEqual(local.portArgv, ['open', '8787', '--yes']);
  assert.equal(parseRunpaneArgs(['port', '--help']).command, 'help');
});

test('runpane port list prints URLs, suggestions and manifests', async () => {
  const out: string[] = [];
  const calls: Array<[string, JsonValue]> = [];
  const code = await runPortsCommand({ sub: 'list', verify: true, json: false }, {
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      return listResult([port({ reachable: true }), port({ name: 'api', port: 3000, httpsPort: 8443, url: `https://${HOST}:8443/`, reachable: false, detail: 'Tailscale Serve answered 502' })]);
    },
    stdout: (line) => out.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['runpane:ports:list', [{ verify: true }]]]);
  const text = out.join('\n');
  assert.match(text, /site\s+8787\s+https:\/\/rp-a1b2c3d4\.tail-example\.ts\.net:8787\/\s+user\s+serving\s+yes/u);
  assert.match(text, /api\s+3000\s+.*NO/u);
  assert.match(text, /5173 on 127\.0\.0\.1 \(node\): runpane port open 5173/u);
  assert.match(text, /Manifest \/home\/user\/app\/\.runpane\/ports\.json: 1 port/u);
});

test('runpane port list says when the daemon cannot read its ports state file', async () => {
  const out: string[] = [];
  const stateError = '/home/user/.runpane-cloud/ports.json is unreadable (not JSON); Pane keeps it as is and changes no ports until it is repaired or removed';
  const code = await runPortsCommand({ sub: 'list', verify: false, json: false }, {
    invoke: async () => ({ ...listResult([]), stateError }),
    stdout: (line) => out.push(line),
  });
  assert.equal(code, 0);
  assert.ok(out.includes(`  State file problem: ${stateError}`), out.join('\n'));
});

test('runpane port open prints the URL and what it replaced', async () => {
  const out: string[] = [];
  await runPortsCommand({ sub: 'open', request: { port: 8787, yes: true }, json: false }, {
    invoke: async () => ({ ok: true, port: port(), alreadyOpen: false, replaced: { httpsPort: 8787, was: 'plain tcp -> 127.0.0.1:8787' } }),
    stdout: (line) => out.push(line),
  });
  assert.deepEqual(out, ['Replaced the Tailscale Serve entry on :8787 (plain tcp -> 127.0.0.1:8787).', `Published site: https://${HOST}:8787/`]);
});

test('runpane cloud port list calls the host daemon and checks each URL from this machine', async () => {
  const harness = await createTestHarness();
  assert.equal(await runCloudCommand(parseCloudArgs(['new', '--label', 'Ports', '--name-prefix', 'rp-test', '--no-import', '--yes', '--json']), harness.deps), 0);
  const created: { host: { hostname: string } } = JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
  const channels: string[] = [];
  harness.deps.invokeDaemon = async (_profile, channel) => {
    channels.push(channel);
    if (channel === 'runpane:ports:open') return { ok: true, port: port(), alreadyOpen: false };
    return listResult([port(), port({ name: 'down', port: 3000, status: 'missing' })]);
  };
  harness.out.length = 0;
  assert.equal(await runCloudCommand(parseCloudArgs(['port', 'open', created.host.hostname, '8787', '--name', 'site']), harness.deps), 0);
  assert.equal(await runCloudCommand(parseCloudArgs(['port', 'list', created.host.hostname, '--json']), harness.deps), 0);
  assert.deepEqual(channels, ['runpane:ports:open', 'runpane:ports:list']);
  const listed: { ports: Array<{ name: string; reachable: boolean }> } = JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
  // The fake URL does not resolve from here; a missing entry is not even tried.
  assert.deepEqual(listed.ports.map((entry) => [entry.name, entry.reachable]), [['site', false], ['down', false]]);
});
