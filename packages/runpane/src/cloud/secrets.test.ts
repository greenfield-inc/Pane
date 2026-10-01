import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import type { SandboxHandle } from './provider';
import { checkDopplerConfig, checkSecretName, deniedBy, parseSecretsArgs } from './secrets';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// `runpane cloud secrets`: the deny-list, the value sources, and the real sandbox script run with
// bash and python3 against a temporary HOME, the way a new panel shell would load it.

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

interface RealSandbox {
  home: string;
  scripts: string[];
  writes: { path: string; content: string }[];
}

/** A host from `new`, whose sandbox handle runs scripts for real with HOME=<temp dir> standing in for /home/user. */
async function hostWithRealSandbox(harness: TestHarness): Promise<{ hostname: string; sandbox: RealSandbox }> {
  assert.equal(await run(harness, ['new', '--label', 'Secrets', '--name-prefix', 'rp-test', '--no-import', '--yes', '--json']), 0);
  const created: { host: { hostname: string } } = JSON.parse(harness.out[harness.out.length - 1]);
  const hostname = created.host.hostname;
  const home = path.join(harness.root, 'sandbox-home');
  await fs.mkdir(path.join(home, '.runpane-cloud'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, '.bashrc'), '# user bashrc\ncase $- in *i*) ;; *) return;; esac\nexport FROM_USER_RC=1\n');
  const sandbox: RealSandbox = { home, scripts: [], writes: [] };
  const local = (file: string) => file.replace(/^\/home\/user/u, home);
  const handle: SandboxHandle = {
    id: 'real',
    async writeFile(file, content) {
      sandbox.writes.push({ path: file, content });
      await fs.writeFile(local(file), content);
    },
    async runScript(script) {
      sandbox.scripts.push(script);
      const result = spawnSync('bash', ['-c', script], { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8' });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  const createProvider = harness.deps.createProvider;
  harness.deps.createProvider = (credentials) => ({ ...createProvider(credentials), handle: () => handle });
  harness.out.length = 0;
  return { hostname, sandbox };
}

/** What a new interactive panel shell (bash -i, which reads ~/.bashrc) sees for `name`. */
function panelShellValue(home: string, name: string): string | undefined {
  const result = spawnSync('bash', ['-ic', `if [ -n "\${${name}+x}" ]; then printf '<<SET>>%s' "$${name}"; fi`], {
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' },
    encoding: 'utf8',
  });
  // /etc/bash.bashrc may print its own notes first; the value is everything after the marker.
  const at = result.stdout.indexOf('<<SET>>');
  return at === -1 ? undefined : result.stdout.slice(at + '<<SET>>'.length);
}

test('parseSecretsArgs: sources and arity', () => {
  assert.deepEqual(parseSecretsArgs(['set', 'rp-x', 'A', 'B']).source, { kind: 'env' });
  assert.deepEqual(parseSecretsArgs(['set', 'rp-x', 'A', '--from-env', 'OTHER']).source, { kind: 'env', variable: 'OTHER' });
  assert.deepEqual(parseSecretsArgs(['set', 'rp-x', 'A', '--from-file=-']).source, { kind: 'file', path: '-' });
  assert.deepEqual(parseSecretsArgs(['set', 'rp-x', 'A', 'B', '--from-doppler', 'app/dev']).source, { kind: 'doppler', project: 'app', config: 'dev' });
  assert.throws(() => parseSecretsArgs(['set', 'rp-x', 'A', 'B', '--from-env', 'OTHER']), /one NAME/u);
  assert.throws(() => parseSecretsArgs(['set', 'rp-x', 'A', 'B', '--from-file', 'f']), /one NAME/u);
  assert.throws(() => parseSecretsArgs(['set', 'rp-x', 'A', '--from-doppler', 'app']), /<project>\/<config>/u);
  assert.throws(() => parseSecretsArgs(['set', 'rp-x', 'A', '--from-env', 'X', '--from-file', 'f']), /one value source/u);
  assert.throws(() => parseSecretsArgs(['set', 'rp-x']), /at least one NAME/u);
  assert.throws(() => parseSecretsArgs(['list', 'rp-x', 'A']), /Usage/u);
  assert.throws(() => parseSecretsArgs(['rm', 'rp-x', 'A', '--from-env', 'X']), /only applies to runpane cloud secrets set/u);
  assert.deepEqual(parseSecretsArgs(['rm', 'rp-x', 'A', 'A', 'B', '--json']), { sub: 'rm', host: 'rp-x', names: ['A', 'B'], source: { kind: 'env' }, json: true });
});

test('the deny-list refuses production, infrastructure and secret-manager names', () => {
  for (const name of ['PRODUCTION_DATABASE_URL', 'CLOUDFLARE_API_TOKEN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_ADMIN', 'VERCEL_TOKEN', 'NEON_API_KEY',
    'DOPPLER_TOKEN', 'DOPPLER_CONFIG', 'OPENROUTER_MANAGEMENT_API_KEY', 'cloudflare_api_token']) {
    assert.ok(deniedBy(name), `${name} should be denied`);
    assert.throws(() => checkSecretName(name), /deny-list/u);
  }
  for (const name of ['OPENROUTER_API_KEY', 'SHOPIFY_API_KEY', 'GITHUB_READ_TOKEN', 'MY_NEON_LIGHT']) {
    assert.equal(deniedBy(name), null, `${name} should be allowed`);
  }
  assert.equal(deniedBy('E2B_API_KEY', ['E2B_*']), 'E2B_*');
  assert.throws(() => checkSecretName('STRIPE_SECRET', ['stripe_*']), /stripe_\*/u);
  assert.throws(() => checkSecretName('PATH'), /the shell or Pane sets it/u);
  assert.throws(() => checkSecretName('LD_PRELOAD'), /the shell or Pane sets it/u);
  assert.throws(() => checkSecretName('PANE_SESSION_ID'), /the shell or Pane sets it/u);
  assert.throws(() => checkSecretName('1BAD'), /not a valid/u);
  assert.throws(() => checkSecretName('A-B'), /not a valid/u);
});

test('--from-doppler refuses staging and production configs', () => {
  for (const config of ['prd', 'PROD', 'stg', 'staging', 'production', 'prd_personal', 'stg-branch']) {
    assert.throws(() => checkDopplerConfig(config), /Refusing Doppler config/u, config);
  }
  for (const config of ['dev', 'dev_personal', 'ci', 'product_dev']) checkDopplerConfig(config);
});

test('secrets set stores the value where a new panel shell sees it, without the value in any script or output', async () => {
  const harness = await createTestHarness();
  const { hostname, sandbox } = await hostWithRealSandbox(harness);
  const tricky = "it's a \"value\" with $HOME, `ticks`, \\ and\na second line";
  harness.deps.env = { SERVICE_KEY: tricky, OTHER_SOURCE: 'plain-value-123' };

  assert.equal(await run(harness, ['secrets', 'set', hostname, 'SERVICE_KEY', '--json']), 0);
  assert.deepEqual(JSON.parse(harness.out[harness.out.length - 1]), { ok: true, host: hostname, set: ['SERVICE_KEY'], names: ['SERVICE_KEY'] });
  assert.equal(await run(harness, ['secrets', 'set', hostname, 'RENAMED', '--from-env', 'OTHER_SOURCE']), 0);

  assert.equal(panelShellValue(sandbox.home, 'SERVICE_KEY'), tricky);
  assert.equal(panelShellValue(sandbox.home, 'RENAMED'), 'plain-value-123');
  assert.equal(panelShellValue(sandbox.home, 'FROM_USER_RC'), '1', 'the user bashrc still runs after the loader');

  for (const file of ['secrets.json', 'secrets.env']) {
    assert.equal((await fs.stat(path.join(sandbox.home, '.runpane-cloud', file))).mode & 0o777, 0o600, file);
  }
  assert.deepEqual((await fs.readdir(path.join(sandbox.home, '.runpane-cloud'))).filter((name) => name.includes('stage')), [], 'staged files are shredded');
  const bashrc = await fs.readFile(path.join(sandbox.home, '.bashrc'), 'utf8');
  assert.ok(bashrc.startsWith('# >>> runpane cloud secrets >>>'), 'the loader runs before a non-interactive early return');
  assert.equal(bashrc.split('# >>> runpane cloud secrets >>>').length, 2, 'the loader is installed once');
  assert.ok((await fs.readFile(path.join(sandbox.home, '.zshenv'), 'utf8')).includes('secrets.env'));

  // Values travel only in the staged file: never in a script (command) or in anything printed.
  for (const script of sandbox.scripts) {
    assert.ok(!script.includes('plain-value-123') && !script.includes('second line'), 'no value in a script');
  }
  assert.deepEqual(sandbox.writes.filter((write) => write.content.includes('plain-value-123')).map((write) => /secrets\.stage-[0-9a-f]+\.json$/u.test(write.path)), [true]);
  assert.ok(![...harness.out, ...harness.err].some((line) => line.includes('plain-value-123') || line.includes('second line')));

  assert.equal(await run(harness, ['secrets', 'list', hostname]), 0);
  assert.deepEqual(harness.out.slice(-3), [`${hostname} agent secrets (names only):`, '  RENAMED', '  SERVICE_KEY']);

  assert.equal(await run(harness, ['secrets', 'rm', hostname, 'SERVICE_KEY', 'NEVER_SET', '--json']), 0);
  assert.deepEqual(JSON.parse(harness.out[harness.out.length - 1]), { ok: true, host: hostname, removed: ['SERVICE_KEY'], notFound: ['NEVER_SET'], names: ['RENAMED'] });
  assert.equal(panelShellValue(sandbox.home, 'SERVICE_KEY'), undefined, 'a new panel no longer sees a removed secret');
  assert.equal(panelShellValue(sandbox.home, 'RENAMED'), 'plain-value-123');
});

test('a denied name is refused before anything reaches the sandbox, including one smuggled through --from-env', async () => {
  const harness = await createTestHarness();
  const { hostname, sandbox } = await hostWithRealSandbox(harness);
  harness.deps.env = { CLOUDFLARE_API_TOKEN: 'cf-secret', HARMLESS: 'ok-value' };
  await harness.deps.store.writeSettings({ ...(await harness.deps.store.readSettings()), secretsDenyList: ['E2B_*'] });
  harness.deps.env.E2B_API_KEY = 'e2b-secret';

  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'HARMLESS', 'CLOUDFLARE_API_TOKEN']), /deny-list pattern CLOUDFLARE_\*/u);
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'LOOKS_FINE', '--from-env', 'CLOUDFLARE_API_TOKEN']), /Refusing CLOUDFLARE_API_TOKEN/u);
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'E2B_API_KEY']), /E2B_\*/u);
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'OPENROUTER_API_KEY', '--from-doppler', 'app/prd']), /Refusing Doppler config prd/u);
  assert.deepEqual(sandbox.writes, []);
  assert.deepEqual(sandbox.scripts, []);
});

test('--from-doppler resolves with the local doppler CLI and strips its trailing newline', async () => {
  const harness = await createTestHarness();
  const { hostname, sandbox } = await hostWithRealSandbox(harness);
  const calls: string[][] = [];
  harness.deps.runLocal = async (file, args) => {
    calls.push([file, ...args]);
    if (args[2] === 'MISSING') return { exitCode: 1, stdout: '', stderr: 'Doppler Error: Could not find requested secret: MISSING\n' };
    return { exitCode: 0, stdout: `value-of-${args[2]}\n`, stderr: '' };
  };
  assert.equal(await run(harness, ['secrets', 'set', hostname, 'OPENROUTER_API_KEY', 'SECOND_KEY', '--from-doppler', 'my-app/dev']), 0);
  assert.deepEqual(calls[0], ['doppler', 'secrets', 'get', 'OPENROUTER_API_KEY', '--plain', '--project', 'my-app', '--config', 'dev']);
  assert.equal(panelShellValue(sandbox.home, 'OPENROUTER_API_KEY'), 'value-of-OPENROUTER_API_KEY');
  assert.equal(panelShellValue(sandbox.home, 'SECOND_KEY'), 'value-of-SECOND_KEY');

  const writesBefore = sandbox.writes.length;
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'OK_ONE', 'MISSING', '--from-doppler', 'my-app/dev']), /could not read MISSING from my-app\/dev \(exit 1\): Doppler Error/u);
  assert.equal(sandbox.writes.length, writesBefore, 'one failed value stores none of them');
});

test('secrets need an awake Session and a value', async () => {
  const harness = await createTestHarness();
  const { hostname } = await hostWithRealSandbox(harness);
  harness.deps.env = { EMPTY: '' };
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'EMPTY']), /EMPTY is empty/u);
  await assert.rejects(run(harness, ['secrets', 'set', hostname, 'UNSET_VAR']), /UNSET_VAR is not set/u);
  const sandbox = [...harness.world.sandboxes.values()][0];
  sandbox.state = 'stopped';
  await assert.rejects(run(harness, ['secrets', 'list', hostname]), /wake it first: runpane cloud wake/u);
});

test('secrets inspect reports every store by name and flags a file group or others can read, never printing a value', async () => {
  const harness = await createTestHarness();
  const { hostname, sandbox } = await hostWithRealSandbox(harness);
  const values = ['byok-synthetic-value-1', 'anthropic-synthetic-key-2', 'doppler-synthetic-value-3', 'peer-synthetic-token-4', 'git-synthetic-token-5'];
  harness.deps.env = { SERVICE_KEY: values[0] };
  assert.equal(await run(harness, ['secrets', 'set', hostname, 'SERVICE_KEY']), 0);
  const home = sandbox.home;
  const write = async (rel: string, content: string, mode = 0o600) => {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, rel), content, { mode });
    await fs.chmod(path.join(home, rel), mode);
  };
  await write('.runpane-cloud/agent.env', `ANTHROPIC_API_KEY=${values[1]}\n`);
  await write('.runpane-cloud/doppler/secrets.json', JSON.stringify({
    version: 'v1', fetchedAt: '2026-10-01T00:00:00.000Z', storedAt: '2026-10-01T00:00:00.000Z', reason: null, policy: 'default', manifest: null,
    configs: [{ project: 'my-app', config: 'dev', values: { OPENROUTER_API_KEY: values[2] }, withheld: [{ name: 'PATH', reason: 'reserved' }], missing: [], refused: null }],
  }));
  await write('.config/runpane-cloud/peers.json', JSON.stringify({ coordinator: { token: values[3] } }), 0o644);
  await write('.config/runpane-cloud-git/github-acme-app.token', values[4]);
  await write('.runpane-cloud/secrets.stage-abc123.json', JSON.stringify({ set: { LEFT: values[0] } }));
  harness.out.length = 0;
  harness.err.length = 0;

  assert.equal(await run(harness, ['secrets', 'inspect', hostname]), 1, 'a readable file or a leftover staged file fails the check');
  const text = harness.out.join('\n');
  assert.match(text, /agent secrets \(runpane cloud secrets set\): 1 \(SERVICE_KEY\)/u);
  assert.match(text, /agent sign-in: 1 \(ANTHROPIC_API_KEY\)/u);
  assert.match(text, /my-app\/dev: 1 \(OPENROUTER_API_KEY\); withheld PATH/u);
  assert.match(text, /0644 {2}~\/\.config\/runpane-cloud\/peers\.json .*WARNING: group or others can read it/u);
  assert.match(text, /0600 {2}~\/\.config\/runpane-cloud-git\/github-acme-app\.token/u);
  assert.match(text, /1 staged secrets file\(s\) were not shredded/u);

  await fs.chmod(path.join(home, '.config/runpane-cloud/peers.json'), 0o600);
  await fs.rm(path.join(home, '.runpane-cloud/secrets.stage-abc123.json'));
  assert.equal(await run(harness, ['secrets', 'inspect', hostname, '--json']), 0);
  const report = JSON.parse(harness.out[harness.out.length - 1]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.exposed, []);
  assert.deepEqual(report.agentSecrets, ['SERVICE_KEY']);
  assert.deepEqual(report.doppler.configs[0].names, ['OPENROUTER_API_KEY']);

  const printed = [...harness.out, ...harness.err, ...sandbox.scripts.filter((script) => script.includes('RP_SECRETS_INSPECT'))].join('\n');
  for (const value of values) assert.equal(printed.includes(value), false, `a value of length ${value.length} was printed or scripted`);
});
