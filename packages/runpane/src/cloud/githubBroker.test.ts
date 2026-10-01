import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { parseDirectory } from './coordinator';
import { agentNotes, installBrokerToolsScript, removeBrokerToolsScript } from './githubBroker';
import { SANDBOX_HOME } from './provider';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

const REPO = 'acme/private-app';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

function lastJson<Value>(harness: TestHarness): Value {
  return JSON.parse(harness.out[harness.out.length - 1]);
}

/** A harness whose coordinator is deployed and whose broker answers `broker`. */
async function brokerHarness(broker?: { mode: 'app' | 'pat' | 'off'; repos?: string[] }): Promise<TestHarness> {
  const harness = await createTestHarness();
  harness.world.github.repos.set(REPO, { fullName: REPO, private: true, defaultBranch: 'master', admin: true });
  harness.world.pushedDirectories = [];
  if (broker) harness.world.broker = { mode: broker.mode, app: broker.mode === 'app' ? 'runpane-cloud-app' : null, repos: broker.repos ?? [REPO] };
  await harness.deps.store.writeSettings({
    coordinator: {
      enabled: true,
      deployment: {
        sandboxId: 'bx_coord', hostname: 'rp-test-coord', nodeId: 'n-coord', baseUrl: 'http://rp-test-coord.tailtest.ts.net:47300',
        scopedKeyId: 'k', managedPrefix: 'rp-gh-', reconcile: true, deployedAt: '2026-09-30T00:00:00Z', appVersion: 'test',
      },
    },
  });
  await harness.deps.store.writeSecretText('coordinator-secret', 'coordinator-hmac-secret');
  return harness;
}

function lastDirectoryEntry(harness: TestHarness): JsonObject {
  const directory = harness.world.pushedDirectories?.at(-1);
  assert.ok(directory, 'a directory was pushed');
  parseDirectory(directory); // the coordinator's own parser still accepts it
  const sessions = decodeBoundary(directory.sessions, boundary.array(boundary.jsonObject));
  return sessions[sessions.length - 1];
}

function scriptsFor(harness: TestHarness, marker: string): string[] {
  return harness.world.scripts.map(({ script }) => script).filter((script) => script.includes(marker));
}

test('new --github with the broker in App mode: no deploy key, repo in the directory, gh shim + helper, clone over https', async () => {
  const harness = await brokerHarness({ mode: 'app' });
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--repo', `https://github.com/${REPO}`, '--github', '--yes', '--json', '--no-import']), 0);
  const result = lastJson<{ host: { hostname: string }; githubBroker: { repos: string[]; mode: string } }>(harness);
  const host = result.host.hostname;
  assert.deepEqual(result.githubBroker.repos, [REPO]);
  assert.equal(result.githubBroker.mode, 'app');

  assert.deepEqual(harness.world.github.keys, [], 'no deploy key');
  assert.ok(!harness.world.calls.some((call) => call.startsWith('github-get-repo')), 'the laptop GitHub credential is not needed');
  assert.ok(!harness.world.provisionRepos.some((url) => url.includes(REPO)), 'provision does not clone before the coordinator knows the Session');

  const entry = lastDirectoryEntry(harness);
  assert.deepEqual(entry.github, { repos: [REPO] });

  const peers: { coordinator?: { baseUrl: string; token: string } } = JSON.parse([...harness.world.files.entries()].find(([key]) => key.endsWith('/peers.json') || key.includes('peers.json'))?.[1] ?? '{}');
  assert.equal(peers.coordinator?.baseUrl, 'http://rp-test-coord.tailtest.ts.net:47300');
  assert.match(peers.coordinator?.token ?? '', /^rpc1\./u);

  const [install] = scriptsFor(harness, 'echo RP_OK broker-tools');
  assert.match(install, /cat > \/home\/user\/\.local\/bin\/gh/u);
  assert.match(install, /credential\.https:\/\/github\.com\.helper' \/home\/user\/\.local\/bin\/git-credential-runpane/u);
  const [clone] = scriptsFor(harness, "printf 'RP_HEAD");
  assert.match(clone, /git clone --quiet 'https:\/\/github\.com\/acme\/private-app\.git' '\/home\/user\/private-app'/u);
  const calls = harness.world.calls;
  assert.ok(calls.indexOf('invoke ' + host + ' runpane:repos:add') > -1, 'the clone is registered with Pane');
  // Order: the directory and peers list exist before the clone asks the coordinator for a token.
  const cloneIndex = harness.world.scripts.findIndex(({ script }) => script.includes("printf 'RP_HEAD"));
  const peersIndex = harness.world.scripts.findIndex(({ script }) => script.includes('peers.json'));
  assert.ok(peersIndex > -1 && peersIndex < cloneIndex);
});

test('new --github with the broker in PAT mode keeps the read-only deploy key and installs the shim without the helper', async () => {
  const harness = await brokerHarness({ mode: 'pat' });
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--repo', `https://github.com/${REPO}`, '--github', '--yes', '--json', '--no-import']), 0);
  assert.equal(harness.world.github.keys.length, 1);
  assert.equal(harness.world.github.keys[0].readOnly, true);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [REPO] });
  const [install] = scriptsFor(harness, 'echo RP_OK broker-tools');
  assert.doesNotMatch(install, /cat > \/home\/user\/\.local\/bin\/git-credential-runpane/u);
  assert.match(install, /cat > \/home\/user\/\.local\/bin\/gh/u);
  assert.deepEqual(scriptsFor(harness, "printf 'RP_HEAD"), [], 'provision cloned over the deploy key');
});

test('new --github falls back to deploy keys when the broker is off, does not reach the repo, or --read-write is asked', async () => {
  const cases: [{ mode: 'app' | 'off'; repos?: string[] }, string[]][] = [[{ mode: 'off' }, []], [{ mode: 'app', repos: ['acme/other'] }, []], [{ mode: 'app' }, ['--read-write']]];
  for (const [broker, extra] of cases) {
    const harness = await brokerHarness(broker);
    assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--repo', `https://github.com/${REPO}`, '--github', ...extra, '--yes', '--json', '--no-import']), 0);
    assert.equal(harness.world.github.keys.length, 1, JSON.stringify(broker));
    assert.equal(lastJson<{ githubBroker: unknown }>(harness).githubBroker, null);
    assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [] });
    assert.deepEqual(scriptsFor(harness, 'echo RP_OK broker-tools'), []);
  }
});

test('github connect --broker adds the repo, syncs directory and peers list, installs the tools; disconnect undoes it', async () => {
  const harness = await brokerHarness({ mode: 'app', repos: [REPO, 'acme/second'] });
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--yes', '--json', '--no-import']), 0);
  const host = lastJson<{ host: { hostname: string } }>(harness).host.hostname;
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [] });

  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO, '--broker', '--json']), 0);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [REPO] });
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', 'https://github.com/acme/second.git', '--broker']), 0);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [REPO, 'acme/second'] });
  assert.match(harness.out.join('\n'), /can now push to cloud\/rp-gh-[a-z0-9-]+\/\* on acme\/second/u);
  const notes = scriptsFor(harness, 'echo RP_OK broker-tools').at(-1) ?? '';
  assert.match(notes, /Repositories: acme\/private-app, acme\/second/u);

  harness.out.length = 0;
  assert.equal(await run(harness, ['github', 'list', host]), 0);
  assert.match(harness.out.join('\n'), /-> acme\/private-app {2}\(coordinator broker, GitHub App/u);

  assert.equal(await run(harness, ['github', 'disconnect', host, '--repo', 'acme/second', '--broker']), 0);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [REPO] });
  assert.equal(await run(harness, ['github', 'disconnect', host, '--broker', '--json']), 0);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [] });
  assert.equal(lastJson<{ toolsRemoved: boolean }>(harness).toolsRemoved, true);
  assert.equal(scriptsFor(harness, 'echo RP_OK broker-tools-removed').length, 1);
  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.meta.brokerRepos, undefined);
  assert.equal(record.meta.brokerMode, undefined);
});

test('github connect --broker explains an off broker, an unreached repo, a missing coordinator and bad combinations', async () => {
  const off = await brokerHarness({ mode: 'off' });
  assert.equal(await run(off, ['new', '--name-prefix', 'rp-gh', '--yes', '--json', '--no-import']), 0);
  const host = lastJson<{ host: { hostname: string } }>(off).host.hostname;
  await assert.rejects(run(off, ['github', 'connect', host, '--repo', REPO, '--broker']), /broker is off.*coordinator github set/u);
  off.world.broker = { mode: 'app', app: null, repos: ['acme/other'] };
  await assert.rejects(run(off, ['github', 'connect', host, '--repo', REPO, '--broker']), /does not reach acme\/private-app/u);
  off.world.broker = undefined;
  await assert.rejects(run(off, ['github', 'connect', host, '--repo', REPO, '--broker']), /can't be asked: No coordinator client is configured/u);
  await assert.rejects(run(off, ['github', 'connect', host, '--repo', REPO, '--broker', '--read-write']), /does not combine/u);
  await assert.rejects(run(off, ['github', 'disconnect', host, '--broker']), /has no broker access/u);
});

// ---------------------------------------------------------------- the Session-side scripts, run for real

async function runInFakeHome(script: string, home: string): Promise<void> {
  execFileSync('bash', ['-c', script.split(SANDBOX_HOME).join(home)], {
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', RP_SYSTEM_BIN: path.join(home, 'usr-local-bin') },
    stdio: 'pipe',
  });
}

test('the install script writes a working gh launcher, the helper config, the PATH guard and the notes; remove undoes only its own parts', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-broker-home-'));
  try {
    // Like Ubuntu's: non-interactive shells (Pane's PATH probe) stop at the top.
    await fs.writeFile(path.join(home, '.bashrc'), '# mine\ncase $- in *i*) ;; *) return;; esac\nalias ll="ls -l"\n');
    await fs.mkdir(path.join(home, 'usr-local-bin'));
    await fs.mkdir(path.join(home, '.claude'));
    await fs.writeFile(path.join(home, '.claude', 'CLAUDE.md'), '# My notes\nKeep tests green.\n');
    const grant = { repos: [REPO], mode: 'app' as const };
    await runInFakeHome(installBrokerToolsScript(grant), home);
    await runInFakeHome(installBrokerToolsScript(grant), home); // idempotent

    const fakeRunpane = path.join(home, 'fake-runpane');
    await fs.writeFile(fakeRunpane, '#!/bin/sh\necho "runpane $*"\n', { mode: 0o755 });
    const env = { ...process.env, HOME: home, PANE_RUNPANE_BIN: fakeRunpane };
    assert.equal(execFileSync(path.join(home, '.local/bin/gh'), ['pr', 'create', '--title', 'a b'], { env, encoding: 'utf8' }).trim(), 'runpane cloud agent gh pr create --title a b');
    assert.equal(execFileSync(path.join(home, '.local/bin/git-credential-runpane'), ['get'], { env, encoding: 'utf8' }).trim(), 'runpane cloud agent git-credential get');

    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    const helpers = execFileSync('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], { env: gitEnv, encoding: 'utf8' });
    assert.equal(helpers, `\n${home}/.local/bin/git-credential-runpane\n`);
    assert.equal(execFileSync('git', ['config', '--global', 'credential.https://github.com.useHttpPath'], { env: gitEnv, encoding: 'utf8' }).trim(), 'true');

    const bashrc = await fs.readFile(path.join(home, '.bashrc'), 'utf8');
    assert.equal(bashrc, '# runpane-cloud-github:start\nexport PATH="$HOME/.local/bin:$PATH"\n# runpane-cloud-github:end\n# mine\ncase $- in *i*) ;; *) return;; esac\nalias ll="ls -l"\n');
    // Pane's packaged PATH probe: bash -c 'source /etc/profile; source ~/.bashrc; echo $PATH' from /etc/environment's PATH.
    const probed = execFileSync('bash', ['-c', 'source ~/.bashrc 2>/dev/null || true; echo $PATH'], { env: { HOME: home, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, encoding: 'utf8' }).trim();
    assert.ok(probed.startsWith(`${home}/.local/bin:`), probed);
    assert.equal(await fs.readlink(path.join(home, 'usr-local-bin', 'gh')), `${home}/.local/bin/gh`, 'the daemon\'s PATH finds the shim via the system bin dir');
    const claude = await fs.readFile(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    assert.equal(claude, `# My notes\nKeep tests green.\n\n${agentNotes([REPO])}\n`);
    assert.match(claude, /always \*\*drafts\*\*/u);
    assert.match(claude, /`master`\/`main` \(the default branch\) is off-limits/u);
    assert.equal(await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), `${agentNotes([REPO])}\n`);

    await runInFakeHome(removeBrokerToolsScript(), home);
    await assert.rejects(fs.access(path.join(home, '.local/bin/gh')));
    await assert.rejects(fs.access(path.join(home, '.local/bin/git-credential-runpane')));
    assert.equal(await fs.readFile(path.join(home, '.bashrc'), 'utf8'), '# mine\ncase $- in *i*) ;; *) return;; esac\nalias ll="ls -l"\n');
    await assert.rejects(fs.lstat(path.join(home, 'usr-local-bin', 'gh')));
    assert.equal(await fs.readFile(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), '# My notes\nKeep tests green.\n\n');
    assert.throws(() => execFileSync('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], { env: gitEnv, stdio: 'pipe' }));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('setup warns (without failing) when the Session\'s Pane predates runpane cloud agent', async () => {
  const harness = await brokerHarness({ mode: 'app' });
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-gh', '--yes', '--json', '--no-import']), 0);
  const host = lastJson<{ host: { hostname: string } }>(harness).host.hostname;
  harness.world.oldPaneRunpane = true;
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO, '--broker', '--json']), 0);
  assert.equal(lastJson<{ shimReady: boolean }>(harness).shimReady, false);
  assert.match(harness.err.join('\n'), /Pane \(runpane 2\.4\.141-old\) predates `runpane cloud agent`/u);
  assert.deepEqual(lastDirectoryEntry(harness).github, { repos: [REPO] }, 'the grant is still in place');
  harness.world.oldPaneRunpane = false;
  harness.err.length = 0;
  assert.equal(await run(harness, ['github', 'connect', host, '--repo', REPO, '--broker', '--json']), 0);
  assert.equal(lastJson<{ shimReady: boolean }>(harness).shimReady, true);
  assert.doesNotMatch(harness.err.join('\n'), /predates/u);
});
