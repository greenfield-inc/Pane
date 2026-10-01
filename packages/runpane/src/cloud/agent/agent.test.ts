import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { runCloudAgent } from './index';
import { runGit } from './localGit';
import type { AgentDeps } from './session';
import { HOST, READ_TOKEN, startMockBroker, type MockBroker } from './__tests__/mockBroker';

const execFileAsync = promisify(execFile);
const REPO = 'acme/widgets';
const CALLER_TOKEN = 'rpc1.sess123.mac';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

let root: string;
let broker: MockBroker;
let peersFile: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-agent-'));
  broker = await startMockBroker();
  peersFile = path.join(root, 'peers.json');
  await fs.writeFile(peersFile, JSON.stringify({ v: 1, hosts: [], coordinator: { baseUrl: broker.baseUrl, token: CALLER_TOKEN } }));
});

after(async () => {
  await broker.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** A bare "GitHub" with one commit on main, and a Session checkout of it whose origin says github.com. */
async function checkout(name: string): Promise<{ work: string; origin: string; mainSha: string }> {
  const origin = path.join(root, `${name}-origin.git`);
  const seed = path.join(root, `${name}-seed`);
  const work = path.join(root, name);
  git(['init', '--quiet', '--bare', '-b', 'main', origin], root);
  git(['init', '--quiet', '-b', 'main', seed], root);
  await fs.writeFile(path.join(seed, 'README.md'), 'hello\n');
  git(['add', '.'], seed);
  git(['commit', '--quiet', '-m', 'initial'], seed);
  git(['push', '--quiet', origin, 'main'], seed);
  git(['clone', '--quiet', origin, work], root);
  git(['remote', 'set-url', 'origin', `https://github.com/${REPO}.git`], work);
  return { work, origin, mainSha: git(['rev-parse', 'main'], work) };
}

async function commit(work: string, file: string, text: string, message: string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(work, file)), { recursive: true });
  await fs.writeFile(path.join(work, file), text);
  git(['add', '.'], work);
  git(['commit', '--quiet', '-m', message], work);
  return git(['rev-parse', 'HEAD'], work);
}

function deps(cwd: string, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const agentDeps: AgentDeps = {
    env: { ...process.env, ...GIT_ENV, RUNPANE_PEERS_FILE: peersFile },
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(stdin),
    git: runGit,
  };
  return { out, err, deps: agentDeps };
}

function lastRequest(method: string, pathName: string) {
  const found = broker.requests.filter((request) => request.method === method && request.path === pathName).at(-1);
  assert.ok(found, `no ${method} ${pathName}`);
  return found;
}

/** The pushed bundle must apply on top of what GitHub (the bare origin) has, and carry refs/heads/<branch>. */
async function verifyBundle(bundle: Buffer, origin: string, branch: string, head: string): Promise<void> {
  const file = path.join(root, `check-${Date.now()}.bundle`);
  await fs.writeFile(file, bundle);
  const heads = git(['bundle', 'list-heads', file], root);
  assert.equal(heads, `${head} refs/heads/${branch}`);
  const check = path.join(root, `check-${Date.now()}`);
  git(['clone', '--quiet', '--bare', origin, check], root);
  git(['bundle', 'verify', '--quiet', file], check);
  git(['fetch', '--quiet', file, `refs/heads/${branch}:refs/heads/landed`], check);
  assert.equal(git(['rev-parse', 'landed'], check), head);
}

test('agent github push bundles the current branch against origin/main and sends it with the Session caller token', async () => {
  const { work, origin, mainSha } = await checkout('push');
  git(['checkout', '--quiet', '-b', 'feature/login'], work);
  await commit(work, 'src/a.txt', 'a\n', 'first');
  const head = await commit(work, 'src/b.txt', 'b\n', 'second');
  const run = deps(work);
  assert.equal(await runCloudAgent(['github', 'push', '--json'], run.deps), 0);

  const request = lastRequest('POST', '/cloud/github/push');
  assert.equal(request.authorization, `Bearer ${CALLER_TOKEN}`);
  assert.equal(request.body?.repo, REPO);
  assert.equal(request.body?.branch, 'feature/login');
  assert.equal(request.body?.force, undefined);
  const bundle = broker.bundles.at(-1);
  assert.ok(bundle);
  await verifyBundle(bundle, origin, 'feature/login', head);
  // Only the two new commits travel: main's commit is the one prerequisite, which GitHub already has.
  const bundleFile = path.join(root, 'push.bundle');
  await fs.writeFile(bundleFile, bundle);
  const verify = spawnSync('git', ['bundle', 'verify', bundleFile], { cwd: work, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.match(`${verify.stdout}${verify.stderr}`, new RegExp(`requires this ref:?\\s+${mainSha}`, 'u'));

  const result: { ok: boolean; ref: string; sha: string; commits: number; base: string } = JSON.parse(run.out[0]);
  assert.equal(result.ok, true);
  assert.equal(result.ref, `cloud/${HOST}/feature/login`);
  assert.equal(result.sha, head);
  assert.equal(result.commits, 2);
  assert.equal(result.base, 'main');
});

test('agent github push sends the whole branch when it shares no history with origin, and --force', async () => {
  const { work } = await checkout('orphan');
  git(['checkout', '--quiet', '--orphan', 'fresh'], work);
  git(['rm', '--quiet', '-rf', '.'], work);
  const head = await commit(work, 'new.txt', 'new\n', 'unrelated');
  assert.equal(await runCloudAgent(['github', 'push', '--branch', 'fresh', '--force'], deps(work).deps), 0);
  assert.equal(lastRequest('POST', '/cloud/github/push').body?.force, true);
  const bundle = broker.bundles.at(-1);
  assert.ok(bundle);
  const empty = path.join(root, 'empty.git');
  git(['init', '--quiet', '--bare', empty], root);
  const file = path.join(root, 'orphan.bundle');
  await fs.writeFile(file, bundle);
  git(['fetch', '--quiet', file, 'refs/heads/fresh:refs/heads/fresh'], empty);
  assert.equal(git(['rev-parse', 'fresh'], empty), head);
});

test('agent github push refuses a branch with nothing new and bad branch names, before calling the broker', async () => {
  const { work } = await checkout('nothing');
  const before = broker.requests.length;
  await assert.rejects(runCloudAgent(['github', 'push'], deps(work).deps), /no commits that origin\/main lacks/u);
  git(['checkout', '--quiet', '-b', 'feat+plus'], work);
  await commit(work, 'c.txt', 'c\n', 'c');
  await assert.rejects(runCloudAgent(['github', 'push'], deps(work).deps), /not a branch name the broker accepts/u);
  assert.equal(broker.requests.length, before);
});

test('agent github pr/issue commands send the documented bodies; errors carry the broker message', async () => {
  const { work } = await checkout('items');
  git(['checkout', '--quiet', '-b', 'fix'], work);
  await commit(work, 'fix.txt', 'x\n', 'fix it');
  const run = deps(work, 'body from stdin\n');
  assert.equal(await runCloudAgent(['github', 'pr', 'create', '--title', 'Fix it', '--body-file', '-', '--base', 'develop', '--json'], run.deps), 0);
  assert.equal(lastRequest('POST', '/cloud/github/push').body?.branch, 'fix');
  const pull = lastRequest('POST', '/cloud/github/pulls').body;
  assert.deepEqual(pull, { repo: REPO, branch: 'fix', title: 'Fix it', body: 'body from stdin\n', draft: true, base: 'develop' });

  assert.equal(await runCloudAgent(['github', 'pr', 'edit', '#40', '--title', 'Better'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/pulls/40').body, { repo: REPO, title: 'Better' });
  assert.equal(await runCloudAgent(['github', 'pr', 'close', 'https://github.com/acme/widgets/pull/40'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/pulls/40').body, { repo: REPO, state: 'closed' });
  assert.equal(await runCloudAgent(['github', 'pr', 'comment', '40', '--body', 'done'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/comments').body, { repo: REPO, number: 40, body: 'done' });

  assert.equal(await runCloudAgent(['github', 'issue', 'create', '--title', 'Bug', '--body', 'steps', '--label', 'bug,p1', '--label', 'cloud', '--repo', 'other/repo'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/issues').body, { repo: 'other/repo', title: 'Bug', body: 'steps', labels: ['bug', 'p1', 'cloud'] });
  assert.equal(await runCloudAgent(['github', 'issue', 'comment', '5', '--body', 'more'], deps(work).deps), 0);
  assert.equal(await runCloudAgent(['github', 'issue', 'close', '5'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/issues/5').body, { repo: REPO, state: 'closed' });

  broker.reads.set('pulls/40/files', [{ filename: 'fix.txt' }]);
  const read = deps(work);
  assert.equal(await runCloudAgent(['github', 'read', 'pulls/40/files?per_page=5'], read.deps), 0);
  assert.deepEqual(JSON.parse(read.out[0]), [{ filename: 'fix.txt' }]);
  const readRequest = lastRequest('GET', '/cloud/github/read/acme/widgets/pulls/40/files');
  assert.equal(readRequest.query.get('per_page'), '5');

  broker.failures.set('POST /cloud/github/issues', { status: 403, code: 'repo-not-allowed', message: 'acme/secret is not allowed for this Session' });
  await assert.rejects(runCloudAgent(['github', 'issue', 'create', '--title', 'x', '--body', 'y'], deps(work).deps), /acme\/secret is not allowed/u);
  broker.failures.clear();
  await assert.rejects(runCloudAgent(['github', 'pr', 'create', '--title', 'x'], deps(work).deps), /needs --body/u);
});

test('agent github status reports mode, repositories and the branch prefix', async () => {
  const run = deps(root);
  assert.equal(await runCloudAgent(['github', 'status', '--json'], run.deps), 0);
  const status: { mode: string; caller: { branchPrefix: string; repos: string[] } } = JSON.parse(run.out[0]);
  assert.equal(status.mode, 'app');
  assert.equal(status.caller.branchPrefix, `cloud/${HOST}/`);
  assert.deepEqual(status.caller.repos, [REPO]);
});

test('without a peers list naming a coordinator, agent commands say where it comes from', async () => {
  const run = deps(root);
  run.deps.env = { ...run.deps.env, RUNPANE_PEERS_FILE: path.join(root, 'missing.json') };
  await assert.rejects(runCloudAgent(['github', 'status'], run.deps), /No runpane cloud coordinator is configured here/u);
});

// ---------------------------------------------------------------- gh shim

test('gh pr create pushes the branch, opens a draft and prints its URL; --head cloud/<host>/x and --fill work', async () => {
  const { work } = await checkout('gh-create');
  git(['checkout', '--quiet', '-b', 'topic'], work);
  await commit(work, 't.txt', 't\n', 'Add topic\n\nLonger explanation.');
  const run = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--title', 'Topic', '--body', 'Body', '--draft'], run.deps), 0);
  assert.equal(lastRequest('POST', '/cloud/github/push').body?.branch, 'topic');
  assert.deepEqual(lastRequest('POST', '/cloud/github/pulls').body, { repo: REPO, branch: 'topic', title: 'Topic', body: 'Body', draft: true });
  assert.match(run.out.at(-1) ?? '', /^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/u);

  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--fill', '--head', `cloud/${HOST}/topic`, '-B', 'main'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/pulls').body, { repo: REPO, branch: 'topic', title: 'Add topic', body: 'Longer explanation.', draft: true, base: 'main' });

  const missing = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'create', '--title', 'only'], missing.deps), 1);
  assert.match(missing.err.join('\n'), /--body/u);
});

test('gh refuses everything outside the allowlist with exit 2 and a clear message, without calling the broker', async () => {
  const before = broker.requests.length;
  for (const argv of [
    ['api', 'repos/acme/widgets'], ['pr', 'merge', '12'], ['pr', 'review', '12', '--approve'], ['pr', 'ready', '12'],
    ['repo', 'clone', 'acme/widgets'], ['release', 'create', 'v1'], ['workflow', 'run', 'ci.yml'], ['secret', 'set', 'X'],
    ['auth', 'token'], ['auth', 'login'], ['issue', 'delete', '3'], ['pr', 'create', '--title', 't', '--body', 'b', '--reviewer', 'x'],
    ['pr', 'close', '3', '--delete-branch'], ['pr', 'view', '3', '--jq', '.title'], ['pr', 'view', '3', '--web'],
  ]) {
    const run = deps(root);
    assert.equal(await runCloudAgent(['gh', ...argv], run.deps), 2, argv.join(' '));
    assert.match(run.err.join('\n'), /not available in a runpane cloud Session \(broker allowlist\)/u, argv.join(' '));
  }
  assert.equal(broker.requests.length, before);
  const version = deps(root);
  assert.equal(await runCloudAgent(['gh', '--version'], version.deps), 0);
  assert.match(version.out[0], /runpane-cloud-shim/u);
});

test('gh pr view/list and issue view/list map GitHub REST onto gh output and --json fields', async () => {
  const { work } = await checkout('gh-read');
  const pull = {
    number: 41, title: 'Topic', body: 'Body', state: 'open', draft: true, html_url: 'https://github.com/acme/widgets/pull/41',
    user: { login: 'runpane-cloud-test[bot]' }, labels: [], head: { ref: `cloud/${HOST}/topic`, sha: 'abc' }, base: { ref: 'main' },
    created_at: '2026-09-30T10:00:00Z', updated_at: '2026-09-30T10:00:00Z', closed_at: null, merged_at: null, node_id: 'PR_1',
  };
  broker.reads.set('pulls/41', pull);
  broker.reads.set('pulls', [pull, { ...pull, number: 42, head: { ref: 'someone-else', sha: 'def' }, draft: false }]);
  broker.reads.set('issues', [{ number: 7, title: 'Bug', state: 'open', labels: [{ name: 'bug' }], html_url: 'u', user: { login: 'x' }, updated_at: 't' }, { number: 41, pull_request: {}, title: 'PR', state: 'open' }]);
  broker.reads.set('issues/7', { number: 7, title: 'Bug', body: 'steps', state: 'closed', labels: [{ name: 'bug' }], html_url: 'https://github.com/acme/widgets/issues/7', user: { login: 'x' } });

  const view = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'view', '41', '--json', 'number,isDraft,headRefName,state'], view.deps), 0);
  assert.deepEqual(JSON.parse(view.out[0]), { number: 41, isDraft: true, headRefName: `cloud/${HOST}/topic`, state: 'OPEN' });

  // No number: the open pull request whose head is this Session's copy of the current branch.
  git(['checkout', '--quiet', '-b', 'topic'], work);
  const current = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'view', '--json', 'number'], current.deps), 0);
  assert.deepEqual(JSON.parse(current.out[0]), { number: 41 });
  assert.equal(await runCloudAgent(['gh', 'pr', 'comment', '--body', 'on the current PR'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/comments').body, { repo: REPO, number: 41, body: 'on the current PR' });

  const list = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'list', '--limit', '5'], list.deps), 0);
  assert.equal(list.out[0].split('\n')[0], `41\tTopic\tcloud/${HOST}/topic\tDRAFT\t2026-09-30T10:00:00Z`);
  assert.equal(lastRequest('GET', '/cloud/github/read/acme/widgets/pulls').query.get('per_page'), '5');

  const issues = deps(work);
  assert.equal(await runCloudAgent(['gh', 'issue', 'list', '--label', 'bug', '--json', 'number,labels'], issues.deps), 0);
  assert.deepEqual(JSON.parse(issues.out[0]), [{ number: 7, labels: [{ name: 'bug' }] }], 'pull requests are not issues');
  assert.equal(lastRequest('GET', '/cloud/github/read/acme/widgets/issues').query.get('labels'), 'bug');

  const issue = deps(work);
  assert.equal(await runCloudAgent(['gh', 'issue', 'view', '7'], issue.deps), 0);
  assert.match(issue.out[0], /title:\tBug\nstate:\tCLOSED/u);
  const unknown = deps(work);
  assert.equal(await runCloudAgent(['gh', 'issue', 'view', '7', '--json', 'nope'], unknown.deps), 1);
  assert.match(unknown.err[0], /Unknown JSON field: nope/u);
});

test('gh issue create/comment/close and pr edit/close go through the broker', async () => {
  const { work } = await checkout('gh-items');
  const created = deps(work);
  assert.equal(await runCloudAgent(['gh', 'issue', 'create', '-t', 'Crash', '-b', 'on start', '-l', 'bug'], created.deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/issues').body, { repo: REPO, title: 'Crash', body: 'on start', labels: ['bug'] });
  assert.match(created.out[0], /issues\/\d+$/u);
  assert.equal(await runCloudAgent(['gh', 'issue', 'close', '9', '--comment', 'fixed', '--reason', 'completed'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('POST', '/cloud/github/comments').body, { repo: REPO, number: 9, body: 'fixed' });
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/issues/9').body, { repo: REPO, state: 'closed' });
  assert.equal(await runCloudAgent(['gh', 'pr', 'edit', '12', '--body', 'new body', '-R', 'acme/other'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/pulls/12').body, { repo: 'acme/other', body: 'new body' });
  assert.equal(await runCloudAgent(['gh', 'pr', 'close', '12'], deps(work).deps), 0);
  assert.deepEqual(lastRequest('PATCH', '/cloud/github/pulls/12').body, { repo: REPO, state: 'closed' });
  broker.failures.set('PATCH /cloud/github/pulls/13', { status: 403, code: 'not-owner', message: 'pull request 13 is not this Session\'s' });
  const refused = deps(work);
  assert.equal(await runCloudAgent(['gh', 'pr', 'close', '13'], refused.deps), 1);
  assert.match(refused.err.join('\n'), /not this Session's \(not-owner\)/u);
  broker.failures.clear();
});

test('gh auth status answers from the broker and never shows a token', async () => {
  const run = deps(root);
  assert.equal(await runCloudAgent(['gh', 'auth', 'status'], run.deps), 0);
  assert.match(run.out[0], /Logged in to github\.com through the runpane cloud broker/u);
  assert.match(run.out[0], /acme\/widgets/u);
  broker.mode = 'off';
  const off = deps(root);
  assert.equal(await runCloudAgent(['gh', 'auth', 'status'], off.deps), 1);
  broker.mode = 'app';
});

// ---------------------------------------------------------------- git credential helper

test('git-credential-runpane answers get with the read token for the repository path, and nothing in PAT mode', async () => {
  const run = deps(root, 'protocol=https\nhost=github.com\npath=acme/widgets.git\n\n');
  assert.equal(await runCloudAgent(['git-credential', 'get'], run.deps), 0);
  assert.match(run.out[0], new RegExp(`^username=x-access-token\\npassword=${READ_TOKEN}\\npassword_expiry_utc=\\d+\\n$`, 'u'));
  assert.deepEqual(lastRequest('POST', '/cloud/github/token').body, { repo: REPO });

  broker.mode = 'pat';
  const pat = deps(root, 'protocol=https\nhost=github.com\npath=acme/widgets.git\n');
  assert.equal(await runCloudAgent(['git-credential', 'get'], pat.deps), 0);
  assert.deepEqual(pat.out, []);
  assert.deepEqual(pat.err, []);
  broker.mode = 'app';

  const store = deps(root, 'protocol=https\nhost=github.com\npath=acme/widgets.git\npassword=x\n');
  const count = broker.requests.length;
  assert.equal(await runCloudAgent(['git-credential', 'store'], store.deps), 0);
  assert.equal(await runCloudAgent(['git-credential', 'get'], deps(root, 'protocol=https\nhost=github.com\n').deps), 0);
  assert.equal(broker.requests.length, count, 'store and a pathless get never call the broker');
});

test('git-credential-runpane never hands the GitHub token to another host, whatever the git config routes to it', async () => {
  const count = broker.requests.length;
  for (const host of ['gitlab.example.com', 'github.com.evil.example', 'api.github.com', '']) {
    const other = deps(root, `protocol=https\nhost=${host}\npath=acme/widgets.git\n\n`);
    assert.equal(await runCloudAgent(['git-credential', 'get'], other.deps), 0);
    assert.deepEqual(other.out, [], host);
    assert.match(other.err.join('\n'), /answers only for github\.com/u);
  }
  assert.equal(broker.requests.length, count, 'another host never reaches the broker');
  const upper = deps(root, 'protocol=https\nhost=GitHub.com\npath=acme/widgets.git\n\n');
  assert.equal(await runCloudAgent(['git-credential', 'get'], upper.deps), 0);
  assert.match(upper.out[0], /^username=x-access-token\n/u);
});

/**
 * git's smart HTTP (`git http-backend`) over https with a throwaway self-signed certificate, behind Basic
 * auth that only takes the broker's read token. (The helper never answers plain http.)
 */
async function startGitServer(projectRoot: string): Promise<{ baseUrl: string; close(): Promise<void>; auths: string[] }> {
  const auths: string[] = [];
  const keyFile = path.join(root, 'tls.key');
  const certFile = path.join(root, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const server = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, (req, res) => {
    const auth = req.headers.authorization ?? '';
    auths.push(auth);
    if (auth !== `Basic ${Buffer.from(`x-access-token:${READ_TOKEN}`).toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake github"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://git');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'x-access-token',
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    cgi.on('close', () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      const headers = output.subarray(0, split).toString('utf8').split('\r\n');
      let status = 200;
      const out: Record<string, string> = {};
      for (const line of headers) {
        const [name, ...value] = line.split(':');
        if (name.toLowerCase() === 'status') status = Number(value.join(':').trim().split(' ')[0]);
        else out[name] = value.join(':').trim();
      }
      res.writeHead(status, out);
      res.end(output.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() on a TCP port has resolved, so address() is an AddressInfo.
  return { baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, auths, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('git fetch through git-credential-runpane: git gets the broker token and the authenticated fetch works', async () => {
  const { origin, mainSha } = await checkout('fetch');
  const projectRoot = path.join(root, 'fetch-github');
  await fs.mkdir(path.join(projectRoot, 'acme'), { recursive: true });
  await fs.rename(origin, path.join(projectRoot, 'acme', 'widgets.git'));
  const server = await startGitServer(projectRoot);
  const helper = path.join(root, 'git-credential-runpane');
  // The launcher the Session gets, pointed at this build instead of Pane's runpane, and at this server's host.
  const gitHost = new URL(server.baseUrl).host;
  const launch = `const session = require(${JSON.stringify(path.join(__dirname, 'session.js'))}); `
    + `require(process.argv[1]).runCloudAgent(process.argv.slice(2), { ...session.defaultAgentDeps(), gitHost: ${JSON.stringify(gitHost)} }).then((code) => { process.exitCode = code; })`;
  await fs.writeFile(helper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${launch}' ${JSON.stringify(path.join(__dirname, 'index.js'))} git-credential "$@"\n`, { mode: 0o755 });
  const target = path.join(root, 'fetch-target');
  git(['init', '--quiet', target], root);
  const env = { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_SSL_NO_VERIFY: '1', RUNPANE_PEERS_FILE: peersFile };
  try {
    // Async: the git server runs in this process, so a synchronous git would deadlock it.
    await assert.rejects(execFileAsync('git', ['fetch', '--quiet', `${server.baseUrl}/acme/widgets.git`, 'main'], { cwd: target, env }), 'no helper, no access');
    await execFileAsync('git', [
      '-c', `credential.${server.baseUrl}.helper=${helper}`, '-c', `credential.${server.baseUrl}.useHttpPath=true`,
      'fetch', '--quiet', `${server.baseUrl}/acme/widgets.git`, 'main:refs/heads/fetched',
    ], { cwd: target, env });
    assert.equal(git(['rev-parse', 'fetched'], target), mainSha);
    assert.ok(server.auths.some((auth) => auth.startsWith('Basic ')));
    assert.deepEqual(lastRequest('POST', '/cloud/github/token').body, { repo: REPO });
  } finally {
    await server.close();
  }
});
