// runpane workspace machine selection and path routing, driven through the CLI with a fake
// `tailscale` whose status lists the owner's machines. Their MagicDNS names do not resolve,
// so every remote call fails fast and the error text shows where runpane routed it.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'cli.js');
const owner = 31;
const peer = (name, OS, Online, ip, UserID = owner, Tags = null) => ({
  DNSName: `${name}.tail.invalid.`, OS, Online, UserID, Tags, TailscaleIPs: [ip],
});
const status = {
  BackendState: 'Running',
  Self: peer('parsas-macbook-pro', 'macOS', true, '100.64.0.1'),
  Peer: {
    a: peer('parsa-devbox', 'windows', true, '100.64.0.2'),
    b: peer('parsa-devbox-old', 'windows', false, '100.64.0.3'),
    c: peer('build-server', 'linux', true, '100.64.0.4'),
    d: peer('tylers-mac-mini', 'macOS', true, '100.64.0.5', 99),
    e: peer('ci-runner', 'linux', true, '100.64.0.6', owner, ['tag:ci']),
    f: peer('iphone', 'iOS', true, '100.64.0.7'),
  },
};

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-workspace-'));
fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });

function runpane(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PANE_DIR: bin, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const posixOnly = { skip: process.platform === 'win32' && 'the fake tailscale is a shell script' };

test('a machine resolves by full name, unique prefix, MagicDNS name, or Tailscale IP', posixOnly, () => {
  for (const name of ['parsa-devbox', 'PARSA-DEVBOX', 'parsa-devbox.tail.invalid', '100.64.0.2']) {
    assert.match(runpane('workspace', name, 'read', 'C:\\x').output, /Could not reach Pane on parsa-devbox \(/, name);
  }
  assert.match(runpane('workspace', 'build', 'read', '/x').output, /Could not reach Pane on build-server/);
});

test('an ambiguous or unknown name lists only the owner\'s own machines', posixOnly, () => {
  assert.match(runpane('workspace', 'parsa', 'read', '/x').output, /matches several machines: parsas-macbook-pro, parsa-devbox, parsa-devbox-old/);
  const unknown = runpane('workspace', 'tylers-mac-mini', 'read', '/x');
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /No machine of yours on Tailscale is called "tylers-mac-mini"/);
  assert.match(unknown.output, /Your machines: build-server \(Linux, online\), parsa-devbox \(Windows, online\), parsa-devbox-old \(Windows, offline\)\./);
  assert.doesNotMatch(unknown.output, /ci-runner|iphone/);
});

test('a path that cannot exist on this machine routes to the online machines whose OS fits it', posixOnly, () => {
  const windowsOnly = runpane('workspace', 'read', 'C:\\Users\\khaza\\.pane\\plans\\a\\index.html');
  assert.match(windowsOnly.output, /none of your joined machines fits it/);
  const windowsOrLinux = runpane('workspace', 'read', '/mnt/c/Users/khaza/notes.md');
  assert.match(windowsOrLinux.output, /could be on build-server, parsa-devbox\. Name one: runpane workspace <machine> read/);
});

test('a missing file shaped like another machine\'s path names that machine and the command', posixOnly, () => {
  const hinted = runpane('panes', 'create', '--from-json', 'C:\\Users\\khaza\\plan.json', '--yes');
  assert.match(hinted.output, /It looks like it is on parsa-devbox \(Windows, online\), parsa-devbox-old \(Windows, offline\)\. Read it with: runpane workspace parsa-devbox read 'C:\\Users\\khaza\\plan\.json'/);
  assert.notEqual(hinted.status, 0);
});
