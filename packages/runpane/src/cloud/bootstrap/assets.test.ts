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
