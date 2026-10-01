import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { RemoteHttpRequest, RemoteHttpTransport } from '../../remote/remoteDaemonClient';
import { decodePairingCode, encodePairingCode } from '../pairing';
import type { MintAuthKeyOptions, TailscaleApi, TailscaleDevice } from '../tailscale';
import { cloudHostname, parseStepResult, provisionSandbox, reenrolSandbox, redact } from './provision';
import type { SandboxCommandResult, SandboxHandle } from './types';

const PAIRING_TOKEN = 'FAKE-user-token';
const PAIRING = encodePairingCode({
  v: 1,
  label: 'Cloud k3j9',
  baseUrl: 'https://rp-k3j9x0q2.tailnet-example.ts.net',
  token: PAIRING_TOKEN,
  transport: 'http+sse',
});
const COORD_PAIRING = encodePairingCode({
  v: 1,
  label: 'runpane-cloud-coordinator',
  baseUrl: 'https://rp-k3j9x0q2.tailnet-example.ts.net',
  token: 'FAKE-coordinator-token',
  transport: 'http+sse',
});
const AUTH_KEY = 'tskey-fake-kSECRETSECRET-abcdef';

interface FakeState {
  joined: boolean;
  hostname: string;
  runSsh: boolean;
  checkOk: boolean;
  dnsSuffix: string;
}

class FakeSandbox implements SandboxHandle {
  readonly id = 'bx_fake';
  readonly files = new Map<string, string>();
  readonly steps: string[][] = [];
  readonly scripts: string[] = [];
  state: FakeState = { joined: false, hostname: '', runSsh: false, checkOk: true, dnsSuffix: '' };
  certRateLimited = false;
  localHealthy = true;

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async runScript(script: string): Promise<SandboxCommandResult> {
    this.scripts.push(script);
    if (!script.startsWith('bash ')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const args = [...script.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1].replace(/'\\''/g, "'"));
    const [, step, ...rest] = args;
    this.steps.push([step, ...rest]);
    return { exitCode: 0, stdout: `some log\nRP_RESULT ${this.respond(step, rest)}\n`, stderr: '' };
  }

  private identity(): string {
    return JSON.stringify(this.state.joined
      ? {
          ok: true,
          backendState: 'Running',
          nodeId: 'nNEW11CNTRL',
          hostname: this.state.hostname,
          magicDnsName: `${this.state.hostname}${this.state.dnsSuffix}.tailnet-example.ts.net`,
          tailscaleIps: ['100.64.0.9'],
          tags: ['tag:rp-session'],
          runSsh: this.state.runSsh,
        }
      : { ok: true, backendState: 'NeedsLogin' });
  }

  private respond(step: string, args: string[]): string {
    return JSON.stringify(this.reply(step, args));
  }

  private reply(step: string, args: string[]) {
    switch (step) {
      case 'identity': return { ok: true, reset: true, machineId: 'abc' };
      case 'ts-guard': return { ok: true };
      case 'cert-status': return { ok: true, rateLimited: this.certRateLimited, detail: this.certRateLimited ? '429 rateLimited: too many certificates (50) already issued' : null };
      case 'serve-guard': return { ok: true, applied: false, detail: 'rp-serve-restore: serve ok' };
      case 'serve-http': return { ok: true, baseUrl: `http://${this.state.hostname}.tailnet-example.ts.net:42137` };
      case 'firewall': return { ok: true, allowedTcp: args[0].split(',').map(Number) };
      case 'tailscale-install': return { ok: true, installed: false, backendState: 'NeedsLogin' };
      case 'tailnet-identity': return JSON.parse(this.identity());
      case 'check': return this.state.checkOk ? { ok: true, failed: [], passed: 29 } : { ok: false, failed: ['npmrc (/home/user) present'], passed: 28 };
      case 'tailscale-up': {
        assert.equal(this.files.get(args[0]), AUTH_KEY, 'the key file holds the minted key');
        this.files.delete(args[0]);
        this.state.joined = true;
        this.state.hostname = args[1];
        return JSON.parse(this.identity());
      }
      case 'tailscale-reset': this.state.joined = false; return { ok: true, backendState: 'NeedsLogin' };
      case 'serve-restore': return { ok: true, listenPort: 42137 };
      case 'install-pane': return { ok: true, skipped: false, version: '2.4.141-rc.1', listenPort: 42137 };
      case 'pairing-read': return { ok: true, code: args[0] ? COORD_PAIRING : PAIRING };
      case 'add-client': return { ok: true };
      case 'clone': return { ok: true, dir: args[2], head: 'deadbeef' };
      case 'health-local': return this.localHealthy ? { ok: true } : { ok: false, error: 'daemon /health on 127.0.0.1:42137 failed' };
      default: return { ok: false, error: `unknown step ${step}` };
    }
  }
}

class FakeTailscale implements TailscaleApi {
  devices: TailscaleDevice[] = [];
  readonly minted: MintAuthKeyOptions[] = [];
  readonly deleted: string[] = [];
  readonly log: string[] = [];

  async mintAuthKey(options: MintAuthKeyOptions = {}) {
    this.minted.push(options);
    this.log.push('mint');
    return { id: 'k1', key: AUTH_KEY };
  }

  async listDevices() {
    return this.devices;
  }

  async findDevicesByHostname(hostname: string) {
    return this.devices.filter((device) => device.hostname === hostname);
  }

  async deleteDevice(nodeId: string) {
    this.deleted.push(nodeId);
    this.log.push(`delete ${nodeId}`);
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.nodeId !== nodeId);
    return before !== this.devices.length;
  }
}

function device(nodeId: string, hostname: string): TailscaleDevice {
  return { nodeId, id: '1', hostname, name: `${hostname}.tailnet-example.ts.net`, addresses: [], tags: ['tag:rp-session'] };
}

const invokeBodySchema = boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) });

const healthyFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ ok: true, status: 'ready', transport: 'http+sse', version: '2.4.141-rc.1' }), { status: 200 });

function recordingInvoke() {
  const requests: RemoteHttpRequest[] = [];
  const transport: RemoteHttpTransport = async (request) => {
    requests.push(request);
    return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, created: true } }) };
  };
  return { transport, requests };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bootstrap-test-'));
}

test('cloudHostname takes rp- plus eight lowercase alphanumerics', () => {
  assert.equal(cloudHostname('AbC-123_def-XYZ'), 'rp-abc123de');
  assert.equal(cloudHostname('k3j9x0q2m1', 'rp-loop-cli'), 'rp-loop-cli-k3j9x0q2');
  assert.throws(() => cloudHostname('--'));
});

test('provisionSandbox runs every step in order and writes the pairing file 0600', async () => {
  const sandbox = new FakeSandbox();
  const tailscale = new FakeTailscale();
  const dir = tempDir();
  const pairingOutputPath = path.join(dir, 'sub', 'pairing.code');
  const coordPath = path.join(dir, 'coord.code');
  const seen: string[] = [];
  const invoke = recordingInvoke();

  const result = await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1',
    label: 'Cloud k3j9',
    tailscale,
    paneSource: { kind: 'deb-url', url: 'https://example.test/pane.deb', sha256: 'ff' },
    repo: { url: 'https://github.com/example/app.git', ref: 'main' },
    pairingOutputPath,
    extraClients: [{ label: 'runpane-cloud-coordinator', outputPath: coordPath, scope: 'coordinator' }],
    fetchImpl: healthyFetch,
    remoteTransport: invoke.transport,
    onStep: (step) => seen.push(`${step.step}:${step.state}`),
  });

  assert.deepEqual(sandbox.steps.map((step) => step[0]), [
    'identity', 'tailscale-install', 'tailnet-identity', 'check', 'firewall', 'tailscale-up',
    'install-pane', 'pairing-read', 'add-client', 'pairing-read', 'clone', 'serve-guard',
  ]);
  assert.deepEqual(sandbox.steps.at(-1)?.slice(1), ['https'], 'the Serve guard records the transport it ended on');
  // Only Tailscale Serve (tcp/443) may reach the sandbox over the tailnet, set up before it joins.
  assert.deepEqual(sandbox.steps[4].slice(1), ['443']);
  assert.deepEqual(sandbox.steps[5].slice(2), ['rp-k3j9x0q2']);
  assert.deepEqual(sandbox.steps[6].slice(1), ['deb-url', 'https://example.test/pane.deb', 'ff', '', 'Cloud k3j9']);
  assert.deepEqual(sandbox.steps[8].slice(1), ['runpane-cloud-coordinator', 'runpane-cloud-coordinator', 'coordinator']);
  assert.deepEqual(sandbox.steps[10].slice(1), ['https://github.com/example/app.git', 'main', '/home/user/app']);
  assert.equal(result.magicDnsName, 'rp-k3j9x0q2.tailnet-example.ts.net');
  assert.equal(result.baseUrl, 'https://rp-k3j9x0q2.tailnet-example.ts.net');
  assert.equal(result.nodeId, 'nNEW11CNTRL');
  assert.equal(result.daemonVersion, '2.4.141-rc.1');
  assert.equal(result.runSsh, false);
  assert.equal(fs.readFileSync(pairingOutputPath, 'utf8'), `${PAIRING}\n`);
  assert.equal(fs.statSync(pairingOutputPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(coordPath, 'utf8'), `${COORD_PAIRING}\n`);
  assert.equal(fs.statSync(coordPath).mode & 0o777, 0o600);
  assert.ok(seen.includes('health:done'));
  // The clone is registered with the daemon once it is healthy, so `panes create --repo app` works.
  assert.deepEqual(seen.slice(-6), [
    'health:start', 'health:done', 'serve-guard:start', 'serve-guard:done', 'register-repo:start', 'register-repo:done',
  ]);
  assert.equal(invoke.requests.length, 1);
  assert.equal(invoke.requests[0].url, 'https://rp-k3j9x0q2.tailnet-example.ts.net/invoke');
  assert.equal(invoke.requests[0].headers.Authorization, `Bearer ${PAIRING_TOKEN}`);
  const body = decodeBoundary(JSON.parse(invoke.requests[0].body ?? '{}'), invokeBodySchema);
  assert.equal(body.channel, 'runpane:repos:add');
  assert.deepEqual(body.args, [{ path: '/home/user/app', name: 'app' }]);
  assert.equal(result.repoDir, '/home/user/app');

  // Single-use, tagged, pre-authorized key; the key never appears in a command line.
  assert.deepEqual(tailscale.minted[0].tags, ['tag:rp-session']);
  assert.notEqual(tailscale.minted[0].reusable, true);
  assert.ok(sandbox.scripts.every((script) => !script.includes(AUTH_KEY) && !script.includes('--ssh')));
  assert.ok(sandbox.files.has('/home/user/.runpane-cloud/bin/rp-bootstrap.sh'));
  assert.ok(![...sandbox.files.keys()].some((key) => key.includes('tskey-')), 'the key file is consumed');
});

test('provisionSandbox deletes a stale device holding the hostname before joining', async () => {
  const sandbox = new FakeSandbox();
  const tailscale = new FakeTailscale();
  tailscale.devices = [device('nSTALE11CNTRL', 'rp-k3j9x0q2'), device('nOTHER', 'rp-other')];
  const result = await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale, paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: healthyFetch,
  });
  assert.deepEqual(result.deletedStaleNodeIds, ['nSTALE11CNTRL']);
  assert.deepEqual(tailscale.log, ['delete nSTALE11CNTRL', 'mint']);
});

test('provisionSandbox never deletes a member device holding the hostname: it stops the join and names it', async () => {
  const sandbox = new FakeSandbox();
  const tailscale = new FakeTailscale();
  tailscale.devices = [{ ...device('nMEMBER', 'rp-k3j9x0q2'), tags: [] }];
  await assert.rejects(provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale, paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: healthyFetch,
  }), /rp-k3j9x0q2\.tailnet-example\.ts\.net \(nMEMBER, untagged\).*did not create/u);
  assert.deepEqual(tailscale.log, []);
  assert.equal(tailscale.devices.length, 1);
});

test('provisionSandbox skips the join when the sandbox is already on the tailnet (retry)', async () => {
  const sandbox = new FakeSandbox();
  sandbox.state = { ...sandbox.state, joined: true, hostname: 'rp-k3j9x0q2' };
  const tailscale = new FakeTailscale();
  await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale, paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: healthyFetch,
  });
  assert.equal(tailscale.minted.length, 0);
  assert.ok(!sandbox.steps.some((step) => step[0] === 'check' || step[0] === 'tailscale-up'));
  assert.ok(sandbox.steps.some((step) => step[0] === 'firewall'), 'the firewall is (re)applied on a retry too');
  assert.ok(sandbox.steps.some((step) => step[0] === 'ts-guard'), 'the tailscaled.state guard is installed on a retry too');
});

test('provisionSandbox refuses a failed strip-list check, Tailscale SSH, and a suffixed name', async () => {
  const base = { sessionId: 'k3j9x0q2m1', label: 'x', paneSource: { kind: 'preinstalled' } as const, fetchImpl: healthyFetch };

  const dirty = new FakeSandbox();
  dirty.state.checkOk = false;
  await assert.rejects(
    provisionSandbox(dirty, { ...base, tailscale: new FakeTailscale(), pairingOutputPath: path.join(tempDir(), 'p') }),
    { name: 'BootstrapError', step: 'check', message: /npmrc/ },
  );

  const ssh = new FakeSandbox();
  ssh.state.runSsh = true;
  await assert.rejects(
    provisionSandbox(ssh, { ...base, tailscale: new FakeTailscale(), pairingOutputPath: path.join(tempDir(), 'p') }),
    /Tailscale SSH/,
  );

  const suffixed = new FakeSandbox();
  suffixed.state.dnsSuffix = '-1';
  await assert.rejects(
    provisionSandbox(suffixed, { ...base, tailscale: new FakeTailscale(), pairingOutputPath: path.join(tempDir(), 'p') }),
    /joined as "rp-k3j9x0q2-1"/,
  );
});

test('provisionSandbox refuses a Pane .deb that is not served over https before touching the sandbox', async () => {
  for (const url of ['http://example.test/pane.deb', 'file:///tmp/pane.deb', 'not a url']) {
    const sandbox = new FakeSandbox();
    await assert.rejects(
      provisionSandbox(sandbox, {
        sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), fetchImpl: healthyFetch,
        paneSource: { kind: 'deb-url', url }, pairingOutputPath: path.join(tempDir(), 'p'),
      }),
      /must be an https:\/\/ URL/,
    );
    assert.deepEqual(sandbox.steps, [], url);
  }
});

test('auto transport: when Let\'s Encrypt refuses the Serve certificate, it switches to plain HTTP inside the tailnet', async () => {
  const sandbox = new FakeSandbox();
  sandbox.certRateLimited = true;
  const dir = tempDir();
  const pairingOutputPath = path.join(dir, 'pairing.code');
  const coordPath = path.join(dir, 'coord.code');
  const invoke = recordingInvoke();
  const httpsNeverAnswers: typeof fetch = async (input) =>
    String(input).startsWith('https://') ? new Response('', { status: 502 }) : healthyFetch(input);
  const seen: string[] = [];

  const result = await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'Cloud k3j9', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
    repo: { url: 'https://github.com/example/app.git' }, pairingOutputPath,
    extraClients: [{ label: 'runpane-cloud-coordinator', outputPath: coordPath, scope: 'coordinator' }],
    fetchImpl: httpsNeverAnswers, remoteTransport: invoke.transport, autoHttpsWaitMs: 10,
    onStep: (step) => { if (step.state === 'done') seen.push(`${step.step}:${step.detail ?? ''}`); },
  });

  const httpBase = 'http://rp-k3j9x0q2.tailnet-example.ts.net:42137';
  assert.equal(result.transport, 'http');
  assert.equal(result.baseUrl, httpBase);
  assert.ok(seen.some((line) => line.startsWith('cert-check:') && line.includes('rate limit')), seen.join('\n'));
  // Both pairing codes now point at the http address with their own tokens, and the repo is registered through it.
  assert.equal(decodePairingCode(fs.readFileSync(pairingOutputPath, 'utf8')).baseUrl, httpBase);
  assert.equal(decodePairingCode(fs.readFileSync(pairingOutputPath, 'utf8')).token, PAIRING_TOKEN);
  assert.equal(decodePairingCode(fs.readFileSync(coordPath, 'utf8')).baseUrl, httpBase);
  assert.equal(invoke.requests[0].url, `${httpBase}/invoke`);
  assert.deepEqual(sandbox.steps.find((step) => step[0] === 'serve-guard')?.slice(1), ['http']);
});

test('auto transport switches when HTTPS stays down but the daemon answers on loopback, even without a logged 429', async () => {
  const httpsNeverAnswers: typeof fetch = async (input) =>
    String(input).startsWith('https://') ? new Response('', { status: 502 }) : healthyFetch(input);
  const sandbox = new FakeSandbox();
  const result = await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: httpsNeverAnswers, healthTimeoutMs: 50, autoHttpsWaitMs: 5,
  });
  assert.equal(result.transport, 'http');
});

test('auto transport does not switch when the daemon itself is down, and https never switches', async () => {
  const notReady: typeof fetch = async () => new Response('bad gateway', { status: 502 });
  const sandbox = new FakeSandbox();
  sandbox.localHealthy = false;
  await assert.rejects(provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: notReady, healthTimeoutMs: 10, autoHttpsWaitMs: 5,
  }), /https:\/\/rp-k3j9x0q2\.tailnet-example\.ts\.net\/health not ready.*loopback check failed/);
  assert.ok(!sandbox.steps.some((step) => step[0] === 'serve-http'));

  const strict = new FakeSandbox();
  strict.certRateLimited = true;
  await assert.rejects(provisionSandbox(strict, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: notReady, healthTimeoutMs: 10, transport: 'https',
  }), /not ready/);
  assert.ok(!strict.steps.some((step) => step[0] === 'cert-status' || step[0] === 'serve-http'));
});

test('http transport serves plain HTTP inside the tailnet from the start', async () => {
  const sandbox = new FakeSandbox();
  const result = await provisionSandbox(sandbox, {
    sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
    pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: healthyFetch, transport: 'http',
  });
  assert.equal(result.baseUrl, 'http://rp-k3j9x0q2.tailnet-example.ts.net:42137');
  assert.ok(!sandbox.steps.some((step) => step[0] === 'cert-status'));
});

test('provisionSandbox fails with a diagnosis when /health never gets ready', async () => {
  const notReady: typeof fetch = async () => new Response('bad gateway', { status: 502 });
  await assert.rejects(
    provisionSandbox(new FakeSandbox(), {
      sessionId: 'k3j9x0q2m1', label: 'x', tailscale: new FakeTailscale(), paneSource: { kind: 'preinstalled' },
      pairingOutputPath: path.join(tempDir(), 'p'), fetchImpl: notReady, healthTimeoutMs: 10,
    }),
    /last HTTP 502; in-sandbox loopback check ok/,
  );
});

test('reenrolSandbox deletes the old device before wiping state, and keeps the name', async () => {
  const sandbox = new FakeSandbox();
  sandbox.state = { ...sandbox.state, joined: true, hostname: 'rp-k3j9x0q2' };
  const tailscale = new FakeTailscale();
  tailscale.devices = [device('nOLD11CNTRL', 'rp-k3j9x0q2')];

  const result = await reenrolSandbox(sandbox, { hostname: 'rp-k3j9x0q2', oldNodeId: 'nOLD11CNTRL', tailscale });

  assert.deepEqual(result.deletedNodeIds, ['nOLD11CNTRL']);
  assert.deepEqual(tailscale.log, ['delete nOLD11CNTRL', 'mint']);
  assert.deepEqual(sandbox.steps.map((step) => step[0]), ['tailscale-reset', 'tailscale-up', 'serve-restore']);
  assert.equal(result.magicDnsName, 'rp-k3j9x0q2.tailnet-example.ts.net');
});

test('reenrolSandbox leaves a differently tagged device alone and stops before wiping state', async () => {
  const sandbox = new FakeSandbox();
  sandbox.state = { ...sandbox.state, joined: true, hostname: 'rp-k3j9x0q2' };
  const tailscale = new FakeTailscale();
  tailscale.devices = [device('nOLD11CNTRL', 'rp-k3j9x0q2'), { ...device('nSERVER', 'rp-k3j9x0q2'), tags: ['tag:server'] }];

  await assert.rejects(reenrolSandbox(sandbox, { hostname: 'rp-k3j9x0q2', oldNodeId: 'nOLD11CNTRL', tailscale }),
    /nSERVER, tags tag:server/u);
  assert.deepEqual(tailscale.deleted, []);
  assert.deepEqual(sandbox.steps.map((step) => step[0]), []);
});

test('step results parse from the last RP_RESULT line and errors are redacted', () => {
  assert.deepEqual(parseStepResult('x\nRP_RESULT {"ok":false}\nRP_RESULT {"ok":true}\n'), { ok: true });
  assert.equal(parseStepResult('no result'), undefined);
  assert.equal(parseStepResult('RP_RESULT [1]'), undefined);
  assert.equal(redact(`code ${PAIRING} key ${AUTH_KEY}`), 'code <pairing-redacted> key <tskey-redacted>');
});
