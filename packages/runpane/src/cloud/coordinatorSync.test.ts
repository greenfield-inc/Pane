import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { parseDirectory } from './coordinator';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

function lastPushed(harness: TestHarness) {
  const pushed = harness.world.pushedDirectories ?? [];
  assert.ok(pushed.length > 0, 'expected a directory push');
  // The coordinator's own parser is the contract: what it rejects, the coordinator would refuse.
  return parseDirectory(pushed[pushed.length - 1]);
}

test('new pushes a directory the coordinator accepts, with the new host in it', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  assert.equal(await run(harness, ['new', '--label', 'Checkout', '--yes', '--no-import']), 0);
  const [record] = await harness.deps.store.listHosts();
  const directory = lastPushed(harness);
  assert.equal(directory.entries.length, 1);
  assert.deepEqual(directory.entries[0], {
    sessionId: record.profile.cloud.sessionId,
    label: 'Checkout',
    provider: 'boat',
    sandboxId: record.profile.cloud.sandboxId,
    baseUrl: record.profile.baseUrl,
    nodeId: record.profile.cloud.nodeId,
    pinnedVersion: null,
    coordinatorToken: null,
    // The wallet boat billed at create (the fake account's active wallet is personal).
    org: 'personal',
    // No repos until the laptop grants some (GitHub broker allowlist).
    githubRepos: [],
    // No repository, so no secrets manifest to read.
    secretsManifest: null,
  });
  assert.match(harness.out.join('\n'), /coordinator: directory updated \(1 cloud Session\)/u);
});

test('with the coordinator enabled, new mints its client and the directory carries its token', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await harness.deps.store.writeSettings({ coordinator: { enabled: true } });
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  const [record] = await harness.deps.store.listHosts();
  assert.equal(lastPushed(harness).entries[0].coordinatorToken, `coordinator-token-${record.profile.cloud.sessionId}`);
  assert.doesNotMatch(harness.out.join('\n'), /coordinator-token-/u);
});

test('destroy pushes a directory without the destroyed host', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await run(harness, ['new', '--yes', '--no-import', '--label', 'a']);
  await run(harness, ['new', '--yes', '--no-import', '--label', 'b']);
  assert.equal(lastPushed(harness).entries.length, 2);
  assert.equal(await run(harness, ['destroy', 'a', '--yes', '--no-import']), 0);
  assert.deepEqual(lastPushed(harness).entries.map((entry) => entry.label), ['b']);
});

test('sync pushes too, and an empty directory is still a valid directory', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  assert.equal(await run(harness, ['sync', '--desktop-dir', harness.desktopDir, '--json']), 0);
  assert.equal(lastPushed(harness).entries.length, 0);
});

test('a failed push warns but never fails the command that already changed the world', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  harness.world.failPush = 'connect ETIMEDOUT';
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  assert.match(harness.err.join('\n'), /directory was not updated \(connect ETIMEDOUT\)\. Retry with: runpane cloud sync/u);
});

test('without a coordinator nothing is pushed and nothing is printed about it', async () => {
  const harness = await createTestHarness();
  assert.equal(await run(harness, ['new', '--yes', '--no-import']), 0);
  assert.doesNotMatch([...harness.out, ...harness.err].join('\n'), /coordinator/u);
});

/** Writes `hosts/<file>` next to the records `new` wrote. */
async function writeHostFile(harness: TestHarness, file: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(harness.deps.store.dir, 'hosts', file), typeof value === 'string' ? value : JSON.stringify(value));
}

async function connectedRecord(harness: TestHarness) {
  assert.equal(await run(harness, ['new', '--yes', '--no-import', '--label', 'kept']), 0);
  const [record] = await harness.deps.store.listHosts();
  return record;
}

test('an invalid host record blocks the whole push instead of publishing the rest', async () => {
  const cases: Array<[string, (record: Awaited<ReturnType<typeof connectedRecord>>) => unknown]> = [
    ['an unknown version', (record) => ({ ...record, version: 2 })],
    ['no sandbox id', (record) => ({ ...record, profile: { ...record.profile, cloud: { ...record.profile.cloud, sandboxId: '' } } })],
    ['no hostname', (record) => ({ ...record, profile: { ...record.profile, cloud: { ...record.profile.cloud, hostname: undefined } } })],
    ['a connected host without a token', (record) => ({ ...record, profile: { ...record.profile, token: '' } })],
    ['a base URL that is not a URL', (record) => ({ ...record, profile: { ...record.profile, baseUrl: 'rp-x:8443' } })],
    ['broker repos that are not strings', (record) => ({ ...record, meta: { ...record.meta, brokerRepos: [42] } })],
  ];
  for (const [problem, corrupt] of cases) {
    const harness = await createTestHarness();
    harness.world.pushedDirectories = [];
    const record = await connectedRecord(harness);
    const pushedBefore = harness.world.pushedDirectories.length;
    const broken = corrupt({ ...record, profile: { ...record.profile, cloud: { ...record.profile.cloud, hostname: 'rp-broken', sessionId: 'other', sandboxId: problem === 'no sandbox id' ? '' : 'bx_other' } } });
    await writeHostFile(harness, 'rp-broken.json', broken);

    assert.equal(await run(harness, ['sync', '--desktop-dir', harness.desktopDir]), 0, problem);
    assert.equal(harness.world.pushedDirectories.length, pushedBefore, `${problem}: nothing pushed`);
    assert.match(harness.err.join('\n'), /directory was not updated \(.*rp-broken\.json/u, problem);
  }
});

test('a host record that is not JSON stops sync before anything is pushed', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  await connectedRecord(harness);
  const pushedBefore = harness.world.pushedDirectories.length;
  await writeHostFile(harness, 'rp-broken.json', '{torn');

  await assert.rejects(run(harness, ['sync', '--desktop-dir', harness.desktopDir]), /rp-broken\.json is not valid JSON/u);
  assert.equal(harness.world.pushedDirectories.length, pushedBefore);
});

test('a host record whose hostname does not match its file name blocks the push', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  const record = await connectedRecord(harness);
  await writeHostFile(harness, 'rp-copy.json', { ...record, profile: { ...record.profile, cloud: { ...record.profile.cloud, sessionId: 'copy' } } });
  const pushedBefore = harness.world.pushedDirectories.length;

  await run(harness, ['sync', '--desktop-dir', harness.desktopDir]);
  assert.equal(harness.world.pushedDirectories.length, pushedBefore);
  assert.match(harness.err.join('\n'), /rp-copy\.json/u);
});

test('a host still being set up (empty connection fields) is valid and left out of the directory', async () => {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  const record = await connectedRecord(harness);
  await writeHostFile(harness, 'rp-pending.json', {
    ...record,
    profile: {
      ...record.profile,
      id: 'cloud-pending',
      baseUrl: '',
      token: '',
      cloud: { ...record.profile.cloud, hostname: 'rp-pending', sessionId: 'pending', sandboxId: 'bx_pending', nodeId: '' },
    },
    meta: { ...record.meta, magicDnsName: '' },
  });

  assert.equal(await run(harness, ['sync', '--desktop-dir', harness.desktopDir]), 0);
  assert.deepEqual(lastPushed(harness).entries.map((entry) => entry.label), ['kept']);
});
