#!/usr/bin/env node
// Merging the per-arch latest-mac.yml files must reproduce what a single
// two-arch electron-builder run published for v2.4.201.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'merge-mac-latest.js');
const fixtures = path.join(__dirname, 'fixtures', 'latest-mac');
const fixture = (name) => path.join(fixtures, name);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-mac-latest-'));

try {
  const output = path.join(outDir, 'latest-mac.yml');
  execFileSync('node', [script, fixture('v2.4.201-arm64.yml'), fixture('v2.4.201-x64.yml'), output]);
  assert.equal(fs.readFileSync(output, 'utf8'), fs.readFileSync(fixture('v2.4.201-released.yml'), 'utf8'));

  const swapped = spawnSync('node', [script, fixture('v2.4.201-x64.yml'), fixture('v2.4.201-arm64.yml'), output], { encoding: 'utf8' });
  assert.notEqual(swapped.status, 0);
  assert.match(swapped.stderr, /macOS-arm64\.zip/);

  const otherVersion = path.join(outDir, 'x64-other-version.yml');
  fs.writeFileSync(otherVersion, fs.readFileSync(fixture('v2.4.201-x64.yml'), 'utf8').replace('version: 2.4.201', 'version: 2.4.202'));
  const mismatch = spawnSync('node', [script, fixture('v2.4.201-arm64.yml'), otherVersion, output], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Version mismatch/);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log('latest-mac.yml merge checks passed');
