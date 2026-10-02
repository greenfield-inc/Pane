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
  fs.cpSync(path.join(__dirname, 'license-texts'), path.join(root, 'scripts/license-texts'), {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: '1.0.0', author: {name: 'Pane Author'}, license: 'MIT'}));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Pane license text');
  for (const [name, license, text] of [
    ['alpha', 'MIT', 'Copyright Alpha. Permission granted.'],
    ['beta', 'MIT', 'Copyright Beta. Permission granted.'],
    ['alpha-copy', 'MIT', 'Copyright Alpha. Permission granted.'],
    ['missing-mit', 'MIT', null],
    ['missing-isc', 'ISC', null],
    ['missing-bsd', 'BSD-2-Clause', null],
    ['missing-apache', 'Apache-2.0', null],
    ['missing-lgpl', 'LGPL-3.0-or-later', null],
    ['unknown-license', 'LicenseRef-Fixture', null],
    ['free-package', 'Unlicense', 'Public domain fixture'],
  ]) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, {recursive: true});
    const metadata = {name, version: '1.0.0', license};
    if (name === 'missing-mit') metadata.copyright = 'Copyright 2026 Fixture Maintainers';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata));
    if (text) fs.writeFileSync(path.join(dir, 'LICENSE'), text);
  }
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-notices.js')], {stdio: 'pipe'});
  const notices = fs.readFileSync(path.join(root, 'NOTICES'), 'utf8');
  assert.ok(notices.includes('Copyright Beta. Permission granted.'), 'each package copyright is preserved');
  assert.equal(notices.split('Copyright Alpha. Permission granted.').length - 1, 1, 'identical license texts are deduplicated');
  assert.ok(notices.includes('alpha-copy'), 'every package remains attributed');
  assert.ok(!notices.includes('free-package'), 'Unlicense exclusion is case insensitive');
  assert.ok(notices.includes('Author: Pane Author'), 'structured author names render as text');
  const fallback = notices.split('Package: missing-mit\n')[1].split('--------------------------------------------------------------------------------')[0];
  assert.ok(fallback.includes('Permission is hereby granted, free of charge'), 'missing license files still include the declared license terms');
  assert.ok(fallback.includes('Copyright notice: Copyright 2026 Fixture Maintainers'), 'supplied package copyright metadata is preserved');
  assert.ok(fallback.includes('Standard SPDX license terms for MIT'), 'fallback terms are identified separately from package license files');
  assert.ok(!fallback.includes('Copyright Alpha'), 'fallback never borrows another package copyright');
  for (const [name, clause] of [
    ['missing-isc', 'Permission to use, copy, modify, and/or distribute'],
    ['missing-bsd', 'Redistributions of source code must retain'],
    ['missing-apache', 'Grant of Patent License'],
    ['missing-lgpl', 'Combined Works'],
  ]) {
    const section = notices.split(`Package: ${name}\n`)[1].split('--------------------------------------------------------------------------------')[0];
    assert.ok(section.includes(clause), `${name} includes the declared license terms`);
  }
  const lgpl = notices.split('Package: missing-lgpl\n')[1].split('--------------------------------------------------------------------------------')[0];
  assert.ok(lgpl.includes('Conveying Non-Source Forms'), 'LGPL fallback includes the incorporated GPL terms');
  assert.equal(lgpl.split('GNU GENERAL PUBLIC LICENSE').length - 1, 1, 'incorporated GPL terms appear once');
  assert.ok(notices.includes('no standard fallback is bundled for this declaration'), 'unsupported declarations are reported without guessing license terms');
  console.log('License generation behavior passed');
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
