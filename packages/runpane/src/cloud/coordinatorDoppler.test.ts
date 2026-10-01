import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { JsonValue } from '../boundaryDecoder';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { parseCoordinatorDopplerArgs } from './coordinatorDoppler';
import { installSecretsToolsScript, removeSecretsToolsScript } from './sessionSecrets';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// `runpane cloud coordinator doppler set|policy|status|unset` on the laptop, and `deploy` keeping the
// secrets config on an in-place redeploy.

const STAGE = '/home/user/.runpane-cloud/coordinator-stage';
const DOPPLER_DIR = '/home/user/.config/runpane-cloud-coordinator/doppler';
const minted = (config: string) => `dp.st.${config}.FAKEtokenFAKEtokenFAKEtoken`;

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

interface Deployed {
  harness: TestHarness;
  sandboxId: string;
  dopplerCalls: string[][];
  apiCalls: string[];
}

async function deployed(options: { failMintFor?: string } = {}): Promise<Deployed> {
  const harness = await createTestHarness();
  harness.world.pushedDirectories = [];
  harness.world.coordinatorHealthy = true;
  const dopplerCalls: string[][] = [];
  const apiCalls: string[] = [];
  harness.deps.runLocal = async (file, args) => {
    assert.equal(file, 'doppler');
    dopplerCalls.push([...args]);
    const config = args[args.indexOf('--config') + 1];
    if (args[0] === 'configs' && args[1] === 'tokens' && args[2] === 'create') {
      if (config === options.failMintFor) return { exitCode: 1, stdout: '', stderr: 'Doppler Error: forbidden' };
      return { exitCode: 0, stdout: JSON.stringify({ name: args[3], token: minted(config), slug: `slug-${config}`, config, project: 'my-app', access: 'read' }), stderr: '' };
    }
    if (args[0] === 'configs' && args[1] === 'tokens' && args[2] === 'revoke') return { exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'configs' && args[1] === '--project') return { exitCode: 0, stdout: JSON.stringify([{ name: 'dev' }, { name: 'dev_personal' }, { name: 'stg' }, { name: 'prd' }]), stderr: '' };
    return { exitCode: 2, stdout: '', stderr: 'unexpected' };
  };
  harness.deps.callCoordinatorApi = async (method, pathAndQuery): Promise<{ status: number; body: JsonValue }> => {
    apiCalls.push(`${method} ${pathAndQuery}`);
    if (pathAndQuery.startsWith('/cloud/secrets/status')) {
      return { status: 200, body: { ok: true, enabled: true, configs: [{ project: 'my-app', config: 'dev', loaded: true, names: 91 }], policy: { mode: 'allow-all', deniedNames: [], deniedConfigs: [] } } };
    }
    return { status: 200, body: { ok: true, mode: 'off', repos: [] } };
  };
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--json']), 0);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.ok(deployment);
  return { harness, sandboxId: deployment.sandboxId, dopplerCalls, apiCalls };
}

function stagedSecrets(harness: TestHarness, sandboxId: string): JsonValue {
  return JSON.parse(harness.world.files.get(`${sandboxId}:${STAGE}/config.json`) ?? '{}').secrets ?? null;
}

function lastScript(harness: TestHarness, sandboxId: string): string {
  return harness.world.scripts.filter((entry) => entry.sandboxId === sandboxId).map((entry) => entry.script).pop() ?? '';
}

test('coordinator doppler args', () => {
  assert.throws(() => parseCoordinatorDopplerArgs(['set']), /needs --project/u);
  assert.throws(() => parseCoordinatorDopplerArgs(['set', '--project', 'p']), /--config <c> \(repeatable\) or --all-configs/u);
  assert.throws(() => parseCoordinatorDopplerArgs(['set', '--project', 'p', '--config', 'a', '--config', 'b', '--token-file', 't']), /exactly one --config/u);
  assert.throws(() => parseCoordinatorDopplerArgs(['set', '--project', '../x', '--config', 'dev']), /not a Doppler project/u);
  assert.throws(() => parseCoordinatorDopplerArgs(['policy']), /needs --default, --allow-all/u);
  assert.throws(() => parseCoordinatorDopplerArgs(['policy', '--default', '--allow-all']), /one policy/u);
  assert.deepEqual(parseCoordinatorDopplerArgs(['policy', '--deny-names', 'A_*, B', '--deny-configs', 'prd']).policy, { mode: 'custom', deniedNames: ['A_*', 'B'], deniedConfigs: ['prd'] });
  assert.throws(() => parseCoordinatorDopplerArgs(['unset', '--yes']), /--all/u);
  assert.equal(parseCoordinatorDopplerArgs(['set', '--project', 'my-app', '--all-configs', '--policy', 'allow-all']).policy?.mode, 'allow-all');
});

test('doppler set mints read-only tokens locally, installs them 0600 via the files API, and never prints or saves them', async () => {
  const { harness, sandboxId, dopplerCalls, apiCalls } = await deployed();
  assert.equal(await run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--all-configs', '--policy', 'allow-all']), 0);

  const creates = dopplerCalls.filter((args) => args[2] === 'create');
  assert.deepEqual(creates.map((args) => args[args.indexOf('--config') + 1]), ['dev', 'dev_personal', 'stg', 'prd']);
  for (const args of creates) {
    assert.equal(args[args.indexOf('--access') + 1], 'read');
    assert.equal(args[3], `runpane-cloud-${(await harness.deps.store.readSettings()).coordinator?.deployment?.hostname ?? ''}`);
  }
  // Each token is staged through the files API; the script installs it 0600 and shreds the staged copy.
  assert.equal(harness.world.files.get(`${sandboxId}:${STAGE}/doppler-token-0`), `${minted('dev')}\n`);
  const script = lastScript(harness, sandboxId);
  assert.match(script, new RegExp(`install -m 600 "\\$S/doppler-token-3" '${DOPPLER_DIR}/my-app\\.prd\\.token'; shred -u "\\$S/doppler-token-3"`, 'u'));
  for (const config of ['dev', 'dev_personal', 'stg', 'prd']) {
    assert.ok(!script.includes(minted(config)), 'no token in any script');
    assert.ok(![...harness.out, ...harness.err].join('\n').includes(minted(config)), 'no token printed');
  }
  const settings = JSON.stringify(await harness.deps.store.readSettings());
  assert.ok(!settings.includes('dp.st.'), 'no token in the laptop settings');
  assert.deepEqual(stagedSecrets(harness, sandboxId), {
    doppler: {
      apiBaseUrl: 'https://api.doppler.com',
      tokens: ['dev', 'dev_personal', 'stg', 'prd'].map((config) => ({ project: 'my-app', config, tokenFile: `${DOPPLER_DIR}/my-app.${config}.token` })),
    },
    policy: { mode: 'allow-all' },
  });
  assert.ok(apiCalls.includes('GET /cloud/secrets/status?check=1'));
  assert.match(harness.out.join('\n'), /my-app\/dev: 91 names readable/u);

  // An in-place redeploy keeps the secrets config and leaves the token files alone.
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes']), 0);
  assert.deepEqual(stagedSecrets(harness, sandboxId), {
    doppler: {
      apiBaseUrl: 'https://api.doppler.com',
      tokens: ['dev', 'dev_personal', 'stg', 'prd'].map((config) => ({ project: 'my-app', config, tokenFile: `${DOPPLER_DIR}/my-app.${config}.token` })),
    },
    policy: { mode: 'allow-all' },
  });
  assert.doesNotMatch(lastScript(harness, sandboxId), /doppler/u);
  assert.match(harness.out.join('\n'), /Doppler secrets kept \(my-app\/dev, my-app\/dev_personal, my-app\/stg, my-app\/prd; policy allow-all\)/u);

  // Re-setting one config revokes the token it replaces.
  assert.equal(await run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--config', 'dev']), 0);
  assert.deepEqual(dopplerCalls.filter((args) => args[2] === 'revoke').map((args) => args[args.indexOf('--slug') + 1]), ['slug-dev']);

  // The policy command rewrites only the policy.
  assert.equal(await run(harness, ['coordinator', 'doppler', 'policy', '--default']), 0);
  assert.deepEqual(JSON.parse(harness.world.files.get(`${sandboxId}:${STAGE}/config.json`) ?? '{}').secrets.policy, { mode: 'default' });

  // unset --all: every token shredded on the box, the minted ones revoked in Doppler, the service off.
  assert.equal(await run(harness, ['coordinator', 'doppler', 'unset', '--all', '--yes']), 0);
  assert.match(lastScript(harness, sandboxId), /for f in "\$D"\/\*\.token; do \[ -f "\$f" \] && shred -u "\$f"; done/u);
  assert.equal(stagedSecrets(harness, sandboxId), null);
  assert.equal((await harness.deps.store.readSettings()).coordinator?.deployment?.secrets, undefined);
  assert.deepEqual(dopplerCalls.filter((args) => args[2] === 'revoke').map((args) => args[args.indexOf('--slug') + 1]).sort(), ['slug-dev', 'slug-dev', 'slug-dev_personal', 'slug-prd', 'slug-stg']);
});

test('doppler set revokes what it minted when a later config fails, and installs nothing', async () => {
  const { harness, sandboxId, dopplerCalls } = await deployed({ failMintFor: 'stg' });
  const before = harness.world.scripts.length;
  await assert.rejects(run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--config', 'dev', '--config', 'stg']), /forbidden/u);
  assert.deepEqual(dopplerCalls.filter((args) => args[2] === 'revoke').map((args) => args[args.indexOf('--slug') + 1]), ['slug-dev']);
  assert.equal(harness.world.scripts.length, before);
  assert.equal(harness.world.files.get(`${sandboxId}:${STAGE}/doppler-token-0`), undefined);
});

test('doppler set --token-file takes only a service token: personal, CLI and service account tokens are refused before touching the coordinator', async () => {
  const { harness } = await deployed();
  const before = harness.world.scripts.length;
  const personal = path.join(harness.root, 'personal');
  await fs.writeFile(personal, 'dp.pt.0123456789abcdefghijklmnopqrstuvwxyz\n', { mode: 0o600 });
  await assert.rejects(run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--config', 'dev', '--token-file', personal]), /a personal token .*not a service token/u);
  assert.equal(harness.world.scripts.length, before);
  // A service account token can span projects and configs and may write: refused by its prefix, not trusted as read-only.
  const account = path.join(harness.root, 'account');
  await fs.writeFile(account, 'dp.sa.0123456789abcdefghijklmnopqrstuvwxyz\n', { mode: 0o600 });
  await assert.rejects(run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--config', 'dev', '--token-file', account]), /a service account token .*not a service token/u);
  assert.equal(harness.world.scripts.length, before);
  const service = path.join(harness.root, 'service');
  await fs.writeFile(service, `${minted('dev')}\n`, { mode: 0o600 });
  assert.equal(await run(harness, ['coordinator', 'doppler', 'set', '--project', 'my-app', '--config', 'dev', '--token-file', service]), 0);
  assert.match(harness.err.join('\n'), /cannot check it is read-only/u);
  // Not minted here, so unset cannot revoke it and says so.
  assert.equal(await run(harness, ['coordinator', 'doppler', 'unset', '--config', 'dev', '--yes']), 1);
  assert.match(harness.err.join('\n'), /not minted by this machine/u);
});

test('the Session tools script installs the stand-in, the boot unit and the notes without any value', () => {
  const script = installSecretsToolsScript();
  assert.match(script, /exec "\$rp" cloud agent doppler "\$@"/u);
  assert.match(script, /ExecStart=\/home\/user\/\.local\/bin\/doppler refresh --boot --quiet/u);
  assert.match(script, /WantedBy=default\.target/u);
  assert.match(script, /systemctl --user enable runpane-cloud-secrets\.service/u);
  assert.match(script, /doppler run -- <command>/u);
  assert.match(removeSecretsToolsScript(), /shred -u/u);
});
