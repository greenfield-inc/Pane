import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

/** The `--json` shapes these tests read; a field the CLI renames breaks the test on purpose. */
interface CloudJson {
  ok: boolean;
  status?: string;
  flushed?: boolean;
  flushedBy?: string;
  blockers?: { condition: string; message: string }[];
  resumed?: boolean;
  serveRepaired?: boolean;
  serveApplied?: boolean;
  guards?: string;
  alreadyStopped?: boolean;
  sameTailnetNode?: boolean;
  baseUrl?: string;
  sandbox?: string;
  deletedNodeIds?: string[];
  checks?: Record<string, string>;
  host?: { hostname: string };
  hosts?: { hostname: string; state: string }[];
  unmanaged?: { sandboxId: string }[];
}

function lastJson(harness: TestHarness): CloudJson {
  return JSON.parse(harness.out[harness.out.length - 1]);
}

async function newHost(harness: TestHarness, extra: string[] = []): Promise<string> {
  await fs.mkdir(harness.desktopDir, { recursive: true });
  const code = await run(harness, ['new', '--label', 'Checkout', '--name-prefix', 'rp-test', '--desktop-dir', harness.desktopDir, '--yes', '--json', ...extra]);
  assert.equal(code, 0);
  const host = lastJson(harness).host;
  assert.ok(host);
  return host.hostname;
}

async function mode(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).mode & 0o777;
}

test('new creates a named sandbox, provisions it, and saves a 0600 host record and pairing file', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness, ['--size', 'large', '--from', 'rp-golden-1']);

  assert.match(hostname, /^rp-test-[a-z0-9]{8}$/u);
  assert.ok(harness.world.calls.includes(`create ${hostname} large rp-golden-1`));
  assert.ok(harness.world.calls.some((call) => call.startsWith('provision ') && call.endsWith(hostname)));

  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.profile.cloud.hostname, hostname);
  assert.equal(record.profile.cloud.provider, 'boat');
  assert.equal(record.profile.cloud.version, 1);
  assert.match(record.profile.cloud.nodeId, /CNTRL$/u);
  assert.equal(record.profile.baseUrl, `https://${hostname}.tailtest.ts.net`);
  assert.equal(record.profile.transport, 'http+sse');
  assert.equal(await mode(path.join(harness.deps.store.dir, 'hosts', `${hostname}.json`)), 0o600);
  assert.equal(await mode(record.meta.pairingPath), 0o600);
  assert.equal(await mode(path.join(harness.deps.store.dir, 'hosts')), 0o700);
});

test('new never prints the daemon token or pairing code', async () => {
  const harness = await createTestHarness();
  await newHost(harness);
  const printed = [...harness.out, ...harness.err].join('\n');
  assert.doesNotMatch(printed, /secret-token-/u);
  assert.doesNotMatch(printed, /pane-remote:\/\//u);
});

test('new adds the host to the desktop saved remote hosts with its cloud field', async () => {
  const harness = await createTestHarness();
  await fs.mkdir(harness.desktopDir, { recursive: true });
  await fs.writeFile(path.join(harness.desktopDir, 'config.json'), JSON.stringify({
    theme: 'dark',
    remoteDaemon: { client: { profiles: [{ id: 'office', label: 'Office', baseUrl: 'https://office', token: 't', transport: 'http+sse' }], activeProfileId: 'office', mode: 'remote' } },
  }));
  const hostname = await newHost(harness);

  const config = JSON.parse(await fs.readFile(path.join(harness.desktopDir, 'config.json'), 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.equal(config.remoteDaemon.client.activeProfileId, 'office');
  assert.equal(config.remoteDaemon.client.mode, 'remote');
  assert.equal(config.remoteDaemon.client.profiles.length, 2);
  const cloudProfile = config.remoteDaemon.client.profiles[1];
  assert.equal(cloudProfile.cloud.hostname, hostname);
  assert.equal(cloudProfile.label, 'Checkout');
  assert.match(cloudProfile.token, /^secret-token-/u);
});

test('new without --yes refuses before touching the provider', async () => {
  const harness = await createTestHarness();
  await assert.rejects(run(harness, ['new']), /--yes/u);
  assert.deepEqual(harness.world.calls, []);
});

test('new without a Tailscale client explains how to run setup', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeCredentials({ boat: { apiKey: 'k' } });
  await assert.rejects(run(harness, ['new', '--yes']), /runpane cloud setup --tailscale-client-id/u);
});

test('a failed setup removes the tailnet device first, then the sandbox, and forgets the host', async () => {
  const harness = await createTestHarness();
  harness.world.failProvision = 'daemon install failed';
  const originalProvision = harness.deps.bootstrap.provision;
  harness.deps.bootstrap.provision = async (sandbox, request, tailnet) => {
    harness.world.devices.push({ nodeId: 'nHALFJOINED', hostname: request.hostname });
    return originalProvision(sandbox, request, tailnet);
  };

  await assert.rejects(run(harness, ['new', '--yes', '--no-import']), /daemon install failed/u);
  const deleteIndex = harness.world.calls.indexOf('tailnet-delete nHALFJOINED');
  const destroyIndex = harness.world.calls.findIndex((call) => call.startsWith('destroy '));
  assert.ok(deleteIndex >= 0 && destroyIndex > deleteIndex, harness.world.calls.join('\n'));
  assert.equal(harness.world.sandboxes.size, 0);
  assert.deepEqual(await harness.deps.store.listHosts(), []);
});

test('new records an unnamed sandbox before naming it, and removes it when naming fails', async () => {
  const named = await createTestHarness();
  named.world.createUnnamed = true;
  await run(named, ['new', '--yes', '--no-import', '--name-prefix', 'rp-test']);
  assert.deepEqual([...named.world.sandboxes.values()].map((sandbox) => sandbox.name.startsWith('rp-test-')), [true]);

  const harness = await createTestHarness();
  harness.world.createUnnamed = true;
  harness.world.failRename = 'boat PATCH failed with HTTP 503';
  await assert.rejects(run(harness, ['new', '--yes', '--no-import']), /PATCH failed/u);
  assert.equal(harness.world.sandboxes.size, 0, harness.world.calls.join('\n'));
  assert.deepEqual(await harness.deps.store.listHosts(), []);
});

test('--keep-on-failure leaves the sandbox for debugging', async () => {
  const harness = await createTestHarness();
  harness.world.failProvision = 'boom';
  await assert.rejects(run(harness, ['new', '--yes', '--no-import', '--keep-on-failure']), /boom/u);
  assert.equal(harness.world.sandboxes.size, 1);
  assert.equal((await harness.deps.store.listHosts()).length, 1);
});

test('the runaway guard refuses new sandboxes past the live limit', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ maxLiveSandboxes: 1 });
  await newHost(harness);
  await assert.rejects(run(harness, ['new', '--yes', '--name-prefix', 'rp-test', '--no-import']), /Runaway guard: 1 cloud sandboxes/u);
});

test('stop flushes, stops and waits; wake resumes and waits for /health on the same node', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  const [record] = await harness.deps.store.listHosts();

  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  const stopped = lastJson(harness);
  assert.equal(stopped.status, 'asleep');
  assert.equal(stopped.flushed, true);
  assert.equal(stopped.flushedBy, 'safe-to-stop');
  assert.ok(harness.world.calls.includes(`safe-to-stop ${record.profile.baseUrl}`));
  assert.ok(!harness.world.scripts.some((entry) => entry.script.includes('sync')));
  assert.equal(harness.world.sandboxes.get(record.profile.cloud.sandboxId)?.state, 'stopped');

  assert.equal(await run(harness, ['status', hostname, '--json']), 0);
  assert.equal(lastJson(harness).status, 'asleep');

  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  const woke = lastJson(harness);
  assert.equal(woke.status, 'awake');
  assert.equal(woke.resumed, true);
  assert.equal(woke.sameTailnetNode, true);
  assert.equal(woke.baseUrl, record.profile.baseUrl);

  assert.equal(await run(harness, ['status', hostname, '--json']), 0);
  assert.equal(lastJson(harness).status, 'awake');
});

test('wake of an awake host does not resume it again', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.equal(lastJson(harness).resumed, false);
  assert.ok(!harness.world.calls.some((call) => call.startsWith('resume ')));
});

test('stop warns about what is still running but stops, and falls back to sync when the daemon cannot answer', async () => {
  const busy = await createTestHarness();
  const busyHost = await newHost(busy);
  busy.world.safeToStop = { safe: false, blockers: [{ condition: 'agent-working', message: 'Agent in panel p1 is working' }] };
  assert.equal(await run(busy, ['stop', busyHost, '--yes', '--json']), 0);
  const stopped = lastJson(busy);
  assert.equal(stopped.status, 'asleep');
  assert.deepEqual(stopped.blockers, [{ condition: 'agent-working', message: 'Agent in panel p1 is working' }]);
  assert.ok(busy.err.some((line) => line.includes('agent-working')), busy.err.join('\n'));

  const old = await createTestHarness();
  const oldHost = await newHost(old);
  old.world.safeToStop = 'unreachable';
  assert.equal(await run(old, ['stop', oldHost, '--yes', '--json']), 0);
  assert.equal(lastJson(old).flushedBy, 'sync');
  assert.ok(old.world.scripts.some((entry) => entry.script.includes('sync')));
});

test('wake re-applies a Tailscale Serve config that the resume lost (node Running, /health unreachable)', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  await run(harness, ['stop', hostname, '--yes']);
  harness.world.serveLost.add(hostname);
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  const woke = lastJson(harness);
  assert.equal(woke.status, 'awake');
  assert.equal(woke.serveRepaired, true);
  assert.ok(harness.world.calls.some((call) => call.startsWith('repair-serve ') && call.endsWith(' https')));
});

test('repair fixes an awake Session in place and never starts or stops one', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  harness.world.serveLost.add(hostname);
  const mutations = () => harness.world.calls.filter((call) => /^(stop|resume) /u.test(call)).length;
  assert.equal(await run(harness, ['repair', hostname, '--json']), 0);
  const repaired = lastJson(harness);
  assert.equal(repaired.serveApplied, true);
  assert.equal(repaired.guards, 'installed');
  assert.equal(mutations(), 0);

  assert.equal(await run(harness, ['repair', hostname, '--json']), 0, 'idempotent');
  assert.equal(lastJson(harness).serveApplied, false);

  await run(harness, ['stop', hostname, '--yes']);
  const before = mutations();
  await assert.rejects(run(harness, ['repair', hostname]), /asleep; repair only works on an awake Session/u);
  assert.equal(mutations(), before, 'repair never wakes a sleeping Session');
});

test('stop of a stopped host is a no-op', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  await run(harness, ['stop', hostname, '--yes']);
  const stopsBefore = harness.world.calls.filter((call) => call.startsWith('stop ')).length;
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  assert.equal(lastJson(harness).alreadyStopped, true);
  assert.equal(harness.world.calls.filter((call) => call.startsWith('stop ')).length, stopsBefore);
});

test('destroy deletes the tailnet device before the sandbox, then forgets the host everywhere', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  const [record] = await harness.deps.store.listHosts();

  assert.equal(await run(harness, ['destroy', hostname, '--yes', '--desktop-dir', harness.desktopDir, '--json']), 0);
  const deleteIndex = harness.world.calls.indexOf(`tailnet-delete ${record.profile.cloud.nodeId}`);
  const destroyIndex = harness.world.calls.indexOf(`destroy ${record.profile.cloud.sandboxId}`);
  assert.ok(deleteIndex >= 0 && destroyIndex > deleteIndex, harness.world.calls.join('\n'));
  assert.equal(harness.world.devices.length, 0);
  assert.equal(harness.world.sandboxes.size, 0);
  assert.deepEqual(await harness.deps.store.listHosts(), []);
  await assert.rejects(fs.access(record.meta.pairingPath));
  const config = JSON.parse(await fs.readFile(path.join(harness.desktopDir, 'config.json'), 'utf8'));
  assert.deepEqual(config.remoteDaemon.client.profiles, []);
  const result = lastJson(harness);
  assert.deepEqual(result.deletedNodeIds, [record.profile.cloud.nodeId]);
  assert.equal(result.sandbox, 'deleted');
});

test('destroy requires --yes', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  await assert.rejects(run(harness, ['destroy', hostname]), /--yes/u);
  assert.equal(harness.world.sandboxes.size, 1);
});

test('list merges local hosts with provider state and flags unmanaged look-alikes', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  harness.world.sandboxes.set('bx_stray001', { id: 'bx_stray001', name: 'rp-strayhost', state: 'running', providerState: 'idle', pending: [] });
  harness.world.sandboxes.set('bx_devbox01', { id: 'bx_devbox01', name: 'my-devbox', state: 'running', providerState: 'idle', pending: [] });

  assert.equal(await run(harness, ['list', '--json']), 0);
  const listed = lastJson(harness);
  assert.equal(listed.hosts?.length, 1);
  assert.equal(listed.hosts?.[0].hostname, hostname);
  assert.equal(listed.hosts?.[0].state, 'running');
  assert.deepEqual(listed.unmanaged?.map((entry) => entry.sandboxId), ['bx_stray001']);
  assert.doesNotMatch(harness.out.join('\n'), /secret-token-/u);
});

test('status reports lost when the provider no longer has the sandbox', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  harness.world.sandboxes.clear();
  assert.equal(await run(harness, ['status', hostname, '--json']), 1);
  assert.equal(lastJson(harness).status, 'lost');
});

test('status reports daemon-down when the sandbox runs but /health does not answer', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  harness.world.healthy.clear();
  assert.equal(await run(harness, ['status', hostname, '--json']), 0);
  assert.equal(lastJson(harness).status, 'daemon-down');
});

test('pair prints the pairing code only when asked, with a warning', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  harness.out.length = 0;
  assert.equal(await run(harness, ['pair', hostname]), 0);
  assert.match(harness.out.join('\n'), /^pane-remote:\/\//u);
  assert.match(harness.err.join('\n'), /full control/u);
});

test('hosts can be selected by label, session id or sandbox id', async () => {
  const harness = await createTestHarness();
  await newHost(harness);
  const [record] = await harness.deps.store.listHosts();
  for (const selector of ['Checkout', record.profile.cloud.sessionId, record.profile.cloud.sandboxId]) {
    assert.equal(await run(harness, ['status', selector, '--json']), 0);
  }
  await assert.rejects(run(harness, ['status', 'nope']), /No cloud host matches "nope"/u);
});

test('sync re-imports every host into the desktop and keeps the desktop profile id', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  const configPath = path.join(harness.desktopDir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.remoteDaemon.client.profiles[0].id = 'desktop-chosen-id';
  config.remoteDaemon.client.activeProfileId = 'desktop-chosen-id';
  config.remoteDaemon.client.mode = 'remote';
  await fs.writeFile(configPath, JSON.stringify(config));

  assert.equal(await run(harness, ['sync', '--desktop-dir', harness.desktopDir, '--json']), 0);
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(after.remoteDaemon.client.profiles.length, 1);
  assert.equal(after.remoteDaemon.client.profiles[0].id, 'desktop-chosen-id');
  assert.equal(after.remoteDaemon.client.profiles[0].cloud.hostname, hostname);
  assert.equal(after.remoteDaemon.client.activeProfileId, 'desktop-chosen-id');
});

test('destroy of the active desktop host switches the desktop back to local', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  const configPath = path.join(harness.desktopDir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.remoteDaemon.client.activeProfileId = config.remoteDaemon.client.profiles[0].id;
  config.remoteDaemon.client.mode = 'remote';
  await fs.writeFile(configPath, JSON.stringify(config));

  await run(harness, ['destroy', hostname, '--yes', '--desktop-dir', harness.desktopDir]);
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(after.remoteDaemon.client.activeProfileId, null);
  assert.equal(after.remoteDaemon.client.mode, 'local');
});

test('new skips the desktop import when no desktop config exists and says how to import later', async () => {
  const harness = await createTestHarness();
  const code = await run(harness, ['new', '--yes']);
  assert.equal(code, 0);
  assert.match(harness.out.join('\n'), /desktop: not imported/u);
  assert.match(harness.out.join('\n'), /runpane cloud sync/u);
});

test('setup stores keys 0600, verifies them, and never prints them', async () => {
  const harness = await createTestHarness();
  const keyFile = path.join(harness.root, 'boat.key');
  const secretFile = path.join(harness.root, 'ts.secret');
  await fs.writeFile(keyFile, 'boat_live_key_value\n');
  await fs.writeFile(secretFile, 'ts-oauth-secret-value\n');

  assert.equal(await run(harness, [
    'setup', '--boat-key-file', keyFile, '--tailscale-client-id', 'kClient', '--tailscale-secret-file', secretFile,
    '--golden', 'rp-golden-7', '--size', 'large', '--json',
  ]), 0);
  const credentials = await harness.deps.store.readCredentials();
  assert.equal(credentials.boat?.apiKey, 'boat_live_key_value');
  assert.equal(credentials.tailscale?.clientSecret, 'ts-oauth-secret-value');
  assert.equal(await mode(path.join(harness.deps.store.dir, 'credentials.json')), 0o600);
  assert.deepEqual(await harness.deps.store.readSettings(), { goldenSnapshot: 'rp-golden-7', size: 'large' });
  const printed = harness.out.join('\n');
  assert.doesNotMatch(printed, /boat_live_key_value|ts-oauth-secret-value/u);
  const summary = lastJson(harness);
  assert.deepEqual(summary.checks, { boat: 'ok (fake@example.test)', tailscale: 'ok' });
});

test('coordinator subcommands are delegated with their raw arguments', async () => {
  const harness = await createTestHarness();
  await assert.rejects(run(harness, ['coordinator', 'alerts']), /not available/u);
  let seen: string[] = [];
  harness.deps.runCoordinator = async (argv) => {
    seen = argv;
    return 0;
  };
  assert.equal(await run(harness, ['coordinator', 'mint-token', 'user:owner', '--json']), 0);
  assert.deepEqual(seen, ['mint-token', 'user:owner', '--json']);
});
