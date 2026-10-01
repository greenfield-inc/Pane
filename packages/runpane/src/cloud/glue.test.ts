import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { isCoordinatorLifecycleCommand, parseCoordinatorArgs } from './coordinatorDeploy';
import { parseCoordinatorRevokeArgs } from './coordinatorRevoke';
import { parsePeersArgs } from './peers';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// The glue between the W1 pieces: coordinator deploy/stop/start/destroy, peers allow/revoke,
// agent credentials at `new`, and the peers list written into sandboxes.

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

/** The `--json` fields these tests read. */
interface GlueJson {
  host?: { hostname: string };
  state?: string;
  grants?: { from: string; to: string }[];
  peersFile?: { written: boolean };
  agentCredentials?: string[];
  status?: string;
  repaired?: { oldNodeId: string; nodeId: string } | null;
  coordinatorClientsRevoked?: string[];
  coordinatorClientsNotRevoked?: { host: string; reason: string }[];
  coordinatorClientsPaired?: string[];
  revoked?: string[];
}

function lastJson(harness: TestHarness): GlueJson {
  return JSON.parse(harness.out[harness.out.length - 1]);
}

async function newHost(harness: TestHarness, label: string): Promise<string> {
  assert.equal(await run(harness, ['new', '--label', label, '--name-prefix', 'rp-test', '--no-import', '--yes', '--json']), 0);
  const host = lastJson(harness).host;
  assert.ok(host);
  return host.hostname;
}

function peersFile(harness: TestHarness, hostname: string): { v: number; hosts: { label: string; token: string; cloud?: { hostname: string } }[]; coordinator?: { baseUrl: string; token: string } } {
  const sandbox = [...harness.world.sandboxes.values()].find((candidate) => candidate.name === hostname);
  assert.ok(sandbox, `no sandbox ${hostname}; have ${[...harness.world.sandboxes.values()].map((candidate) => candidate.name).join(', ')}`);
  const content = harness.world.files.get(`${sandbox.id}:/home/user/.config/runpane-cloud/peers.json`);
  assert.ok(content, `no peers.json in ${hostname}`);
  return JSON.parse(content);
}

test('coordinator lifecycle routing: status alone is ours, status <host> is the coordinator\'s', () => {
  assert.equal(isCoordinatorLifecycleCommand(['deploy', '--yes']), true);
  assert.equal(isCoordinatorLifecycleCommand(['status']), true);
  assert.equal(isCoordinatorLifecycleCommand(['status', '--json']), true);
  assert.equal(isCoordinatorLifecycleCommand(['status', 'rp-abc']), false);
  assert.equal(isCoordinatorLifecycleCommand(['wake', 'rp-abc']), false);
  assert.equal(isCoordinatorLifecycleCommand([]), false);
});

test('coordinator deploy args: a pin needs version, url and sha256', () => {
  assert.throws(() => parseCoordinatorArgs(['deploy', '--pin-version', '1.2.3']), /all three/u);
  assert.throws(() => parseCoordinatorArgs(['deploy', '--pin-version', '1', '--pin-deb-url', 'u', '--pin-deb-sha256', 'xyz']), /64 lowercase hex/u);
  assert.throws(() => parseCoordinatorArgs(['deploy', '--pin-version', '2.4.142', '--pin-deb-url', 'http://example.test/pane.deb', '--pin-deb-sha256', 'a'.repeat(64)]), /https/u);
  assert.throws(() => parseCoordinatorArgs(['stop', '--name', 'x']), /Unknown option/u);
  const parsed = parseCoordinatorArgs(['deploy', '--yes', '--no-reconcile', '--idle-check-seconds', '60', '--name', 'rp-coord2']);
  assert.equal(parsed.reconcile, false);
  assert.equal(parsed.idleCheckSeconds, 60);
  assert.equal(parsed.name, 'rp-coord2');
  assert.equal(parsed.stopOrphans, undefined);
  assert.equal(parseCoordinatorArgs(['deploy', '--stop-orphans']).stopOrphans, true);
  assert.equal(parseCoordinatorArgs(['deploy', '--no-stop-orphans']).stopOrphans, false);
});

test('coordinator deploy creates a small tailnet sandbox, a scoped key, and wires this machine to it', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test', goldenSnapshot: 'rp-golden-1' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);

  assert.ok(harness.world.calls.includes('create rp-test-coord small rp-golden-1'));
  assert.ok(harness.world.calls.some((call) => call.startsWith('join ') && call.endsWith('rp-test-coord')));
  assert.ok(harness.world.calls.includes('scoped-key runpane-cloud-coordinator rp-test-coord sandbox.read,sandbox.stop,sandbox.resume'));

  const settings = await harness.deps.store.readSettings();
  assert.equal(settings.coordinator?.enabled, true);
  const deployment = settings.coordinator?.deployment;
  assert.ok(deployment);
  assert.equal(deployment.baseUrl, 'http://rp-test-coord.tailtest.ts.net:47300');
  assert.equal(deployment.managedPrefix, 'rp-test-');

  // The config the service reads: tailnet-only listen address, its own sandbox excluded, scoped key file.
  const config = JSON.parse(harness.world.files.get(`${deployment.sandboxId}:/home/user/.runpane-cloud/coordinator-stage/config.json`) ?? '{}');
  assert.equal(config.listenHost, '100.64.0.9');
  assert.equal(config.selfSandboxId, deployment.sandboxId);
  assert.equal(config.managedNamePrefix, 'rp-test-');
  assert.deepEqual(config.reconcile, { enabled: true, stopOrphans: false }, 'orphans are alert-only unless --stop-orphans');
  assert.equal(harness.world.files.get(`${deployment.sandboxId}:/home/user/.runpane-cloud/coordinator-stage/boat-scoped-key`), 'scoped-secret-value\n');

  const client = JSON.parse(await fs.readFile(harness.deps.store.coordinatorClientPath, 'utf8'));
  assert.equal(client.baseUrl, deployment.baseUrl);
  assert.match(client.token, /^rpc1\.user:/u);
  assert.equal((await fs.stat(harness.deps.store.coordinatorClientPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(harness.deps.store.dir, 'coordinator-secret'))).mode & 0o777, 0o600);
  assert.equal(harness.world.pushedDirectories.length, 1);

  // Secrets are never printed.
  const printed = [...harness.out, ...harness.err].join('\n');
  assert.doesNotMatch(printed, /scoped-secret-value|rpc1\./u);
});

test('coordinator deploy steps the scoped key lifetime down when the account key expires sooner', async () => {
  const harness = await createTestHarness();
  harness.world.maxKeyTtlDays = 100;
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  assert.equal((await harness.deps.store.readSettings()).coordinator?.deployment?.scopedKeyTtl, '90d');
  assert.equal(harness.world.calls.filter((call) => call.startsWith('scoped-key ')).length, 1);
});

test('coordinator deploy again updates in place: no new sandbox or key, pin applied', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json', '--idle-check-seconds', '60', '--stop-orphans']), 0);
  const creates = harness.world.calls.filter((call) => call.startsWith('create ')).length;
  const sha = 'a'.repeat(64);
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json', '--pin-version', '2.4.142', '--pin-deb-url', 'https://example.test/pane.deb', '--pin-deb-sha256', sha]), 0);
  assert.equal(harness.world.calls.filter((call) => call.startsWith('create ')).length, creates);
  assert.equal(harness.world.calls.filter((call) => call.startsWith('scoped-key ')).length, 1);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.deepEqual(deployment?.pin, { version: '2.4.142', debUrl: 'https://example.test/pane.deb', sha256: sha });
  const config = JSON.parse(harness.world.files.get(`${deployment?.sandboxId}:/home/user/.runpane-cloud/coordinator-stage/config.json`) ?? '{}');
  assert.equal(config.pinnedVersion, '2.4.142');
  assert.equal(config.pinnedDebSha256, sha);
  // Timings given at the first deploy survive a redeploy that does not repeat them.
  assert.equal(config.idleStop.intervalSeconds, 60);
  assert.equal(config.reconcile.stopOrphans, true);
});

// The Session, not the coordinator, decides what runpane:cloud:upgrade installs: the laptop writes the pin
// into each Session (root-owned), and the daemon installs only a request equal to it.
test('the laptop writes the coordinator pin into every Session it reaches: deploy, new, wake and repair', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const awake = await newHost(harness, 'awake');
  const asleep = await newHost(harness, 'asleep');
  assert.equal(harness.world.panePins.get(awake), null, 'no pin yet: new clears any stale one');
  await run(harness, ['stop', asleep, '--yes']);

  const sha = 'a'.repeat(64);
  const pinArgs = ['--pin-version', '2.4.142', '--pin-deb-url', 'https://example.test/pane.deb', '--pin-deb-sha256', sha];
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json', ...pinArgs]), 0);
  const deployed: { panePins: { host: string; written: boolean; reason?: string }[] } = JSON.parse(harness.out[harness.out.length - 1]);
  assert.equal(harness.world.panePins.get(awake), '2.4.142');
  assert.equal(harness.world.panePins.get(asleep), null, 'a sleeping Session is not woken to pin it');
  assert.deepEqual(deployed.panePins.find((result) => result.host === asleep), { host: asleep, written: false, reason: 'sandbox is stopped' });

  // The coordinator's own wake found the old pin (the Session refuses to upgrade); once the laptop has written
  // the new one, it asks the coordinator again, which now upgrades the awake Session.
  harness.world.coordinatorWakes = true;
  const coordinatorWakes = () => harness.world.calls.filter((call) => call.startsWith('coordinator-wake ')).length;
  assert.equal(await run(harness, ['wake', asleep, '--json']), 0);
  assert.equal(harness.world.panePins.get(asleep), '2.4.142', 'the laptop pins a Session when it wakes it');
  assert.equal(coordinatorWakes(), 2);
  const woke: { version: string; pinUpgrade: { status: string; version: string } } = JSON.parse(harness.out[harness.out.length - 1]);
  assert.deepEqual([woke.pinUpgrade.status, woke.pinUpgrade.version, woke.version], ['awake', '2.4.142', '2.4.142']);
  await run(harness, ['stop', asleep, '--yes']);
  harness.world.daemonVersions.set(asleep, '2.4.142');
  assert.equal(await run(harness, ['wake', asleep, '--json']), 0);
  assert.equal(coordinatorWakes(), 3, 'a Session already on the pin is not asked again');
  harness.world.coordinatorWakes = false;
  assert.equal(harness.world.panePins.get(await newHost(harness, 'fresh')), '2.4.142');

  harness.world.panePins.set(awake, null);
  assert.equal(await run(harness, ['repair', awake, '--json']), 0);
  assert.equal(harness.world.panePins.get(awake), '2.4.142');

  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json', '--no-pin']), 0);
  assert.equal(harness.world.panePins.get(awake), null, '--no-pin removes the pin, so the Session refuses every upgrade');
});

test('coordinator stop, status, start and destroy', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.ok(deployment);

  await assert.rejects(run(harness, ['coordinator', 'stop']), /--yes/u);
  assert.equal(await run(harness, ['coordinator', 'stop', '--yes', '--json']), 0);
  assert.equal(await run(harness, ['coordinator', 'status', '--json']), 0);
  assert.equal(lastJson(harness).state, 'stopped');
  assert.equal(await run(harness, ['coordinator', 'start', '--json']), 0);
  assert.equal(lastJson(harness).state, 'running');
  assert.ok(harness.world.calls.includes(`resume ${deployment.sandboxId}`));

  assert.equal(await run(harness, ['coordinator', 'destroy', '--yes', '--json']), 0);
  assert.ok(harness.world.calls.includes(`destroy ${deployment.sandboxId}`));
  assert.ok(harness.world.calls.includes('revoke-key sak_fake1'));
  assert.equal(harness.world.devices.length, 0);
  assert.equal((await harness.deps.store.readSettings()).coordinator?.enabled, false);
  await assert.rejects(fs.access(harness.deps.store.coordinatorClientPath));
});

test('coordinator deploy keeps --name inside the cloud name prefix, so it can never replace a member device', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  harness.world.devices.push({ nodeId: 'nLAPTOP', hostname: 'mac-mini' });
  await assert.rejects(run(harness, ['coordinator', 'deploy', '--yes', '--name', 'mac-mini']), /--name must start with "rp-test-"/u);
  assert.equal(harness.world.sandboxes.size, 0);
  assert.deepEqual(harness.world.devices.map((device) => device.nodeId), ['nLAPTOP']);
});

test('coordinator destroy still finishes when boat refuses the key revocation, and names the key to revoke by hand', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.ok(deployment);
  harness.world.revokeKeyError = 'boat DELETE /api-keys/sak_fake1 failed with HTTP 500';

  assert.equal(await run(harness, ['coordinator', 'destroy', '--yes']), 0);
  assert.ok(harness.world.calls.includes(`destroy ${deployment.sandboxId}`));
  assert.ok(harness.world.calls.includes('revoke-key sak_fake1'));
  assert.match(harness.out.join('\n'), /scoped key NOT revoked \(boat DELETE .*HTTP 500\); revoke sak_fake1 in the provider dashboard/u);
  assert.equal((await harness.deps.store.readSettings()).coordinator?.enabled, false);
});

test('coordinator destroy revokes its client on awake Sessions and forgets the token; a redeploy pairs a new one', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const awake = await newHost(harness, 'Awake');
  const asleep = await newHost(harness, 'Asleep');
  const old = await newHost(harness, 'Old');
  harness.world.daemons.set(awake, { sessions: [], peers: [], coordinatorClients: ['coordinator-token-old'] });
  harness.world.daemons.set(old, { sessions: [], peers: [] });
  const pairingOf = async (host: string) => (await harness.deps.store.listHosts()).find((record) => record.profile.cloud.hostname === host)?.meta;

  assert.equal(await run(harness, ['coordinator', 'destroy', '--yes', '--json']), 0);
  const destroyed = lastJson(harness);
  assert.deepEqual(destroyed.coordinatorClientsRevoked, [awake]);
  assert.deepEqual(destroyed.coordinatorClientsNotRevoked?.map((failure) => failure.host).sort(), [asleep, old].sort());
  assert.match(JSON.stringify(destroyed.coordinatorClientsNotRevoked), /predates coordinator-client revocation/u);
  assert.deepEqual(harness.world.daemons.get(awake)?.coordinatorClients, []);
  const awakeMeta = await pairingOf(awake);
  assert.equal(awakeMeta?.coordinatorPairingPath, undefined, 'the revoked token is forgotten here');
  assert.equal(awakeMeta?.coordinatorClientRevoked, true);
  await assert.rejects(fs.access(harness.deps.store.coordinatorPairingPath(awake)));
  assert.ok((await pairingOf(asleep))?.coordinatorPairingPath, 'an unreachable Session keeps its record for a later revoke-clients');

  // The asleep one wakes: revoke-clients finishes the job.
  harness.world.daemons.set(asleep, { sessions: [], peers: [], coordinatorClients: ['coordinator-token-old'] });
  await assert.rejects(run(harness, ['coordinator', 'revoke-clients', '--json']), /Rerun with --yes/u);
  assert.equal(await run(harness, ['coordinator', 'revoke-clients', '--yes', '--json']), 1, 'Old still runs a Pane without the channel');
  assert.deepEqual(lastJson(harness).revoked, [asleep]);
  assert.deepEqual(harness.world.daemons.get(asleep)?.coordinatorClients, []);

  // A redeploy pairs a fresh client where this machine revoked one, and the directory carries the new token.
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  assert.deepEqual(lastJson(harness).coordinatorClientsPaired?.sort(), [asleep, awake].sort());
  const fresh = harness.world.daemons.get(awake)?.coordinatorClients ?? [];
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0], 'coordinator-token-old');
  assert.equal((await pairingOf(awake))?.coordinatorClientRevoked, undefined);
  assert.equal((await fs.stat(harness.deps.store.coordinatorPairingPath(awake))).mode & 0o777, 0o600);
  const directory = harness.world.pushedDirectories[harness.world.pushedDirectories.length - 1];
  const sessions = Array.isArray(directory.sessions) ? directory.sessions : [];
  assert.ok(sessions.some((session) => JSON.stringify(session).includes(fresh[0])));
  assert.doesNotMatch([...harness.out, ...harness.err].join('\n'), /coordinator-token-/u);
});

test('coordinator revoke-caller keeps revokedCallers in the config across redeploys, and --undo lifts it', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const host = await newHost(harness, 'Peer');
  const [record] = await harness.deps.store.listHosts();
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.ok(deployment);
  const config = () => JSON.parse(harness.world.files.get(`${deployment.sandboxId}:/home/user/.runpane-cloud/coordinator-stage/config.json`) ?? '{}');

  assert.equal(await run(harness, ['coordinator', 'revoke-caller', 'user:old-laptop', '--json']), 0);
  assert.equal(await run(harness, ['coordinator', 'revoke-caller', host, '--json']), 0);
  assert.deepEqual(config().revokedCallers, [record.profile.cloud.sessionId, 'user:old-laptop'].sort());
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  assert.deepEqual(config().revokedCallers, [record.profile.cloud.sessionId, 'user:old-laptop'].sort(), 'a redeploy keeps it');
  assert.equal(await run(harness, ['coordinator', 'revoke-caller', 'user:old-laptop', '--undo', '--json']), 0);
  assert.deepEqual(config().revokedCallers, [record.profile.cloud.sessionId]);
  assert.throws(() => parseCoordinatorRevokeArgs(['revoke-caller']), /revoke-caller <user:name/u);
  await assert.rejects(run(harness, ['coordinator', 'revoke-caller', 'user:bad name']), /user:<name>/u);
});

test('new after a deploy gets a coordinator client and a peers list naming the coordinator', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const hostname = await newHost(harness, 'Alpha');
  const [record] = await harness.deps.store.listHosts();
  assert.ok(record.meta.coordinatorPairingPath, 'new asked bootstrap for the coordinator client');
  const file = peersFile(harness, hostname);
  assert.deepEqual(file.hosts, []);
  assert.match(file.coordinator?.token ?? '', new RegExp(`^rpc1\\.${record.profile.cloud.sessionId}\\.`, 'u'));
  const last = harness.world.pushedDirectories[harness.world.pushedDirectories.length - 1];
  assert.equal(Array.isArray(last.sessions) ? last.sessions.length : -1, 1);
});

test('new places saved agent credentials through the daemon unit, never on a command line', async () => {
  const harness = await createTestHarness();
  const credentials = await harness.deps.store.readCredentials();
  await harness.deps.store.writeCredentials({ ...credentials, anthropic: { apiKey: 'fake-anthropic-0123456789abcdefghij' }, claude: { oauthToken: 'fake-claude-oauth-value' } });
  const hostname = await newHost(harness, 'Keys');
  const sandbox = [...harness.world.sandboxes.values()].find((candidate) => candidate.name === hostname);
  assert.ok(sandbox);
  assert.equal(harness.world.files.get(`${sandbox.id}:/home/user/.runpane-cloud/agent.env`),
    'ANTHROPIC_API_KEY=fake-anthropic-0123456789abcdefghij\nCLAUDE_CODE_OAUTH_TOKEN=fake-claude-oauth-value\n');
  const scripts = harness.world.scripts.map((entry) => entry.script).join('\n');
  assert.doesNotMatch(scripts, /fake-anthropic-|fake-claude-oauth/u);
  assert.match(scripts, /EnvironmentFile=\/home\/user\/\.runpane-cloud\/agent\.env/u);
  assert.deepEqual(lastJson(harness).agentCredentials, ['Anthropic API key', 'Claude token']);
  assert.doesNotMatch([...harness.out, ...harness.err].join('\n'), /fake-anthropic-|fake-claude-oauth/u);
});

test('peers args', () => {
  assert.deepEqual(parsePeersArgs(['allow', 'a', 'b', '--session', 'Main']), { sub: 'allow', json: false, from: 'a', to: 'b', session: 'Main' });
  assert.throws(() => parsePeersArgs(['allow', 'a']), /Usage/u);
  assert.throws(() => parsePeersArgs(['revoke', 'a', 'b', '--session', 'x']), /Unknown option/u);
  assert.deepEqual(parsePeersArgs(['list']), { sub: 'list', json: false, from: undefined, to: undefined });
});

test('peers allow mints a peer on the target, allowlisted to its one Session, and writes the source\'s peers list', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const a = await newHost(harness, 'Alpha');
  const b = await newHost(harness, 'Beta');
  harness.world.daemons.set(b, { sessions: [{ id: 'legacy-pane-chat', name: 'Pane Chat' }, { id: 'sess-b', name: 'Main' }, { id: 'old', name: 'Old', archived: true }], peers: [] });

  // Empty by default.
  assert.deepEqual(peersFile(harness, a).hosts, []);
  assert.equal(await run(harness, ['peers', 'allow', a, b, '--json']), 0);
  const daemon = harness.world.daemons.get(b);
  assert.deepEqual(daemon?.peers, [{ id: 'peer-1', label: 'Alpha', sessions: ['sess-b'] }]);
  const file = peersFile(harness, a);
  assert.equal(file.hosts.length, 1);
  assert.equal(file.hosts[0].label, 'Beta');
  assert.equal(file.hosts[0].token, 'peer-token-peer-1');
  assert.equal(file.hosts[0].cloud?.hostname, b);
  assert.ok(file.coordinator);
  // B's own list is untouched: the grant is one-way.
  assert.deepEqual(peersFile(harness, b).hosts, []);
  assert.doesNotMatch(harness.out.join('\n'), /peer-token-/u);

  await assert.rejects(run(harness, ['peers', 'allow', a, b]), /already message/u);
  assert.equal(await run(harness, ['peers', 'list', '--json']), 0);
  assert.equal(lastJson(harness).grants?.length, 1);

  assert.equal(await run(harness, ['peers', 'revoke', a, b, '--json']), 0);
  assert.deepEqual(harness.world.daemons.get(b)?.peers, []);
  assert.deepEqual(peersFile(harness, a).hosts, []);
  const [record] = (await harness.deps.store.listHosts()).filter((candidate) => candidate.profile.cloud.hostname === a);
  assert.equal(record.meta.peers, undefined);
});

test('peers allow needs a Session choice when the target has several, and says so when it has none', async () => {
  const harness = await createTestHarness();
  const a = await newHost(harness, 'Alpha');
  const b = await newHost(harness, 'Beta');
  harness.world.daemons.set(b, { sessions: [], peers: [] });
  await assert.rejects(run(harness, ['peers', 'allow', a, b]), /no Pane Session yet/u);
  harness.world.daemons.set(b, { sessions: [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }], peers: [] });
  await assert.rejects(run(harness, ['peers', 'allow', a, b]), /--session/u);
  assert.equal(await run(harness, ['peers', 'allow', a, b, '--session', 'Two']), 0);
  assert.deepEqual(harness.world.daemons.get(b)?.peers[0].sessions, ['s2']);
});

test('peers allow to an asleep target explains how to wake it', async () => {
  const harness = await createTestHarness();
  const a = await newHost(harness, 'Alpha');
  const b = await newHost(harness, 'Beta');
  await assert.rejects(run(harness, ['peers', 'allow', a, b]), /runpane cloud wake/u);
});

test('peers allow with the source asleep keeps the grant and writes its list on wake', async () => {
  const harness = await createTestHarness();
  const a = await newHost(harness, 'Alpha');
  const b = await newHost(harness, 'Beta');
  harness.world.daemons.set(b, { sessions: [{ id: 'sess-b', name: 'Main' }], peers: [] });
  assert.equal(await run(harness, ['stop', a, '--yes', '--json']), 0);
  assert.equal(await run(harness, ['peers', 'allow', a, b, '--json']), 0);
  assert.equal(lastJson(harness).peersFile?.written, false);
  assert.equal(await run(harness, ['wake', a, '--json']), 0);
  assert.equal(peersFile(harness, a).hosts.length, 1);
});

test('wake re-enrols a node that came back logged out, keeping its name and bumping the profile version', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness, 'Alpha');
  const [before] = await harness.deps.store.listHosts();
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  harness.world.loggedOut.add(hostname);
  assert.equal(await run(harness, ['wake', hostname, '--json', '--timeout-ms', '5000']), 0);
  const woke = lastJson(harness);
  assert.equal(woke.status, 'awake');
  assert.equal(woke.repaired?.oldNodeId, before.profile.cloud.nodeId);
  const [after] = await harness.deps.store.listHosts();
  assert.equal(after.profile.cloud.nodeId, woke.repaired?.nodeId);
  assert.equal(after.profile.cloud.version, before.profile.cloud.version + 1);
  assert.equal(after.profile.baseUrl, before.profile.baseUrl);
});

test('wake leaves a running node alone when only the daemon is slow', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness, 'Alpha');
  harness.world.healthy.delete(hostname);
  assert.equal(await run(harness, ['wake', hostname, '--json', '--timeout-ms', '3000']), 1);
  assert.ok(harness.world.calls.some((call) => call.startsWith('repair ')));
  assert.equal((await harness.deps.store.listHosts())[0].profile.cloud.version, 1);
});

test('wake goes through the coordinator when one is configured, and resumes directly otherwise', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness, 'Alpha');
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  harness.world.coordinatorWakes = true;
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('coordinator-wake ')));
  assert.ok(!harness.world.calls.some((call) => call.startsWith('resume ')), 'no direct resume after the coordinator woke it');

  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  harness.world.coordinatorWakes = false;
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('resume ')));
});

test('coordinator start re-enrols a node that came back logged out and reinstalls its config', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  assert.equal(await run(harness, ['coordinator', 'stop', '--yes', '--json']), 0);
  harness.world.loggedOut.add('rp-test-coord');
  harness.world.coordinatorHealthy = false;
  const installsBefore = harness.world.scripts.filter((entry) => entry.script.includes('install-service')).length;
  assert.equal(await run(harness, ['coordinator', 'start', '--json']), 0);
  assert.equal(lastJson(harness).state, 'running');
  assert.equal(harness.world.scripts.filter((entry) => entry.script.includes('install-service')).length, installsBefore + 1);
  assert.match((await harness.deps.store.readSettings()).coordinator?.deployment?.nodeId ?? '', /NEW$/u);
});

test('destroy revokes the destroyed Session\'s peer records and drops grants to it', async () => {
  const harness = await createTestHarness();
  const a = await newHost(harness, 'Alpha');
  const b = await newHost(harness, 'Beta');
  const c = await newHost(harness, 'Gamma');
  harness.world.daemons.set(b, { sessions: [{ id: 'sess-b', name: 'Main' }], peers: [] });
  harness.world.daemons.set(a, { sessions: [{ id: 'sess-a', name: 'Main' }], peers: [] });
  assert.equal(await run(harness, ['peers', 'allow', a, b]), 0);
  assert.equal(await run(harness, ['peers', 'allow', c, a]), 0);
  assert.equal(await run(harness, ['destroy', a, '--yes', '--no-import', '--json']), 0);
  assert.deepEqual(harness.world.daemons.get(b)?.peers, []);
  const gamma = (await harness.deps.store.listHosts()).find((record) => record.profile.cloud.hostname === c);
  assert.equal(gamma?.meta.peers, undefined);
  assert.deepEqual(peersFile(harness, c).hosts, []);
});
