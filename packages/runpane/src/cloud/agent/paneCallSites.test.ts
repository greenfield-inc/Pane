import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import { runCloudAgent } from './index';
import { runGit } from './localGit';
import type { AgentDeps } from './session';
import { HOST, startMockBroker, type MockBroker } from './__tests__/mockBroker';

/**
 * Pane itself shells out to `gh` on the host that runs its daemon, a cloud Session's included. These run
 * the EXACT argv of those call sites through the shim and decode the output the way each call site does.
 */

const REPO = 'acme/widgets';
const SHA = '1111111111111111111111111111111111111111';
const GIT_ENV = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

let root: string;
let work: string;
let broker: MockBroker;
let peersFile: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-gh-callsites-'));
  broker = await startMockBroker();
  peersFile = path.join(root, 'peers.json');
  await fs.writeFile(peersFile, JSON.stringify({ v: 1, hosts: [], coordinator: { baseUrl: broker.baseUrl, token: 'rpc1.s.mac' } }));
  work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '-b', 'feature', work], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: work, env: { ...process.env, ...GIT_ENV } });
});

after(async () => {
  await broker.close();
  await fs.rm(root, { recursive: true, force: true });
});

function pull(number: number, head: string, extra: Record<string, string | boolean | null> = {}) {
  return {
    number, title: `PR ${number}`, body: `body ${number}`, state: 'open', draft: false,
    html_url: `https://github.com/${REPO}/pull/${number}`, user: { login: 'runpane-cloud[bot]' }, labels: [],
    head: { ref: head, sha: SHA }, base: { ref: 'main' }, created_at: '2026-09-30T10:00:00Z', merged_at: null, ...extra,
  };
}

beforeEach(() => {
  broker.reads.clear();
  broker.failures.clear();
  broker.reads.set('pulls', [
    pull(44, 'someone-elses-branch'),
    pull(43, `cloud/${HOST}/feature`, { draft: true }),
    pull(42, 'feature', { state: 'closed', merged_at: '2026-09-29T10:00:00Z' }),
    pull(41, `cloud/${HOST}/feature`, { state: 'closed' }),
  ]);
});

async function gh(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: AgentDeps = {
    env: { ...process.env, ...GIT_ENV, RUNPANE_PEERS_FILE: peersFile },
    cwd: work,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    git: runGit,
  };
  const code = await runCloudAgent(['gh', ...argv], deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function headQueries(): string[] {
  return broker.requests.filter((request) => request.path === `/cloud/github/read/${REPO}/pulls`).map((request) => request.query.get('head') ?? '');
}

test('gitStatusManager.ts:625 (PR badge): gh pr list --head <b> --state all --json number,url,title,state,isDraft,body --limit 1', async () => {
  const result = await gh(['pr', 'list', '--head', 'feature', '--state', 'all', '--json', 'number,url,title,state,isDraft,body', '--limit', '1']);
  assert.equal(result.code, 0, result.err);
  // gitStatusManager's githubPrListSchema: number, url, title, state, isDraft, body.
  const prs = decodeBoundary(JSON.parse(result.out), boundary.array(boundary.object({
    number: boundary.number, url: boundary.string, title: boundary.string, state: boundary.enumeration('OPEN', 'CLOSED', 'MERGED'), isDraft: boundary.boolean, body: boundary.string,
  })));
  assert.deepEqual(prs, [{ number: 43, url: `https://github.com/${REPO}/pull/43`, title: 'PR 43', state: 'OPEN', isDraft: true, body: 'body 43' }]);
  assert.deepEqual(Object.keys(JSON.parse(result.out)[0]), ['number', 'url', 'title', 'state', 'isDraft', 'body']);
  // Both the Session's published name and the literal branch, owner-qualified as GitHub's head= wants.
  assert.deepEqual(headQueries().slice(-2).sort(), [`acme:cloud/${HOST}/feature`, 'acme:feature']);
  assert.ok(broker.requests.filter((request) => request.path.endsWith('/pulls')).slice(-2).every((request) => request.query.get('state') === 'all'));
});

test('dashboard.ts:550: gh pr list --head <b> --state all --json number,title,state,url --limit 1', async () => {
  const result = await gh(['pr', 'list', '--head', 'feature', '--state', 'all', '--json', 'number,title,state,url', '--limit', '1']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out), [{ number: 43, title: 'PR 43', state: 'OPEN', url: `https://github.com/${REPO}/pull/43` }]);
  broker.reads.set('pulls', []);
  const none = await gh(['pr', 'list', '--head', 'feature', '--state', 'all', '--json', 'number,title,state,url', '--limit', '1']);
  assert.equal(none.out, '[]', 'no PR: an empty JSON array, like gh');
});

test('runpane.ts:4129 (archive): gh pr list --head <b> --state merged --json number,headRefOid --limit 20', async () => {
  const result = await gh(['pr', 'list', '--head', 'feature', '--state', 'merged', '--json', 'number,headRefOid', '--limit', '20']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out), [{ number: 42, headRefOid: SHA }], 'merged only; closed-unmerged #41 and the other branch are out');
  assert.equal(broker.requests.at(-1)?.query.get('state'), 'closed', 'GitHub has no merged state: closed, then filtered');
});

test('sessionPrMonitor.ts:191: gh pr view <n> --json number,url,state,mergeable,statusCheckRollup,headRefOid', async () => {
  broker.reads.set('pulls/43', pull(43, `cloud/${HOST}/feature`, { mergeable: true }));
  broker.reads.set(`commits/${SHA}/check-runs`, { total_count: 2, check_runs: [
    { name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-09-30T10:00:00Z', completed_at: '2026-09-30T10:02:00Z', details_url: 'https://ci/1' },
    { name: 'e2e', status: 'in_progress', conclusion: null, started_at: '2026-09-30T10:00:00Z', completed_at: null, details_url: 'https://ci/2' },
  ] });
  broker.reads.set(`commits/${SHA}/status`, { state: 'failure', statuses: [{ context: 'lint', state: 'failure', target_url: 'https://ci/3', created_at: '2026-09-30T10:01:00Z' }] });
  const result = await gh(['pr', 'view', '43', '--json', 'number,url,state,mergeable,statusCheckRollup,headRefOid']);
  assert.equal(result.code, 0, result.err);
  // sessionPrMonitor's prViewSchema and prCheckSchema.
  const check = boundary.object({
    __typename: boundary.optional(boundary.string), name: boundary.optional(boundary.nullable(boundary.string)), context: boundary.optional(boundary.nullable(boundary.string)),
    status: boundary.optional(boundary.nullable(boundary.string)), conclusion: boundary.optional(boundary.nullable(boundary.string)), state: boundary.optional(boundary.nullable(boundary.string)),
  });
  const view = decodeBoundary(JSON.parse(result.out), boundary.object({
    number: boundary.number, url: boundary.string, state: boundary.string, mergeable: boundary.optional(boundary.nullable(boundary.string)),
    statusCheckRollup: boundary.optional(boundary.nullable(boundary.array(check))), headRefOid: boundary.string,
  }));
  assert.equal(view.state, 'OPEN');
  assert.equal(view.mergeable, 'MERGEABLE');
  assert.equal(view.headRefOid, SHA);
  assert.deepEqual(view.statusCheckRollup?.map((entry) => [entry.__typename, entry.name ?? entry.context, entry.status ?? entry.state, entry.conclusion ?? null]), [
    ['CheckRun', 'build', 'COMPLETED', 'SUCCESS'],
    ['CheckRun', 'e2e', 'IN_PROGRESS', ''],
    ['StatusContext', 'lint', 'FAILURE', null],
  ]);

  broker.reads.set('pulls/43', pull(43, `cloud/${HOST}/feature`, { mergeable: false }));
  broker.failures.set(`GET /cloud/github/read/${REPO}/commits/${SHA}/check-runs`, { status: 502, code: 'github-error', message: 'Resource not accessible by integration' });
  const partial = await gh(['pr', 'view', '43', '--json', 'number,url,state,mergeable,statusCheckRollup,headRefOid']);
  assert.equal(partial.code, 0, 'a check source the App cannot read is left out, not an error');
  assert.equal(JSON.parse(partial.out).mergeable, 'CONFLICTING');
  assert.equal(JSON.parse(partial.out).statusCheckRollup.length, 1);
  assert.match(partial.err, /check runs unavailable through the broker \(github-error\)/u);

  broker.reads.set('pulls/42', pull(42, 'feature', { state: 'closed', merged_at: '2026-09-29T10:00:00Z', mergeable: null }));
  const merged = await gh(['pr', 'view', '42', '--json', 'number,url,state,mergeable,statusCheckRollup,headRefOid']);
  assert.deepEqual([JSON.parse(merged.out).state, JSON.parse(merged.out).mergeable], ['MERGED', 'UNKNOWN']);
});

test('onboarding.ts probes: gh --version and gh auth status -h github.com pass; gh api -i /user refuses so the scopes come from auth status', async () => {
  assert.equal((await gh(['--version'])).code, 0);
  const status = await gh(['auth', 'status', '-h', 'github.com']);
  assert.equal(status.code, 0, status.err);
  const scopes = /Token scopes:(.*)$/mu.exec(status.out)?.[1].split(',').map((scope) => scope.trim().replace(/^['"]|['"]$/gu, ''));
  assert.deepEqual(scopes, ['repo', 'user'], 'onboarding requires the user scope');
  assert.equal((await gh(['api', '-i', '/user', '--silent', '--hostname', 'github.com'])).code, 2);
  assert.equal((await gh(['auth', 'status', '--hostname', 'github.com'])).code, 0, 'feedback.ts:213 spelling');
});

test('gh pr checks: gh\'s rows and exit codes (0 pass, 1 fail, 8 pending), and --watch until settled', async () => {
  broker.reads.set('pulls/43', pull(43, `cloud/${HOST}/feature`));
  broker.reads.set(`commits/${SHA}/status`, { state: 'success', statuses: [] });
  broker.reads.set(`commits/${SHA}/check-runs`, { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-09-30T10:00:00Z', completed_at: '2026-09-30T10:02:00Z', details_url: 'https://ci/1' }] });
  const pass = await gh(['pr', 'checks', '43']);
  assert.deepEqual([pass.code, pass.out], [0, 'build\tpass\t120s\thttps://ci/1']);
  broker.reads.set(`commits/${SHA}/check-runs`, { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', details_url: 'https://ci/1' }] });
  assert.equal((await gh(['pr', 'checks', '43'])).code, 1);
  broker.reads.set(`commits/${SHA}/check-runs`, { check_runs: [{ name: 'build', status: 'queued', conclusion: null }] });
  const pending = await gh(['pr', 'checks']);
  assert.deepEqual([pending.code, pending.out], [8, 'build\tpending\t0\t'], 'no number: the current branch\'s open PR');
  const watching = gh(['pr', 'checks', '43', '--watch', '--interval', '1']);
  setTimeout(() => broker.reads.set(`commits/${SHA}/check-runs`, { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }), 300);
  assert.equal((await watching).code, 0);
  broker.reads.set(`commits/${SHA}/check-runs`, { check_runs: [] });
  const none = await gh(['pr', 'checks', '43']);
  assert.equal(none.code, 1);
  assert.match(none.err, /no checks reported/u);
});

test('gh pr diff: a unified diff rebuilt from the PR\'s files, and --name-only', async () => {
  broker.reads.set('pulls/43/files', [
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
    { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+hello' },
    { filename: 'img.png', status: 'added' },
    { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed' },
  ]);
  const diff = await gh(['pr', 'diff', '43']);
  assert.equal(diff.code, 0, diff.err);
  assert.equal(diff.out, [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new',
    'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+hello',
    'diff --git a/img.png b/img.png', 'new file mode 100644', 'Binary files /dev/null and b/img.png differ',
    'diff --git a/a.ts b/b.ts', 'rename from a.ts', 'rename to b.ts',
  ].join('\n'));
  assert.equal((await gh(['pr', 'diff', '43', '--name-only'])).out, 'src/a.ts\nsrc/new.ts\nimg.png\nb.ts');
});

test('gh api graphql is refused with a message that names GraphQL (babysit-pr\'s review threads)', async () => {
  const before = broker.requests.length;
  const result = await gh(['api', 'graphql', '-f', 'query=query{viewer{login}}']);
  assert.equal(result.code, 2);
  assert.match(result.err, /GraphQL API is not available in a runpane cloud Session/u);
  assert.equal(broker.requests.length, before);
});
