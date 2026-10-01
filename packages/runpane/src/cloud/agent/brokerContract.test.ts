import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { MemoryAlertSink } from '../coordinator/alerts';
import { mintCallerToken } from '../coordinator/callerAuth';
import { parseCoordinatorConfig } from '../coordinator/config';
import { FakeGitHub } from '../coordinator/github/__tests__/fakeGitHub';
import { createCoordinatorServer } from '../coordinator/server';
import type { CoordinatorApi } from '../coordinator/server';
import { buildGitHubBroker } from '../coordinator/service';
import { entry, FakeClock, FakeDirectory } from '../coordinator/__tests__/fakes';
import { runCloudAgent } from './index';
import { runGit } from './localGit';
import type { AgentDeps } from './session';

/**
 * The Session side against the REAL coordinator broker (coordinator/github/broker.ts) and its fake GitHub (git http-backend +
 * REST): what `gh` and `runpane cloud agent github` send is what the broker accepts, and it lands on "GitHub".
 */

const execFileAsync = promisify(execFile);
const SECRET = 'contract-test-secret';
const APP_ID = '777';
const REPO = 'acme/app';
const HOST = 'rp-one';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
};
const unusedApi: CoordinatorApi = {
  status: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  wake: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  reconcile: async () => { throw new Error('unused'); },
  idleCheck: async () => ({ ok: true, results: [] }),
};

let root: string;
let fake: FakeGitHub;
let fakeBase: string;
let peersFile: string;
let closeServer: () => Promise<void>;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-agent-contract-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fake = new FakeGitHub({ root: path.join(root, 'github'), appId: APP_ID, appPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  fake.createRepo(REPO);
  fakeBase = await fake.start();
  const keyFile = path.join(root, 'app.pem');
  await fs.writeFile(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), { mode: 0o600 });
  const config = parseCoordinatorConfig({
    version: 1,
    listenHost: '127.0.0.1',
    stateDir: path.join(root, 'state'),
    provider: { kind: 'boat', apiKeyFile: path.join(root, 'unused') },
    managedNamePrefix: 'rp-',
    github: { mode: 'app', appId: APP_ID, privateKeyFile: keyFile, apiBaseUrl: fakeBase, gitBaseUrl: fakeBase },
  }, root);
  const clock = new FakeClock(Date.now());
  const directory = FakeDirectory.of([entry('s1', 'bx_a', { label: 'One', baseUrl: `https://${HOST}.tail.ts.net`, nodeId: 'nOne', githubRepos: [REPO] })]);
  // The request comes from this Session's tailnet node.
  const whois = { whois: async () => ({ stableId: 'nOne', name: `${HOST}.tail.ts.net`, tags: ['tag:rp-session'] }) };
  const server = createCoordinatorServer({
    api: unusedApi, directory, directoryWriter: null, alerts: new MemoryAlertSink(), clock, secret: SECRET,
    revokedCallers: [], version: 'test', log: () => undefined, github: buildGitHubBroker(config, clock, directory, { whois }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() on a TCP port has resolved, so address() is an AddressInfo.
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  peersFile = path.join(root, 'peers.json');
  await fs.writeFile(peersFile, JSON.stringify({ v: 1, hosts: [], coordinator: { baseUrl: base, token: mintCallerToken(SECRET, 's1') } }), { mode: 0o600 });
});

after(async () => {
  await closeServer();
  await fake.stop();
  await fs.rm(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

/** A Session checkout: cloned from the fake, origin renamed to github.com as a real Session has it. */
async function checkout(name: string): Promise<string> {
  const dir = path.join(root, name);
  git(['clone', '-q', fake.repos.get(REPO)?.dir ?? '', dir], root);
  git(['remote', 'set-url', 'origin', `https://github.com/${REPO}.git`], dir);
  return dir;
}

async function commit(dir: string, file: string, text: string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), text);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', `change ${file}`], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function run(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: AgentDeps = {
    env: { ...process.env, ...GIT_ENV, RUNPANE_PEERS_FILE: peersFile },
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    git: runGit,
  };
  return { out, err, deps };
}

function repoState() {
  const repo = fake.repos.get(REPO);
  assert.ok(repo);
  return repo;
}

test('gh pr create and agent github push land in cloud/<host>/ on GitHub as a draft PR with the Session footer', async () => {
  const dir = await checkout('work');
  git(['checkout', '-q', '-b', 'feature/x'], dir);
  const first = await commit(dir, 'src/a.txt', 'a\n');
  const created = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--title', 'Add a', '--body', 'Why: tests'], created.deps), 0, created.err.join('\n'));
  assert.equal(fake.refs(REPO)[`refs/heads/cloud/${HOST}/feature/x`], first);
  const [pull] = repoState().pulls;
  assert.equal(pull.head, `cloud/${HOST}/feature/x`);
  assert.equal(pull.draft, true);
  assert.match(pull.body, /^Why: tests\n\n---\nOpened by runpane cloud Session One \(rp-one\)\. <!-- runpane-cloud:s1 -->$/u);
  assert.match(created.out.at(-1) ?? '', new RegExp(`/${REPO}/pull/${pull.number}$`, 'u'), 'gh prints the pull request URL');

  const second = await commit(dir, 'src/b.txt', 'b\n');
  const pushed = run(dir);
  assert.equal(await runCloudAgent(['github', 'push', '--json'], pushed.deps), 0, pushed.err.join('\n'));
  const result: { ref: string; sha: string; outcome: string } = JSON.parse(pushed.out[0]);
  assert.deepEqual([result.ref, result.sha, result.outcome], [`cloud/${HOST}/feature/x`, second, 'fast-forward']);
  assert.equal(fake.refs(REPO)[`refs/heads/cloud/${HOST}/feature/x`], second);
  assert.equal(fake.refs(REPO)['refs/heads/master'], git(['rev-parse', 'origin/master'], dir), 'master untouched');

  const view = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'view', '--json', 'number,isDraft,headRefName,state'], view.deps), 0, view.err.join('\n'));
  assert.deepEqual(JSON.parse(view.out[0]), { number: pull.number, isDraft: true, headRefName: `cloud/${HOST}/feature/x`, state: 'OPEN' });
  const list = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'list'], list.deps), 0, list.err.join('\n'));
  assert.match(list.out[0], new RegExp(`^${pull.number}\tAdd a\tcloud/${HOST}/feature/x\tDRAFT\t`, 'u'));
  assert.equal(await runCloudAgent(['gh', 'pr', 'close', String(pull.number)], run(dir).deps), 0);
  assert.equal(repoState().pulls[0].state, 'closed');
});

test('gh issue create, comment and close work against the broker', async () => {
  const dir = await checkout('issues');
  const created = run(dir);
  assert.equal(await runCloudAgent(['gh', 'issue', 'create', '--title', 'Crash', '--body', 'steps', '--label', 'bug'], created.deps), 0, created.err.join('\n'));
  const issue = repoState().issues.at(-1);
  assert.ok(issue);
  assert.deepEqual(issue.labels, ['bug']);
  assert.equal(await runCloudAgent(['gh', 'issue', 'comment', String(issue.number), '--body', 'more'], run(dir).deps), 0);
  assert.equal(await runCloudAgent(['gh', 'issue', 'close', String(issue.number)], run(dir).deps), 0);
  assert.equal(repoState().issues.at(-1)?.state, 'closed');
  assert.match(repoState().comments.at(-1)?.body ?? '', /^more\n\n---\nOpened by runpane cloud Session One/u);
});

test('the broker\'s refusals reach the agent: default branch, workflow files', async () => {
  const dir = await checkout('refusals');
  await commit(dir, 'on-master.txt', 'x\n');
  const master = run(dir);
  await assert.rejects(runCloudAgent(['github', 'push'], master.deps), /master|default branch/iu);
  git(['checkout', '-q', '-b', 'ci-change'], dir);
  await commit(dir, '.github/workflows/ci.yml', 'on: pull_request\n');
  const workflow = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--title', 't', '--body', 'b'], workflow.deps), 1);
  assert.match(workflow.err.join('\n'), /workflow-change-refused/u);
  assert.equal(fake.refs(REPO)[`refs/heads/cloud/${HOST}/ci-change`], undefined);
});

test('git-credential-runpane hands git a token that reads the repository and cannot push', async () => {
  const helper = run(root);
  helper.deps.readStdin = () => Promise.resolve(`protocol=https\nhost=github.com\npath=${REPO}.git\n\n`);
  assert.equal(await runCloudAgent(['git-credential', 'get'], helper.deps), 0, helper.err.join('\n'));
  const token = /^password=(.+)$/mu.exec(helper.out.join('\n'))?.[1];
  assert.ok(token);
  const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const target = path.join(root, 'fetched');
  git(['init', '-q', target], root);
  const env = { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' };
  await execFileAsync('git', ['-c', `http.extraHeader=${auth}`, 'fetch', '-q', `${fakeBase}/${REPO}.git`, 'master:refs/heads/fetched'], { cwd: target, env });
  assert.equal(git(['rev-parse', 'fetched'], target), fake.refs(REPO)['refs/heads/master']);
  await commit(target, 'x.txt', 'x\n');
  await assert.rejects(execFileAsync('git', ['-c', `http.extraHeader=${auth}`, 'push', '-q', `${fakeBase}/${REPO}.git`, 'HEAD:refs/heads/cloud/rp-one/sneaky'], { cwd: target, env }));
  assert.equal(fake.refs(REPO)['refs/heads/cloud/rp-one/sneaky'], undefined);
});

test('Pane\'s own gh calls (PR badge, PR monitor, archive) answer through the real broker', async () => {
  const dir = await checkout('pane-callsites');
  git(['checkout', '-q', '-b', 'badge'], dir);
  const head = await commit(dir, 'badge.txt', 'x\n');
  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--title', 'Badge', '--body', 'b'], run(dir).deps), 0);
  const number = repoState().pulls.at(-1)?.number;

  const badge = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'list', '--head', 'badge', '--state', 'all', '--json', 'number,url,title,state,isDraft,body', '--limit', '1'], badge.deps), 0, badge.err.join('\n'));
  const [listed] = JSON.parse(badge.out[0]);
  assert.deepEqual([listed.number, listed.state, listed.isDraft, listed.title], [number, 'OPEN', true, 'Badge']);

  const monitor = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'view', String(number), '--json', 'number,url,state,mergeable,statusCheckRollup,headRefOid'], monitor.deps), 0, monitor.err.join('\n'));
  const viewed = JSON.parse(monitor.out[0]);
  assert.deepEqual([viewed.number, viewed.state, viewed.headRefOid, viewed.mergeable], [number, 'OPEN', head, 'UNKNOWN']);
  // Design §6's App has no Checks/Statuses read: the broker says so, and the rollup is empty rather than an error.
  assert.deepEqual(viewed.statusCheckRollup, []);
  assert.match(monitor.err.join('\n'), /check runs unavailable through the broker/u);

  const archive = run(dir);
  assert.equal(await runCloudAgent(['gh', 'pr', 'list', '--head', 'badge', '--state', 'merged', '--json', 'number,headRefOid', '--limit', '20'], archive.deps), 0);
  assert.equal(archive.out[0], '[]', 'not merged yet');
});
