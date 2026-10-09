// runpane workspace machine selection and path routing, driven through the CLI with a fake
// `tailscale` whose status lists the owner's machines and a teammate's. Their MagicDNS names do
// not resolve, so every remote call fails fast and the error text shows where runpane routed it;
// the teammate's two machines answer through a stubbed fetch, as their own Pane would.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'cli.js');
const owner = 31;
const teammate = 99;
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
    d: peer('tylers-mac-mini', 'macOS', true, '100.64.0.5', teammate),
    e: peer('ci-runner', 'linux', true, '100.64.0.6', owner, ['tag:ci']),
    f: peer('iphone', 'iOS', true, '100.64.0.7'),
    g: peer('tylers-pc', 'windows', true, '100.64.0.8', teammate),
    // A device shared in from another tailnet.
    h: { ...peer('guest-mac', 'macOS', true, '100.64.0.9', 77), DNSName: 'guest-mac.other.invalid.', ShareeNode: true },
  },
  User: {
    [owner]: { LoginName: 'parsa@github' },
    [teammate]: { LoginName: 'tbrownio@github' },
    77: { LoginName: 'guest@github' },
  },
};

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-workspace-'));
fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });

// tylers-mac-mini is shared with everyone on the tailnet; tylers-pc is set to "Only me".
const answers = path.join(bin, 'teammate-machines.js');
fs.writeFileSync(answers, `
const realFetch = globalThis.fetch;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const { hostname } = new URL(String(url));
  if (hostname === 'tylers-pc.tail.invalid') {
    return reply(403, { ok: false, error: {
      code: 'ERR_WORKSPACE_IDENTITY_REFUSED',
      message: "This machine accepts only its owner's Tailscale login; parsa@github is refused.",
    } });
  }
  if (hostname !== 'tylers-mac-mini.tail.invalid') return realFetch(url, init);
  const { channel } = JSON.parse(init.body);
  if (channel === 'runpane:machine:info') {
    return reply(200, { ok: true, result: { hostname: 'tylers-mac-mini', os: 'macOS', isWsl: false, shell: '/bin/zsh', homeDir: '/Users/tyler', wslDistros: [] } });
  }
  if (channel === 'runpane:sessions:list') return reply(200, { ok: true, result: { ok: true, sessions: [] } });
  return reply(404, { ok: false, error: { code: 'ERR_UNKNOWN_CHANNEL', message: 'unknown channel' } });
};
`);

function runpane(...args) {
  const result = spawnSync(process.execPath, ['--require', answers, cli, ...args], {
    cwd: bin,
    input: 'brief\n',
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

test('an ambiguous or unknown name lists the tailnet\'s machines, other people\'s with their owner', posixOnly, () => {
  assert.match(runpane('workspace', 'parsa', 'read', '/x').output, /matches several machines: parsas-macbook-pro, parsa-devbox, parsa-devbox-old/);
  const unknown = runpane('workspace', 'nope', 'read', '/x');
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /No machine on your tailnet is called "nope"/);
  assert.match(unknown.output, new RegExp([
    'Machines: build-server \\(Linux, online\\), parsa-devbox \\(Windows, online\\), parsa-devbox-old \\(Windows, offline\\), ',
    "tylers-mac-mini \\(macOS, online, owner tbrownio@github\\), tylers-pc \\(Windows, online, owner tbrownio@github\\)\\.",
  ].join('')));
  assert.doesNotMatch(unknown.output, /ci-runner|iphone|guest-mac/);
});

test('list shows a teammate\'s machines after mine, labeled with their owner', posixOnly, () => {
  const list = runpane('workspace', 'list');
  assert.equal(list.status, 0, list.output);
  const lines = list.output.split('\n');
  const index = (name) => lines.findIndex((line) => line.startsWith(`${name} (`));
  assert.ok(index('parsa-devbox') < index('tylers-mac-mini'), list.output);
  assert.equal(lines[index('tylers-mac-mini')], "tylers-mac-mini (macOS, online, owner tbrownio@github): joined, shell /bin/zsh");
  assert.match(lines[index('tylers-pc')], /^tylers-pc \(Windows, online, owner tbrownio@github\): not reachable: tylers-pc: This machine accepts only its owner's Tailscale login/);
  assert.doesNotMatch(list.output, /guest-mac|ci-runner/);
});

test('list probes online machines first, so offline ones never use up the probe limit', posixOnly, () => {
  const crowded = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-crowded-'));
  const offline = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`o${index}`, peer(`old-box-${index}`, 'linux', false, `100.64.1.${index}`)]));
  const crowdedStatus = { ...status, Peer: { ...offline, d: status.Peer.d } };
  fs.writeFileSync(path.join(crowded, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(crowdedStatus)}\nEOF\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--require', answers, cli, 'workspace', 'list'], {
    cwd: crowded,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PATH: `${crowded}${path.delimiter}${process.env.PATH}`, PANE_DIR: crowded, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.match(result.stdout, /^tylers-mac-mini \(macOS, online, owner tbrownio@github\): joined, shell \/bin\/zsh$/m, result.stdout + result.stderr);
});

test('a teammate\'s machine shared with the tailnet answers commands by name', posixOnly, () => {
  const sessions = runpane('workspace', 'tylers-mac-mini', 'sessions', 'list', '--json');
  assert.equal(sessions.status, 0, sessions.output);
  assert.deepEqual(JSON.parse(sessions.output), { ok: true, sessions: [] });
});

test('a machine set to "Only me" refuses other logins and says how its owner can let them in', posixOnly, () => {
  const refused = runpane('workspace', 'tylers-pc', 'sessions', 'list', '--json');
  assert.equal(refused.status, 1);
  assert.match(refused.output, /tylers-pc: This machine accepts only its owner's Tailscale login; parsa@github is refused\./);
  assert.match(refused.output, /Its owner can let you in from Pane on that machine: Settings → Remote Access → Access to this computer → Who can connect → Everyone on tailnet\./);
});

test('a path that cannot exist on this machine routes to the online machines whose OS fits it', posixOnly, () => {
  const windowsOnly = runpane('workspace', 'read', 'C:\\Users\\khaza\\.pane\\plans\\a\\index.html');
  assert.match(windowsOnly.output, /is not on this machine\. It fits parsa-devbox, but Pane is not answering there/);
  // /mnt/c is a real path shape on Linux, so it routes only from a Mac.
  if (process.platform === 'darwin') {
    const windowsOrLinux = runpane('workspace', 'read', '/mnt/c/Users/khaza/notes.md');
    assert.match(windowsOrLinux.output, /could be on build-server, parsa-devbox\. Name one: runpane workspace <machine> read/);
  }
});

test('writing a Windows path from a Mac or Linux routes it instead of writing a local file', posixOnly, () => {
  const result = runpane('workspace', 'write', 'C:\\Users\\khaza\\brief.md');
  assert.match(result.output, /It fits parsa-devbox, but Pane is not answering there/);
  assert.deepEqual(fs.readdirSync(bin).filter((name) => name.includes('brief')), []);
});

test('a missing file shaped like another machine\'s path names that machine and the command', posixOnly, () => {
  const hinted = runpane('panes', 'create', '--from-json', 'C:\\Users\\khaza\\plan.json', '--yes');
  assert.match(hinted.output, /It looks like it is on parsa-devbox \(Windows, online\), parsa-devbox-old \(Windows, offline\)\. Read it with: runpane workspace parsa-devbox read 'C:\\Users\\khaza\\plan\.json'/);
  assert.notEqual(hinted.status, 0);
});

test('another machine answers daemon commands, including workspace state; local-only commands stay here', posixOnly, () => {
  assert.match(runpane('workspace', 'parsa-devbox', 'workspace', 'state', '--json').output, /Could not reach Pane on parsa-devbox/);
  assert.match(runpane('workspace', 'parsa-devbox', 'sessions', 'list', '--json').output, /Could not reach Pane on parsa-devbox/);
  assert.match(runpane('workspace', 'parsa-devbox', 'workspace', 'list').output, /runs on this machine only/);
  assert.match(runpane('workspace', 'parsa-devbox', 'doctor').output, /use: runpane workspace parsa-devbox exec -- runpane doctor/);
});

/** Runs runpane while a fake local Pane answers machine commands; returns the output and what Pane was asked. */
async function runpaneWithLocalPane(input, ...args) {
  const { getPaneDaemonEndpoint } = require(path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const endpoint = getPaneDaemonEndpoint(bin);
  fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
  fs.rmSync(endpoint.path, { force: true });
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (frame.id !== 1) continue;
        requests.push({ channel: frame.channel, args: frame.args });
        const result = frame.channel === 'runpane:machine:read'
          ? { path: '/resolved', encoding: 'utf8', content: 'from this Pane\n', bytes: 15 }
          : { path: '/resolved', bytes: 6 };
        socket.end(`${JSON.stringify({ type: 'response', id: 1, ok: true, result })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint.path, resolve));
  try {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: bin,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PANE_DIR: bin, RUNPANE_TELEMETRY_DISABLED: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdin.end(input);
    const status = await new Promise((resolve) => child.on('close', resolve));
    return { status, output, requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('without a machine name, local reads and writes go through this machine\'s Pane', posixOnly, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-local-'));
  const read = await runpaneWithLocalPane('', 'workspace', 'read', directory);
  assert.equal(read.output, 'from this Pane\n');
  assert.deepEqual(read.requests, [{ channel: 'runpane:machine:read', args: [{ path: directory }] }]);

  const home = await runpaneWithLocalPane('', 'workspace', 'read', '~/notes.md');
  assert.deepEqual(home.requests, [{ channel: 'runpane:machine:read', args: [{ path: '~/notes.md' }] }]);

  const nested = path.join(directory, 'new', 'parent', 'file.txt');
  const write = await runpaneWithLocalPane('hello\n', 'workspace', 'write', nested);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(write.requests, [{ channel: 'runpane:machine:write', args: [{ path: nested, content: 'hello\n', encoding: 'utf8' }] }]);
});
