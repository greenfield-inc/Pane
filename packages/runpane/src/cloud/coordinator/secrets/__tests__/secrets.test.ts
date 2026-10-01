import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { boundary, decodeBoundary } from '../../../../boundaryDecoder';
import type { JsonObject, JsonValue } from '../../../../boundaryDecoder';
import { MemoryAlertSink } from '../../alerts';
import { mintCallerToken } from '../../callerAuth';
import { parseCoordinatorConfig } from '../../config';
import { createCoordinatorServer } from '../../server';
import type { CoordinatorApi } from '../../server';
import { buildGitHubBroker, buildSecretsService } from '../../service';
import { entry, FakeClock, FakeDirectory } from '../../__tests__/fakes';
import type { FetchLike } from '../../../githubTransport';
import type { TailnetNode, WhoisResolver } from '../../github/whois';
import { FakeGitHub } from '../../github/__tests__/fakeGitHub';
import { MANIFEST_PATH, parseManifest } from '../manifest';
import { sessionWritableRef } from '../service';

const SECRET = 'secrets-test-secret';
const APP_ID = '515151';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// Fake Doppler: one service token per config, like Doppler's own scoping.
const TOKENS = { dev: 'dp.st.dev.FAKEFAKEFAKE', prd: 'dp.st.prd.FAKEFAKEFAKE', personal: 'dp.st.dev_personal.FAKE' } as const;
const DEV_VALUES = new Map([
  ['OPENROUTER_API_KEY', 'sk-or-value-1'],
  ['PRODUCTION_DATABASE_URL', 'postgres://prod-value'],
  ['NEON_CONNECTION_STRING', 'postgres://neon-value'],
  ['R2_ACCESS_KEY_ID', 'r2-id-value'],
  ['R2_SECRET_ACCESS_KEY', 'r2-secret-value'],
  ['DOPPLER_PROJECT', 'my-app'],
  ['DOPPLER_CONFIG', 'dev'],
  ['PATH', '/evil'],
]);
/** The values that are secrets (DOPPLER_PROJECT and DOPPLER_CONFIG are the project and config names, which output shows). */
const SECRET_VALUES = [...DEV_VALUES].filter(([name]) => !name.startsWith('DOPPLER_')).map(([, value]) => value);

const S1 = entry('s1', 'bx_a', { label: 'One', baseUrl: 'https://rp-one.tail.ts.net', nodeId: 'nOne', githubRepos: ['acme/app'], secretsManifest: { repo: 'acme/app', ref: 'manifest' } });
const S2 = entry('s2', 'bx_b', { label: 'Two', baseUrl: 'https://rp-two.tail.ts.net', nodeId: 'nTwo', githubRepos: ['acme/app'], secretsManifest: { repo: 'acme/app', ref: 'cloud/rp-two/mine' } });
const S3 = entry('s3', 'bx_c', { label: 'Three', baseUrl: 'https://rp-three.tail.ts.net', nodeId: 'nThree', githubRepos: [], secretsManifest: null });
// Session B, created with `cloud new --ref cloud/rp-two/grant`: a branch Session A (S2) pushes to through the broker.
const S4 = entry('s4', 'bx_d', { label: 'Four', baseUrl: 'https://rp-four.tail.ts.net', nodeId: 'nFour', githubRepos: ['acme/app'], secretsManifest: { repo: 'acme/app', ref: 'cloud/rp-two/grant' } });
const NODES = {
  s1: { stableId: 'nOne', name: 'rp-one.tail.ts.net', tags: ['tag:rp-session'] },
  s2: { stableId: 'nTwo', name: 'rp-two.tail.ts.net', tags: ['tag:rp-session'] },
  s3: { stableId: 'nThree', name: 'rp-three.tail.ts.net', tags: ['tag:rp-session'] },
  s4: { stableId: 'nFour', name: 'rp-four.tail.ts.net', tags: ['tag:rp-session'] },
} satisfies Record<string, TailnetNode>;

const json = (value: JsonValue): JsonObject => decodeBoundary(value, boundary.jsonObject);
const configsOf = (body: JsonObject) => decodeBoundary(body.configs, boundary.array(boundary.object({
  project: boundary.string,
  config: boundary.string,
  values: boundary.jsonObject,
  withheld: boundary.array(boundary.object({ name: boundary.string, reason: boundary.string })),
  missing: boundary.array(boundary.string),
  refused: boundary.nullable(boundary.string),
})));

const unusedApi: CoordinatorApi = {
  status: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  wake: async () => ({ ok: false, code: 'unknown-host', message: '' }),
  reconcile: async () => { throw new Error('unused'); },
  idleCheck: async () => ({ ok: true, results: [] }),
};

class SwitchableWhois implements WhoisResolver {
  node: TailnetNode | null = NODES.s1;

  async whois(): Promise<TailnetNode | null> {
    return this.node;
  }
}

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  fake: FakeGitHub;
  whois: SwitchableWhois;
  stateDir: string;
  dopplerCalls: string[];
  dopplerDown: { value: boolean };
  call(caller: string, method: string, route: string): Promise<{ status: number; body: JsonObject }>;
  callFrom(caller: string, node: TailnetNode | null, method: string, route: string): Promise<{ status: number; body: JsonObject }>;
  setManifest(text: string | null, branch?: string): void;
  close(): Promise<void>;
}

async function harness(options: { policy?: JsonObject; tokens?: Array<keyof typeof TOKENS>; badTokenFile?: boolean; limits?: JsonObject } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-secrets-'));
  roots.push(root);
  const clock = new FakeClock(Date.now());
  const fake = new FakeGitHub({ root: path.join(root, 'github'), appId: APP_ID, appPublicKey: PUBLIC_PEM, now: () => clock.now() });
  fake.createRepo('acme/app');
  const fakeBase = await fake.start();
  const keyFile = path.join(root, 'app.pem');
  fs.writeFileSync(keyFile, PRIVATE_PEM, { mode: 0o600 });
  const tokenEntries = (options.tokens ?? ['dev', 'prd']).map((name) => {
    const config = name === 'personal' ? 'dev_personal' : name;
    const file = path.join(root, `my-app.${config}.token`);
    fs.writeFileSync(file, `${TOKENS[name]}\n`, { mode: options.badTokenFile && name === 'dev' ? 0o644 : 0o600 });
    return { project: 'my-app', config, tokenFile: file };
  });
  const secretsSection: JsonObject = { doppler: { apiBaseUrl: 'https://doppler.invalid', tokens: tokenEntries } };
  if (options.policy) secretsSection.policy = options.policy;
  if (options.limits) secretsSection.limits = options.limits;
  const config = parseCoordinatorConfig({
    version: 1,
    listenHost: '127.0.0.1',
    stateDir: path.join(root, 'state'),
    provider: { kind: 'boat', apiKeyFile: path.join(root, 'unused') },
    managedNamePrefix: 'rp-',
    github: { mode: 'app', appId: APP_ID, privateKeyFile: keyFile, apiBaseUrl: fakeBase, gitBaseUrl: fakeBase },
    secrets: secretsSection,
  }, root);
  const directory = FakeDirectory.of([S1, S2, S3, S4]);
  const whois = new SwitchableWhois();
  const dopplerCalls: string[] = [];
  const dopplerDown = { value: false };
  const dopplerFetch: FetchLike = async (url, init) => {
    const token = (init.headers.get('authorization') ?? '').replace(/^Bearer /u, '');
    dopplerCalls.push(url);
    const reply = (status: number, body: JsonValue) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (dopplerDown.value) return reply(503, { messages: ['Doppler is down'], success: false });
    const parsed = new URL(url);
    if (parsed.pathname !== '/v3/configs/config/secrets/download' || parsed.searchParams.get('format') !== 'json') return reply(404, { messages: ['no route'] });
    // Like Doppler: a service token reads only its own config.
    const wanted = `${parsed.searchParams.get('project') ?? ''}/${parsed.searchParams.get('config') ?? ''}`;
    const own = token === TOKENS.dev ? 'my-app/dev' : token === TOKENS.personal ? 'my-app/dev_personal' : token === TOKENS.prd ? 'my-app/prd' : '';
    if (own && wanted !== own) return reply(400, { messages: [`This token does not have access to requested config '${parsed.searchParams.get('config') ?? ''}'`], success: false });
    if (token === TOKENS.dev) return reply(200, Object.fromEntries(DEV_VALUES));
    if (token === TOKENS.personal) return reply(200, { OPENROUTER_API_KEY: 'personal-value', DOPPLER_CONFIG: 'dev_personal' });
    if (token === TOKENS.prd) return reply(200, { DOPPLER_PROJECT: 'my-app', DOPPLER_CONFIG: 'prd', PRD_ONLY: 'prd-value' });
    return reply(401, { messages: ['Invalid Auth token'], success: false });
  };
  const broker = buildGitHubBroker(config, clock, directory, { whois });
  const secrets = buildSecretsService(config, clock, directory, broker, { whois, dopplerFetch });
  const server = createCoordinatorServer({
    api: unusedApi, directory, directoryWriter: null, alerts: new MemoryAlertSink(), clock, secret: SECRET, revokedCallers: [], version: 'test', log: () => undefined, github: broker, secrets,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listening on a TCP host and port, the server reports an AddressInfo.
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const callFrom = async (caller: string, node: TailnetNode | null, method: string, route: string) => {
    whois.node = node;
    const response = await fetch(`${base}/cloud/secrets/${route}`, {
      method,
      headers: { Authorization: `Bearer ${mintCallerToken(SECRET, caller)}`, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    return { status: response.status, body: json(await response.json()) };
  };
  return {
    fake,
    whois,
    stateDir: config.stateDir,
    dopplerCalls,
    dopplerDown,
    call: (caller, method, route) => {
      if (caller === 's1' || caller === 's2' || caller === 's3' || caller === 's4') whois.node = NODES[caller];
      return callFrom(caller, whois.node, method, route);
    },
    callFrom,
    setManifest(text, branch = 'manifest') {
      fake.commitFiles('acme/app', branch, new Map([[MANIFEST_PATH, text]]), 'manifest');
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.stop();
    },
  };
}

const ALL_DEV = JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: 'all' }] });

function auditText(stateDir: string): string {
  return fs.readFileSync(path.join(stateDir, 'secrets-audit.jsonl'), 'utf8');
}

describe('manifest', () => {
  it('parses names or all per config and refuses bad input with the fix', () => {
    assert.deepEqual(parseManifest(ALL_DEV).entries, [{ project: 'my-app', config: 'dev', names: 'all' }]);
    assert.deepEqual(parseManifest(JSON.stringify({ version: 1, doppler: [{ project: 'p', config: 'c', names: ['A', 'R2_*', 'A'] }] })).entries[0].names, ['A', 'R2_*']);
    for (const bad of ['{', '{"version":2,"doppler":[]}', '{"version":1,"doppler":[]}', '{"version":1,"doppler":[{"project":"p","config":"c","names":[]}]}',
      '{"version":1,"doppler":[{"project":"p","config":"c","names":["A B"]}]}', '{"version":1,"doppler":[{"project":"../x","config":"c","names":"all"}]}',
      '{"version":1,"doppler":[{"project":"p","config":"c","names":"all"},{"project":"p","config":"c","names":"all"}]}']) {
      assert.throws(() => parseManifest(bad), /\.runpane\/secrets\.json/u, bad);
    }
  });
});

describe('secrets service', () => {
  it('allow-all delivers every manifest name (production included) and audits names, never values', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      h.setManifest(ALL_DEV);
      const answer = await h.call('s1', 'POST', 'fetch');
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const [dev] = configsOf(answer.body);
      assert.equal(dev.values.PRODUCTION_DATABASE_URL, 'postgres://prod-value');
      assert.equal(dev.values.NEON_CONNECTION_STRING, 'postgres://neon-value');
      assert.equal(dev.values.OPENROUTER_API_KEY, 'sk-or-value-1');
      // Shell and Pane variables are never delivered, whatever the policy.
      assert.equal(dev.values.PATH, undefined);
      assert.deepEqual(dev.withheld.map((item) => item.name), ['PATH']);
      assert.equal(answer.body.policy, 'allow-all');
      assert.match(String(answer.body.version), /^[0-9a-f]{16}$/u);
      const audit = auditText(h.stateDir);
      assert.match(audit, /PRODUCTION_DATABASE_URL/u);
      for (const value of SECRET_VALUES) assert.equal(audit.includes(value), false, 'no value in the audit');
      assert.equal((fs.statSync(path.join(h.stateDir, 'secrets-audit.jsonl')).mode & 0o777), 0o600);
    } finally {
      await h.close();
    }
  });

  it('the default policy withholds production families and refuses prd configs', async () => {
    const h = await harness();
    try {
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: 'all' }, { project: 'my-app', config: 'prd', names: 'all' }] }));
      const answer = await h.call('s1', 'POST', 'fetch');
      assert.equal(answer.status, 200);
      const [dev, prd] = configsOf(answer.body);
      assert.deepEqual(Object.keys(dev.values).sort(), ['OPENROUTER_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
      assert.deepEqual(dev.withheld.map((item) => item.name), ['DOPPLER_CONFIG', 'DOPPLER_PROJECT', 'NEON_CONNECTION_STRING', 'PATH', 'PRODUCTION_DATABASE_URL']);
      assert.match(prd.refused ?? '', /policy \(default\) refuses config prd/u);
      assert.deepEqual(prd.values, {});
      // A refused config is not even read from Doppler.
      assert.equal(h.dopplerCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  it('a names list with patterns narrows the set and reports names Doppler lacks', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: ['OPENROUTER_API_KEY', 'R2_*', 'NOT_THERE'] }] }));
      const [dev] = configsOf((await h.call('s1', 'POST', 'fetch')).body);
      assert.deepEqual(Object.keys(dev.values).sort(), ['OPENROUTER_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
      assert.deepEqual(dev.missing, ['NOT_THERE']);
    } finally {
      await h.close();
    }
  });

  it('a manifest change shows up on the next fetch (removal included), with a new version', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: ['OPENROUTER_API_KEY', 'R2_ACCESS_KEY_ID'] }] }));
      const first = await h.call('s1', 'POST', 'fetch');
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: ['OPENROUTER_API_KEY'] }] }));
      const second = await h.call('s1', 'POST', 'fetch');
      assert.deepEqual(Object.keys(configsOf(second.body)[0].values), ['OPENROUTER_API_KEY']);
      assert.notEqual(first.body.version, second.body.version);
      h.setManifest(null);
      const third = await h.call('s1', 'POST', 'fetch');
      assert.equal(third.status, 200);
      assert.deepEqual(third.body.configs, []);
      assert.match(String(third.body.reason), /has no \.runpane\/secrets\.json/u);
    } finally {
      await h.close();
    }
  });

  it('refuses an invalid manifest (422), a manifest on the caller\'s own branch (403) and answers Sessions without a repo', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      h.setManifest('{"version":1,"doppler":"all"}');
      const invalid = await h.call('s1', 'POST', 'fetch');
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.code, 'manifest-invalid');
      h.setManifest(ALL_DEV, 'cloud/rp-two/mine');
      const own = await h.call('s2', 'POST', 'fetch');
      assert.equal(own.status, 403);
      assert.equal(own.body.code, 'manifest-ref-writable');
      const none = await h.call('s3', 'POST', 'fetch');
      assert.equal(none.status, 200);
      assert.equal(none.body.manifest, null);
      assert.equal(h.dopplerCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('refuses a manifest another Session wrote: B created from A\'s cloud/<A>/ branch gets nothing, in any ref spelling', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      // Session A (rp-two) asks for production through a branch the broker lets it push.
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: 'all' }, { project: 'my-app', config: 'prd', names: 'all' }] }), 'cloud/rp-two/grant');
      const crossed = await h.call('s4', 'POST', 'fetch');
      assert.equal(crossed.status, 403, `status ${crossed.status} code ${String(crossed.body.code)}`);
      assert.equal(crossed.body.code, 'manifest-ref-writable');
      assert.equal(crossed.body.configs, undefined, 'nothing delivered');
      assert.equal(h.dopplerCalls.length, 0, 'Doppler is never asked');
      for (const ref of ['refs/heads/cloud/rp-two/grant', 'heads/cloud/rp-two/grant', 'Cloud/rp-two/grant', 'cloud/rp-one/x']) {
        assert.equal(sessionWritableRef(ref), true, ref);
      }
      for (const ref of ['main', 'manifest', 'refs/heads/main', 'feature/cloud/x', 'cloudy/x']) {
        assert.equal(sessionWritableRef(ref), false, ref);
      }
    } finally {
      await h.close();
    }
  });

  it('binds the caller to its node before GitHub or Doppler is asked; users stay off fetch, Sessions off the audit', async () => {
    const h = await harness({ policy: { mode: 'allow-all' } });
    try {
      h.setManifest(ALL_DEV);
      const githubBefore = h.fake.requests.length;
      // s1's token, sent from s2's node (a copied token).
      const copied = await h.callFrom('s1', NODES.s2, 'POST', 'fetch');
      assert.equal(copied.status, 403);
      assert.equal(copied.body.code, 'caller-node-mismatch');
      const untagged = await h.callFrom('s1', { ...NODES.s1, tags: [] }, 'POST', 'fetch');
      assert.equal(untagged.status, 403);
      assert.equal((await h.callFrom('s1', null, 'GET', 'status')).status, 403);
      assert.equal(h.fake.requests.length, githubBefore);
      const user = await h.call('user:owner', 'POST', 'fetch');
      assert.equal(user.status, 403);
      assert.equal(user.body.code, 'forbidden');
      assert.equal((await h.call('s1', 'GET', 'audit')).status, 403);
      const userAudit = await h.call('user:owner', 'GET', 'audit');
      assert.equal(userAudit.status, 200);
      assert.match(JSON.stringify(userAudit.body), /caller-node-mismatch/u);
      assert.equal(h.dopplerCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('status: users see configs, policy and a names count with check=1; nothing secret', async () => {
    const h = await harness({ policy: { mode: 'allow-all' }, tokens: ['dev', 'personal'] });
    try {
      const status = await h.call('user:owner', 'GET', 'status?check=1');
      assert.equal(status.status, 200);
      const text = JSON.stringify(status.body);
      assert.match(text, /"names":8/u);
      assert.match(text, /"mode":"allow-all"/u);
      for (const token of Object.values(TOKENS)) assert.equal(text.includes(token), false);
      for (const value of SECRET_VALUES) assert.equal(text.includes(value), false);
    } finally {
      await h.close();
    }
  });

  it('a config without a token is refused by name; a token file others can read is not loaded', async () => {
    const h = await harness({ policy: { mode: 'allow-all' }, badTokenFile: true, tokens: ['dev'] });
    try {
      h.setManifest(JSON.stringify({ version: 1, doppler: [{ project: 'my-app', config: 'dev', names: 'all' }, { project: 'my-app', config: 'stg', names: 'all' }] }));
      const [dev, stg] = configsOf((await h.call('s1', 'POST', 'fetch')).body);
      assert.match(dev.refused ?? '', /could not be loaded: .*chmod 600/u);
      assert.match(stg.refused ?? '', /holds no Doppler token for my-app\/stg/u);
    } finally {
      await h.close();
    }
  });

  it('a Doppler outage fails the fetch (so Sessions keep their copy); the rate limit applies', async () => {
    const h = await harness({ policy: { mode: 'allow-all' }, limits: { fetchesPerSessionPerHour: 2 } });
    try {
      h.setManifest(ALL_DEV);
      h.dopplerDown.value = true;
      const down = await h.call('s1', 'POST', 'fetch');
      assert.equal(down.status, 502);
      assert.equal(down.body.code, 'doppler-error');
      h.dopplerDown.value = false;
      assert.equal((await h.call('s1', 'POST', 'fetch')).status, 200);
      const limited = await h.call('s1', 'POST', 'fetch');
      assert.equal(limited.status, 429);
    } finally {
      await h.close();
    }
  });
});

describe('secrets config', () => {
  it('resolves the policy modes', () => {
    const base = { version: 1, listenHost: '127.0.0.1', provider: { kind: 'boat', apiKeyFile: '/x' }, managedNamePrefix: 'rp-' };
    const doppler = { apiBaseUrl: 'https://api.doppler.com', tokens: [{ project: 'p', config: 'dev', tokenFile: '/t' }] };
    assert.equal(parseCoordinatorConfig(base, '/h').secrets, null);
    const defaults = parseCoordinatorConfig({ ...base, secrets: { doppler } }, '/h').secrets;
    assert.equal(defaults?.policy.mode, 'default');
    assert.ok(defaults?.policy.deniedNames.includes('PRODUCTION_*'));
    assert.ok(defaults?.policy.deniedConfigs.includes('prd'));
    const open = parseCoordinatorConfig({ ...base, secrets: { doppler, policy: { mode: 'allow-all' } } }, '/h').secrets;
    assert.deepEqual(open?.policy, { mode: 'allow-all', deniedNames: [], deniedConfigs: [] });
    const custom = parseCoordinatorConfig({ ...base, secrets: { doppler, policy: { mode: 'custom', deniedNames: ['X_*'] } } }, '/h').secrets;
    assert.deepEqual(custom?.policy.deniedNames, ['X_*']);
    assert.throws(() => parseCoordinatorConfig({ ...base, secrets: { doppler: { tokens: [doppler.tokens[0], doppler.tokens[0]] } } }, '/h'), /twice/u);
  });
});
