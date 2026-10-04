import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonObject } from '../../boundaryDecoder';
import type { SandboxCommandResult, SandboxHandle } from '../provider';
import type { TailscaleApi, TailscaleDevice } from '../tailscale';
import {
  provisionSandbox,
  pushStartupScript,
  applyGitHubToken,
  writeLocalEnv,
  readStartupLog,
  redact,
  setSandboxHostname,
  repairSandboxTailnet,
  runStartupScript,
  updateSandboxPane,
  type ProvisionStep,
} from './provision';

const FQDN = 'rp-abc12345.tail1234.ts.net';
const PAIRING = `pane-remote://${Buffer.from(JSON.stringify({
  v: 1, label: 'Cloud', baseUrl: `https://${FQDN}`, token: 'paired-token', transport: 'http+sse',
  tunnel: { kind: 'tailscale', selected: true },
})).toString('base64url')}`;
const RUNNING: JsonObject = { ok: true, backendState: 'Running', nodeId: 'n-new', hostname: 'rp-abc12345', magicDnsName: FQDN, tags: ['tag:rp-session'], runSsh: false };

/** How a fake sandbox answers one rp-bootstrap.sh step, given its arguments. */
type StepAnswer = (args: string[]) => JsonObject;

const answer = (payload: JsonObject): StepAnswer => () => payload;

/** A sandbox whose rp-bootstrap.sh steps answer from `answers`; records each step and written file. */
function fakeSandbox(answers: Map<string, StepAnswer>) {
  const steps: Array<{ name: string; args: string[] }> = [];
  const files = new Map<string, string>();
  const handle: SandboxHandle = {
    id: 'bx_1',
    async writeFile(path, content) {
      files.set(path, content);
    },
    async runScript(script): Promise<SandboxCommandResult> {
      const words = [...script.matchAll(/'((?:[^']|'\\'')*)'/gu)].map((match) => match[1]);
      if (!words[0]?.endsWith('/rp-bootstrap.sh')) return { exitCode: 0, stdout: '', stderr: '' };
      const [, name, ...args] = words;
      steps.push({ name, args });
      const respond = answers.get(name);
      if (respond === undefined) return { exitCode: 1, stdout: `RP_RESULT ${JSON.stringify({ ok: false, error: `unexpected step ${name}` })}\n`, stderr: '' };
      const payload = respond(args);
      return { exitCode: 0, stdout: `progress\nRP_RESULT ${JSON.stringify(payload)}\n`, stderr: '' };
    },
  };
  return { handle, steps, files, names: () => steps.map((step) => step.name) };
}

function fakeTailnet(devices: TailscaleDevice[] = []) {
  const deleted: string[] = [];
  const api: TailscaleApi = {
    mintAuthKey: async () => ({ id: 'k1', key: 'tskey-fake-k1-SECRET' }),
    listDevices: async () => devices,
    findDevicesByHostname: async () => devices,
    getDevice: async (nodeId) => devices.find((device) => device.nodeId === nodeId) ?? null,
    deleteDevice: async (nodeId) => {
      deleted.push(nodeId);
      return true;
    },
  };
  return { api, deleted };
}

/** /health answers ready only on the given base URLs. */
function healthFetch(readyBases: string[]): typeof fetch {
  return async (input) => {
    const ready = readyBases.some((base) => String(input) === `${base}/health`);
    if (!ready) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true, status: 'ready', version: '2.4.146' }), { status: 200 });
  };
}

const freshSandboxAnswers = () => {
  let joined = false;
  return new Map<string, StepAnswer>([
    ['identity', answer({ ok: true, reset: true })],
    ['os-hostname', (args: string[]) => ({ ok: true, hostname: args[0] })],
    ['tailscale-install', answer({ ok: true })],
    ['tailnet-identity', () => (joined ? RUNNING : { ok: true, backendState: 'NeedsLogin' })],
    ['check', answer({ ok: true, passed: 30 })],
    ['firewall', answer({ ok: true, allowedTcp: [443] })],
    ['tailscale-up', () => {
      joined = true;
      return RUNNING;
    }],
    ['agent-env', answer({ ok: true })],
    ['agent-prompts', answer({ ok: true, trustedFolders: 1 })],
    ['install-pane', answer({ ok: true, version: '2.4.146' })],
    ['pairing-read', answer({ ok: true, code: PAIRING })],
    ['cert-status', answer({ ok: true, rateLimited: true, detail: 'too many certificates' })],
    ['health-local', answer({ ok: true })],
    ['serve-http', answer({ ok: true, baseUrl: `http://${FQDN}:42137` })],
    ['serve-guard', answer({ ok: true, applied: false })],
  ]);
};

test('provisions over HTTPS: identity, check, firewall, tagged join, agent env, install, pairing, health, serve guard', async () => {
  const sandbox = fakeSandbox(freshSandboxAnswers());
  const tailnet = fakeTailnet();
  const steps: ProvisionStep[] = [];
  const result = await provisionSandbox(sandbox.handle, {
    sessionId: 'abc12345xyz',
    label: 'Cloud',
    hostname: 'rp-abc12345',
    tailscale: tailnet.api,
    paneSource: { kind: 'deb-url', url: 'https://example.com/pane.deb', sha256: 'a'.repeat(64) },
    agentEnv: 'CLAUDE_CODE_OAUTH_TOKEN=claude-secret',
    fetchImpl: healthFetch([`https://${FQDN}`]),
    onStep: (step) => steps.push(step),
  });

  assert.deepEqual(sandbox.names(), [
    'identity', 'os-hostname', 'tailscale-install', 'tailnet-identity', 'check', 'firewall', 'tailscale-up', 'agent-env', 'agent-prompts', 'install-pane',
    'pairing-read', 'serve-guard',
  ]);
  // The OS gets the sandbox's tailnet name right after the identity reset, before anything else reads it.
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'os-hostname')?.args, ['rp-abc12345']);
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'firewall')?.args, ['443']);
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'install-pane')?.args,
    ['deb-url', 'https://example.com/pane.deb', 'a'.repeat(64), '', 'Cloud']);
  assert.equal(sandbox.files.get('/home/user/.runpane-cloud/agent.env'), 'CLAUDE_CODE_OAUTH_TOKEN=claude-secret\n');
  assert.equal(result.transport, 'https');
  assert.equal(result.pairing.baseUrl, `https://${FQDN}`);
  assert.equal(result.nodeId, 'n-new');
  assert.equal(result.daemonVersion, '2.4.146');
  // Progress details never carry a secret.
  assert.doesNotMatch(JSON.stringify(steps), /claude-secret|paired-token|tskey-|pane-remote/u);
});

test('auto switches to plain HTTP inside the tailnet when the HTTPS certificate does not come', async () => {
  const sandbox = fakeSandbox(freshSandboxAnswers());
  const result = await provisionSandbox(sandbox.handle, {
    sessionId: 'abc12345xyz',
    label: 'Cloud',
    hostname: 'rp-abc12345',
    tailscale: fakeTailnet().api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' },
    autoHttpsWaitMs: 1,
    fetchImpl: healthFetch([`http://${FQDN}:42137`]),
  });
  assert.equal(result.transport, 'http');
  assert.equal(result.pairing.baseUrl, `http://${FQDN}:42137`);
  assert.equal(result.pairing.token, 'paired-token');
  assert.ok(!sandbox.names().includes('agent-env'), 'no agent env without a saved sign-in');
  assert.ok(sandbox.names().includes('agent-prompts'), 'Claude Code\'s prompts are answered with or without a saved sign-in');
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'serve-guard')?.args, ['http']);
});

test('a stale node of ours under the name is deleted before the join; anyone else\'s stops it', async () => {
  const stale: TailscaleDevice = { nodeId: 'n-old', id: '1', hostname: 'rp-abc12345', name: FQDN, addresses: [], tags: ['tag:rp-session'] };
  const tailnet = fakeTailnet([stale]);
  await provisionSandbox(fakeSandbox(freshSandboxAnswers()).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: tailnet.api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([`https://${FQDN}`]),
  });
  assert.deepEqual(tailnet.deleted, ['n-old']);

  const laptop: TailscaleDevice = { ...stale, nodeId: 'n-laptop', tags: [] };
  await assert.rejects(provisionSandbox(fakeSandbox(freshSandboxAnswers()).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: fakeTailnet([laptop]).api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([`https://${FQDN}`]),
  }), /runpane did not create/u);
});

test('a failing step is reported with its name and without secrets', async () => {
  const answers = freshSandboxAnswers();
  answers.set('install-pane', answer({ ok: false, error: `setup printed ${PAIRING} after tskey-fake-k1-SECRET` }));
  await assert.rejects(provisionSandbox(fakeSandbox(answers).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: fakeTailnet().api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([]),
  }), (error: Error) => {
    assert.match(error.message, /step "install-pane" failed: setup printed <pairing-redacted> after <tskey-redacted>/u);
    return true;
  });
  assert.equal(redact('x pane-remote://abc y'), 'x <pairing-redacted> y');
});

test('repair leaves a running node joined and only re-applies a missing Serve config', async () => {
  const sandbox = fakeSandbox(new Map([
    ['tailnet-identity', answer(RUNNING)],
    ['ts-guard', answer({ ok: true })],
    ['serve-guard', answer({ ok: true, applied: true })],
  ]));
  const tailnet = fakeTailnet();
  const result = await repairSandboxTailnet(sandbox.handle, { hostname: 'rp-abc12345', tailscale: tailnet.api, oldNodeId: 'n-new', transport: 'https' });
  assert.deepEqual(result, { reenrolled: false, backendState: 'Running', serveApplied: true });
  assert.deepEqual(sandbox.names(), ['tailnet-identity', 'ts-guard', 'serve-guard']);
  assert.deepEqual(tailnet.deleted, []);
});

test('repair re-enrols a logged-out node under the same name and restores Serve', async () => {
  const old: TailscaleDevice = { nodeId: 'n-old', id: '1', hostname: 'rp-abc12345', name: FQDN, addresses: [], tags: ['tag:rp-session'] };
  const sandbox = fakeSandbox(new Map([
    ['tailnet-identity', answer({ ok: true, backendState: 'NeedsLogin' })],
    ['tailscale-reset', answer({ ok: true })],
    ['tailscale-up', answer(RUNNING)],
    ['serve-restore', answer({ ok: true })],
  ]));
  const tailnet = fakeTailnet([old]);
  const result = await repairSandboxTailnet(sandbox.handle, { hostname: 'rp-abc12345', tailscale: tailnet.api, oldNodeId: 'n-old', transport: 'https' });
  assert.equal(result.reenrolled, true);
  assert.deepEqual(tailnet.deleted, ['n-old']);
  assert.deepEqual(sandbox.names(), ['tailnet-identity', 'tailscale-reset', 'tailscale-up', 'serve-restore']);
  assert.equal(sandbox.steps[2].args[1], 'rp-abc12345');
});

test('update needs an https .deb and its sha256, then runs update-pane', async () => {
  const sandbox = fakeSandbox(new Map([['update-pane', answer({ ok: true, version: '2.4.147' })]]));
  await assert.rejects(updateSandboxPane(sandbox.handle, { debUrl: 'http://example.com/pane.deb', sha256: 'a'.repeat(64) }), /https:\/\//u);
  await assert.rejects(updateSandboxPane(sandbox.handle, { debUrl: 'https://example.com/pane.deb', sha256: 'nope' }), /sha256/u);
  assert.deepEqual(await updateSandboxPane(sandbox.handle, { debUrl: 'https://example.com/pane.deb', sha256: 'b'.repeat(64) }), { version: '2.4.147' });
  assert.deepEqual(sandbox.steps, [{ name: 'update-pane', args: ['https://example.com/pane.deb', 'b'.repeat(64)] }]);
});

test('pushStartupScript uploads the runner, then installs the script through a private upload; an empty script removes it', async () => {
  const sandbox = fakeSandbox(new Map([['startup-install', (args: string[]) => ({ ok: true, sha256: args[0] ? 'ab'.repeat(32) : null })]]));
  assert.deepEqual(await pushStartupScript(sandbox.handle, 'echo hi\n'), { sha256: 'ab'.repeat(32) });
  const upload = '/home/user/.runpane-cloud/startup.sh.new';
  assert.equal(sandbox.files.get(upload), 'echo hi\n');
  assert.ok(sandbox.files.has('/home/user/.runpane-cloud/bin/rp-user-startup.sh'), 'the runner is uploaded with the other scripts');
  assert.deepEqual(sandbox.steps, [{ name: 'startup-install', args: [upload] }]);

  assert.deepEqual(await pushStartupScript(sandbox.handle, '  \n'), { sha256: null });
  assert.deepEqual(sandbox.steps[1], { name: 'startup-install', args: [''] });
});

const noWait = { sleep: async () => undefined };

test('runStartupScript waits out a run in progress, starts one, and follows it until it finishes', async () => {
  const before = { exitCode: 0, startedAt: '2026-10-03T10:00:00.000Z', finishedAt: '2026-10-03T10:00:31.000Z', sha256: 'ab'.repeat(32), timedOut: false };
  const after = { ...before, exitCode: 1, startedAt: '2026-10-03T10:05:00.000Z', finishedAt: '2026-10-03T10:05:02.000Z' };
  const runs = ['busy', 'busy', 'started'];
  const polls: JsonObject[] = [
    // The old status until the new run writes its own.
    { ok: true, active: false, status: before },
    { ok: true, active: true, status: { ...after, exitCode: null, finishedAt: null } },
    { ok: true, active: false, status: after },
  ];
  const sandbox = fakeSandbox(new Map([
    ['startup-run', () => ({ ok: true, state: runs.shift() ?? 'started', status: before })],
    ['startup-status', () => polls.shift() ?? { ok: false, error: 'polled too often' }],
  ]));
  assert.deepEqual(await runStartupScript(sandbox.handle, 'always', noWait), { ran: true, status: after });
  assert.deepEqual(sandbox.names(), ['startup-run', 'startup-run', 'startup-run', 'startup-status', 'startup-status', 'startup-status']);
});

test('runStartupScript returns the last status when nothing needs to run, and parses a timed-out run', async () => {
  const status = { exitCode: 1, startedAt: '2026-10-03T10:00:00.000Z', finishedAt: '2026-10-03T10:00:02.000Z', sha256: 'ab'.repeat(32), timedOut: false };
  const skipped = fakeSandbox(new Map([['startup-run', answer({ ok: true, state: 'skipped', status })]]));
  assert.deepEqual(await runStartupScript(skipped.handle, 'if-changed', noWait), { ran: false, status });
  const none = fakeSandbox(new Map([['startup-run', answer({ ok: true, state: 'skipped', status: null })]]));
  assert.deepEqual(await runStartupScript(none.handle, 'always', noWait), { ran: false, status: null });

  const timedOut = { ...status, exitCode: 124, timedOut: true, startedAt: '2026-10-03T11:00:00.000Z' };
  const slow = fakeSandbox(new Map([
    ['startup-run', answer({ ok: true, state: 'started', status: null })],
    ['startup-status', answer({ ok: true, active: false, status: timedOut })],
  ]));
  assert.deepEqual(await runStartupScript(slow.handle, 'always', noWait), { ran: true, status: timedOut });

  const broken = fakeSandbox(new Map([['startup-run', answer({ ok: true, state: 'skipped', status: { exitCode: 'one' } })]]));
  await assert.rejects(runStartupScript(broken.handle, 'always', noWait), /cloud bootstrap step "startup-run" failed: malformed result/u);
});

test('runStartupScript gives up when a run never starts or never ends', async () => {
  let time = 0;
  const clock = { sleep: async (ms: number) => { time += ms; }, now: () => time };
  const neverStarts = fakeSandbox(new Map([
    ['startup-run', answer({ ok: true, state: 'started', status: null })],
    ['startup-status', answer({ ok: true, active: false, status: null })],
  ]));
  await assert.rejects(runStartupScript(neverStarts.handle, 'always', clock), /the startup script did not start/u);

  time = 0;
  const neverEnds = fakeSandbox(new Map([['startup-run', answer({ ok: true, state: 'busy', status: null })]]));
  await assert.rejects(runStartupScript(neverEnds.handle, 'always', clock), /the startup script was still running after 22 min/u);
});

test('readStartupLog returns the log text the sandbox reports', async () => {
  const sandbox = fakeSandbox(new Map([['startup-log', answer({ ok: true, log: 'line 1\nline 2\n' })]]));
  assert.equal(await readStartupLog(sandbox.handle), 'line 1\nline 2\n');
});

test('setSandboxHostname gives the OS the tailnet name and refuses anything else', async () => {
  const sandbox = fakeSandbox(new Map([['os-hostname', (args: string[]) => ({ ok: true, hostname: args[0] })]]));
  assert.deepEqual(await setSandboxHostname(sandbox.handle, 'rp-abc12345'), { hostname: 'rp-abc12345' });
  assert.deepEqual(sandbox.steps, [{ name: 'os-hostname', args: ['rp-abc12345'] }]);
  await assert.rejects(setSandboxHostname(sandbox.handle, 'Not A Name'), /is not a valid tailnet hostname/u);
});

const GITHUB_TOKEN = 'FAKE-GH-TOKEN-provision-SECRET';

/** fakeSandbox, plus every script string it was asked to run. */
function recordingSandbox(answers: Map<string, StepAnswer>) {
  const sandbox = fakeSandbox(answers);
  const scripts: string[] = [];
  const runScript = sandbox.handle.runScript.bind(sandbox.handle);
  sandbox.handle.runScript = async (script, options) => {
    scripts.push(script);
    return runScript(script, options);
  };
  return { ...sandbox, scripts };
}

test('applyGitHubToken sends the token only as file content and runs github-auth on that file', async () => {
  const sandbox = recordingSandbox(new Map([['github-auth', answer({ ok: true, state: 'signed-in', user: 'octo-cat' })]]));
  assert.deepEqual(await applyGitHubToken(sandbox.handle, GITHUB_TOKEN), { state: 'signed-in', user: 'octo-cat' });
  const [file] = sandbox.steps.find((step) => step.name === 'github-auth')?.args ?? [];
  assert.match(file, /^\/home\/user\/\.runpane-cloud\/gh-token-[0-9a-f]{12}$/u, 'a private file in the 0700 state dir');
  assert.equal(sandbox.files.get(file), `${GITHUB_TOKEN}\n`);
  for (const script of sandbox.scripts) assert.ok(!script.includes(GITHUB_TOKEN), 'the token is in no command string');
  for (const [name, content] of sandbox.files) {
    if (name !== file) assert.ok(!content.includes(GITHUB_TOKEN), `${name} does not carry the token`);
  }
});

test('applyGitHubToken skips quietly without a token and maps every outcome to fixed text', async () => {
  const none = recordingSandbox(new Map());
  assert.deepEqual(await applyGitHubToken(none.handle, undefined), { state: 'none' });
  assert.deepEqual(await applyGitHubToken(none.handle, '  '), { state: 'none' });
  assert.deepEqual(none.scripts, [], 'nothing runs');
  assert.equal(none.files.size, 0);

  const outcome = async (payload: JsonObject) => applyGitHubToken(recordingSandbox(new Map([['github-auth', answer(payload)]])).handle, GITHUB_TOKEN);
  assert.deepEqual(await outcome({ ok: true, state: 'invalid' }), { state: 'invalid' });
  assert.deepEqual(await outcome({ ok: true, state: 'error', reason: 'gh-missing' }), { state: 'error', message: "gh isn't installed on the sandbox." });
  assert.deepEqual(await outcome({ ok: true, state: 'error', reason: 'login-failed' }),
    { state: 'error', message: "gh couldn't sign in on the sandbox (GitHub may be unreachable from it)." });
  assert.deepEqual(await outcome({ ok: true, state: 'error', reason: 'setup-git-failed' }), { state: 'error', message: 'gh signed in, but setting up git failed.' });
  assert.deepEqual(await outcome({ ok: true, state: 'error', reason: 'something-new' }), { state: 'error', message: "Couldn't apply the GitHub token on the sandbox." });
  // Signed in counts even when the account name couldn't be read.
  assert.deepEqual(await outcome({ ok: true, state: 'signed-in', user: '' }), { state: 'signed-in', user: '' });
});

test('applyGitHubToken removes the uploaded token file when the step never runs', async () => {
  const sandbox = recordingSandbox(new Map());
  const runScript = sandbox.handle.runScript;
  sandbox.handle.runScript = async (script, options) => {
    if (script.includes("'github-auth'")) throw new Error('boat exec failed');
    return runScript(script, options);
  };
  await assert.rejects(applyGitHubToken(sandbox.handle, GITHUB_TOKEN), /boat exec failed/u);
  const file = [...sandbox.files.keys()].find((name) => name.includes('/gh-token-')) ?? '';
  assert.ok(sandbox.scripts.some((script) => script.startsWith('shred -u ') && script.includes(file)), 'the file is removed');
  for (const script of sandbox.scripts) assert.ok(!script.includes(GITHUB_TOKEN), 'the token is in no command string');
});

const LOCAL_ENV = "export DOPPLER_TOKEN='FAKE-LOCAL-ENV-provision-SECRET'\n";

test('writeLocalEnv sends the env only as file content, and an empty env removes the file', async () => {
  const sandbox = recordingSandbox(new Map([['local-env-install', (args: string[]) => ({ ok: true, keys: args[0] ? 1 : 0, dropped: 0 })]]));
  assert.deepEqual(await writeLocalEnv(sandbox.handle, LOCAL_ENV), { keys: 1, reserved: [] });
  const [file] = sandbox.steps.find((step) => step.name === 'local-env-install')?.args ?? [];
  assert.match(file, /^\/home\/user\/\.runpane-cloud\/local-env-[0-9a-f]{12}$/u);
  assert.equal(sandbox.files.get(file), LOCAL_ENV);
  for (const script of sandbox.scripts) assert.ok(!script.includes('FAKE-LOCAL-ENV'), 'no value in any command string');

  assert.deepEqual(await writeLocalEnv(sandbox.handle, ''), { keys: 0, reserved: [] });
  assert.deepEqual(sandbox.steps.at(-1), { name: 'local-env-install', args: [''] });
});

test('writeLocalEnv reports dropped reserved names and removes the upload when the step never runs', async () => {
  const reserved = recordingSandbox(new Map([['local-env-install', answer({ ok: true, keys: 1, dropped: 1, reserved: ['PATH'] })]]));
  assert.deepEqual(await writeLocalEnv(reserved.handle, LOCAL_ENV), { keys: 1, reserved: ['PATH'] });

  const broken = recordingSandbox(new Map());
  const runScript = broken.handle.runScript;
  broken.handle.runScript = async (script, options) => {
    if (script.includes("'local-env-install'")) throw new Error('boat exec failed');
    return runScript(script, options);
  };
  await assert.rejects(writeLocalEnv(broken.handle, LOCAL_ENV), /boat exec failed/u);
  const file = [...broken.files.keys()].find((name) => name.includes('/local-env-')) ?? '';
  assert.ok(broken.scripts.some((script) => script.startsWith('shred -u ') && script.includes(file)), 'the upload is removed');
});

test('provisioning installs the local env before Pane, so the daemon starts with BASH_ENV', async () => {
  const answers = freshSandboxAnswers();
  answers.set('local-env-install', answer({ ok: true, keys: 1, dropped: 0 }));
  const sandbox = fakeSandbox(answers);
  await provisionSandbox(sandbox.handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: fakeTailnet().api,
    paneSource: { kind: 'deb-url', url: 'https://example.com/pane.deb', sha256: 'a'.repeat(64) },
    localEnv: LOCAL_ENV, fetchImpl: healthFetch([`https://${FQDN}`]),
  });
  const names = sandbox.names();
  assert.ok(names.indexOf('local-env-install') > -1 && names.indexOf('local-env-install') < names.indexOf('install-pane'));
});
