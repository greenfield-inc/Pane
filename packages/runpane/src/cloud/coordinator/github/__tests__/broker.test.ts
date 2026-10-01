import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { boundary, decodeBoundary } from '../../../../boundaryDecoder';
import type { JsonObject, JsonValue } from '../../../../boundaryDecoder';
import { MemoryAlertSink } from '../../alerts';
import { mintCallerToken } from '../../callerAuth';
import { parseCoordinatorConfig } from '../../config';
import type { CoordinatorConfig } from '../../config';
import { createCoordinatorServer } from '../../server';
import type { CoordinatorApi } from '../../server';
import { buildGitHubBroker } from '../../service';
import { entry, FakeClock, FakeDirectory } from '../../__tests__/fakes';
import { assertFineGrainedPat } from '../credentials';
import { parseBundleHeader, withFooter } from '../policy';
import { appJwt, loadAppPrivateKey } from '../rest';
import type { TailnetNode, WhoisResolver } from '../whois';
import { parseWhois } from '../whois';
import { FakeGitHub } from './fakeGitHub';

const SECRET = 'broker-test-secret';
const APP_ID = '424242';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PAT = 'github_pat_11FAKEFAKE0123456789_abcdefghijklmnopqrstuvwxyz';

const S1 = entry('s1', 'bx_a', { label: 'One', baseUrl: 'https://rp-one.tail.ts.net', nodeId: 'nOne', githubRepos: ['acme/app'] });
const S2 = entry('s2', 'bx_b', { label: 'Two', baseUrl: 'https://rp-two.tail.ts.net', nodeId: 'nTwo', githubRepos: ['acme/app'] });
const NODES = {
  s1: { stableId: 'nOne', name: 'rp-one.tail.ts.net', tags: ['tag:rp-session'] },
  s2: { stableId: 'nTwo', name: 'rp-two.tail.ts.net', tags: ['tag:rp-session'] },
} satisfies Record<string, TailnetNode>;

const json = (value: JsonValue): JsonObject => decodeBoundary(value, boundary.jsonObject);
const jsonList = (value: JsonValue | undefined): JsonObject[] => decodeBoundary(value, boundary.array(boundary.jsonObject));
const auditLineSchema = boundary.object({ bundleSha: boundary.optional(boundary.nullable(boundary.string)), node: boundary.optional(boundary.nullable(boundary.string)) });
const claimsSchema = boundary.object({ iat: boundary.number, exp: boundary.number, iss: boundary.string });

const unusedApi: CoordinatorApi = {
  status: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  wake: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  reconcile: async () => { throw new Error('unused'); },
  idleCheck: async () => ({ ok: true, results: [] }),
};

class SwitchableWhois implements WhoisResolver {
  node: TailnetNode | null = NODES.s1;
  addresses: string[] = [];

  async whois(address: string): Promise<TailnetNode | null> {
    this.addresses.push(address);
    return this.node;
  }
}

interface Harness {
  fake: FakeGitHub;
  clock: FakeClock;
  whois: SwitchableWhois;
  stateDir: string;
  base: string;
  call(caller: string, method: string, route: string, body?: JsonValue): Promise<{ status: number; body: JsonObject }>;
  close(): Promise<void>;
}

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function harness(options: { mode?: 'app' | 'pat' | 'off'; github?: JsonObject; tokenTtlMs?: number; permissions?: Record<string, 'read' | 'write'> } = {}): Promise<Harness> {
  const root = tempDir('rp-broker-');
  const clock = new FakeClock(Date.now());
  const fake = new FakeGitHub({
    root: path.join(root, 'github'),
    appId: APP_ID,
    appPublicKey: PUBLIC_PEM,
    tokenTtlMs: options.tokenTtlMs,
    installationPermissions: options.permissions,
    now: () => clock.now(),
  });
  fake.createRepo('acme/app');
  fake.createRepo('acme/other');
  fake.addPat(PAT, ['acme/app']);
  const fakeBase = await fake.start();
  const keyFile = path.join(root, 'app.pem');
  fs.writeFileSync(keyFile, PRIVATE_PEM, { mode: 0o600 });
  const patFile = path.join(root, 'pat');
  fs.writeFileSync(patFile, `${PAT}\n`, { mode: 0o600 });
  const mode = options.mode ?? 'app';
  const github: JsonObject | null = mode === 'off' ? null : {
    mode,
    ...(mode === 'app' ? { appId: APP_ID, privateKeyFile: keyFile } : { patFile }),
    apiBaseUrl: fakeBase,
    gitBaseUrl: fakeBase,
    ...options.github,
  };
  const config: CoordinatorConfig = parseCoordinatorConfig({
    version: 1,
    listenHost: '127.0.0.1',
    stateDir: path.join(root, 'state'),
    provider: { kind: 'boat', apiKeyFile: path.join(root, 'unused') },
    managedNamePrefix: 'rp-',
    github,
  }, root);
  const directory = FakeDirectory.of([S1, S2]);
  const whois = new SwitchableWhois();
  const broker = buildGitHubBroker(config, clock, directory, { whois });
  const server = createCoordinatorServer({
    api: unusedApi,
    directory,
    directoryWriter: null,
    alerts: new MemoryAlertSink(),
    clock,
    secret: SECRET,
    revokedCallers: [],
    version: 'test',
    log: () => undefined,
    github: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listening on a TCP host and port, the server reports an AddressInfo.
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    fake,
    clock,
    whois,
    stateDir: config.stateDir,
    base,
    async call(caller, method, route, body) {
      if (caller === 's1' || caller === 's2') whois.node = NODES[caller];
      const response = await fetch(`${base}/cloud/github/${route}`, {
        method,
        headers: { Authorization: `Bearer ${mintCallerToken(SECRET, caller)}`, 'Content-Type': 'application/json' },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: json(await response.json()) };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.stop();
    },
  };
}

// ---------------------------------------------------------------- a Session's working copy

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: 'agent',
  GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'agent',
  GIT_COMMITTER_EMAIL: 'agent@example.invalid',
};

class Work {
  readonly dir: string;

  constructor(fake: FakeGitHub, repo = 'acme/app') {
    this.dir = tempDir('rp-work-');
    const bare = fake.repos.get(repo)?.dir ?? '';
    execFileSync('git', ['clone', '-q', bare, this.dir], { env: GIT_ENV });
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: GIT_ENV }).toString().trim();
  }

  commit(file: string, content: string, message = `change ${file}`): string {
    fs.mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, file), content);
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  remove(file: string): string {
    this.git('rm', '-q', file);
    this.git('commit', '-q', '-m', `remove ${file}`);
    return this.git('rev-parse', 'HEAD');
  }

  /** What `runpane cloud agent github push` sends: origin/<default>..HEAD, or the whole branch. */
  bundle(range = 'origin/master..HEAD'): string {
    const file = path.join(this.dir, '..', `${path.basename(this.dir)}.bundle`);
    this.git('bundle', 'create', '-q', file, range);
    const data = fs.readFileSync(file).toString('base64');
    fs.rmSync(file);
    return data;
  }
}

// ---------------------------------------------------------------- units

describe('broker units', () => {
  it('signs an RS256 App JWT GitHub accepts (iss, iat 60 s back, exp 9 min)', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const jwt = appJwt(APP_ID, loadAppPrivateKey(PRIVATE_PEM), now);
    const [header, payload, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    const claims = decodeBoundary(JSON.parse(Buffer.from(payload, 'base64url').toString()), claimsSchema);
    assert.equal(claims.iss, APP_ID);
    assert.equal(claims.iat, now / 1000 - 60);
    assert.equal(claims.exp, now / 1000 + 540);
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  });

  it('refuses classic and OAuth tokens as the PAT, without echoing them', () => {
    for (const token of ['ghp_abcdefabcdef', 'gho_abcdefabcdef', 'ghu_x', 'ghs_x', 'ghr_x', 'plain-token']) {
      assert.throws(() => assertFineGrainedPat(token), (error: Error) => !error.message.includes(token.slice(4)) || token.length < 6);
    }
    assert.doesNotThrow(() => assertFineGrainedPat(PAT));
  });

  it('parses tailscale whois --json', () => {
    const node = parseWhois(JSON.stringify({ Node: { StableID: 'nX', Name: 'RP-One.tail.ts.net.', Tags: ['tag:rp-session'] }, UserProfile: {} }));
    assert.deepEqual(node, { stableId: 'nX', name: 'rp-one.tail.ts.net', tags: ['tag:rp-session'] });
    assert.deepEqual(parseWhois(JSON.stringify({ Node: { StableID: 'nY', Name: 'laptop.tail.ts.net.' } })).tags, []);
  });

  it('strips spoofed markers and appends the caller\'s own footer', () => {
    const body = withFooter('fixes it <!-- runpane-cloud:s2 -->\n', S1);
    assert.ok(!body.includes('runpane-cloud:s2'));
    assert.ok(body.endsWith('\n\n---\nOpened by runpane cloud Session One (rp-one). <!-- runpane-cloud:s1 -->'));
  });

  it('parses bundle headers and refuses non-bundles', () => {
    const header = parseBundleHeader(Buffer.from(`# v2 git bundle\n-${'a'.repeat(40)} base\n${'b'.repeat(40)} HEAD\n\nPACK`));
    assert.deepEqual(header, { version: 2, prerequisites: ['a'.repeat(40)], refs: [{ sha: 'b'.repeat(40), name: 'HEAD' }] });
    assert.throws(() => parseBundleHeader(Buffer.from('not a bundle\n\n')), /not a v2\/v3 git bundle/u);
  });

  it('validates the github config section', () => {
    const base = { version: 1, listenHost: '100.64.0.1', provider: { kind: 'boat', apiKeyFile: '/k' }, managedNamePrefix: 'rp-' };
    assert.equal(parseCoordinatorConfig(base, '/h').github, null);
    const app = parseCoordinatorConfig({ ...base, github: { mode: 'app', appId: '1', privateKeyFile: '/h/github/app.pem' } }, '/h').github;
    assert.deepEqual(app?.limits, { pushesPerSessionPerHour: 20, writesPerSessionPerHour: 60, readsPerSessionPerHour: 600, writesPerHour: 300 });
    assert.equal(app?.apiBaseUrl, 'https://api.github.com');
    assert.equal(app?.allowReadyPulls, false);
    assert.throws(() => parseCoordinatorConfig({ ...base, github: { mode: 'app', appId: '1' } }, '/h'), /needs appId and privateKeyFile/u);
    assert.throws(() => parseCoordinatorConfig({ ...base, github: { mode: 'pat' } }, '/h'), /needs patFile/u);
    assert.throws(() => parseCoordinatorConfig({ ...base, github: { mode: 'pat', patFile: '/p', apiBaseUrl: 'file:///x' } }, '/h'), /http\(s\) URL/u);
  });
});

// ---------------------------------------------------------------- App mode, end to end over HTTP

describe('GitHub broker (App mode) against a fake GitHub', () => {
  let h: Harness;

  before(async () => {
    h = await harness({ github: { limits: { pushesPerSessionPerHour: 1000, writesPerSessionPerHour: 1000 } } });
  });
  after(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.fake.rateLimitNext = false;
  });

  it('status: mode, app, installed repos and the caller namespace, never a token', async () => {
    const user = await h.call('user:owner', 'GET', 'status');
    assert.equal(user.status, 200);
    assert.equal(user.body.mode, 'app');
    assert.deepEqual(user.body.app, {
      id: APP_ID,
      slug: 'runpane-cloud-fake',
      installationIds: [4242],
      installations: [{ id: 4242, repositorySelection: 'selected', extraPermissions: [], missingPermissions: [], forbiddenPermissions: [] }],
    });
    assert.deepEqual(user.body.repos, ['acme/app', 'acme/other']);
    assert.equal(user.body.caller, null);
    const peer = await h.call('s1', 'GET', 'status');
    assert.deepEqual(peer.body.caller, { sessionId: 's1', host: 'rp-one', namespace: 'cloud/rp-one/', repos: ['acme/app'] });
    assert.ok(!JSON.stringify(peer.body).includes('ghs_'));
    // status is polled: the App, installations and repositories are cached, not re-minted per call.
    const minted = h.fake.minted.length;
    await h.call('user:owner', 'GET', 'status');
    assert.equal(h.fake.minted.length, minted);
  });

  it('push lands in cloud/<host>/<branch>, then fast-forwards; a non-fast-forward is refused unless forced', async () => {
    const work = new Work(h.fake);
    const first = work.commit('src/a.ts', 'export const a = 1;\n');
    const created = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'feature', bundle: work.bundle() });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.ref, 'refs/heads/cloud/rp-one/feature');
    assert.equal(created.body.sha, first);
    assert.equal(created.body.outcome, 'created');
    assert.match(String(created.body.compareUrl), /\/acme\/app\/compare\/master\.\.\.cloud\/rp-one\/feature$/u);
    assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/feature'], first);

    const second = work.commit('src/b.ts', 'export const b = 2;\n');
    const ff = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'cloud/rp-one/feature', bundle: work.bundle() });
    assert.equal(ff.body.outcome, 'fast-forward');
    assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/feature'], second);

    work.git('reset', '-q', '--hard', 'origin/master');
    const other = work.commit('src/c.ts', 'export const c = 3;\n');
    const rejected = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'feature', bundle: work.bundle() });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'non-fast-forward');
    const forced = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'feature', bundle: work.bundle(), force: true });
    assert.equal(forced.body.outcome, 'forced');
    assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/feature'], other);
  });

  it('push without a bundle re-points a branch at a commit GitHub already has', async () => {
    const master = h.fake.refs('acme/app')['refs/heads/master'];
    const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'from-master', sha: master });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/from-master'], master);
  });

  it('refuses refs outside the namespace, the default branch, tags and malformed names; master never moves', async () => {
    const master = h.fake.refs('acme/app')['refs/heads/master'];
    const work = new Work(h.fake);
    work.commit('x.txt', 'x\n');
    const bundle = work.bundle();
    const cases: Array<[string, string]> = [
      ['master', 'ref-outside-namespace'],
      ['main', 'ref-outside-namespace'],
      ['cloud/rp-one/master', 'ref-outside-namespace'],
      ['refs/heads/master', 'ref-outside-namespace'],
      ['refs/tags/v1', 'ref-outside-namespace'],
      ['cloud/rp-two/feature', 'ref-outside-namespace'],
      ['cloud/other', 'ref-outside-namespace'],
      ['../master', 'bad-request'],
      ['/master', 'bad-request'],
      ['a..b', 'bad-request'],
      ['x.lock', 'bad-request'],
      ['with space', 'bad-request'],
    ];
    for (const [branch, code] of cases) {
      const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch, bundle });
      assert.equal(result.body.code, code, `${branch}: ${JSON.stringify(result.body)}`);
    }
    assert.equal(h.fake.refs('acme/app')['refs/heads/master'], master);
    assert.ok(!Object.keys(h.fake.refs('acme/app')).some((ref) => ref.startsWith('refs/tags/') || ref.includes('rp-two')));
  });

  it('refuses any change under .github/workflows/ or .github/actions/ against the merge base (edit, add, delete, orphan history)', async () => {
    const before = h.fake.refs('acme/app');
    const edit = new Work(h.fake);
    edit.commit('.github/workflows/ci.yml', 'on: push\njobs: { steal: {} }\n');
    const add = new Work(h.fake);
    add.commit('.github/workflows/new.yml', 'on: push\n');
    const remove = new Work(h.fake);
    remove.remove('.github/workflows/ci.yml');
    const hidden = new Work(h.fake);
    hidden.commit('.github/workflows/ci.yml', 'evil\n');
    hidden.commit('.github/workflows/ci.yml', 'on: push\njobs: {}\n'); // net zero vs the merge base
    const orphan = new Work(h.fake);
    orphan.git('checkout', '-q', '--orphan', 'fresh');
    orphan.commit('.github/workflows/ci.yml', 'on: push\n', 'orphan');
    // A local composite action runs inside the existing workflows with their secrets.
    const action = new Work(h.fake);
    action.commit('.github/actions/setup/action.yml', 'runs: { using: composite, steps: [] }\n');
    for (const [name, work, range] of [['edit', edit, undefined], ['add', add, undefined], ['delete', remove, undefined], ['orphan', orphan, 'fresh'], ['action', action, undefined]] as const) {
      const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: `wf-${name}`, bundle: work.bundle(range) });
      assert.equal(result.status, 403, `${name}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, 'workflow-change-refused');
    }
    assert.deepEqual(h.fake.refs('acme/app'), before);
    // A net-zero branch passes the broker's merge-base check, but GitHub checks every commit for a
    // token without the workflows permission; its refusal gets the same code.
    const netZero = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'wf-net-zero', bundle: hidden.bundle() });
    assert.deepEqual([netZero.status, netZero.body.code], [403, 'workflow-change-refused'], JSON.stringify(netZero.body));
    assert.match(String(netZero.body.message), /GitHub refused/u);
    assert.deepEqual(h.fake.refs('acme/app'), before);
  });

  it('allows a branch that merged a workflow change from the default branch (merge-base diff)', async () => {
    const upstream = new Work(h.fake);
    upstream.commit('.github/workflows/ci.yml', 'on: [push, pull_request]\njobs: {}\n', 'maintainer edits CI');
    // A maintainer (with the workflows permission) changes CI on the default branch.
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:master'], { cwd: upstream.dir, env: { ...GIT_ENV, FAKE_ALLOW_WORKFLOWS: '1' } });
    const work = new Work(h.fake);
    work.git('reset', '-q', '--hard', 'HEAD~1');
    work.commit('feature.txt', 'feature\n');
    work.git('fetch', '-q', 'origin');
    work.git('merge', '-q', '--no-edit', 'origin/master');
    const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'merged-master', bundle: work.bundle() });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  it('refuses a bundle that builds on commits GitHub does not have, and junk bundles', async () => {
    const work = new Work(h.fake);
    work.commit('local-only.txt', '1\n');
    work.git('branch', 'local-base');
    work.commit('on-top.txt', '2\n');
    const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'missing-base', bundle: work.bundle('local-base..HEAD') });
    assert.equal(result.body.code, 'bad-request');
    assert.match(String(result.body.message), /does not have/u);
    const junk = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'junk', bundle: Buffer.from('# v2 git bundle\nzzz HEAD\n\n').toString('base64') });
    assert.equal(junk.body.code, 'bad-request');
    const none = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'nothing' });
    assert.equal(none.body.code, 'bad-request');
  });

  it('refuses repos outside the Session allowlist, users on write endpoints, and unknown endpoints', async () => {
    const outside = await h.call('s1', 'POST', 'push', { repo: 'acme/other', branch: 'x', sha: 'a'.repeat(40) });
    assert.deepEqual([outside.status, outside.body.code], [403, 'repo-not-allowed']);
    const user = await h.call('user:owner', 'POST', 'push', { repo: 'acme/app', branch: 'x', sha: 'a'.repeat(40) });
    assert.deepEqual([user.status, user.body.code], [403, 'forbidden']);
    for (const [method, route] of [['PUT', 'pulls/1/merge'], ['POST', 'merge'], ['DELETE', 'refs/heads/x'], ['POST', 'releases'], ['POST', 'pulls/1/reviews'], ['GET', 'repos/acme/app']] as const) {
      const result = await h.call('s1', method, route, {});
      assert.deepEqual([result.status, result.body.code], [404, 'not-found'], `${method} ${route}`);
    }
    assert.ok(!h.fake.requests.some((request) => request.path.endsWith('/merge')));
  });

  it('binds the token to the Session node: another node, a missing tag or a stale node id is refused before GitHub is called', async () => {
    const calls = h.fake.requests.length;
    const attempts: Array<TailnetNode | null> = [
      NODES.s2,
      { ...NODES.s1, tags: [] },
      { ...NODES.s1, stableId: 'nImpostor' },
      { stableId: 'nFNi', name: 'laptop.tail.ts.net', tags: [] },
      null,
    ];
    for (const node of attempts) {
      h.whois.node = node;
      const response = await fetch(`${h.base}/cloud/github/push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${mintCallerToken(SECRET, 's1')}` },
        body: JSON.stringify({ repo: 'acme/app', branch: 'stolen', sha: 'a'.repeat(40) }),
      });
      const body = json(await response.json());
      assert.deepEqual([response.status, body.code], [403, 'caller-node-mismatch'], JSON.stringify(node));
    }
    assert.equal(h.fake.requests.length, calls);
    assert.ok(h.whois.addresses.every((address) => address.endsWith('127.0.0.1')));
  });

  it('token: a read-only 1 h installation token for one repo, which can fetch but not push', async () => {
    const minted = h.fake.minted.length;
    const result = await h.call('s1', 'POST', 'token', { repo: 'acme/app' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.permissions, { contents: 'read', metadata: 'read' });
    const expiresIn = Date.parse(String(result.body.expiresAt)) - h.clock.now();
    assert.ok(expiresIn > 0 && expiresIn <= 3_600_000);
    assert.deepEqual(h.fake.minted.slice(minted), [{ repositories: ['app'], requestedPermissions: { metadata: 'read', contents: 'read' }, permissions: { metadata: 'read', contents: 'read' }, expiresAt: String(result.body.expiresAt) }]);
    const token = String(result.body.token);
    const work = tempDir('rp-readtoken-');
    const env = { ...GIT_ENV, RP_TOKEN: token };
    const helper = ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$RP_TOKEN"; }; f'];
    // Async git: the fake serves from this same process.
    const git = promisify(execFile);
    const listed = (await git('git', [...helper, 'ls-remote', `${h.fake.baseUrl}/acme/app.git`], { env })).stdout;
    assert.match(listed, /refs\/heads\/master/u);
    await git('git', [...helper, 'clone', '-q', `${h.fake.baseUrl}/acme/app.git`, work], { env });
    await assert.rejects(git('git', [...helper, 'push', `${h.fake.baseUrl}/acme/app.git`, 'HEAD:refs/heads/cloud/rp-one/by-read-token'], { cwd: work, env }));
    assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/by-read-token'], undefined);
    const other = await h.call('s1', 'POST', 'token', { repo: 'acme/other' });
    assert.equal(other.body.code, 'repo-not-allowed');
  });

  it('caches installation tokens per repo and permission set until 5 minutes before expiry', async () => {
    const work = new Work(h.fake);
    work.commit('cache.txt', '1\n');
    const count = () => h.fake.minted.filter((token) => token.permissions.contents === 'write').length;
    await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'cache', bundle: work.bundle() });
    const afterFirst = count();
    work.commit('cache.txt', '2\n');
    await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'cache', bundle: work.bundle() });
    assert.equal(count(), afterFirst);
    h.clock.time += 56 * 60_000;
    work.commit('cache.txt', '3\n');
    const late = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'cache', bundle: work.bundle() });
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(count(), afterFirst + 1);
    const status = await h.call('user:owner', 'GET', 'status');
    assert.ok(jsonList(status.body.tokens).some((token) => token.repo === 'acme/app' && token.access === 'write'));
  });

  it('pull requests: head in the caller namespace, draft forced, marker footer; edits only on own PRs; never ready/merge', async () => {
    const work = new Work(h.fake);
    work.commit('pr.txt', 'pr\n');
    await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'pr-branch', bundle: work.bundle() });
    const created = await h.call('s1', 'POST', 'pulls', { repo: 'acme/app', branch: 'pr-branch', title: '[runpane-cloud test] pr', body: 'Does a thing.', draft: false });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.draft, true);
    assert.equal(created.body.head, 'cloud/rp-one/pr-branch');
    assert.equal(created.body.base, 'master');
    const pull = h.fake.repos.get('acme/app')?.pulls.find((candidate) => candidate.number === created.body.number);
    assert.ok(pull?.draft);
    assert.ok(pull?.body.endsWith('<!-- runpane-cloud:s1 -->'));

    const foreign = await h.call('s1', 'POST', 'pulls', { repo: 'acme/app', branch: 'cloud/rp-two/x', title: 't' });
    assert.equal(foreign.body.code, 'ref-outside-namespace');

    const edited = await h.call('s1', 'PATCH', `pulls/${String(created.body.number)}`, { repo: 'acme/app', title: 'renamed', state: 'closed' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.state, 'closed');
    const reopened = await h.call('s1', 'PATCH', `pulls/${String(created.body.number)}`, { repo: 'acme/app', state: 'open' });
    assert.equal(reopened.body.state, 'open');
    const ready = await h.call('s1', 'PATCH', `pulls/${String(created.body.number)}`, { repo: 'acme/app', draft: false });
    assert.deepEqual([ready.status, ready.body.code], [403, 'forbidden']);
    const rebase = await h.call('s1', 'PATCH', `pulls/${String(created.body.number)}`, { repo: 'acme/app', base: 'other' });
    assert.equal(rebase.body.code, 'forbidden');
    const notMine = await h.call('s2', 'PATCH', `pulls/${String(created.body.number)}`, { repo: 'acme/app', state: 'closed' });
    assert.deepEqual([notMine.status, notMine.body.code], [403, 'not-owner']);
  });

  it('issues: labels must exist, marker footer, spoofed markers do not grant ownership', async () => {
    const created = await h.call('s1', 'POST', 'issues', { repo: 'acme/app', title: 'bug found', body: 'details <!-- runpane-cloud:s2 -->', labels: ['BUG', 'made-up'] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(created.body.labels, ['bug']);
    assert.deepEqual(created.body.droppedLabels, ['made-up']);
    const issue = h.fake.repos.get('acme/app')?.issues.find((candidate) => candidate.number === created.body.number);
    assert.ok(issue && !issue.body.includes('runpane-cloud:s2') && issue.body.includes('<!-- runpane-cloud:s1 -->'));
    const byOther = await h.call('s2', 'PATCH', `issues/${String(created.body.number)}`, { repo: 'acme/app', state: 'closed' });
    assert.equal(byOther.body.code, 'not-owner');
    const closed = await h.call('s1', 'PATCH', `issues/${String(created.body.number)}`, { repo: 'acme/app', state: 'closed' });
    assert.equal(closed.body.state, 'closed');
    const pulls = h.fake.repos.get('acme/app')?.pulls ?? [];
    if (pulls.length > 0) {
      const asIssue = await h.call('s1', 'PATCH', `issues/${pulls[0].number}`, { repo: 'acme/app', state: 'closed' });
      assert.equal(asIssue.body.code, 'not-owner');
    }
  });

  it('comments on any issue or PR in an allowed repo, with the marker', async () => {
    const issue = await h.call('s2', 'POST', 'issues', { repo: 'acme/app', title: 'from two' });
    const comment = await h.call('s1', 'POST', 'comments', { repo: 'acme/app', number: issue.body.number, body: 'looking' });
    assert.equal(comment.status, 200, JSON.stringify(comment.body));
    const stored = h.fake.repos.get('acme/app')?.comments.find((candidate) => candidate.id === comment.body.id);
    assert.ok(stored?.body.startsWith('looking\n\n---\nOpened by runpane cloud Session One'));
  });

  it('read passthrough: allowlisted paths and query keys only', async () => {
    const pulls = await h.call('s1', 'GET', 'read/acme/app/pulls?state=all&per_page=5');
    assert.equal(pulls.status, 200, JSON.stringify(pulls.body));
    assert.ok(Array.isArray(pulls.body.data));
    const seeded = await h.call('s1', 'POST', 'issues', { repo: 'acme/app', title: 'seeded for read', body: 'read me' });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const issue = await h.call('s1', 'GET', `read/acme/app/issues/${String(seeded.body.number)}`);
    assert.equal(issue.status, 200, JSON.stringify(issue.body));
    assert.equal(issue.body.status, 200);
    const data = json(issue.body.data);
    assert.equal(data.number, seeded.body.number);
    assert.equal(data.title, 'seeded for read');
    assert.equal(data.state, 'open');
    assert.ok(String(data.body).startsWith('read me'));
    for (const route of ['read/acme/app/collaborators', 'read/acme/app/pulls/1/merge', 'read/acme/app/git/refs', 'read/acme/app/issues?access_token=x', 'read/acme/app/../../user']) {
      const refused = await h.call('s1', 'GET', route);
      assert.ok(['forbidden', 'bad-request', 'not-found'].includes(String(refused.body.code)), `${route}: ${JSON.stringify(refused.body)}`);
    }
    const other = await h.call('s1', 'GET', 'read/acme/other/pulls');
    assert.equal(other.body.code, 'repo-not-allowed');
    // statuses/checks/actions need permissions this App lacks: refused before minting a token.
    const checks = await h.call('s1', 'GET', 'read/acme/app/commits/master/check-runs');
    assert.equal(checks.body.code, 'github-error');
    assert.equal(checks.body.githubStatus, 403);
  });

  it('maps GitHub rate limiting to github-rate-limited', async () => {
    h.fake.rateLimitNext = true;
    const result = await h.call('s1', 'POST', 'issues', { repo: 'acme/app', title: 'limited' });
    assert.deepEqual([result.status, result.body.code], [429, 'github-rate-limited']);
  });

  it('audits every call without tokens or text (0600)', async () => {
    const file = path.join(h.stateDir, 'github-audit.jsonl');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, 'utf8');
    for (const token of h.fake.tokens.keys()) assert.ok(!text.includes(token));
    assert.ok(!text.includes('Does a thing') && !text.includes('bug found') && !text.includes('looking'));
    const lines = text.trim().split('\n').map((line) => json(JSON.parse(line)));
    const refused = lines.find((line) => line.outcome === 'workflow-change-refused');
    assert.ok(refused && refused.callerId === 's1' && refused.label === 'One' && refused.repo === 'acme/app');
    assert.ok(lines.some((line) => line.outcome === 'caller-node-mismatch'));
    // Refusals record what was asked for.
    assert.ok(lines.some((line) => line.outcome === 'repo-not-allowed' && line.repo === 'acme/other'));
    assert.ok(lines.some((line) => line.outcome === 'ref-outside-namespace' && line.target === 'refs/heads/master'));
    const push = lines.find((line) => line.endpoint === 'POST push' && line.outcome === 'ok');
    assert.ok(push);
    const pushed = decodeBoundary(push, auditLineSchema);
    assert.match(pushed.bundleSha ?? '', /^[0-9a-f]{40}$/u);
    assert.ok((pushed.node ?? '').startsWith('rp-one.tail.ts.net'));
    const audit = await h.call('user:owner', 'GET', 'audit?limit=5');
    assert.equal(jsonList(audit.body.entries).length, 5);
    // A Session must not read other Sessions' calls.
    const peer = await h.call('s1', 'GET', 'audit');
    assert.deepEqual([peer.status, peer.body.code], [403, 'forbidden']);
  });
});

describe('GitHub broker limits, PAT mode and off', () => {
  it('rate-limits pushes per Session per hour', async () => {
    const h = await harness({ github: { limits: { pushesPerSessionPerHour: 2 } } });
    try {
      const master = h.fake.refs('acme/app')['refs/heads/master'];
      for (const expected of [200, 200, 429]) {
        const result = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: `limited-${expected}-${Math.random()}`.replace('0.', ''), sha: master });
        assert.equal(result.status, expected, JSON.stringify(result.body));
        if (expected === 429) assert.equal(result.body.code, 'broker-rate-limited');
      }
      const other = await h.call('s2', 'POST', 'push', { repo: 'acme/app', branch: 'still-fine', sha: master });
      assert.equal(other.status, 200);
      h.clock.time += 3_600_001;
      const later = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'after-an-hour', sha: master });
      assert.equal(later.status, 200);
    } finally {
      await h.close();
    }
  });

  it('allowReadyPulls lets a Session open a ready PR', async () => {
    const h = await harness({ github: { allowReadyPulls: true } });
    try {
      const master = h.fake.refs('acme/app')['refs/heads/master'];
      const work = new Work(h.fake);
      work.commit('ready.txt', 'r\n');
      await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'ready', bundle: work.bundle() });
      const pull = await h.call('s1', 'POST', 'pulls', { repo: 'acme/app', branch: 'ready', title: 'ready', draft: false });
      assert.equal(pull.body.draft, false);
      assert.ok(master);
    } finally {
      await h.close();
    }
  });

  it('PAT mode: pushes with the PAT; no read tokens; a repo the PAT cannot see fails at GitHub', async () => {
    const h = await harness({ mode: 'pat' });
    try {
      const status = await h.call('user:owner', 'GET', 'status');
      assert.equal(status.body.mode, 'pat');
      assert.ok(!JSON.stringify(status.body).includes(PAT));
      const work = new Work(h.fake);
      const head = work.commit('pat.txt', 'p\n');
      const pushed = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'via-pat', bundle: work.bundle() });
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
      assert.equal(h.fake.refs('acme/app')['refs/heads/cloud/rp-one/via-pat'], head);
      const token = await h.call('s1', 'POST', 'token', { repo: 'acme/app' });
      assert.deepEqual([token.status, token.body.code], [409, 'read-token-unsupported']);
      assert.equal(h.fake.minted.length, 0);
    } finally {
      await h.close();
    }
  });

  it('a classic token in the PAT file leaves the broker disabled with the reason', async () => {
    const h = await harness({ mode: 'pat' });
    await h.close();
    const root = tempDir('rp-classic-');
    const patFile = path.join(root, 'pat');
    fs.writeFileSync(patFile, 'ghp_classicclassicclassic\n', { mode: 0o600 });
    const config = parseCoordinatorConfig({
      version: 1, listenHost: '127.0.0.1', stateDir: path.join(root, 'state'), provider: { kind: 'boat', apiKeyFile: '/k' }, managedNamePrefix: 'rp-',
      github: { mode: 'pat', patFile, apiBaseUrl: 'http://127.0.0.1:9', gitBaseUrl: 'http://127.0.0.1:9' },
    }, root);
    const broker = buildGitHubBroker(config, new FakeClock(), FakeDirectory.of([S1]), { whois: { whois: async () => NODES.s1 } });
    const answer = await broker.handle({ method: 'POST', path: 'push', query: new URLSearchParams(), caller: { id: 's1', role: 'peer' }, remoteAddress: '100.64.0.2', readBody: async () => ({}) });
    assert.equal(answer.body.code, 'github-disabled');
    assert.match(String(answer.body.message), /refusing a ghp_/u);
    assert.ok(!String(answer.body.message).includes('classicclassic'));
    const status = await broker.handle({ method: 'GET', path: 'status', query: new URLSearchParams(), caller: { id: 'user:owner', role: 'user' }, remoteAddress: '100.64.0.9', readBody: async () => ({}) });
    assert.equal(status.body.mode, 'pat');
    assert.match(String(status.body.error), /refusing a ghp_/u);
  });

  it('off: status says so and writes answer github-disabled', async () => {
    const h = await harness({ mode: 'off' });
    try {
      const status = await h.call('user:owner', 'GET', 'status');
      assert.equal(status.body.mode, 'off');
      const push = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'x', sha: 'a'.repeat(40) });
      assert.deepEqual([push.status, push.body.code], [503, 'github-disabled']);
    } finally {
      await h.close();
    }
  });

  it('an expired installation token is not reused (the fake rejects it) because the cache refreshes early', async () => {
    const h = await harness({ tokenTtlMs: 10 * 60_000 });
    try {
      const master = h.fake.refs('acme/app')['refs/heads/master'];
      const first = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'ttl-1', sha: master });
      assert.equal(first.status, 200);
      h.clock.time += 6 * 60_000; // 4 minutes left: inside the 5-minute margin
      const second = await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'ttl-2', sha: master });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(h.fake.minted.filter((token) => token.permissions.contents === 'write').length, 2);
    } finally {
      await h.close();
    }
  });
});

// A real App installation can be granted more than the broker needs. Whatever the grant, every token the
// broker mints must be capped: explicit permissions within the ceiling, never write for checks,
// statuses or actions, and one repository for anything beyond metadata.
describe('GitHub broker with an over-privileged App installation', () => {
  const OVER_PRIVILEGED = {
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    metadata: 'read',
    actions: 'write',
    statuses: 'write',
    merge_queues: 'write',
    gists: 'write',
    issue_fields: 'write',
    issue_types: 'write',
    organization_events: 'read',
  } satisfies Record<string, 'read' | 'write'>;
  const CEILING = new Map([['contents', 'write'], ['issues', 'write'], ['pull_requests', 'write'], ['metadata', 'read'], ['checks', 'read'], ['statuses', 'read'], ['actions', 'read']]);

  it('every access_tokens request, across every endpoint, is explicit, capped and single-repo', async () => {
    const h = await harness({ permissions: OVER_PRIVILEGED, github: { limits: { pushesPerSessionPerHour: 1000, writesPerSessionPerHour: 1000 } } });
    try {
      const calls: Array<[string, string, string, JsonValue?]> = [];
      const call = async (caller: string, method: string, route: string, body?: JsonValue) => {
        const result = await h.call(caller, method, route, body);
        calls.push([caller, method, route, result.body.code === undefined ? 'ok' : String(result.body.code)]);
        return result;
      };
      // status as user and as a Session (describe), then every Session endpoint.
      const status = await call('user:owner', 'GET', 'status');
      await call('s1', 'GET', 'status');
      await call('s1', 'POST', 'token', { repo: 'acme/app' });
      const work = new Work(h.fake);
      work.commit('over.txt', 'o\n');
      assert.equal((await call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'over', bundle: work.bundle() })).status, 200);
      const pull = await call('s1', 'POST', 'pulls', { repo: 'acme/app', branch: 'over', title: 'over' });
      assert.equal(pull.status, 200, JSON.stringify(pull.body));
      const n = String(pull.body.number);
      await call('s1', 'PATCH', `pulls/${n}`, { repo: 'acme/app', title: 'renamed' });
      const issue = await call('s1', 'POST', 'issues', { repo: 'acme/app', title: 'over issue', labels: ['bug'] });
      const i = String(issue.body.number);
      await call('s1', 'PATCH', `issues/${i}`, { repo: 'acme/app', state: 'closed' });
      await call('s1', 'POST', 'comments', { repo: 'acme/app', number: Number(n), body: 'c' });
      for (const path of ['issues', `issues/${i}`, `issues/${i}/comments`, 'pulls', `pulls/${n}`, `pulls/${n}/files`, `pulls/${n}/reviews`, 'commits/master/status', 'commits/master/check-runs', 'actions/runs?branch=master']) {
        await call('s1', 'GET', `read/acme/app/${path}`);
      }
      // Everything the grant allows worked; check-runs is refused because this App has no checks at all.
      const failed = calls.filter(([, , , outcome]) => outcome !== 'ok').map(([, method, route, outcome]) => `${method} ${route} ${outcome}`);
      assert.deepEqual(failed, ['GET read/acme/app/commits/master/check-runs github-error']);

      assert.ok(h.fake.minted.length >= 8, `minted ${h.fake.minted.length}`);
      for (const minted of h.fake.minted) {
        const label = JSON.stringify(minted);
        assert.ok(minted.requestedPermissions, `no explicit permissions: ${label}`);
        const requested = Object.entries(minted.requestedPermissions);
        assert.ok(requested.length > 0, label);
        for (const [name, level] of requested) {
          const cap = CEILING.get(name);
          assert.ok(cap, `${name} is outside the broker's permission set: ${label}`);
          assert.ok(level === 'read' || cap === 'write', `${name}:${level} exceeds ${cap}: ${label}`);
        }
        const beyondMetadata = requested.some(([name]) => name !== 'metadata');
        if (beyondMetadata) assert.deepEqual(minted.repositories, ['app'], label);
        // The only installation-wide token is describe()'s metadata-only one (it lists repositories).
        if (minted.repositories === null) assert.deepEqual(minted.requestedPermissions, { metadata: 'read' }, label);
      }
      // acme/other is installed too, but no Session is granted it: no token ever names it.
      await call('s1', 'GET', 'read/acme/other/pulls');
      assert.ok(!h.fake.minted.some((minted) => minted.repositories?.includes('other')));
      // Reads of statuses/actions got read-only tokens despite the write grant.
      assert.ok(h.fake.minted.some((minted) => minted.requestedPermissions?.statuses === 'read'));
      assert.ok(h.fake.minted.some((minted) => minted.requestedPermissions?.actions === 'read'));

      // status reports the excess grant (never used) so the user can narrow the App.
      const installation = jsonList(json(status.body.app ?? null).installations)[0];
      assert.deepEqual(installation.extraPermissions, ['actions:write', 'gists:write', 'issue_fields:write', 'issue_types:write', 'merge_queues:write', 'organization_events:read', 'statuses:write']);
      assert.deepEqual(installation.missingPermissions, []);
      assert.deepEqual(installation.forbiddenPermissions, []);
      assert.equal(installation.repositorySelection, 'selected');
    } finally {
      await h.close();
    }
  });
});

// Seen on real GitHub: POST pulls answered 422 "not all refs are readable" because the token had
// only pull_requests:write. GitHub reads the head and base refs, which needs contents:read.
describe('pull requests need contents:read (real-GitHub regression)', () => {
  it('the fake refuses a PR without contents:read like GitHub; the broker mints contents:read + pull_requests:write', async () => {
    const h = await harness();
    try {
      const work = new Work(h.fake);
      work.commit('refs.txt', 'r\n');
      assert.equal((await h.call('s1', 'POST', 'push', { repo: 'acme/app', branch: 'refs', bundle: work.bundle() })).status, 200);
      // A token with pull_requests:write only, straight at the fake: GitHub's 422.
      h.fake.addPat('github_pat_prsonly', ['acme/app'], { pull_requests: 'write', metadata: 'read' });
      const direct = await fetch(`${h.fake.baseUrl}/repos/acme/app/pulls`, {
        method: 'POST',
        headers: { Authorization: 'Bearer github_pat_prsonly', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 't', head: 'cloud/rp-one/refs', base: 'master', draft: true }),
      });
      assert.equal(direct.status, 422);
      assert.match(JSON.stringify(await direct.json()), /not all refs are readable/u);

      const before = h.fake.minted.length;
      const pull = await h.call('s1', 'POST', 'pulls', { repo: 'acme/app', branch: 'refs', title: 'refs' });
      assert.equal(pull.status, 200, JSON.stringify(pull.body));
      const edited = await h.call('s1', 'PATCH', `pulls/${String(pull.body.number)}`, { repo: 'acme/app', state: 'closed' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const pullTokens = h.fake.minted.slice(before).filter((minted) => minted.requestedPermissions?.pull_requests === 'write');
      assert.ok(pullTokens.length >= 1);
      for (const minted of pullTokens) assert.deepEqual(minted.requestedPermissions, { metadata: 'read', contents: 'read', pull_requests: 'write' });
      const files = await h.call('s1', 'GET', `read/acme/app/pulls/${String(pull.body.number)}/files`);
      assert.equal(files.status, 200, JSON.stringify(files.body));
    } finally {
      await h.close();
    }
  });
});
