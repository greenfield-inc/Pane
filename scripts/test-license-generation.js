#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Exercise the CLI against installed package fixtures, without changing workspace dependencies.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notices-'));
try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, 'generate-notices.js'), path.join(root, 'scripts/generate-notices.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: '1.0.0', author: {name: 'Pane Author'}, license: 'MIT'}));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Pane license text');
  for (const [name, license, text] of [
    ['alpha', 'MIT', 'Copyright Alpha. Permission granted.'],
    ['beta', 'MIT', 'Copyright Beta. Permission granted.'],
    ['alpha-copy', 'MIT', 'Copyright Alpha. Permission granted.'],
    ['free-package', 'Unlicense', 'Public domain fixture'],
  ]) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license}));
    fs.writeFileSync(path.join(dir, 'LICENSE'), text);
  }
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-notices.js')], {stdio: 'pipe'});
  const notices = fs.readFileSync(path.join(root, 'NOTICES'), 'utf8');
  assert.ok(notices.includes('Copyright Beta. Permission granted.'), 'each package copyright is preserved');
  assert.equal(notices.split('Copyright Alpha. Permission granted.').length - 1, 1, 'identical license texts are deduplicated');
  assert.ok(notices.includes('alpha-copy'), 'every package remains attributed');
  assert.ok(!notices.includes('free-package'), 'Unlicense exclusion is case insensitive');
  assert.ok(notices.includes('Author: Pane Author'), 'structured author names render as text');
  console.log('License generation behavior passed');
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
