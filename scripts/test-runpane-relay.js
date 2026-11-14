// `runpane relay` runs the pane-relay binary from its platform package, installed beside runpane the
// way npm installs an optional dependency. PANE_RELAY_BIN names the binary; without it, cargo builds relay/.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
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

function run(cli, args) {
  const child = spawn(process.execPath, [cli, 'relay', ...args], {
    env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' },
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

test('runpane relay says how to get pane-relay when its package is not installed', async () => {
  const cli = install(null);
  const { code, stderr } = await run(cli, ['--dev']).ended;
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`its package ${relayPackage} is not installed beside this runpane\\. Nothing was started\\.`));
  assert.match(stderr, /Next: Run npx --yes runpane@latest relay <flags>/);
});
