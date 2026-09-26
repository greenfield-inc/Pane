const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

function buildFixture(failDownload) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-win-build-'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'dist-electron', 'win-arm64-unpacked'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'build-win.js'), path.join(directory, 'scripts', 'build-win.js'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { '@lydell/node-pty': '9.8.7' } }));
  fs.writeFileSync(path.join(directory, 'scripts', 'verify-packaged-icon.js'), 'exports.verifyPackedApp = () => {};');
  fs.writeFileSync(path.join(directory, 'hooks.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'glob') return { globSync: () => [] };
  return load.call(this, name, ...args);
};
require('node:os').arch = () => 'x64';
require('node:child_process').execSync = command => {
  fs.appendFileSync(path.join(__dirname, 'commands.jsonl'), JSON.stringify(command) + '\\n');
  if (command.startsWith('npm pack ')) {
    if (${failDownload}) throw new Error('fixture download failed');
    fs.writeFileSync(path.join(__dirname, 'tmp-arm64', 'pty.tgz'), 'fixture');
  }
};
`);
  return directory;
}

for (const failDownload of [true, false]) {
  test(failDownload ? 'Windows cross-build stops when the terminal backend download fails' : 'Windows cross-build downloads the declared terminal backend version', () => {
    const directory = buildFixture(failDownload);
    try {
      const result = spawnSync(process.execPath, ['--require', './hooks.cjs', 'scripts/build-win.js', 'arm64'], {
        cwd: directory, encoding: 'utf8', timeout: 5000,
      });
      const commands = fs.readFileSync(path.join(directory, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      if (failDownload) {
        assert.notEqual(result.status, 0, 'a missing cross-arch terminal backend must fail the build');
        assert.ok(!commands.some(command => command.includes('build:frontend') || command.includes('electron-builder')),
          'packaging must not begin after terminal backend installation fails');
        assert.match(result.stderr, /fixture download failed/);
        assert.equal(fs.existsSync(path.join(directory, 'tmp-arm64')), false, 'failed downloads must be cleaned up');
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(commands.find(command => command.startsWith('npm pack ')), /@lydell\/node-pty-win32-arm64@9\.8\.7 /);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await pause(20);
  }
  return false;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function terminate(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* Fixture may already have exited. */ }
}
function quoteShell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function launcherFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-launcher-'));
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: /fixture/main/.git/worktrees/dev\n');
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  for (const folder of ['node_modules', 'frontend/node_modules', 'main/node_modules', 'main/src', 'main/dist/main/src', 'bin']) {
    fs.mkdirSync(path.join(directory, folder), { recursive: true });
  }
  fs.writeFileSync(path.join(directory, 'node_modules', '.electron-rebuild-marker'), 'fixture');
  fs.writeFileSync(path.join(directory, 'main/dist/main/src/preload.js'), 'require("electron");');
  fs.utimesSync(path.join(directory, 'package.json'), new Date(0), new Date(0));
  const fakeCli = path.join(directory, 'fake-cli.cjs');
  fs.writeFileSync(fakeCli, `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'wait-on') process.exit(0);
const leaf = args[0] === '--leaf';
const role = leaf ? args[1] + '-leaf' : args.includes('main') ? 'tsc' : args.includes('frontend') ? 'vite' : 'electron';
const ready = () => fs.appendFileSync(path.join(__dirname, 'pids.jsonl'), JSON.stringify({ pid: process.pid, role, port: Number(process.env.VITE_PORT) }) + '\\n');
if (!leaf) spawn(process.execPath, [__filename, '--leaf', role], { stdio: 'ignore' });
if (role === 'vite') require('node:net').createServer().listen(Number(process.env.VITE_PORT), ready);
else ready();
if (role === 'tsc') console.log('Watching for file changes.');
setInterval(() => {
  if (role === 'electron' && fs.existsSync(path.join(__dirname, 'close-electron'))) process.exit(0);
}, 20);
`);
  for (const command of ['pnpm', 'npx']) {
    fs.writeFileSync(path.join(directory, 'bin', command), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(fakeCli)} "$@"\n`, { mode: 0o755 });
  }
  return directory;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const shutdown of ['SIGTERM', 'SIGHUP', 'electron-exit']) {
  test(`dev launcher stops watchers and descendants on ${shutdown}`, { skip: process.platform === 'win32', timeout: 12000 }, async () => {
    const directory = launcherFixture();
    const pidFile = path.join(directory, 'pids.jsonl');
    const records = () => fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const env = { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}` };
    delete env.PORT;
    delete env.VITE_PORT;
    const requestedPort = shutdown === 'SIGTERM' ? await availablePort() : undefined;
    if (requestedPort) env.VITE_PORT = String(requestedPort);
    const launcher = spawn(process.execPath, [path.join(root, 'scripts/pane-run-script.js')], {
      cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    launcher.stdout.on('data', data => { output += data; });
    launcher.stderr.on('data', data => { output += data; });
    const exited = new Promise(resolve => launcher.once('exit', code => resolve(code)));
    try {
      assert.ok(await waitFor(() => records().length === 6), `Fixture children did not start: ${output}`);
      if (requestedPort) assert.equal(records().find(record => record.role === 'vite').port, requestedPort, 'explicit VITE_PORT must reach the dev server');
      if (shutdown !== 'electron-exit') launcher.kill(shutdown);
      else fs.writeFileSync(path.join(directory, 'close-electron'), 'close');
      assert.equal(await exited, 0, output);
      assert.ok(await waitFor(() => records().every(record => !alive(record.pid))),
        `Orphaned fixture processes: ${records().filter(record => alive(record.pid)).map(record => record.role).join(', ')}`);
    } finally {
      terminate(launcher.pid);
      terminate(-launcher.pid);
      for (const record of records()) terminate(record.pid);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const configName of ['playwright.config.ts', 'playwright.ci.config.ts', 'playwright.ci.minimal.config.ts']) {
  test(`${configName} shuts down the dev process groups after its tests finish`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const directory = launcherFixture();
    const pidFile = path.join(directory, 'pids.jsonl');
    const records = () => fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const port = await availablePort();
    const launcherPidFile = path.join(directory, 'launcher.pid');
    const entry = `require('node:fs').writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid)); require(${JSON.stringify(path.join(root, 'scripts/pane-run-script.js'))});`;
    fs.writeFileSync(path.join(directory, 'playwright.config.cjs'), `
const base = require(${JSON.stringify(path.join(root, configName))}).default;
module.exports = {
  ...base, testDir: __dirname, testMatch: 'fixture.spec.cjs', outputDir: 'results',
  reporter: 'line', retries: 0, workers: 1,
  webServer: { ...base.webServer, cwd: __dirname, port: ${port}, reuseExistingServer: false,
    command: ${JSON.stringify(`${quoteShell(process.execPath)} -e ${quoteShell(entry)}`)},
    env: { VITE_PORT: '${port}', PORT: '${port}' }, timeout: 5000 },
};
`);
    fs.writeFileSync(path.join(directory, 'fixture.spec.cjs'), `
const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
const fs = require('node:fs');
test('fixture services are ready', async () => {
  await expect.poll(() => fs.existsSync(${JSON.stringify(pidFile)}) ? fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim().split('\\n').length : 0).toBe(6);
});
`);
    const runner = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(directory, 'playwright.config.cjs')], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}` },
    });
    let output = '';
    runner.stdout.on('data', data => { output += data; });
    runner.stderr.on('data', data => { output += data; });
    try {
      assert.ok(await waitFor(() => runner.exitCode !== null || runner.signalCode !== null, 10000), `Playwright teardown did not finish: ${output}`);
      assert.equal(runner.exitCode, 0, output);
      assert.equal(records().length, 6, 'the fixture must exercise every dev process and descendant');
      assert.ok(await waitFor(() => records().every(record => !alive(record.pid))), 'Playwright must leave no dev process behind');
    } finally {
      terminate(runner.pid);
      terminate(-runner.pid);
      if (fs.existsSync(launcherPidFile)) terminate(Number(fs.readFileSync(launcherPidFile, 'utf8')));
      for (const record of records()) terminate(record.pid);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
