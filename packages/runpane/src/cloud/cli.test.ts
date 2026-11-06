import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudCreateOptions, CloudCredentialsInput, CloudSandboxes, CloudSandboxInfo } from './api';
import { runCloud } from './cli';

const INFO: CloudSandboxInfo = {
  hostname: 'rp-abc12345', label: 'Cloud', profileId: 'cloud-abc12345', sessionId: 'abc12345', sandboxId: 'bx_1',
  state: 'running', providerState: 'idle', baseUrl: 'https://rp-abc12345.tail1234.ts.net', transport: 'https', createdAt: '2026-10-01T00:00:00.000Z',
};

function harness(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const setups: CloudCredentialsInput[] = [];
  const creates: CloudCreateOptions[] = [];
  const cloud: CloudSandboxes = {
    async setup(input) {
      setups.push(input);
      return { boat: { configured: true }, tailscale: { configured: true }, claude: { configured: false }, github: { configured: false }, ready: true };
    },
    getCredentialsStatus: async () => ({ boat: { configured: false }, tailscale: { configured: false }, claude: { configured: false }, github: { configured: false }, ready: false }),
    async create(options = {}, onProgress) {
      creates.push(options);
      onProgress?.({ step: 'sandbox', message: 'Creating a default sandbox rp-abc12345...' });
      return INFO;
    },
    list: async () => [INFO],
    status: async () => INFO,
    async stop(host) {
      calls.push(`stop ${host}`);
      return { ...INFO, state: 'stopped' };
    },
    async start(host) {
      calls.push(`start ${host}`);
      return INFO;
    },
    async update(host, pane) {
      calls.push(`update ${host} ${pane.debUrl}`);
      return INFO;
    },
    async remove(host) {
      calls.push(`remove ${host}`);
    },
    syncAgentDefaults: async () => INFO,
    runStartupScript: async () => null,
    readStartupLog: async () => '',
  };
  const io = {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    readSecret: async (file: string) => (file === '-' ? 'from-stdin\n' : `contents of ${file}\n`),
    env,
  };
  return { run: (argv: string[]) => runCloud(argv, io, cloud), out, err, calls, setups, creates };
}

test('setup reads secrets from files or stdin, never from arguments', async () => {
  const h = harness();
  assert.equal(await h.run(['setup', '--boat-key-file', '-', '--boat-org', 'test', '--tailscale-client-id', 'cid', '--tailscale-secret-file', '/tmp/ts']), 0);
  assert.deepEqual(h.setups[0], {
    boatApiKey: 'from-stdin', boatOrg: 'test', tailscaleClientId: 'cid', tailscaleClientSecret: 'contents of /tmp/ts', tailnet: undefined, claudeToken: undefined,
  });
  assert.doesNotMatch(h.out.join('\n'), /from-stdin|contents of/u);
  await assert.rejects(h.run(['setup', '--boat-key', 'inline-secret']), /Unknown option for runpane cloud setup: --boat-key/u);
});

test('commands that bill or delete need --yes', async () => {
  const h = harness();
  await assert.rejects(h.run(['new']), /creates a billed cloud sandbox. Rerun with --yes/u);
  await assert.rejects(h.run(['stop', 'rp-abc12345']), /--yes/u);
  await assert.rejects(h.run(['remove', 'rp-abc12345']), /--yes/u);
  assert.deepEqual(h.calls, []);
  assert.equal(await h.run(['stop', 'rp-abc12345', '--yes']), 0);
  assert.equal(await h.run(['start', 'rp-abc12345']), 0);
  assert.equal(await h.run(['remove', 'rp-abc12345', '--yes']), 0);
  assert.deepEqual(h.calls, ['stop rp-abc12345', 'start rp-abc12345', 'remove rp-abc12345']);
});

test('new passes its options through and a .deb needs its sha256', async () => {
  const h = harness();
  await assert.rejects(h.run(['new', '--yes', '--pane-deb-url', 'https://example.com/pane.deb']), /needs --pane-deb-sha256/u);
  await assert.rejects(h.run(['new', '--yes', '--size', 'huge']), /--size must be one of small, default, large/u);
  assert.equal(await h.run(['new', '--yes', '--json', '--label', 'Cloud', '--boat-org', 'test', '--transport', 'http',
    '--pane-deb-url', 'https://example.com/pane.deb', '--pane-deb-sha256', 'a'.repeat(64)]), 0);
  assert.deepEqual(h.creates[0], {
    label: 'Cloud', size: undefined, boatOrg: 'test', transport: 'http',
    paneSource: { kind: 'deb-url', url: 'https://example.com/pane.deb', sha256: 'a'.repeat(64) }, keepOnFailure: false, namePrefix: undefined,
  });
  // --json keeps stdout one JSON document; progress goes to stderr.
  assert.equal(JSON.parse(h.out.join('\n')).sandbox.hostname, 'rp-abc12345');
  assert.deepEqual(h.err, ['Creating a default sandbox rp-abc12345...']);
});

test('update needs the .deb URL and sha256; host commands need a host', async () => {
  const h = harness();
  await assert.rejects(h.run(['update', 'rp-abc12345', '--yes']), /needs --pane-deb-url <url> and --pane-deb-sha256 <hex>/u);
  await assert.rejects(h.run(['status']), /needs a host/u);
  assert.equal(await h.run(['update', 'rp-abc12345', '--yes', '--pane-deb-url', 'https://example.com/p.deb', '--pane-deb-sha256', 'b'.repeat(64)]), 0);
  assert.deepEqual(h.calls, ['update rp-abc12345 https://example.com/p.deb']);
});

test('list prints a table', async () => {
  const h = harness();
  assert.equal(await h.run(['list']), 0);
  assert.match(h.out[0], /^HOST\s+LABEL\s+STATE\s+SIZE\s+WALLET\s+URL\nrp-abc12345\s+Cloud\s+running\s+-\s+-\s+https:\/\/rp-abc12345\.tail1234\.ts\.net$/u);
});
