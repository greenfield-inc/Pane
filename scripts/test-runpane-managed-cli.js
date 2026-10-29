// npm runpane hands off to a newer Pane-managed CLI, and doctor reports stale installs, through the built package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const dist = path.join(__dirname, '..', 'packages', 'runpane', 'dist');

/** An npm global prefix holding runpane at `version`, linked the way npm links it. */
function npmPrefix(root, version) {
  const prefix = path.join(root, 'npm');
  const lib = process.platform === 'win32' ? prefix : path.join(prefix, 'lib');
  const pkg = path.join(lib, 'node_modules', 'runpane');
  fs.cpSync(dist, path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'runpane', version }));
  const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'runpane.cmd'), '@echo off\r\n');
  else fs.symlinkSync(path.join(pkg, 'dist', 'cli.js'), path.join(bin, 'runpane'));
  return { prefix, bin, cli: path.join(pkg, 'dist', 'cli.js') };
}

/** A Pane data directory whose managed CLI reports its argv, environment and exit code 7; `wait` prints the first SIGTERM or SIGINT and exits 3. */
function paneDir(root, version, name = 'pane') {
  const dir = path.join(root, name);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'runpane.cjs'), [
    '#!/usr/bin/env node',
    `// runpane-version ${version}`,
    "if (process.argv[2] === 'wait') { for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { console.log(signal); process.exit(3); }); console.log('ready'); setInterval(() => {}, 1000); return; }",
    'console.log(JSON.stringify({ managed: true, argv: process.argv.slice(2), paneDir: process.env.PANE_DIR, noHandoff: process.env.RUNPANE_NO_HANDOFF }));',
    'process.exitCode = 7;',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'runpane'), `#!/bin/sh\n# pane-managed-runpane-shim v1\nexec node "$(dirname "$0")/runpane.cjs" "$@"\n`, { mode: 0o755 });
  return { dir, bin };
}

function run(cli, args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, RUNPANE_NO_HANDOFF: '', ...env } });
}

function scratch() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'runpane-managed-'));
}

test('an older npm runpane runs the newer Pane-managed CLI with the same arguments and exit code', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const pane = paneDir(root, '2.4.207');
  const result = run(npm.cli, ['panels', 'list', '--json', '--', 'a b'], { PANE_DIR: pane.dir });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    managed: true, argv: ['panels', 'list', '--json', '--', 'a b'], paneDir: pane.dir, noHandoff: '1',
  });
});

test('--pane-dir picks the managed CLI ahead of PANE_DIR, wherever it appears', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const older = paneDir(root, '2.4.99', 'older');
  const named = paneDir(root, '2.4.207', 'named');
  for (const args of [['--pane-dir', named.dir, '--version'], ['version', `--pane-dir=${named.dir}`]]) {
    const result = run(npm.cli, args, { PANE_DIR: older.dir });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).argv, args);
  }
  assert.equal(run(npm.cli, ['--version', '--', '--pane-dir', named.dir], { PANE_DIR: older.dir }).stdout.trim(), 'runpane 2.4.100');
});

test('npm runpane runs itself when there is no Pane install or it is the newer one', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  assert.equal(run(npm.cli, ['--version'], { PANE_DIR: path.join(root, 'no-pane') }).stdout.trim(), 'runpane 2.4.100');
  const pane = paneDir(root, '2.4.99');
  assert.equal(run(npm.cli, ['--version'], { PANE_DIR: pane.dir }).stdout.trim(), 'runpane 2.4.100');
});

test('npm runpane runs itself when the managed version pin points at removed files', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const pane = paneDir(root, '2.4.207');
  fs.writeFileSync(path.join(pane.bin, 'runpane-override.json'), JSON.stringify({
    version: '2.4.300', entrypoint: path.join(root, 'gone', 'cli.js'), runtime: path.join(root, 'gone', 'node'),
  }));
  const result = run(npm.cli, ['--version'], { PANE_DIR: pane.dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'runpane 2.4.100');
});

test('npm runpane under WSL still hands off to a Windows Pane whose pin holds Windows paths', { skip: process.platform === 'win32' }, () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const pane = paneDir(root, '2.4.207');
  fs.writeFileSync(path.join(pane.bin, 'runpane-override.json'), JSON.stringify({
    version: '2.4.300', entrypoint: 'C:\\Users\\me\\.pane\\bin\\cli\\cli.js', runtime: 'C:\\Program Files\\Pane\\Pane.exe',
  }));
  assert.equal(run(npm.cli, ['--version'], { PANE_DIR: pane.dir }).status, 7);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} to the npm runpane reaches the managed CLI once, and its exit code comes back`, { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const root = scratch();
    const npm = npmPrefix(root, '2.4.100');
    const pane = paneDir(root, '2.4.207');
    const child = spawn(process.execPath, [npm.cli, 'wait'], { env: { ...process.env, RUNPANE_NO_HANDOFF: '', PANE_DIR: pane.dir } });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('ready')) child.kill(signal);
    });
    const status = await new Promise(resolve => child.on('close', resolve));
    assert.equal(status, 3);
    assert.equal(stdout, `ready\n${signal}\n`);
  });
}

test('doctor lists every runpane on PATH and gives the command that updates a stale npm install', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const pane = paneDir(root, '2.4.207');
  const result = run(npm.cli, ['doctor', '--json', '--pane-dir', pane.dir], {
    PANE_DIR: pane.dir,
    RUNPANE_NO_HANDOFF: '1',
    PATH: [npm.bin, pane.bin, path.dirname(process.execPath)].join(path.delimiter),
    RUNPANE_TELEMETRY_DISABLED: '1',
  });
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.cliInstalls.installs.slice(0, 2), [
    { path: path.join(npm.bin, process.platform === 'win32' ? 'runpane.cmd' : 'runpane'), origin: 'npm', version: '2.4.100', npmPrefix: npm.prefix },
    { path: path.join(pane.bin, 'runpane'), origin: 'pane', version: '2.4.207' },
  ]);
  assert.equal(report.cliInstalls.managedVersion, '2.4.207');
  assert.deepEqual(report.cliInstalls.warnings.map(warning => [warning.code, warning.fix]), [
    ['RUNPANE_STALE_INSTALL', `npm i -g --prefix ${npm.prefix} runpane@2.4.207`],
  ]);
});

test('doctor warns when Pane-managed installs on PATH disagree, with the update for the right directory', () => {
  const root = scratch();
  const npm = npmPrefix(root, '2.4.100');
  const pane = paneDir(root, '2.4.207');
  const older = paneDir(root, '2.4.150', 'older');
  const newer = paneDir(root, '2.4.210', 'newer');
  const result = run(npm.cli, ['doctor', '--json', '--pane-dir', pane.dir], {
    PANE_DIR: pane.dir,
    RUNPANE_NO_HANDOFF: '1',
    PATH: [older.bin, pane.bin, newer.bin, path.dirname(process.execPath)].join(path.delimiter),
    RUNPANE_TELEMETRY_DISABLED: '1',
  });
  const report = JSON.parse(result.stdout);
  const shim = process.platform === 'win32' ? 'runpane.cmd' : 'runpane';
  assert.deepEqual(report.cliInstalls.warnings.map(warning => [warning.code, warning.path, warning.fix]), [
    ['RUNPANE_STALE_MANAGED', path.join(older.bin, 'runpane'), `${path.join(older.bin, shim)} update --pane-dir ${older.dir}`],
    ['RUNPANE_MANAGED_BEHIND', path.join(newer.bin, 'runpane'), `${path.join(pane.bin, shim)} update --pane-dir ${pane.dir}`],
  ]);
});
