import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';

// SAFETY: Object.keys of the generated const record returns exactly its asset names.
const names = Object.keys(cloudBootstrapAssets) as CloudBootstrapAssetName[];

test('every embedded asset is valid bash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, cloudBootstrapAssets[name]);
    const result = childProcess.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('the bootstrap never enables Tailscale SSH and never mv-s into kept paths', () => {
  for (const name of names) {
    const text = cloudBootstrapAssets[name];
    assert.ok(!/tailscale up[^\n]*--ssh(?!=false)/.test(text), `${name} must not run tailscale up --ssh`);
    assert.ok(!/^\s*(sudo )?mv /m.test(text), `${name} must not mv files (an mv into kept paths arrives empty after a boat restore)`);
  }
});

test('an unknown step fails with a parsable result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const result = childProcess.spawnSync('bash', [file, 'nope'], {
    encoding: 'utf8',
    env: { ...process.env, RP_STATE: path.join(dir, 'state') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RP_RESULT \{"ok": false, "error": "unknown step 'nope'"\}$/m);
});

// Wake: the CLI's repair runs tailnet-identity while the resumed box is still booting, and re-enrols the
// node unless it reports Running. Seen live: first an empty status (json.loads('')
// threw, the wake exited 1), and with a plain "wait until it answers" the transient NoState of tailscaled's
// first second, which re-enrolled a healthy node. The step must wait until the state settles.
test('tailnet-identity waits until tailscaled answers and settles past NoState and Starting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const counter = path.join(dir, 'calls');
  const status = (state: string) => `{"BackendState":"${state}","Self":{"ID":"n1","HostName":"rp-x","DNSName":"rp-x.ts.net.","TailscaleIPs":["100.64.0.1"]}}`;
  // Calls 0-1: no answer; 2-3: NoState; 4: Starting; then Running. Only `status --json` prints.
  const fake = `() { n=$(cat '${counter}' 2>/dev/null || echo 0); echo $((n+1)) > '${counter}'; [ "$1 $2" = "status --json" ] || return 0; `
    + `if [ "$n" -lt 2 ]; then return 1; elif [ "$n" -lt 4 ]; then echo '${status('NoState')}'; elif [ "$n" -lt 5 ]; then echo '${status('Starting')}'; else echo '${status('Running')}'; fi; }`;
  const result = childProcess.spawnSync('bash', [file, 'tailnet-identity'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RP_STATE: path.join(dir, 'state'),
      // Exported functions win over PATH (the script puts /usr/bin first).
      'BASH_FUNC_tailscale%%': fake,
      'BASH_FUNC_sudo%%': '() { "$@"; }',
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RP_RESULT .*"backendState": "Running"/m);
});

// clone <url> <ref> <dir> must land on what origin has now: a failed fetch is a failure, and a branch
// that already exists locally (a retried step, or the clone's own default branch) moves to the fetched commit.
test('clone checks out the freshly fetched commit and fails when the fetch fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const env = {
    ...process.env,
    RP_STATE: path.join(dir, 'state'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost',
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = childProcess.spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const step = (...args: string[]) => childProcess.spawnSync('bash', [file, 'clone', ...args], { env, encoding: 'utf8' });
  const origin = path.join(dir, 'origin');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', origin);
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'one');
  const first = git(origin, 'rev-parse', 'HEAD');
  const target = path.join(dir, 'session', 'app');
  assert.equal(step(origin, '', target).status, 0);
  git(target, 'branch', 'gone');

  git(origin, 'commit', '-q', '--allow-empty', '-m', 'two');
  const second = git(origin, 'rev-parse', 'HEAD');
  const moved = step(origin, 'main', target);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, new RegExp(`^RP_RESULT .*"head": "${second}"`, 'm'));
  assert.equal(git(target, 'rev-parse', 'HEAD'), second);
  assert.equal(git(target, 'symbolic-ref', '--short', 'HEAD'), 'main');

  const pinned = step(origin, first, target);
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
  assert.equal(git(target, 'rev-parse', 'HEAD'), first);

  // A ref origin doesn't have, and an origin that is gone, fail even though a local branch has the name.
  const missing = step(origin, 'gone', target);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^RP_RESULT \{"ok": false, "error": "git fetch of gone failed/m);
  fs.renameSync(origin, work);
  const offline = step(origin, 'main', target);
  assert.equal(offline.status, 1);
  assert.match(offline.stdout, /^RP_RESULT \{"ok": false, "error": "git fetch of main failed/m);
});

// install-pane deb-url downloads only over https, and curl may not follow a redirect to anything else.
test('install-pane refuses a non-https .deb URL and never lets curl downgrade the protocol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const calls = path.join(dir, 'curl-calls');
  const env = {
    ...process.env,
    RP_STATE: path.join(dir, 'state'),
    'BASH_FUNC_curl%%': `() { printf '%s\\n' "$*" >> '${calls}'; return 22; }`,
    'BASH_FUNC_systemctl%%': '() { return 1; }',
  };
  const install = (url: string) => childProcess.spawnSync('bash', [file, 'install-pane', 'deb-url', url, '', '', 'x'], { env, encoding: 'utf8' });

  const plain = install('http://example.test/pane.deb');
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /^RP_RESULT \{"ok": false, "error": "the Pane .deb URL must be https/m);
  assert.ok(!fs.existsSync(calls), 'curl ran for an http URL');

  const secure = install('https://example.test/pane.deb');
  assert.equal(secure.status, 1);
  assert.match(secure.stdout, /download of the Pane .deb failed/);
  const [args] = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(args, /--proto =https --proto-redir =https /);
  assert.ok(args.endsWith(' https://example.test/pane.deb'), args);

  for (const name of names) {
    for (const line of cloudBootstrapAssets[name].split('\n').filter((candidate) => /^\s*[^#]*\bcurl /.test(candidate))) {
      if (/https?:\/\/127\.0\.0\.1[:/]/.test(line)) continue;
      assert.match(line, /--proto =https --proto-redir =https/, `${name}: ${line.trim()}`);
    }
  }
});

// pin-pane writes the only .deb runpane:cloud:upgrade will install, as root:root 0644, and --clear removes it.
test('pin-pane writes a root-owned pin the daemon can read, and refuses a malformed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const pinFile = path.join(dir, 'etc', 'pane-pin.json');
  const chowns = path.join(dir, 'chowns');
  const env = {
    ...process.env,
    RP_STATE: path.join(dir, 'state'),
    RP_PANE_PIN: pinFile,
    // The test is not root: record the chown instead of running it.
    'BASH_FUNC_sudo%%': `() { if [ "$1" = chown ]; then printf '%s\\n' "$*" >> '${chowns}'; else "$@"; fi; }`,
  };
  const pin = (...args: string[]) => childProcess.spawnSync('bash', [file, 'pin-pane', ...args], { env, encoding: 'utf8' });
  const sha = 'a'.repeat(64);

  const written = pin('2.4.142', 'https://example.test/pane.deb', sha);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(pinFile, 'utf8')), { version: '2.4.142', url: 'https://example.test/pane.deb', sha256: sha });
  assert.equal(fs.statSync(pinFile).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(chowns, 'utf8').trim(), `chown root:root ${pinFile}`);

  for (const [args, error] of [
    [['2.4.142', 'http://example.test/pane.deb', sha], 'the .deb URL must be https'],
    [['2.4.142', 'https://example.test/pane.deb', 'ABC'], 'sha256 must be 64 lowercase hex'],
    [['2.4.142; reboot', 'https://example.test/pane.deb', sha], 'bad version'],
  ]) {
    const refused = pin(...args);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, new RegExp(`^RP_RESULT \\{"ok": false, "error": "pin-pane: ${error}`, 'm'));
  }
  assert.equal(JSON.parse(fs.readFileSync(pinFile, 'utf8')).version, '2.4.142');

  assert.equal(pin('--clear').status, 0);
  assert.ok(!fs.existsSync(pinFile));
});
