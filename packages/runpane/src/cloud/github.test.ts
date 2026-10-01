import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { mediatedPushTarget, parseRepoSpec, sshAliasFor } from './github';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

const REPO = 'acme/private-app';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

function lastJson<Value>(harness: TestHarness): Value {
  return JSON.parse(harness.out[harness.out.length - 1]);
}

async function harnessWithHost(options: { admin?: boolean; defaultBranch?: string } = {}): Promise<{ harness: TestHarness; host: string }> {
  const harness = await createTestHarness();
  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: options.defaultBranch ?? 'master', admin: options.admin ?? true });
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--yes', '--json', '--no-import']), 0);
  const { host } = lastJson<{ host: { hostname: string } }>(harness);
  return { harness, host: host.hostname };
}

/** Nothing the laptop's GitHub credential touches may reach a sandbox. */
function assertTokenNeverInSandbox(harness: TestHarness): void {
  for (const { script } of harness.world.scripts) assert.ok(!script.includes('laptop-gh-token'), 'token in a sandbox script');
  for (const content of harness.world.files.values()) assert.ok(!content.includes('laptop-gh-token'), 'token in a sandbox file');
}

test('parseRepoSpec accepts owner/name and GitHub URLs, and nothing else', () => {
  for (const spec of ['acme/app', 'https://github.com/acme/app', 'https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'git@github.com-acme-app:acme/app.git']) {
    assert.equal(parseRepoSpec(spec), 'acme/app', spec);
  }
  for (const spec of ['app', 'https://gitlab.com/acme/app', 'acme/app/extra', 'acme/..', '../x']) {
    assert.throws(() => parseRepoSpec(spec), /not a GitHub repository/u, spec);
  }
  assert.equal(sshAliasFor('Acme/My.App'), 'github.com-acme-my.app');
});

test('mediatedPushTarget only ever writes under the prefix, never the default branch, main or master', () => {
  assert.equal(mediatedPushTarget('cloud/rp-x/', 'feature/a', 'master'), 'cloud/rp-x/feature/a');
  assert.throws(() => mediatedPushTarget('', 'master', 'master'), /--prefix/u);
  assert.throws(() => mediatedPushTarget('cloud', 'x', 'master'), /--prefix/u);
  assert.throws(() => mediatedPushTarget('../', 'x', 'master'), /--prefix/u);
  assert.throws(() => mediatedPushTarget('release/', 'main', 'release/main'), /never pushes to the default branch/u);
  for (const branch of ['..', 'a..b', '-x', 'a b', 'x.lock', 'HEAD', 'a//b', '.hidden', 'a/', 'a~1', 'a:b']) {
    assert.throws(() => mediatedPushTarget('cloud/h/', branch, 'master'), /not a branch name/u, branch);
  }
});

test('connect generates the key in the sandbox, registers only its public half read-only, and proves a clone works', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', `https://github.com/${REPO}.git`, '--json']), 0);

  const result = lastJson<{ grant: { repo: string; mode: string; readOnly: boolean; keyId: number; sshAlias: string }; cloneUrl: string }>(harness);
  assert.equal(result.grant.repo, REPO);
  assert.equal(result.grant.mode, 'deploy-key');
  assert.equal(result.grant.readOnly, true);
  assert.equal(result.cloneUrl, `git@github.com-acme-private-app:${REPO}.git`);

  const [key] = harness.world.github.keys;
  assert.equal(key.readOnly, true);
  assert.match(key.key, /^ssh-ed25519 /u);
  assert.equal(key.id, result.grant.keyId);
  const calls = harness.world.calls;
  assert.ok(calls.findIndex((call) => call.startsWith('sandbox-keygen')) < calls.findIndex((call) => call.startsWith('github-add-key')));
  assert.ok(calls.findIndex((call) => call.startsWith('github-add-key')) < calls.findIndex((call) => call.startsWith('sandbox-ls-remote')));
  assert.ok(calls.some((call) => call.endsWith(result.cloneUrl)), 'verified with the alias URL');

  const keygen = harness.world.scripts.find(({ script }) => script.includes('ssh-keygen'))?.script ?? '';
  assert.match(keygen, /StrictHostKeyChecking yes/u);
  assert.match(keygen, /github\.com ssh-ed25519 AAAA/u, 'pins github.com host keys from the API');
  assert.match(keygen, /chmod 600 \/home\/user\/\.ssh\/rp_github_acme-private-app\n/u);

  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.meta.github?.[0].keyId, key.id);
  assert.deepEqual(record.meta.github?.[0].tokenSource, { kind: 'gh' });
  assertTokenNeverInSandbox(harness);
});

test('connect --read-write registers a writable key and warns', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO, '--read-write']), 0);
  assert.equal(harness.world.github.keys[0].readOnly, false);
  assert.ok(harness.err.some((line) => line.includes('--read-write lets anything')));
});

test('connect removes the key again when the sandbox cannot read the repository with it', async () => {
  const { harness, host } = await harnessWithHost();
  harness.world.github.verifyFails = true;
  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO]), /Permission denied/u);
  assert.equal(harness.world.github.keys.length, 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('github-delete-key')));
  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.meta.github, undefined);
});

test('connect keeps the grant when the sandbox cannot read with the key and GitHub refuses to delete it', async () => {
  const { harness, host } = await harnessWithHost();
  harness.world.github.verifyFails = true;
  harness.world.github.deleteKeyFails = 'GitHub DELETE failed with HTTP 503';
  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO]),
    (error: Error) => /Permission denied/u.test(error.message) && /HTTP 503/u.test(error.message)
      && error.message.includes(`runpane cloud github disconnect ${host} --repo ${REPO}`));
  assert.equal(harness.world.github.keys.length, 1);
  const [record] = await harness.deps.store.listHosts();
  assert.deepEqual(record.meta.github?.map((grant) => [grant.repo, grant.keyId]), [[REPO, 100]]);

  harness.world.github.deleteKeyFails = undefined;
  assert.equal(await run(harness, ['github', 'disconnect', host, '--repo', REPO, '--json']), 0);
  assert.equal(harness.world.github.keys.length, 0);
});

test('connect refuses without repository admin, and on a sleeping Session, before touching anything', async () => {
  const { harness, host } = await harnessWithHost({ admin: false });
  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO]), /needs admin/u);
  assert.equal(harness.world.github.keys.length, 0);

  const other = await harnessWithHost();
  assert.equal(await run(other.harness, ['stop', other.host, '--yes']), 0);
  await assert.rejects(run(other.harness, ['github', 'connect', other.host, '--repo', REPO]), /wake it first/u);
  assert.ok(!other.harness.world.calls.some((call) => call.startsWith('sandbox-keygen') || call.startsWith('github-add-key')));
});

test('connect refuses a second connection to the same repository', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO]), 0);
  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO.toUpperCase()]), /already connected/u);
  assert.equal(harness.world.github.keys.length, 1);
});

test('disconnect deletes the deploy key on GitHub and the key files in the Session', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO]), 0);
  assert.equal(await run(harness, ['github', 'disconnect', host, '--json']), 0);
  const result = lastJson<{ keyDeleted: boolean; sandboxCleaned: boolean }>(harness);
  assert.equal(result.keyDeleted, true);
  assert.equal(result.sandboxCleaned, true);
  assert.equal(harness.world.github.keys.length, 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('sandbox-credential-cleanup')));
  assert.equal(await run(harness, ['github', 'list', '--json']), 0);
  assert.deepEqual(lastJson<{ grants: unknown[] }>(harness).grants, []);
});

test('disconnect of a sleeping Session still deletes the key on GitHub', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO]), 0);
  assert.equal(await run(harness, ['stop', host, '--yes']), 0);
  assert.equal(await run(harness, ['github', 'disconnect', host, '--repo', REPO, '--json']), 0);
  assert.equal(lastJson<{ sandboxCleaned: boolean }>(harness).sandboxCleaned, false);
  assert.equal(harness.world.github.keys.length, 0);
});

test('destroy deletes the Session\'s deploy keys', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO]), 0);
  assert.equal(await run(harness, ['destroy', host, '--yes', '--json']), 0);
  assert.equal(harness.world.github.keys.length, 0);
  assert.deepEqual(lastJson<{ github: { deletedKeys: string[] } }>(harness).github.deletedKeys, [`${REPO}#100`]);
});

test('destroy keeps the Session and its record when a deploy key cannot be deleted, and a retry finishes', async () => {
  const { harness, host } = await harnessWithHost();
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO]), 0);
  const devices = harness.world.devices.length;
  harness.world.github.deleteKeyFails = 'GitHub DELETE failed with HTTP 403: Must have admin rights';
  await assert.rejects(run(harness, ['destroy', host, '--yes', '--json']),
    (error: Error) => error.message.includes(`${REPO}#100`) && error.message.includes(`runpane cloud destroy ${host} --yes`));
  assert.equal(harness.world.sandboxes.size, 1);
  assert.equal(harness.world.devices.length, devices);
  assert.ok(!harness.world.calls.some((call) => call.startsWith('destroy ')));
  const [record] = await harness.deps.store.listHosts();
  assert.deepEqual(record.meta.github?.map((grant) => grant.keyId), [100]);

  harness.world.github.deleteKeyFails = undefined;
  assert.equal(await run(harness, ['destroy', host, '--yes', '--json']), 0);
  assert.deepEqual(lastJson<{ github: { deletedKeys: string[] } }>(harness).github.deletedKeys, [`${REPO}#100`]);
  assert.equal(harness.world.sandboxes.size, 0);
  assert.deepEqual(await harness.deps.store.listHosts(), []);
});

test('new --github clones a private repository over a deploy key made before the clone', async () => {
  const harness = await createTestHarness();
  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: 'main', admin: true });
  assert.equal(await run(harness, ['new', '--repo', `https://github.com/${REPO}`, '--github', '--name-prefix', 'rp-gh', '--yes', '--json', '--no-import']), 0);
  assert.deepEqual(harness.world.provisionRepos, [`git@github.com-acme-private-app:${REPO}.git`]);
  const calls = harness.world.calls;
  assert.ok(calls.findIndex((call) => call.startsWith('github-add-key')) < calls.findIndex((call) => call.startsWith('provision ')));
  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.meta.github?.[0].readOnly, true);
  assert.equal(record.meta.repo?.url, `https://github.com/${REPO}`);
  assertTokenNeverInSandbox(harness);
});

test('new --github checks the credential before creating a sandbox, and revokes the key when setup fails', async () => {
  const harness = await createTestHarness();
  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: 'main', admin: false });
  await assert.rejects(run(harness, ['new', '--repo', REPO, '--github', '--yes']), /cannot add deploy keys/u);
  assert.equal(harness.world.sandboxes.size, 0);

  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: 'main', admin: true });
  harness.world.failProvision = 'boom';
  await assert.rejects(run(harness, ['new', '--repo', REPO, '--github', '--yes']), /boom/u);
  assert.equal(harness.world.github.keys.length, 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('github-delete-key')));
});

test('a failed new --github keeps the sandbox and the grant when the deploy key cannot be deleted', async () => {
  const harness = await createTestHarness();
  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: 'main', admin: true });
  harness.world.failProvision = 'boom';
  harness.world.github.deleteKeyFails = 'GitHub DELETE failed with HTTP 503';
  await assert.rejects(run(harness, ['new', '--repo', REPO, '--github', '--yes']), /boom/u);
  assert.equal(harness.world.github.keys.length, 1);
  assert.equal(harness.world.sandboxes.size, 1);
  const [record] = await harness.deps.store.listHosts();
  const host = record.profile.cloud.hostname;
  assert.deepEqual(record.meta.github?.map((grant) => grant.keyId), [100]);
  assert.ok(harness.err.some((line) => line.includes(`${REPO}#100`) && line.includes(`runpane cloud destroy ${host} --yes`)));

  harness.world.github.deleteKeyFails = undefined;
  assert.equal(await run(harness, ['destroy', host, '--yes']), 0);
  assert.equal(harness.world.github.keys.length, 0);
  assert.equal(harness.world.sandboxes.size, 0);
});

test('new rejects --read-write without --github', () => {
  assert.throws(() => parseCloudArgs(['new', '--repo', REPO, '--read-write', '--yes']), /go with --github/u);
  assert.throws(() => parseCloudArgs(['new', '--github', '--yes']), /needs --repo/u);
});

test('git push moves the branch as a bundle in 4 MiB parts and pushes it from the laptop to cloud/<host>/<branch>', async () => {
  const { harness, host } = await harnessWithHost();
  const data = Buffer.alloc(9 * 1024 * 1024 + 17, 7);
  harness.world.github.bundle = { head: 'a'.repeat(40), origin: `git@github.com-acme-private-app:${REPO}.git`, prerequisites: ['b'.repeat(40)], commits: 3, data };
  assert.equal(await run(harness, ['git', 'push', host, '--path', 'private-app', '--branch', 'feature/x', '--json']), 0);

  const result = lastJson<{ target: string; compareUrl: string; outcome: string }>(harness);
  assert.equal(result.target, `cloud/${host}/feature/x`);
  assert.equal(result.compareUrl, `https://github.com/${REPO}/compare/master...cloud/${host}/feature/x`);
  const [push] = harness.world.github.pushes;
  assert.equal(push.targetRef, `refs/heads/cloud/${host}/feature/x`);
  assert.equal(push.repo, REPO);
  assert.deepEqual(push.bundle, data);
  assert.deepEqual(push.prerequisites, ['b'.repeat(40)]);
  assert.equal(push.bundleRef, 'refs/heads/feature/x');
  assert.equal(harness.world.calls.filter((call) => call.startsWith('read ')).length, 3);
  assert.ok(harness.world.calls.some((call) => call.startsWith('sandbox-xfer-cleanup')));
  const bundle = harness.world.scripts.find(({ script }) => script.includes('git bundle create'))?.script ?? '';
  assert.match(bundle, /cd '\/home\/user\/private-app'/u);
  assertTokenNeverInSandbox(harness);
});

test('git push of a branch GitHub already has fetches the commit itself instead of a bundle', async () => {
  const { harness, host } = await harnessWithHost();
  harness.world.github.bundle = { head: 'c'.repeat(40), origin: `https://github.com/${REPO}.git`, prerequisites: [], commits: 0 };
  assert.equal(await run(harness, ['git', 'push', host, '--path', '/home/user/private-app', '--branch', 'done', '--prefix', 'cloud/review/']), 0);
  const [push] = harness.world.github.pushes;
  assert.equal(push.bundle, undefined);
  assert.deepEqual(push.prerequisites, ['c'.repeat(40)]);
  assert.equal(push.targetRef, 'refs/heads/cloud/review/done');
  assert.ok(harness.out.some((line) => line.includes('compare: https://github.com/')));
});

test('git push refuses the default branch even under a custom prefix, and cleans up the sandbox', async () => {
  const { harness, host } = await harnessWithHost({ defaultBranch: 'release/main' });
  harness.world.github.bundle = { head: 'd'.repeat(40), origin: REPO, prerequisites: [], commits: 1, data: Buffer.from('bundle') };
  await assert.rejects(run(harness, ['git', 'push', host, '--path', 'app', '--branch', 'main', '--prefix', 'release/']), /never pushes to the default branch/u);
  await assert.rejects(run(harness, ['git', 'push', host, '--path', 'app', '--branch', 'x', '--prefix', '']), /--prefix/u);
  assert.equal(harness.world.github.pushes.length, 0);
  assert.ok(harness.world.calls.some((call) => call.startsWith('sandbox-xfer-cleanup')));
});

test('connect --pat-file refuses broad tokens and keeps a fine-grained one only in a 0600 file', async () => {
  const { harness, host } = await harnessWithHost();
  const patFile = path.join(harness.root, 'pat');
  await fs.writeFile(patFile, 'ghp_classicTokenValue\n', { mode: 0o600 });
  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO, '--pat-file', patFile]), /classic or OAuth token/u);

  await fs.writeFile(patFile, 'github_pat_fineGrainedValue\n', { mode: 0o600 });
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO, '--pat-file', patFile, '--json']), 0);
  assert.equal(lastJson<{ grant: { mode: string } }>(harness).grant.mode, 'pat');
  const staged = [...harness.world.files.entries()].filter(([, content]) => content.includes('github_pat_fineGrainedValue'));
  assert.equal(staged.length, 1, 'the token travels once, as a file');
  for (const { script } of harness.world.scripts) assert.ok(!script.includes('github_pat_fineGrainedValue'), 'token in a script');
  const install = harness.world.scripts.find(({ script }) => script.includes('credential-helper'))?.script ?? '';
  assert.match(install, /install -m 600 /u);
  assert.match(install, /credential\.https:\/\/github\.com\/acme\/private-app\.git\.helper/u);
  assert.equal(harness.world.github.keys.length, 0);

  await assert.rejects(run(harness, ['github', 'connect', host, '--repo', REPO, '--pat-file', patFile, '--read-write']), /stands alone/u);
});
