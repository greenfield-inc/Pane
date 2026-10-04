import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCloudSandboxes, type CloudBootstrap, type CloudProgress, type LocalStartEnv } from './api';
import type { DaemonHealthResult } from './bootstrap/health';
import type { GitHubAuthStatus, ProvisionResult, RepairResult, StartupScriptStatus } from './bootstrap/provision';
import type { CloudProvider, CloudSandbox, CreateSandboxRequest, ListedBoatOrg } from './provider';
import type { CloudHostProfile, PaneSource } from './store';
import type { TailscaleApi, TailscaleDevice } from './tailscale';

const FQDN = 'rp-test.tail1234.ts.net';
const SECRETS = ['boat-key-SECRET', 'ts-client-SECRET', 'claude-token-SECRET', 'paired-token-SECRET'];

/** An in-memory boat: sandboxes start, stop and resume instantly; calls are logged. */
/** Time that passes only when the code under test sleeps, so a 15 min wait runs instantly. */
class FakeClock {
  time = Date.now();
  now = () => this.time;
  sleep = async (ms: number) => {
    this.time += ms;
  };
}

/** How boat handles an accepted Stop: archiving for a while, then stopped, its error state, gone, or never done. */
interface SlowStop {
  archivingMs: number;
  then: 'stopped' | 'error' | 'gone' | 'stuck';
}

/** How boat handles an accepted delete (202): gone after a while, or never (the sandbox keeps running). */
interface SlowDestroy {
  goneAfterMs: number | 'never';
}

/** Set `stop` to make the fake boat archive slowly after it accepts a Stop; `destroy` likewise for a delete. */
class SlowBoat {
  stop?: SlowStop;
  acceptedAt?: number;
  /** Commands fail this many more times, as right after a resume before the sandbox takes commands. */
  commandsFailing = 0;
  destroy?: SlowDestroy;
  destroyAcceptedAt?: number;
}

function fakeProvider(clock: FakeClock, orgs: ListedBoatOrg[] = [{ id: 'team_test', name: 'test', active: false }]) {
  const sandboxes = new Map<string, CloudSandbox>();
  const slow = new SlowBoat();
  const calls: string[] = [];
  const creates: CreateSandboxRequest[] = [];
  const keys: Array<{ apiKey: string; org?: string }> = [];
  const factory = (apiKey: string, org?: string): CloudProvider => {
    keys.push({ apiKey, org });
    const set = (id: string, state: CloudSandbox['state'], providerState: string) => {
      const current = sandboxes.get(id);
      if (current) sandboxes.set(id, { ...current, state, providerState });
    };
    return {
      name: 'boat',
      verifyCredentials: async () => ({ account: 'me@example.com' }),
      listOrgs: async () => orgs,
      async create(request) {
        creates.push(request);
        calls.push('create');
        const id = `bx_${sandboxes.size + 1}`;
        const created: CloudSandbox = { id, name: request.name, state: 'running', providerState: 'idle', size: request.size, org: { id: 'team_test', name: 'test' } };
        sandboxes.set(id, created);
        return { ...created, state: 'starting', providerState: 'provisioning' };
      },
      async getWithoutWallet(id) {
        calls.push(`get-without-wallet ${id}`);
        return sandboxes.get(id) ?? { id, name: '', state: 'gone', providerState: 'not_found' };
      },
      async get(id) {
        // boat scopes every call to the wallet in X-Boat-Org: a sandbox in another wallet answers 404.
        const scoped = sandboxes.get(id);
        if (org && scoped?.org && scoped.org.id !== org) return { id, name: '', state: 'gone', providerState: 'not_found' };
        if (slow.destroy && slow.destroyAcceptedAt !== undefined && slow.destroy.goneAfterMs !== 'never'
          && clock.now() - slow.destroyAcceptedAt >= slow.destroy.goneAfterMs) sandboxes.delete(id);
        const current = sandboxes.get(id);
        if (current?.state === 'stopping' && slow.stop && slow.acceptedAt !== undefined && clock.now() - slow.acceptedAt >= slow.stop.archivingMs) {
          if (slow.stop.then === 'stopped') set(id, 'stopped', 'archived');
          if (slow.stop.then === 'error') sandboxes.set(id, { ...current, state: 'error', providerState: 'failed', error: 'snapshot failed' });
          if (slow.stop.then === 'gone') sandboxes.delete(id);
        }
        return sandboxes.get(id) ?? { id, name: '', state: 'gone', providerState: 'not_found' };
      },
      list: async () => [...sandboxes.values()],
      rename: async () => undefined,
      async stop(id) {
        calls.push(`stop ${id}`);
        if (slow.stop) {
          slow.acceptedAt = clock.now();
          set(id, 'stopping', 'archiving');
        } else {
          set(id, 'stopped', 'archived');
        }
      },
      async resume(id) {
        calls.push(`resume ${id}`);
        set(id, 'running', 'idle');
      },
      async destroy(id) {
        calls.push(`destroy ${id}`);
        const scoped = sandboxes.get(id);
        if (org && scoped?.org && scoped.org.id !== org) return;
        if (slow.destroy) slow.destroyAcceptedAt = clock.now();
        else sandboxes.delete(id);
      },
      handle: (id) => ({
        id,
        writeFile: async () => undefined,
        async runScript(script) {
          calls.push(`run ${id} ${script}`);
          if (slow.commandsFailing > 0) {
            slow.commandsFailing -= 1;
            throw new Error('boat command failed: sandbox agent not ready');
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    };
  };
  return { factory, sandboxes, calls, creates, keys, slow };
}

/** Set `device` to re-add it once after a delete (a node that rejoins while its sandbox still runs). */
class TailnetRejoin {
  device?: TailscaleDevice;
  /** Node ids whose delete answers 200 but leaves the device listed. */
  stuck = new Set<string>();
}

function fakeTailnet() {
  const devices: TailscaleDevice[] = [];
  const rejoin = new TailnetRejoin();
  const api: TailscaleApi = {
    mintAuthKey: async () => ({ id: 'k', key: 'tskey-fake-SECRET' }),
    listDevices: async () => devices,
    findDevicesByHostname: async (hostname) => devices.filter((device) => device.hostname === hostname),
    getDevice: async (nodeId) => devices.find((device) => device.nodeId === nodeId) ?? null,
    async deleteDevice(nodeId) {
      const index = devices.findIndex((device) => device.nodeId === nodeId);
      if (rejoin.stuck.has(nodeId)) return true;
      if (index !== -1) devices.splice(index, 1);
      if (rejoin.device) {
        devices.push(rejoin.device);
        rejoin.device = undefined;
      }
      return index !== -1;
    },
  };
  return { api, devices, rejoin };
}

interface BootstrapScript {
  provisionError?: Error;
  /** Answers for successive waitForHealth calls (default: healthy). */
  health?: boolean[];
  repair?: RepairResult;
  /** applyClaudeModel fails, e.g. the sandbox's settings.json is not JSON. */
  claudeModelFails?: boolean;
  /** What the sandbox reports after a startup script run (default: exit 0). */
  startupStatus?: StartupScriptStatus | null;
  startupPushFails?: boolean;
  hostnameFails?: boolean;
  /** What applying the GitHub token reports (default: signed in); a thrown Error when the sandbox fails. */
  github?: GitHubAuthStatus | Error;
  /** applyGitHubToken throws this many times first (a sandbox that isn't ready yet), then answers `github`. */
  githubFailsFirst?: number;
  startupRunFails?: boolean;
}

const STARTUP_OK: StartupScriptStatus = { exitCode: 0, startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:01Z', sha256: 'ab'.repeat(32), timedOut: false };

function fakeBootstrap(tailnet: ReturnType<typeof fakeTailnet>, script: BootstrapScript = {}) {
  const agentEnvs: Array<string | undefined> = [];
  const paneSources: PaneSource[] = [];
  const repairs: string[] = [];
  const updates: string[] = [];
  const claudeModels: string[] = [];
  const health = [...(script.health ?? [])];
  /** Startup script pushes and runs, and health checks, in call order. */
  const events: string[] = [];
  /** Local env files writeLocalEnv received, with the sandbox each went to. Kept out of `events`. */
  const localEnvWrites: Array<{ sandboxId: string; envFile: string }> = [];
  /** What provision was given as the local env (undefined: none). */
  const provisionLocalEnvs: Array<string | undefined> = [];
  /** The GitHub tokens applyGitHubToken received, in order (undefined: none saved). Kept out of `events`. */
  const githubTokens: Array<string | undefined> = [];
  const bootstrap: CloudBootstrap = {
    async provision(_sandbox, options): Promise<ProvisionResult> {
      agentEnvs.push(options.agentEnv);
      provisionLocalEnvs.push(options.localEnv);
      paneSources.push(options.paneSource);
      tailnet.devices.push({ nodeId: 'n1', id: '1', hostname: options.hostname, name: FQDN, addresses: [], tags: ['tag:rp-session'] });
      if (script.provisionError) throw script.provisionError;
      options.onStep?.({ step: 'install-pane', state: 'start' });
      return {
        nodeId: 'n1', hostname: options.hostname, magicDnsName: `${options.hostname}.tail1234.ts.net`, tailscaleIps: [], tags: ['tag:rp-session'], runSsh: false,
        pairing: { v: 1, label: options.label, baseUrl: `https://${options.hostname}.tail1234.ts.net`, token: 'paired-token-SECRET', transport: 'http+sse', tunnel: { kind: 'tailscale', selected: true } },
        transport: 'https',
        daemonVersion: '2.4.146',
        health: { ok: true, elapsedMs: 1, version: '2.4.146' },
        deletedStaleNodeIds: [],
      };
    },
    async repair(_sandbox, options) {
      repairs.push(options.hostname);
      return script.repair ?? { reenrolled: false, backendState: 'Running', serveApplied: true };
    },
    async update(_sandbox, pane) {
      updates.push(pane.debUrl);
      return { version: '2.4.147' };
    },
    async applyClaudeModel(_sandbox, model) {
      if (script.claudeModelFails) throw new Error('cloud bootstrap step "claude-model" failed: settings.json is not a JSON object');
      claudeModels.push(model);
      return { outcome: 'set', model };
    },
    async writeLocalEnv(sandbox, envFile) {
      events.push('local-env');
      localEnvWrites.push({ sandboxId: sandbox.id, envFile });
      return { keys: envFile ? 1 : 0, reserved: [] };
    },
    async applyGitHubToken(_sandbox, token) {
      events.push('github');
      githubTokens.push(token);
      if (!token) return { state: 'none' };
      if ((script.githubFailsFirst ?? 0) > 0) {
        script.githubFailsFirst = (script.githubFailsFirst ?? 0) - 1;
        throw new Error('cloud bootstrap step "github-auth" failed: no result (exit null)');
      }
      if (script.github instanceof Error) throw script.github;
      return script.github ?? { state: 'signed-in', user: 'octo-cat' };
    },
    async setHostname(_sandbox, hostname) {
      events.push(`hostname ${hostname}`);
      if (script.hostnameFails) throw new Error('cloud bootstrap step "os-hostname" failed: hostname exited 1');
      return { hostname };
    },
    async pushStartupScript(_sandbox, startupScript) {
      events.push(`push ${JSON.stringify(startupScript)}`);
      if (script.startupPushFails) throw new Error('cloud bootstrap step "startup-install" failed: no space left');
      return { sha256: startupScript.trim() ? 'ab'.repeat(32) : null };
    },
    async runStartupScript(_sandbox, mode) {
      events.push(`run ${mode}`);
      if (script.startupRunFails) throw new Error('cloud bootstrap step "startup-run" failed: boat exec timed out');
      return { ran: true, status: script.startupStatus === undefined ? STARTUP_OK : script.startupStatus };
    },
    async readStartupLog() {
      events.push('log');
      return 'MARKER\n';
    },
    async waitForHealth(): Promise<DaemonHealthResult> {
      events.push('health');
      const ok = health.length > 0 ? health.shift() === true : true;
      return { ok, elapsedMs: 1, version: ok ? '2.4.146' : undefined };
    },
  };
  return { bootstrap, agentEnvs, paneSources, repairs, updates, claudeModels, events, githubTokens, localEnvWrites, provisionLocalEnvs };
}

/** The user's Claude Code default model on "this machine"; tests change it. */
class LocalClaudeDefault {
  constructor(public model: string | null) {}
}

/** The user's startup script on "this machine"; undefined: the caller has no reader (the CLI). */
class LocalStartupScript {
  constructor(public script: string | undefined) {}
}

/** What the desktop's local start script gives a create or start; undefined: no reader (the CLI). */
class LocalStartScript {
  runs = 0;
  constructor(public result: LocalStartEnv | undefined) {}
}

function harness(script: BootstrapScript = {}, env: NodeJS.ProcessEnv = {}, startupScript?: string, localStart?: LocalStartEnv) {
  const localStartScript = new LocalStartScript(localStart);
  const startup = new LocalStartupScript(startupScript);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cloud-'));
  const clock = new FakeClock();
  const provider = fakeProvider(clock);
  const tailnet = fakeTailnet();
  const boot = fakeBootstrap(tailnet, script);
  const saved = new Map<string, CloudHostProfile>();
  const progress: CloudProgress[] = [];
  const local = new LocalClaudeDefault('claude-opus-5-5');
  const cloud = createCloudSandboxes({
    dir,
    createProvider: provider.factory,
    createTailscale: () => tailnet.api,
    bootstrap: boot.bootstrap,
    savedHosts: {
      upsert: async (profile) => {
        saved.set(profile.cloud.sessionId, profile);
      },
      remove: async (sessionId) => {
        saved.delete(sessionId);
      },
    },
    sleep: clock.sleep,
    now: clock.now,
    env,
    localClaudeModel: async () => local.model,
    readStartupScript: startupScript === undefined ? undefined : async () => startup.script ?? '',
    readLocalStartEnv: localStart === undefined ? undefined : async () => {
      localStartScript.runs += 1;
      return localStartScript.result ?? { status: { state: 'none' }, envFile: '' };
    },
  });
  const onProgress = (update: CloudProgress) => progress.push(update);
  return { dir, cloud, provider, tailnet, boot, saved, progress, onProgress, local, clock, startup, localStartScript };
}

async function withCredentials(h: ReturnType<typeof harness>) {
  await h.cloud.setup({ boatApiKey: SECRETS[0], boatOrg: 'test', tailscaleClientId: 'client-id', tailscaleClientSecret: SECRETS[1], claudeToken: SECRETS[2] });
}

function readTree(dir: string): string {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

test('setup saves the credentials 0600, resolves the wallet, and its status never carries a secret', async () => {
  const h = harness();
  assert.deepEqual(await h.cloud.getCredentialsStatus(), {
    boat: { configured: false }, tailscale: { configured: false }, claude: { configured: false }, github: { configured: false }, ready: false,
  });
  await withCredentials(h);
  const status = await h.cloud.getCredentialsStatus();
  assert.deepEqual(status, {
    boat: { configured: true, org: { id: 'team_test', name: 'test' } }, tailscale: { configured: true }, claude: { configured: true }, github: { configured: false }, ready: true,
  });
  assert.equal(fs.statSync(path.join(h.dir, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.dir).mode & 0o777, 0o700);
  // Empty fields keep what is saved.
  await h.cloud.setup({ boatApiKey: '', tailscaleClientSecret: ' ' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'credentials.json'), 'utf8')).boat.apiKey, SECRETS[0]);
});

test('setup refuses half a Tailscale OAuth client and an unknown wallet', async () => {
  const h = harness();
  await assert.rejects(h.cloud.setup({ tailscaleClientId: 'client-id' }), /needs both its client id and its secret/u);
  await assert.rejects(h.cloud.setup({ boatApiKey: SECRETS[0], boatOrg: 'nope' }), /No boat wallet "nope". Yours: test \(team_test\)/u);
  assert.equal(fs.existsSync(path.join(h.dir, 'credentials.json')), false);
});

test('create provisions in the saved wallet, signs agents in, saves the host and reports progress without secrets', async () => {
  const h = harness();
  await withCredentials(h);
  const info = await h.cloud.create({ label: 'My sandbox' }, h.onProgress);

  assert.equal(info.state, 'running');
  assert.equal(info.label, 'My sandbox');
  assert.match(info.hostname, /^rp-[a-z0-9]{8}$/u);
  assert.equal(info.baseUrl, `https://${info.hostname}.tail1234.ts.net`);
  assert.equal(info.transport, 'https');
  assert.deepEqual(info.health, { ok: true, version: '2.4.146' });
  assert.ok(info.startedAt);
  assert.equal(info.daemonVersion, '2.4.146');
  assert.equal(h.provider.creates[0].org, 'team_test');
  assert.deepEqual(h.boot.paneSources, [{ kind: 'runpane-npm', spec: 'runpane@latest' }]);
  assert.match(h.provider.creates[0].idempotencyKey, /^runpane-cloud-new-/u);
  assert.deepEqual(h.boot.agentEnvs, [`CLAUDE_CODE_OAUTH_TOKEN=${SECRETS[2]}\n`]);

  const saved = h.saved.get(info.sessionId);
  assert.equal(saved?.token, 'paired-token-SECRET');
  assert.deepEqual(saved?.cloud, { provider: 'boat', sandboxId: info.sandboxId, sessionId: info.sessionId, nodeId: 'n1', hostname: info.hostname, version: 1 });
  assert.equal(fs.statSync(path.join(h.dir, 'hosts', `${info.hostname}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(h.progress.map((update) => update.step), ['sandbox', 'tailnet', 'install', 'install', 'saved-host', 'done']);
  assert.deepEqual(info.claudeModel, { model: 'claude-opus-5-5', outcome: 'set' });
  assert.deepEqual(h.boot.claudeModels, ['claude-opus-5-5']);
  const visible = JSON.stringify([info, h.progress]);
  for (const secret of SECRETS) assert.ok(!visible.includes(secret), 'no secret in results or progress');
});

test('a failed create removes the sandbox, its tailnet device and its record', async () => {
  const h = harness({ provisionError: new Error('cloud bootstrap step "install-pane" failed: apt-get exited 100') });
  await withCredentials(h);
  await assert.rejects(h.cloud.create({}, h.onProgress), /Creating rp-[a-z0-9]{8} failed: cloud bootstrap step "install-pane" failed/u);
  assert.equal(h.provider.sandboxes.size, 0);
  assert.equal(h.tailnet.devices.length, 0);
  assert.deepEqual(await h.cloud.list(), []);
  assert.equal(h.saved.size, 0);
});

test('stop flushes then stops; start resumes and waits for the daemon', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sandboxId } = await h.cloud.create();

  const stopped = await h.cloud.stop(hostname, h.onProgress);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(h.provider.calls.slice(-2), [`run ${sandboxId} sync; sleep 0.2; sync`, `stop ${sandboxId}`]);
  assert.equal((await h.cloud.stop(hostname)).state, 'stopped', 'stopping a stopped sandbox is a no-op');
  assert.equal((await h.cloud.list())[0].state, 'stopped');
  assert.equal(h.provider.keys.at(-1)?.org, 'team_test', 'list is scoped to the wallet the sandbox bills');

  const started = await h.cloud.start(hostname, h.onProgress);
  assert.equal(started.state, 'running');
  assert.deepEqual(started.health, { ok: true, version: '2.4.146' });
  assert.deepEqual(h.provider.calls.slice(-2), [`resume ${sandboxId}`, `run ${sandboxId} true`], "resumed, then waited until it takes commands");
  assert.deepEqual(h.boot.repairs, [], 'a healthy start needs no repair');
});

test('start repairs a node that came back logged out, under the same name, and updates the saved host', async () => {
  const h = harness({
    health: [false, true],
    repair: { reenrolled: true, previousBackendState: 'NeedsLogin', deletedNodeIds: ['n1'], nodeId: 'n2', hostname: 'x', magicDnsName: FQDN, tailscaleIps: [], tags: [], runSsh: false },
  });
  await withCredentials(h);
  const { hostname, sessionId, baseUrl } = await h.cloud.create();
  await h.cloud.stop(hostname);
  const started = await h.cloud.start(hostname, h.onProgress);

  assert.deepEqual(h.boot.repairs, [hostname]);
  assert.equal(started.baseUrl, baseUrl, 'same address after a re-enrol');
  assert.deepEqual(h.saved.get(sessionId)?.cloud.nodeId, 'n2');
  assert.equal(h.saved.get(sessionId)?.cloud.version, 2);
  assert.ok(h.progress.some((update) => update.step === 'repair'));
});

test('start fails when the daemon never answers, even after the repair', async () => {
  const h = harness({ health: [false, false] });
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.start(hostname), /its Pane daemon did not answer/u);
});

test('update installs a pinned .deb only on a running sandbox', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  const pane = { debUrl: 'https://example.com/pane_2.4.147_amd64.deb', sha256: 'c'.repeat(64) };
  const updated = await h.cloud.update(hostname, pane, h.onProgress);
  assert.deepEqual(h.boot.updates, [pane.debUrl]);
  assert.equal(updated.daemonVersion, '2.4.146', 'the version the daemon reports wins over the package\'s');
  assert.equal(updated.health?.ok, true);
  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.update(hostname, pane), /is stopped; start it before updating Pane/u);
});

test('remove deletes the tailnet device, the sandbox, the saved host and the record', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await h.cloud.remove(hostname, h.onProgress);
  assert.equal(h.tailnet.devices.length, 0);
  assert.equal(h.provider.sandboxes.size, 0);
  assert.equal(h.saved.has(sessionId), false);
  assert.deepEqual(await h.cloud.list(), []);
  await assert.rejects(h.cloud.status(hostname), /No cloud sandbox matches/u);
});

test('remove after a stop and start waits until boat really deleted the sandbox and the tailnet node is gone', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId, sandboxId } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await h.cloud.start(hostname);
  // boat answers the delete with 202 and finishes it 40 s later; meanwhile the still-running node rejoins once.
  h.provider.slow.destroy = { goneAfterMs: 40_000 };
  const [device] = h.tailnet.devices;
  h.tailnet.rejoin.device = { ...device, nodeId: 'n-rejoined' };

  await h.cloud.remove(hostname, h.onProgress);

  assert.equal((await h.provider.factory('k').get(sandboxId)).state, 'gone', 'boat GET is 404');
  assert.deepEqual(h.tailnet.devices, [], 'no tailnet device is left, including the one that rejoined');
  assert.equal(h.saved.has(sessionId), false);
  assert.deepEqual(await h.cloud.list(), []);
  assert.ok(h.progress.some((update) => update.message.includes('Waiting for boat to finish removing')));
});

test('remove keeps the record and says so when boat accepts the delete but keeps the sandbox', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId, sandboxId, label } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await h.cloud.start(hostname);
  h.provider.slow.destroy = { goneAfterMs: 'never' };

  await assert.rejects(h.cloud.remove(hostname, h.onProgress), new RegExp(
    `^Error: Remove didn't finish: boat still lists ${label}'s sandbox ${sandboxId} \\(idle\\) 3 minutes after accepting the delete\\.`, 'u'));

  assert.equal(h.saved.has(sessionId), true, 'the saved host stays');
  assert.deepEqual((await h.cloud.list()).map((info) => info.hostname), [hostname], 'the record stays, so the row does too');
});

function rewriteRecord(h: ReturnType<typeof harness>, hostname: string, change: (record: { meta: { boatOrg?: { id: string; name: string } } }) => void) {
  const file = path.join(h.dir, 'hosts', `${hostname}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(record);
  fs.writeFileSync(file, JSON.stringify(record));
}

test('remove never takes a sandbox it can\'t see in the host\'s wallet as gone', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId, sandboxId, label } = await h.cloud.create();
  // The record names another wallet: its scoped GET and DELETE answer 404 though the sandbox still exists.
  rewriteRecord(h, hostname, (record) => { record.meta.boatOrg = { id: 'team_other', name: 'other' }; });

  await assert.rejects(h.cloud.remove(hostname, h.onProgress), new RegExp(
    `Remove didn't finish: boat doesn't show ${label}'s sandbox ${sandboxId} in this host's wallet \\(other\\), but it still exists`, 'u'));

  assert.equal(h.provider.sandboxes.has(sandboxId), true, 'the sandbox was not deleted blind');
  assert.equal(h.saved.has(sessionId), true);
  assert.deepEqual((await h.cloud.list()).map((info) => info.hostname), [hostname], 'the record and the row stay');
});

test('remove never deletes a recorded node that is not this sandbox\'s, and keeps the record', async () => {
  for (const foreign of [
    { hostname: 'rp-other1234', name: 'rp-other1234.tail1234.ts.net', tags: ['tag:rp-session'] },
    { tags: [] },
  ]) {
    const h = harness();
    await withCredentials(h);
    const { hostname, sessionId, sandboxId } = await h.cloud.create();
    const [device] = h.tailnet.devices;
    // The record's node id points at another sandbox's node, or at an untagged machine.
    h.tailnet.devices[0] = { ...device, ...foreign };

    await assert.rejects(h.cloud.remove(hostname, h.onProgress),
      new RegExp(`^Error: Remove didn't finish: the recorded tailnet device doesn't belong to this sandbox: ${device.nodeId} is .* Nothing was deleted\\.$`, 'u'));

    assert.deepEqual(h.tailnet.devices.map((left) => left.nodeId), [device.nodeId], 'that device is untouched');
    assert.equal(h.provider.sandboxes.has(sandboxId), true, 'and so is the sandbox');
    assert.ok(!h.provider.calls.includes(`destroy ${sandboxId}`));
    assert.equal(h.saved.has(sessionId), true);
    assert.deepEqual((await h.cloud.list()).map((info) => info.hostname), [hostname], 'the row stays');
  }
});

test('remove checks the recorded node by id: a delete that left it behind keeps the record', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId } = await h.cloud.create();
  const [device] = h.tailnet.devices;
  // Its delete "succeeds" without removing it.
  h.tailnet.rejoin.stuck.add(device.nodeId);

  await assert.rejects(h.cloud.remove(hostname, h.onProgress),
    new RegExp(`Remove didn't finish: the tailnet still lists ${hostname}'s node ${device.nodeId} after deleting it`, 'u'));
  assert.equal(h.saved.has(sessionId), true);
});

test('remove clears a sandbox boat no longer has in any wallet without deleting anything', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sandboxId } = await h.cloud.create();
  h.provider.sandboxes.delete(sandboxId);

  await h.cloud.remove(hostname, h.onProgress);

  assert.ok(!h.provider.calls.includes(`destroy ${sandboxId}`), 'nothing left to delete');
  assert.ok(h.provider.calls.includes(`get-without-wallet ${sandboxId}`), 'checked outside the wallet before calling it gone');
  assert.deepEqual(await h.cloud.list(), []);
});

test('host records hold the paired token but never a provider or Tailscale secret', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  const record = fs.readFileSync(path.join(h.dir, 'hosts', `${hostname}.json`), 'utf8');
  for (const secret of SECRETS.slice(0, 3)) assert.ok(!record.includes(secret));
  // Only credentials.json holds those.
  const others = readTree(path.join(h.dir, 'hosts')) + fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8');
  for (const secret of SECRETS.slice(0, 3)) assert.ok(!others.includes(secret));
});

test('the environment can pin the Pane .deb (with its sha256) and the name prefix for new sandboxes', async () => {
  const h = harness({}, {
    RUNPANE_CLOUD_PANE_DEB_URL: 'https://example.com/pane_cs.deb', RUNPANE_CLOUD_PANE_DEB_SHA256: 'd'.repeat(64), RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs',
  });
  await withCredentials(h);
  const info = await h.cloud.create();
  assert.match(info.hostname, /^rp-loop-cs-[a-z0-9]{8}$/u);
  assert.deepEqual(h.boot.paneSources, [{ kind: 'deb-url', url: 'https://example.com/pane_cs.deb', sha256: 'd'.repeat(64) }]);

  const unpinned = harness({}, { RUNPANE_CLOUD_PANE_DEB_URL: 'https://example.com/pane_cs.deb' });
  await withCredentials(unpinned);
  await assert.rejects(unpinned.cloud.create(), /RUNPANE_CLOUD_PANE_DEB_URL needs RUNPANE_CLOUD_PANE_DEB_SHA256/u);
  assert.equal(unpinned.provider.creates.length, 0, 'refused before anything is billed');
});

test('the sandbox follows the user\'s Claude Code default model: on create, start, update and syncAgentDefaults', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  assert.deepEqual(h.boot.claudeModels, ['claude-opus-5-5']);

  // The user changes their default; a running sandbox follows on syncAgentDefaults, before any restart.
  h.local.model = 'sonnet';
  assert.deepEqual((await h.cloud.syncAgentDefaults(hostname)).claudeModel, { model: 'sonnet', outcome: 'set' });

  // Detection failed (unknown): nothing is sent, so the sandbox keeps 'sonnet' instead of being cleared.
  h.local.model = null;
  const updated = await h.cloud.update(hostname, { debUrl: 'https://example.com/pane.deb', sha256: 'e'.repeat(64) }, h.onProgress);
  assert.equal(updated.claudeModel, undefined);
  assert.ok(h.progress.some((update) => update.step === 'update'
    && update.message === 'Your Claude Code default model is unknown right now, so the sandbox keeps the model it has.'));
  assert.equal((await h.cloud.syncAgentDefaults(hostname)).claudeModel, undefined);

  h.local.model = 'claude-opus-5-5';
  await h.cloud.stop(hostname);
  assert.deepEqual((await h.cloud.start(hostname)).claudeModel, { model: 'claude-opus-5-5', outcome: 'set' });
  assert.deepEqual(h.boot.claudeModels, ['claude-opus-5-5', 'sonnet', 'claude-opus-5-5'], 'an unknown default is never sent');

  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.syncAgentDefaults(hostname), /is stopped; it gets your default model when it starts/u);
});

test('a start whose model update fails still succeeds and says so', async () => {
  const h = harness({ claudeModelFails: true });
  await assert.rejects(withCredentials(h).then(() => h.cloud.create()), /Creating rp-[a-z0-9]{8} failed: cloud bootstrap step "claude-model" failed/u);
  // create is all or nothing; start and update keep a usable sandbox.
  const ok = harness();
  await withCredentials(ok);
  const { hostname } = await ok.cloud.create();
  await ok.cloud.stop(hostname);
  const failing = harness({ claudeModelFails: true });
  // Reuse the same state dir through a second library on it.
  const info = await createCloudSandboxes({
    dir: ok.dir,
    createProvider: ok.provider.factory,
    createTailscale: () => ok.tailnet.api,
    bootstrap: failing.boot.bootstrap,
    savedHosts: { upsert: async () => undefined, remove: async () => undefined },
    sleep: async () => undefined,
    env: {},
    localClaudeModel: async () => 'claude-opus-5-5',
  }).start(hostname, failing.onProgress);
  assert.equal(info.state, 'running');
  assert.equal(info.claudeModel, undefined);
  assert.ok(failing.progress.some((update) => /kept its Claude model: cloud bootstrap step "claude-model" failed/u.test(update.message)));
});

test('a Stop boat accepted waits through a long archive (over 120 s) and reports "Saving the sandbox…"', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sandboxId } = await h.cloud.create();
  h.provider.slow.stop = { archivingMs: 307_000, then: 'stopped' };
  const started = h.clock.now();
  const stopped = await h.cloud.stop(hostname, h.onProgress);
  assert.equal(stopped.state, 'stopped');
  assert.ok(h.clock.now() - started >= 307_000, 'it waited the whole archive');
  assert.deepEqual(h.progress.filter((update) => update.step === 'stopping').map((update) => update.message),
    [`Stopping ${stopped.label}...`, 'Saving the sandbox…']);
  assert.equal(h.progress.at(-1)?.step, 'done');
  assert.equal(h.provider.calls.filter((call) => call === `stop ${sandboxId}`).length, 1, 'one stop request');
});

test('a Stop fails clearly when boat errors, loses the sandbox, or is still archiving at the 15 min ceiling', async () => {
  for (const [then, expected] of [
    ['error', /^boat reported an error while stopping rp-[a-z0-9]{8} \(failed: snapshot failed\)\.$/u],
    ['gone', /^boat no longer has rp-[a-z0-9]{8}'s sandbox bx_1; it was removed while stopping\.$/u],
    ['stuck', /^rp-[a-z0-9]{8} was still archiving after 15 min; boat may still finish stopping it\. Check its state again later\.$/u],
  ] as const) {
    const h = harness();
    await withCredentials(h);
    const { hostname } = await h.cloud.create();
    h.provider.slow.stop = { archivingMs: 200_000, then };
    const started = h.clock.now();
    await assert.rejects(h.cloud.stop(hostname, h.onProgress), (error: Error) => {
      assert.match(error.message, expected);
      for (const secret of SECRETS) assert.ok(!error.message.includes(secret));
      return true;
    });
    if (then === 'stuck') assert.ok(h.clock.now() - started >= 15 * 60_000, 'the ceiling is 15 min, not 120 s');
    else assert.ok(h.clock.now() - started < 15 * 60_000);
  }
});

test('Start waits through a Stop that boat is still archiving, then resumes', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sandboxId } = await h.cloud.create();
  h.provider.slow.stop = { archivingMs: 300_000, then: 'stopped' };
  // A Stop boat accepted, still archiving when the user presses Start.
  await h.provider.factory('k').stop(sandboxId);
  const started = await h.cloud.start(hostname);
  assert.equal(started.state, 'running');
  assert.deepEqual(h.provider.calls.slice(-2), [`resume ${sandboxId}`, `run ${sandboxId} true`], "resumed, then waited until it takes commands");
});

test('create pushes the startup script and runs it once, showing "Running your startup script…"', async () => {
  const h = harness({}, {}, 'echo MARKER\n');
  await withCredentials(h);
  const info = await h.cloud.create({}, h.onProgress);
  assert.deepEqual(h.boot.events.filter((event) => event !== 'health' && event !== 'github'), ['push "echo MARKER\\n"', 'run always']);
  assert.deepEqual(h.progress.find((update) => update.step === 'startup'), { step: 'startup', message: 'Running your startup script…' });
  assert.deepEqual(h.progress.map((update) => update.step).slice(-3), ['saved-host', 'startup', 'done']);
  assert.deepEqual(info.startupScript, STARTUP_OK);
});

test('create with an empty startup script installs the unit but runs nothing; without a reader it pushes nothing', async () => {
  const empty = harness({}, {}, '');
  await withCredentials(empty);
  const info = await empty.cloud.create({}, empty.onProgress);
  assert.deepEqual(empty.boot.events.filter((event) => event !== 'health' && event !== 'github'), ['push ""']);
  assert.ok(!empty.progress.some((update) => update.step === 'startup'));
  assert.equal(info.startupScript, undefined);

  const cli = harness();
  await withCredentials(cli);
  await cli.cloud.create();
  assert.deepEqual(cli.boot.events.filter((event) => event !== 'health' && event !== 'github'), [], 'the CLI never replaces the script desktop Pane pushed');
});

test('a failing startup script never fails create: the sandbox is kept and the status reports the failure', async () => {
  const failed = { ...STARTUP_OK, exitCode: 1 };
  const h = harness({ startupStatus: failed }, {}, 'exit 1\n');
  await withCredentials(h);
  const info = await h.cloud.create({}, h.onProgress);
  assert.equal(info.state, 'running');
  assert.deepEqual(info.startupScript, failed);
  assert.equal(h.saved.size, 1);

  const broken = harness({ startupRunFails: true }, {}, 'echo hi\n');
  await withCredentials(broken);
  const kept = await broken.cloud.create({}, broken.onProgress);
  assert.equal(kept.state, 'running');
  assert.equal(kept.startupScript, undefined);
  assert.equal(broken.provider.sandboxes.size, 1, 'the sandbox stays');
  assert.match(broken.progress.at(-2)?.message ?? '', /^Your startup script could not run: cloud bootstrap step "startup-run" failed/u);
});

test('start pushes the current startup script before the health check, and a failed push never fails the start', async () => {
  const h = harness({}, {}, 'echo v1\n');
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  await h.cloud.stop(hostname);
  h.startup.script = 'echo v2\n';
  h.boot.events.length = 0;
  await h.cloud.start(hostname, h.onProgress);
  assert.deepEqual(h.boot.events, [`hostname ${hostname}`, 'github', 'push "echo v2\\n"', 'health'], 'pushed before the health check, and not run (the boot ran it)');

  const script: BootstrapScript = {};
  const failing = harness(script, {}, 'echo v1\n');
  await withCredentials(failing);
  const created = await failing.cloud.create();
  await failing.cloud.stop(created.hostname);
  script.startupPushFails = true;
  const progress: CloudProgress[] = [];
  const started = await failing.cloud.start(created.hostname, (update) => progress.push(update));
  assert.equal(started.state, 'running');
  assert.ok(progress.some((update) => /^Your startup script could not be updated: cloud bootstrap step "startup-install" failed/u.test(update.message)));
});

test('a failed push never fails create either: the sandbox is kept', async () => {
  const h = harness({ startupPushFails: true }, {}, 'echo v1\n');
  await withCredentials(h);
  const info = await h.cloud.create({}, h.onProgress);
  assert.equal(info.state, 'running');
  assert.equal(info.startupScript, undefined);
  assert.deepEqual(h.boot.events.filter((event) => event !== 'health' && event !== 'github'), ['push "echo v1\\n"'], 'nothing runs without the pushed script');
  assert.ok(h.progress.some((update) => /^Your startup script could not run: cloud bootstrap step "startup-install" failed/u.test(update.message)));
});

test('runStartupScript pushes the current script and runs it on a running sandbox; readStartupLog reads its log', async () => {
  const h = harness({}, {}, 'echo v1\n');
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  h.startup.script = 'echo v2\n';
  h.boot.events.length = 0;
  assert.deepEqual(await h.cloud.runStartupScript(hostname, { onlyIfChanged: true }), STARTUP_OK);
  assert.deepEqual(await h.cloud.runStartupScript(hostname), STARTUP_OK);
  assert.deepEqual(h.boot.events, ['push "echo v2\\n"', 'run if-changed', 'push "echo v2\\n"', 'run always']);
  assert.equal(await h.cloud.readStartupLog(hostname), 'MARKER\n');

  const script: BootstrapScript = { startupPushFails: true };
  const failing = harness(script, {}, 'echo v1\n');
  await withCredentials(failing);
  const created = await failing.cloud.create();
  failing.boot.events.length = 0;
  await assert.rejects(failing.cloud.runStartupScript(created.hostname), /startup-install/u);
  assert.deepEqual(failing.boot.events, ['push "echo v1\\n"'], 'the old script is not run after a failed push');

  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.runStartupScript(hostname), /is stopped; it runs your startup script when it starts/u);
  await assert.rejects(h.cloud.readStartupLog(hostname), /is stopped; start it to read its startup log/u);
});

test('start and update give the OS its tailnet name again (a resume brings back the pool machine\'s), before the health check', async () => {
  const script: BootstrapScript = {};
  const h = harness(script);
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  await h.cloud.stop(hostname);
  h.boot.events.length = 0;
  await h.cloud.start(hostname, h.onProgress);
  assert.deepEqual(h.boot.events, [`hostname ${hostname}`, 'github', 'health']);

  h.boot.events.length = 0;
  await h.cloud.update(hostname, { debUrl: 'https://example.com/pane_2.4.147_amd64.deb', sha256: 'c'.repeat(64) });
  assert.deepEqual(h.boot.events, ['health', `hostname ${hostname}`]);

  // A failure is reported, never thrown: the sandbox works under any OS name.
  await h.cloud.stop(hostname);
  script.hostnameFails = true;
  const progress: CloudProgress[] = [];
  assert.equal((await h.cloud.start(hostname, (update) => progress.push(update))).state, 'running');
  assert.ok(progress.some((update) => /^.+ kept the OS name it came back with: cloud bootstrap step "os-hostname" failed/u.test(update.message)));
});

const GITHUB_TOKEN = 'FAKE-GH-TOKEN-api-SECRET';

test('setup saves the GitHub token like the Claude token: 0600, reported only as configured', async () => {
  const h = harness();
  await withCredentials(h);
  assert.equal((await h.cloud.getCredentialsStatus()).github.configured, false);
  assert.equal((await h.cloud.setup({ githubToken: GITHUB_TOKEN })).github.configured, true);
  assert.equal((await h.cloud.setup({ githubToken: '  ' })).github.configured, true, 'blank keeps the saved token');
  const file = path.join(h.dir, 'credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).github.token, GITHUB_TOKEN);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await h.cloud.getCredentialsStatus()).includes(GITHUB_TOKEN));
});

test('create and every start sign the sandbox in to GitHub with the saved token, and report how it went', async () => {
  const h = harness();
  await withCredentials(h);
  await h.cloud.setup({ githubToken: GITHUB_TOKEN });
  const created = await h.cloud.create({}, h.onProgress);
  assert.deepEqual(created.github, { state: 'signed-in', user: 'octo-cat' });
  await h.cloud.stop(created.hostname);
  const started = await h.cloud.start(created.hostname, h.onProgress);
  assert.deepEqual(started.github, { state: 'signed-in', user: 'octo-cat' });
  assert.deepEqual(h.boot.githubTokens, [GITHUB_TOKEN, GITHUB_TOKEN], 'applied on create and on start');
  const visible = JSON.stringify([created, started, h.progress, h.boot.events]);
  assert.ok(!visible.includes(GITHUB_TOKEN), 'the token is in no result, progress or event');
});

test('no GitHub token is quiet, an invalid one is reported, and a failure never costs the sandbox', async () => {
  const none = harness();
  await withCredentials(none);
  assert.deepEqual((await none.cloud.create()).github, { state: 'none' });
  assert.deepEqual(none.boot.githubTokens, [undefined]);

  const invalid = harness({ github: { state: 'invalid' } });
  await withCredentials(invalid);
  await invalid.cloud.setup({ githubToken: GITHUB_TOKEN });
  const created = await invalid.cloud.create();
  assert.equal(created.state, 'running');
  assert.deepEqual(created.github, { state: 'invalid' });

  const script: BootstrapScript = { github: new Error(`boat exec failed for ${GITHUB_TOKEN.slice(0, 4)}`) };
  const broken = harness(script);
  await withCredentials(broken);
  await broken.cloud.setup({ githubToken: GITHUB_TOKEN });
  const kept = await broken.cloud.create();
  assert.equal(kept.state, 'running');
  assert.deepEqual(kept.github, { state: 'error', message: "Couldn't apply the GitHub token on the sandbox." });
  await broken.cloud.stop(kept.hostname);
  assert.deepEqual((await broken.cloud.start(kept.hostname)).github, { state: 'error', message: "Couldn't apply the GitHub token on the sandbox." });
});

const LOCAL_ENV_FILE = "export DOPPLER_TOKEN='FAKE-LOCAL-ENV-api-SECRET'\n";
const LOCAL_OK: LocalStartEnv = { status: { state: 'ok', keys: 1, reserved: [] }, envFile: LOCAL_ENV_FILE };

test('create runs the local start script once and provisions its variables; the CLI does neither', async () => {
  const h = harness({}, {}, 'echo hi\n', LOCAL_OK);
  await withCredentials(h);
  const info = await h.cloud.create({}, h.onProgress);
  assert.equal(h.localStartScript.runs, 1);
  assert.deepEqual(h.boot.provisionLocalEnvs, [LOCAL_ENV_FILE]);
  assert.deepEqual(info.localStart, { state: 'ok', keys: 1, reserved: [] });
  assert.ok(!JSON.stringify([info, h.progress, h.boot.events]).includes('FAKE-LOCAL-ENV'), 'no value in results or progress');

  const cli = harness();
  await withCredentials(cli);
  const created = await cli.cloud.create();
  assert.deepEqual(cli.boot.provisionLocalEnvs, [undefined]);
  assert.equal(created.localStart, undefined);
});

test('every start sends the fresh variables to THAT sandbox only, before the startup script', async () => {
  const h = harness({}, {}, 'echo hi\n', LOCAL_OK);
  await withCredentials(h);
  const a = await h.cloud.create({ label: 'a' });
  const b = await h.cloud.create({ label: 'b' });
  await h.cloud.stop(a.hostname);
  h.boot.events.length = 0;
  h.boot.localEnvWrites.length = 0;
  const started = await h.cloud.start(a.hostname, h.onProgress);
  assert.deepEqual(h.boot.localEnvWrites, [{ sandboxId: a.sandboxId, envFile: LOCAL_ENV_FILE }], `${b.hostname} (running) gets nothing`);
  assert.ok(h.boot.events.indexOf('local-env') < h.boot.events.indexOf('push "echo hi\\n"'), 'before the startup script push');
  assert.deepEqual(started.localStart, { state: 'ok', keys: 1, reserved: [] });
});

test('a failed or timed-out local start script leaves the sandbox env alone and never fails the start', async () => {
  for (const status of [{ state: 'failed', exitCode: 2 }, { state: 'timeout', seconds: 60 }, { state: 'error', message: "Couldn't start PowerShell for the local start script." }] as const) {
    const h = harness({}, {}, 'echo hi\n', { status, envFile: null });
    await withCredentials(h);
    const created = await h.cloud.create();
    assert.deepEqual(h.boot.provisionLocalEnvs, [undefined], `${status.state}: nothing written on create`);
    assert.deepEqual(created.localStart, status);
    await h.cloud.stop(created.hostname);
    h.boot.localEnvWrites.length = 0;
    const started = await h.cloud.start(created.hostname);
    assert.equal(started.state, 'running');
    assert.deepEqual(h.boot.localEnvWrites, [], `${status.state}: nothing written on start`);
    assert.deepEqual(started.localStart, status);
  }
  const cleared = harness({}, {}, 'echo hi\n', { status: { state: 'none' }, envFile: '' });
  await withCredentials(cleared);
  const created = await cleared.cloud.create();
  await cleared.cloud.stop(created.hostname);
  await cleared.cloud.start(created.hostname);
  assert.deepEqual(cleared.boot.localEnvWrites.map((write) => write.envFile), [''], 'no script: the start removes the old file');
});

test('saving the GitHub token or any other credential keeps the saved boat wallet', async () => {
  const h = harness();
  await h.cloud.setup({ boatApiKey: SECRETS[0], boatOrg: 'test', tailscaleClientId: 'client-id', tailscaleClientSecret: SECRETS[1] });
  assert.deepEqual((await h.cloud.getCredentialsStatus()).boat.org, { id: 'team_test', name: 'test' });
  for (const update of [{ githubToken: 'FAKE-GH-TOKEN-wallet-SECRET' }, { claudeToken: SECRETS[2] }, { tailscaleClientId: 'client-2', tailscaleClientSecret: SECRETS[1] }, { boatApiKey: SECRETS[0] }]) {
    await h.cloud.setup(update);
    assert.deepEqual((await h.cloud.getCredentialsStatus()).boat.org, { id: 'team_test', name: 'test' }, `after saving ${Object.keys(update).join(', ')}`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')).boatOrg.name, 'test');
});

test('R8-GHWARN: start waits until the resumed sandbox takes commands before signing GitHub in', async () => {
  const h = harness();
  await withCredentials(h);
  await h.cloud.setup({ githubToken: GITHUB_TOKEN });
  const created = await h.cloud.create();
  await h.cloud.stop(created.hostname);
  h.boot.events.length = 0;
  h.provider.slow.commandsFailing = 3;
  const started = await h.cloud.start(created.hostname);
  assert.equal(h.provider.slow.commandsFailing, 0, 'it asked until the sandbox answered');
  assert.deepEqual(started.github, { state: 'signed-in', user: 'octo-cat' });
  assert.ok(h.boot.events.indexOf('github') < h.boot.events.indexOf('health'));
});

test('R8-GHWARN: a GitHub apply that fails while the sandbox settles is tried again before any warning', async () => {
  const script: BootstrapScript = {};
  const h = harness(script);
  await withCredentials(h);
  await h.cloud.setup({ githubToken: GITHUB_TOKEN });
  const created = await h.cloud.create();
  await h.cloud.stop(created.hostname);
  script.githubFailsFirst = 2;
  const started = await h.cloud.start(created.hostname);
  assert.deepEqual(started.github, { state: 'signed-in', user: 'octo-cat' }, 'no warning after a retry succeeds');

  await h.cloud.stop(created.hostname);
  script.githubFailsFirst = 3;
  assert.deepEqual((await h.cloud.start(created.hostname)).github, { state: 'error', message: "Couldn't apply the GitHub token on the sandbox." },
    'the warning only after every try failed');
  assert.equal(script.githubFailsFirst, 0, 'three tries');
});
