// `runpane relay` runs the pane-relay binary from its platform package, installed beside runpane the
// way npm installs an optional dependency, or else downloads it from the release.
// PANE_RELAY_BIN names the binary; without it, cargo builds relay/.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const exe = process.platform === 'win32' ? 'pane-relay.exe' : 'pane-relay';
const relayPackage = `@runpane/relay-${process.platform}-${process.arch}`;

function relayBinary() {
  if (process.env.PANE_RELAY_BIN) return process.env.PANE_RELAY_BIN;
  const messages = execFileSync('cargo', ['build', '--locked', '--manifest-path', path.join(root, 'relay', 'Cargo.toml'), '--bin', 'pane-relay', '--message-format=json-render-diagnostics'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const built = messages.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((message) => message.reason === 'compiler-artifact' && message.target?.name === 'pane-relay' && message.executable);
  assert.ok(built, 'cargo build did not report a pane-relay executable');
  return built.executable;
}

/** An npm prefix holding this build of runpane, and its relay package when `binary` is given. */
function install(binary) {
  const modules = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-relay-')), 'node_modules');
  const runpane = path.join(modules, 'runpane');
  fs.cpSync(path.join(root, 'packages', 'runpane', 'dist'), path.join(runpane, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(root, 'packages', 'runpane', 'package.json'), path.join(runpane, 'package.json'));
  if (binary) {
    const pkg = path.join(modules, ...relayPackage.split('/'));
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: relayPackage, version: '0.0.0' }));
    fs.copyFileSync(binary, path.join(pkg, 'bin', exe));
    fs.chmodSync(path.join(pkg, 'bin', exe), 0o755);
  }
  return path.join(runpane, 'dist', 'cli.js');
}

function run(cli, args, env = {}) {
  const child = spawn(process.execPath, [cli, 'relay', ...args], {
    env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, ended };
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    // --dev serves a self-signed certificate.
    https.get({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

async function waitForHealth(port, ended) {
  const deadline = Date.now() + 30_000;
  let exited = false;
  ended.then(() => { exited = true; });
  for (;;) {
    try {
      return await getHealth(port);
    } catch (error) {
      if (exited) throw new Error(`runpane relay exited before /healthz answered: ${(await ended).stderr}`);
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test('runpane relay starts pane-relay with its flags and stops it with SIGTERM', async () => {
  const cli = install(relayBinary());
  const port = await freePort();
  const { child, ended } = run(cli, ['--dev', '--listen', `127.0.0.1:${port}`]);
  try {
    const health = await waitForHealth(port, ended);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, region: 'us', computers: 0 });
  } finally {
    child.kill('SIGTERM');
  }
  const { code, signal, stdout, stderr } = await ended;
  if (process.platform !== 'win32') {
    // runpane forwarded SIGTERM, pane-relay logged its shutdown, and runpane returned its exit code.
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
    assert.match(stdout, /shutting down/);
  }
});

test("runpane relay exits with pane-relay's exit code", async () => {
  const cli = install(relayBinary());
  const { code, stderr } = await run(cli, ['--no-such-flag']).ended;
  assert.equal(code, 2);
  assert.match(stderr, /--no-such-flag/);
});

/** A release folder served over http, as GitHub serves a release's assets, and a fresh cache. */
async function release(files) {
  const server = http.createServer((request, response) => {
    const body = files[path.basename(request.url)];
    response.writeHead(body === undefined ? 404 : 200).end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    env: {
      RUNPANE_RELAY_RELEASE_URL: `http://127.0.0.1:${server.address().port}/download/`,
      XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-relay-cache-')),
      LOCALAPPDATA: '',
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const asset = `pane-relay-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;

test('runpane relay downloads, verifies and caches the release binary when its package is not installed', async () => {
  const binary = fs.readFileSync(relayBinary());
  const sha = crypto.createHash('sha256').update(binary).digest('hex');
  const served = await release({ [asset]: binary, 'pane-relay-sha256.txt': `${'0'.repeat(64)}  pane-relay-other\n${sha}  ${asset}\n` });
  const cli = install(null);
  let first;
  try {
    first = await run(cli, ['--no-such-flag'], served.env).ended;
  } finally {
    await served.close();
  }
  // pane-relay itself ran and rejected the flag.
  assert.equal(first.code, 2, first.stderr);
  assert.match(first.stderr, /SHA-256 matches the release/);
  assert.match(first.stderr, /--no-such-flag/);
  // With the release gone, the cached binary runs.
  const second = await run(cli, ['--no-such-flag'], served.env).ended;
  assert.equal(second.code, 2, second.stderr);
  assert.doesNotMatch(second.stderr, /downloading/);
});

test('runpane relay refuses a downloaded binary whose SHA-256 differs from the release list', async () => {
  const served = await release({ [asset]: Buffer.from('not the relay'), 'pane-relay-sha256.txt': `${'a'.repeat(64)}  ${asset}\n` });
  try {
    const { code, stderr } = await run(install(null), ['--dev'], served.env).ended;
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`its SHA-256 is [0-9a-f]{64} and pane-relay-sha256\\.txt lists ${'a'.repeat(64)}\\. It was deleted without running\\.`));
    assert.deepEqual(fs.readdirSync(served.env.XDG_CACHE_HOME, { recursive: true }).filter((name) => name.includes('pane-relay')), []);
  } finally {
    await served.close();
  }
});

test('runpane relay says what failed when the release has no binary for it', async () => {
  const served = await release({});
  try {
    const { code, stderr } = await run(install(null), ['--dev'], served.env).ended;
    assert.equal(code, 1);
    assert.match(stderr, /could not download pane-relay .* pane-relay-sha256\.txt: HTTP 404\. Nothing was started or saved\./);
    assert.match(stderr, /Next: .*ghcr\.io\/greenfield-inc\/pane-relay/);
  } finally {
    await served.close();
  }
});

test('runpane relay init prints the records, settings and start command for a domain', async () => {
  // Nothing answers DNS on this port, so every check fails and init exits 1.
  const { code, stdout } = await run(install(null), ['init', '--domain', 'Relay.Example.com.', '--public-ip', '203.0.113.10', '--resolver', `127.0.0.1:${await freePort()}`]).ended;
  assert.equal(code, 1);
  assert.match(stdout, /Add these two records at the DNS provider for example\.com:/);
  assert.match(stdout, /^ +relay-ns\.example\.com +A +203\.0\.113\.10$/m);
  assert.match(stdout, /^ +relay\.example\.com +NS +relay-ns\.example\.com$/m);
  assert.match(stdout, /printf '%s\\n' PANE_RELAY_DOMAIN=relay\.example\.com PANE_RELAY_PUBLIC_IP=203\.0\.113\.10 PANE_RELAY_NS=relay-ns\.example\.com > \.env/);
  assert.match(stdout, /Relay address: relay\.example\.com$/m);
  assert.match(stdout, /✗ relay\.example\.com NS relay-ns\.example\.com: /);
});

test('runpane relay init refuses a domain with no name of its own', async () => {
  const { code, stderr } = await run(install(null), ['init', '--domain', 'example.com', '--public-ip', '203.0.113.10']).ended;
  assert.equal(code, 1);
  assert.match(stderr, /"example\.com" is not a subdomain such as relay\.example\.com/);
});
