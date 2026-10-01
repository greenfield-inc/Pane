import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { JsonObject } from '../../boundaryDecoder';
import { BrokerClient } from './brokerClient';
import { runDopplerStandIn, secretsCachePath } from './doppler';
import { runGit, type GitRunner } from './localGit';
import type { AgentDeps } from './session';

// The in-Session `doppler` stand-in against a fake coordinator: what it stores, what `doppler run`
// hands the child, what it prints (never a value unless asked with secrets get), and when it clears.

const roots: string[] = [];
after(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
});

const DEV = { OPENROUTER_API_KEY: 'sk-or-secret-value', PRODUCTION_DATABASE_URL: 'postgres://prod-secret' };
const PERSONAL = { OPENROUTER_API_KEY: 'personal-secret-value' };

function answer(configs: JsonObject[], extra: JsonObject = {}): JsonObject {
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    manifest: { repo: 'acme/app', ref: null, path: '.runpane/secrets.json', sha: 'abc123def4567890' },
    policy: 'allow-all',
    version: 'v1',
    configs,
    ...extra,
  };
}

const TWO_CONFIGS = answer([
  { project: 'my-app', config: 'dev', values: DEV, withheld: [{ name: 'PATH', reason: 'reserved' }], missing: [], refused: null },
  { project: 'my-app', config: 'dev_personal', values: PERSONAL, withheld: [], missing: [], refused: null },
  { project: 'my-app', config: 'prd', values: {}, withheld: [], missing: [], refused: 'policy refuses config prd' },
]);

interface Harness {
  deps: AgentDeps;
  out: string[];
  err: string[];
  home: string;
  requests: string[];
  reply: { status: number; body: JsonObject } | 'down';
}

async function harness(): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-doppler-'));
  roots.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const control: Pick<Harness, 'reply'> = { reply: { status: 200, body: TWO_CONFIGS } };
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const reply = control.reply;
    if (reply === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  };
  const git: GitRunner = runGit;
  const deps: AgentDeps = {
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    cwd: home,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => '',
    git,
    broker: new BrokerClient({ baseUrl: 'http://coordinator.test:47300', token: 'rpc1.s1.mac' }, fakeFetch),
  };
  return {
    deps,
    out,
    err,
    home,
    requests,
    get reply() {
      return control.reply;
    },
    set reply(next) {
      control.reply = next;
    },
  };
}

async function childEnv(h: Harness, argv: string[]): Promise<{ code: number; env: Map<string, string> }> {
  const file = path.join(h.home, `env-${Math.random().toString(16).slice(2)}`);
  const code = await runDopplerStandIn([...argv, '--', 'sh', '-c', `env > '${file}'`], h.deps);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return { code, env: new Map(text.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) };
}

test('refresh stores the set 0600 in a 0700 dir and prints names, never values', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 0);
  const file = secretsCachePath(h.deps.env);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  const printed = [...h.out, ...h.err].join('\n');
  assert.match(printed, /dev 2 names/u);
  for (const value of [...Object.values(DEV), ...Object.values(PERSONAL)]) assert.equal(printed.includes(value), false);
  assert.deepEqual(h.requests, ['POST http://coordinator.test:47300/cloud/secrets/fetch']);
  assert.equal(await runDopplerStandIn(['status'], h.deps), 0);
  assert.match(h.out.join('\n'), /my-app\/prd: refused: policy refuses config prd/u);
});

test('doppler run gives the values to the child only; -p/-c pick the config; a refused or unknown config fails', async () => {
  const h = await harness();
  const first = await childEnv(h, ['run']);
  assert.equal(first.code, 0);
  assert.equal(first.env.get('OPENROUTER_API_KEY'), DEV.OPENROUTER_API_KEY);
  assert.equal(first.env.get('PRODUCTION_DATABASE_URL'), DEV.PRODUCTION_DATABASE_URL);
  assert.equal(first.env.get('DOPPLER_CONFIG'), 'dev');
  assert.equal(first.env.get('DOPPLER_ENVIRONMENT'), 'dev');
  assert.equal(h.deps.env.OPENROUTER_API_KEY, undefined, 'the parent environment is untouched');
  const personal = await childEnv(h, ['run', '-p', 'my-app', '-c', 'dev_personal']);
  assert.equal(personal.env.get('OPENROUTER_API_KEY'), PERSONAL.OPENROUTER_API_KEY);
  assert.equal(personal.env.get('PRODUCTION_DATABASE_URL'), undefined);
  const long = await childEnv(h, ['run', '--project', 'my-app', '--config', 'dev']);
  assert.equal(long.env.get('DOPPLER_CONFIG'), 'dev');
  assert.equal((await childEnv(h, ['run', '-c', 'prd'])).code, 1);
  assert.match(h.err.join('\n'), /not delivered: policy refuses config prd/u);
  assert.equal((await childEnv(h, ['run', '-c', 'stg'])).code, 1);
  assert.match(h.err.join('\n'), /my-app\/stg is not in this Session's manifest/u);
  // One fetch, then the stored copy (under an hour old).
  assert.equal(h.requests.length, 1);
  // The child's exit code comes back, and --command runs through sh.
  assert.equal(await runDopplerStandIn(['run', '--', 'sh', '-c', 'exit 7'], h.deps), 7);
  assert.equal(await runDopplerStandIn(['run', '--command', 'test -n "$OPENROUTER_API_KEY"'], h.deps), 0);
  // --preserve-env keeps a value already in the environment.
  h.deps.env.OPENROUTER_API_KEY = 'mine';
  assert.equal((await childEnv(h, ['run', '--preserve-env'])).env.get('OPENROUTER_API_KEY'), 'mine');
  assert.equal((await childEnv(h, ['run'])).env.get('OPENROUTER_API_KEY'), DEV.OPENROUTER_API_KEY);
});

test('secrets get prints the value asked for; download prints json; the names list has no values', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['secrets', 'get', 'OPENROUTER_API_KEY', '--plain'], h.deps), 0);
  assert.equal(h.out.pop(), DEV.OPENROUTER_API_KEY);
  assert.equal(await runDopplerStandIn(['secrets', 'get', 'PATH', '--plain'], h.deps), 1);
  assert.match(h.err.join('\n'), /PATH: reserved/u);
  assert.equal(await runDopplerStandIn(['secrets', 'download', '--no-file', '--format', 'json', '-c', 'dev_personal'], h.deps), 0);
  assert.equal(JSON.parse(h.out.pop() ?? '{}').OPENROUTER_API_KEY, PERSONAL.OPENROUTER_API_KEY);
  assert.equal(await runDopplerStandIn(['secrets', 'download'], h.deps), 2);
  assert.equal(await runDopplerStandIn(['secrets', '--only-names'], h.deps), 0);
  const names = h.out.pop() ?? '';
  assert.match(names, /OPENROUTER_API_KEY/u);
  assert.equal(names.includes(DEV.OPENROUTER_API_KEY), false);
  assert.equal(await runDopplerStandIn(['secrets', 'set', 'X=1'], h.deps), 2);
  assert.equal(await runDopplerStandIn(['projects'], h.deps), 2);
  assert.equal(await runDopplerStandIn(['setup'], h.deps), 0);
});

test('an outage keeps the stored copy; a decision (service off, manifest invalid) clears it', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 0);
  h.reply = 'down';
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 1);
  assert.equal((await childEnv(h, ['run'])).env.get('OPENROUTER_API_KEY'), DEV.OPENROUTER_API_KEY);
  h.reply = { status: 502, body: { ok: false, code: 'doppler-error', message: 'Doppler answered 503' } };
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 1);
  assert.equal((await childEnv(h, ['run'])).env.get('OPENROUTER_API_KEY'), DEV.OPENROUTER_API_KEY);
  h.reply = { status: 422, body: { ok: false, code: 'manifest-invalid', message: '.runpane/secrets.json is not JSON' } };
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 1);
  const cleared = await childEnv(h, ['run']);
  assert.equal(cleared.code, 1);
  assert.match(h.err.join('\n'), /no Doppler secrets are delivered to this Session: \.runpane\/secrets\.json is not JSON/u);
  const stored = await fs.readFile(secretsCachePath(h.deps.env), 'utf8');
  assert.equal(stored.includes(DEV.OPENROUTER_API_KEY), false, 'the cleared copy holds no value');
});

test('a manifest change (a name removed) is gone after refresh, and refresh reports it', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 0);
  h.reply = { status: 200, body: answer([{ project: 'my-app', config: 'dev', values: { OPENROUTER_API_KEY: DEV.OPENROUTER_API_KEY }, withheld: [], missing: [], refused: null }], { version: 'v2' }) };
  assert.equal(await runDopplerStandIn(['refresh', '--json'], h.deps), 0);
  const summary = JSON.parse(h.out.pop() ?? '{}');
  assert.equal(summary.version, 'v2');
  assert.equal(summary.previousVersion, 'v1');
  assert.ok(summary.removed.includes('my-app/dev:PRODUCTION_DATABASE_URL'));
  assert.equal((await childEnv(h, ['run'])).env.get('PRODUCTION_DATABASE_URL'), undefined);
});

test('a stored copy over an hour old is refreshed before a command', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 0);
  const file = secretsCachePath(h.deps.env);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.storedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await fs.writeFile(file, JSON.stringify(stored));
  await childEnv(h, ['run']);
  assert.equal(h.requests.length, 2);
});

test('listing, status, refresh, configs, help and every error print names and counts, never a value', async () => {
  const h = await harness();
  const values = [...Object.values(DEV), ...Object.values(PERSONAL)];
  const quiet: string[][] = [
    ['refresh'], ['refresh', '--json'], ['status'], ['status', '--json'], ['me'], ['configure'],
    ['secrets'], ['secrets', '--json'], ['secrets', '--only-names'], ['secrets', '--raw'], ['secrets', '-c', 'dev_personal', '--json'],
    ['configs'], ['configs', '--json'], ['help'], ['--version'], ['setup'], ['login'],
    // Errors: a refused or unknown config, absent names, unsupported commands and flags.
    ['secrets', 'get', 'NOPE', '--plain'], ['secrets', 'get', 'PATH'], ['secrets', 'get', 'OPENROUTER_API_KEY', '--copy'],
    ['secrets', 'get', 'OPENROUTER_API_KEY', '-c', 'prd'], ['secrets', 'download'], ['secrets', 'download', 'file.json'],
    ['secrets', 'download', '--no-file', '--format', 'yaml'], ['secrets', 'set', 'OPENROUTER_API_KEY=x'], ['run', '-c', 'stg', '--', 'true'],
    ['run'], ['projects'], ['secrets', 'upload'],
  ];
  for (const argv of quiet) await runDopplerStandIn(argv, h.deps);
  // A store that no longer decodes says so without echoing what is in it.
  const file = secretsCachePath(h.deps.env);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.configs[0].values.OPENROUTER_API_KEY = 42;
  await fs.writeFile(file, JSON.stringify(stored));
  await runDopplerStandIn(['status'], h.deps);
  await runDopplerStandIn(['secrets', '--only-names'], h.deps);
  const printed = [...h.out, ...h.err].join('\n');
  assert.match(printed, /OPENROUTER_API_KEY/u, 'names are shown');
  for (const value of values) assert.equal(printed.includes(value), false, `a value of length ${value.length} was printed`);
});

test('status shows where the set is stored and its mode, and a widened store goes back to 0600/0700', async () => {
  const h = await harness();
  assert.equal(await runDopplerStandIn(['refresh'], h.deps), 0);
  const file = secretsCachePath(h.deps.env);
  await fs.chmod(file, 0o644);
  await fs.chmod(path.dirname(file), 0o755);
  assert.equal(await runDopplerStandIn(['status', '--json'], h.deps), 0);
  const status = JSON.parse(h.out.pop() ?? '{}');
  assert.deepEqual(status.store, { path: file, mode: '0600' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.match(h.err.join('\n'), /was 0644; set it back to 0600/u);
  assert.equal(await runDopplerStandIn(['status'], h.deps), 0);
  assert.match(h.out.join('\n'), /stored in .*secrets\.json \(0600; readable by this Session's user only/u);
});
