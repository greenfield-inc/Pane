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
const { test } = require('./runpane-test-shard');

const cli = path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'cli.js');
const owner = 31;
const teammate = 99;
const peer = (name, OS, Online, ip, UserID = owner, Tags = null) => ({
  DNSName: `${name}.tail.invalid.`, OS, Online, UserID, Tags, TailscaleIPs: [ip],
});
const status = {
  BackendState: 'Running',
  CertDomains: ['parsas-macbook-pro.tail.invalid'],
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

// tylers-mac-mini is shared with everyone on the tailnet; tylers-pc is set to "Only me". Their Panes
// answer in-process: runpane's https.request to them gets a reply without a network.
const answers = path.join(bin, 'teammate-machines.js');
fs.writeFileSync(answers, `
const https = require('node:https');
const { PassThrough, Writable } = require('node:stream');
const realRequest = https.request;
function answer(hostname, { channel }) {
  if (hostname === 'tylers-pc.tail.invalid') {
    return [403, { ok: false, error: {
      code: 'ERR_WORKSPACE_IDENTITY_REFUSED',
      message: "This machine accepts only its owner's Tailscale login; parsa@github is refused.",
    } }];
  }
  if (channel === 'runpane:machine:info') {
    return [200, { ok: true, result: { hostname: 'tylers-mac-mini', os: 'macOS', isWsl: false, shell: '/bin/zsh', homeDir: '/Users/tyler', wslDistros: [] } }];
  }
  if (channel === 'runpane:sessions:list') return [200, { ok: true, result: { ok: true, sessions: [] } }];
  if (channel === 'runpane:doctor') {
    const features = process.env.FAKE_LAUNCH_OPTION ? ['session-launch-option'] : [];
    return [200, { ok: true, result: { ok: true, app: { version: '2.4.200', isPackaged: true, platform: 'darwin' }, daemon: { channels: [], features } } }];
  }
  if (channel === 'runpane:sessions:create') {
    return [200, { ok: true, result: { ok: true, panelId: 'codex-panel', internalSessionId: 'owner', session: { id: 'coordinator', name: 'Release QA', isPinned: false, agent: 'codex',
      internalSessionId: 'owner', panelIds: { claude: 'c', codex: 'codex-panel', cursor: 'u' }, goal: '', context: '', decisions: [], blockers: [], nextAction: '',
      evidence: [], outputs: [], associations: [], activity: [], revision: 1, createdAt: '2026-11-26T03:00:00Z', updatedAt: '2026-11-26T03:00:00Z' } } }];
  }
  return [404, { ok: false, error: { code: 'ERR_UNKNOWN_CHANNEL', message: 'unknown channel' } }];
}
https.request = (url, options, callback) => {
  const { hostname } = new URL(String(url));
  if (!hostname.startsWith('tylers-')) return realRequest(url, options, callback);
  let body = '';
  return new Writable({
    write(chunk, encoding, done) { body += chunk; done(); },
    final(done) {
      if (process.env.FAKE_REQUEST_LOG) require('node:fs').appendFileSync(process.env.FAKE_REQUEST_LOG, body + '\\n');
      const [status, payload] = answer(hostname, JSON.parse(body));
      const response = new PassThrough();
      response.statusCode = status;
      callback(response);
      response.end(JSON.stringify(payload));
      done();
    },
  });
};
`);

function runpane(...args) {
  return runpaneWith({}, ...args);
}

function runpaneWith(env, ...args) {
  const result = spawnSync(process.execPath, ['--require', answers, cli, ...args], {
    cwd: bin,
    input: 'brief\n',
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PANE_DIR: bin, RUNPANE_TELEMETRY_DISABLED: '1', ...env },
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
  assert.match(unknown.output, /No machine on your tailnet or saved in Pane is called "nope"/);
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

test('with HTTPS Certificates off, list names the tailnet setting for machines that do not answer', posixOnly, () => {
  const certificatesOff = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-certs-off-'));
  fs.writeFileSync(path.join(certificatesOff, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ ...status, CertDomains: null })}\nEOF\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--require', answers, cli, 'workspace', 'list'], {
    cwd: certificatesOff,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PATH: `${certificatesOff}${path.delimiter}${process.env.PATH}`, PANE_DIR: certificatesOff, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.match(result.stdout, /^parsa-devbox \(Windows, online\): not reachable: this tailnet has HTTPS certificates turned off\. Fix: Turn on HTTPS Certificates at https:\/\/login\.tailscale\.com\/admin\/dns\.$/m, result.stdout + result.stderr);
  // A machine that answers keeps its own reason.
  assert.match(result.stdout, /^tylers-pc \(Windows, online, owner tbrownio@github\): not reachable: tylers-pc: This machine accepts only/m);
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
  assert.match(refused.output, /Its owner can let you in from Pane on that machine: Settings → Remote Access → Access → Who can connect → Everyone on tailnet\./);
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

test('sessions create --launch-command asks the named machine, and an older Pane there creates nothing', posixOnly, () => {
  const payload = path.join(bin, 'launch-session.json');
  const log = path.join(bin, 'launch-requests.log');
  fs.writeFileSync(payload, JSON.stringify({ name: 'Release QA' }));
  const sent = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const create = ['workspace', 'tylers-mac-mini', 'sessions', 'create', '--from-json', payload, '--launch-command', 'Build bot', '--json'];
  try {
    const created = runpaneWith({ FAKE_LAUNCH_OPTION: '1', FAKE_REQUEST_LOG: log }, ...create);
    assert.equal(created.status, 0, created.output);
    assert.deepEqual(sent().map(({ channel }) => channel), ['runpane:doctor', 'runpane:sessions:create']);
    assert.deepEqual(sent()[1].args, [{ name: 'Release QA', launchOption: 'Build bot' }]);

    fs.rmSync(log, { force: true });
    const older = runpaneWith({ FAKE_REQUEST_LOG: log }, ...create);
    assert.notEqual(older.status, 0);
    assert.match(older.output, /tylers-mac-mini/);
    assert.match(older.output, /Pane 2\.4\.200 on tylers-mac-mini can't pick a saved launch option/);
    assert.deepEqual(sent().map(({ channel }) => channel), ['runpane:doctor']);
  } finally {
    fs.rmSync(log, { force: true });
    fs.rmSync(payload, { force: true });
  }
});

/** Runs runpane while a fake local Pane answers machine commands; returns the output and what Pane was asked. */
async function runpaneWithLocalPane(input, ...args) {
  const pane = await fakeLocalPane(bin, (channel) => (channel === 'runpane:machine:read'
    ? { path: '/resolved', encoding: 'utf8', content: 'from this Pane\n', bytes: 15 }
    : { path: '/resolved', bytes: 6 }));
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
    return { status, output, requests: pane.requests };
  } finally {
    await pane.close();
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

/** A fake local Pane on `paneDir`'s socket: `answer(channel, args)` returns a result or `{ error }`. */
async function fakeLocalPane(paneDir, answer) {
  const { getPaneDaemonEndpoint } = require(path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const endpoint = getPaneDaemonEndpoint(paneDir);
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
        const outcome = answer(frame.channel, frame.args);
        const response = outcome && outcome.error
          ? { type: 'response', id: 1, ok: false, error: outcome.error }
          : { type: 'response', id: 1, ok: true, result: outcome };
        socket.end(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint.path, resolve));
  return { requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

const UNKNOWN_CHANNEL = { error: { code: 'ERR_UNKNOWN_CHANNEL', message: 'No Pane daemon command registered for channel "computers:list".' } };

/** What a computer answers a device paired Read only; it refuses every other command with 409. */
const READ_ONLY_RESULTS = {
  'remote:pwa-affordances': { os: 'macOS' },
  'runpane:sessions:list': { ok: true, sessions: [] },
  'runpane:panels:screen': { ok: true, panelId: 'panel-1', paneId: 'pane-1', source: 'scrollback', limit: 40, returnedLineCount: 1, hasMore: false, text: 'Compiling', nextCommand: 'runpane panels output --panel panel-1 --json', state: { running: true, initialized: true }, composer: { isPresent: true, hasUndeliveredText: false } },
  'runpane:panels:last-message': { ok: false, panelId: 'panel-1', paneId: 'pane-1', reason: 'transcript-unavailable', message: 'No reply yet. Use `runpane panels screen --panel panel-1`.' },
  'runpane:panels:list': { ok: true, paneId: 'pane-1', panels: [] },
  'runpane:workspace:state': { ok: true, epoch: 'e1', generation: 4, entries: [{ gen: 4, at: '2026-11-25T10:00:00.000Z', kind: 'agent.busy', paneId: 'pane-1', paneName: 'fix-auth', panelId: 'panel-1', source: 'agent', baseline: true }] },
};

/**
 * Another computer with Tailscale signed out on this one: a real TLS server on localhost (trusted
 * through NODE_EXTRA_CA_CERTS, as a CA-issued certificate would be), a route that accepts TCP and
 * never answers (Tailscale signed out on the computer), and this machine's Pane listing what
 * `computers(addresses)` returns. `tailnet` is a `tailscale status` to report, or none; `relay` is
 * this machine's phone access (`relay:status`), or none.
 */
async function withComputer({ computers, tailnet = null, relay = null }, check) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-computer-'));
  // Signed out unless `tailnet` is given; this fake comes first, so a real Tailscale app is never asked.
  const status = tailnet ?? { BackendState: 'NeedsLogin' };
  fs.writeFileSync(path.join(home, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });
  const certificate = (name) => {
    const key = path.join(home, `${name}-key.pem`);
    const cert = path.join(home, `${name}-cert.pem`);
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    // base64url SHA-256 of the SubjectPublicKeyInfo, as the openssl pipeline in docs/QR_PAIRING.md would print it.
    const spki = spawnSync('sh', ['-c', `openssl x509 -in "${cert}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: 'utf8' });
    assert.equal(spki.status, 0, spki.stderr);
    return { key, cert, fingerprint: spki.stdout.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
  };
  const laptop = certificate('laptop');
  const other = certificate('other');
  const requests = [];
  const https = require('node:https');
  const linked = https.createServer({ key: fs.readFileSync(laptop.key), cert: fs.readFileSync(laptop.cert) }, (request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, channel: JSON.parse(body).channel });
      const reply = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
      if (request.headers.authorization === 'Bearer pane_read_token') {
        const { channel } = JSON.parse(body);
        const result = READ_ONLY_RESULTS[channel];
        return result ? reply(200, { ok: true, result }) : reply(409, { ok: false, error: {
          code: 'ERR_READ_ONLY_ACCESS', message: `This device is paired Read only with this computer, so it can't use ${channel}. Nothing was run or changed.`, next: 'Ask the computer\'s owner for full access.',
        } });
      }
      if (!['Bearer link-token', 'Bearer tailscale-password'].includes(request.headers.authorization)) {
        return reply(401, { ok: false, error: { code: 'ERR_REMOTE_DAEMON_AUTH_INVALID', message: 'bad token' } });
      }
      const { channel } = JSON.parse(body);
      if (channel === 'runpane:machine:info') {
        return reply(200, { ok: true, result: { hostname: 'travel-laptop', os: 'Linux', isWsl: false, shell: '/bin/bash', homeDir: '/home/ana', wslDistros: [] } });
      }
      if (channel === 'runpane:machine:read') return reply(200, { ok: true, result: { path: '/home/ana/notes.md', encoding: 'utf8', content: 'from the laptop\n', bytes: 16 } });
      return reply(404, { ok: false, error: { code: 'ERR_UNKNOWN_CHANNEL', message: 'unknown channel' } });
    });
  });
  await new Promise((resolve) => linked.listen(0, '127.0.0.1', resolve));
  const held = [];
  const silent = net.createServer((socket) => { held.push(socket); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const addresses = {
    laptop: `https://localhost:${linked.address().port}`,
    silent: `https://localhost:${silent.address().port}`,
    keys: { laptop: laptop.fingerprint, other: other.fingerprint },
  };
  const listed = computers(addresses);
  const pane = await fakeLocalPane(home, (channel) => {
    if (channel === 'computers:list') return listed.computers ?? UNKNOWN_CHANNEL;
    if (channel === 'relay:linked-computers') return listed.linkedComputers ?? UNKNOWN_CHANNEL;
    if (channel === 'relay:status') return relay ?? UNKNOWN_CHANNEL;
    return { enabled: false, state: 'off', reason: 'Tailscale is signed out' };
  });
  const run = (...args) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env, PATH: `${home}${path.delimiter}/usr/bin${path.delimiter}/bin`, PANE_DIR: home, RUNPANE_TELEMETRY_DISABLED: '1',
        NODE_EXTRA_CA_CERTS: laptop.cert,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (status) => resolve({ status, output, ms: Date.now() - started }));
  });
  try {
    await check(run, requests, { held });
  } finally {
    for (const socket of held) socket.destroy();
    await pane.close();
    await new Promise((resolve) => silent.close(resolve));
    await new Promise((resolve) => linked.close(resolve));
  }
}

const relayRoute = (baseUrl, fingerprint) => ({
  id: `relay:${baseUrl}`, kind: 'relay', source: 'link', baseUrl, token: 'link-token', relay: { computerId: 'k3x9linked0000aa', fingerprint },
});
/** Travel Laptop as Pane saves it (shared/types/remoteComputers.ts), reached only through the relay. */
const travelLaptop = (routes) => ({ id: 'relay-k3x9linked0000aa', label: 'Travel Laptop', machineId: 'install-7f3a2c', os: 'Linux', routes });

test('a computer saved in Pane answers by name with its route\'s token when Tailscale is off', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.laptop)])] }) }, async (run, requests) => {
    const read = await run('workspace', 'travel-laptop', 'read', '~/notes.md');
    assert.equal(read.output, 'from the laptop\n');
    assert.equal(read.status, 0);
    assert.deepEqual(requests, [{ authorization: 'Bearer link-token', channel: 'runpane:machine:read' }]);
  });
});

test('a computer whose key is not the one it linked with never receives the token', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.other)])] }) }, async (run, requests) => {
    const read = await run('workspace', 'travel-laptop', 'read', '~/notes.md');
    assert.notEqual(read.status, 0, read.output);
    assert.match(read.output, /presented a key it did not link with/, read.output);
    assert.deepEqual(requests, []);
  });
});

test('a Pane older than computers still lists the computers it linked through the relay', posixOnly, async () => {
  const linkedComputers = ({ laptop, keys }) => ({
    linkedComputers: [{ id: 'k3x9linked0000aa', name: 'Travel Laptop', address: laptop, token: 'link-token', fingerprint: keys.laptop }],
  });
  await withComputer({ computers: linkedComputers }, async (run) => {
    const read = await run('workspace', 'travel-laptop', 'read', '~/notes.md');
    assert.equal(read.output, 'from the laptop\n');
  });
});

test('two saved computers with one name are told apart by relay id, and an unknown OS says so', posixOnly, async () => {
  // Nothing listens on port 1, so neither computer can say which OS it runs.
  const studio = (relayId) => ({ id: `relay-${relayId}`, label: 'Studio Mac', routes: [{
    id: `relay:https://localhost:1/${relayId}`, kind: 'relay', source: 'link', baseUrl: `https://localhost:1/${relayId}`, token: 'link-token',
    relay: { computerId: relayId, fingerprint: 'unused' },
  }] });
  await withComputer({ computers: () => ({ computers: [studio('k7xq2m4n8p3r5t6v'), studio('m2r9w4c6t8b1n3q5')] }) }, async (run) => {
    const read = await run('workspace', 'studio-mac', 'read', '~/notes.md');
    assert.notEqual(read.status, 0);
    assert.match(read.output, /matches several machines: studio-mac \(relay-k7xq2m4n8p3r5t6v\), studio-mac \(relay-m2r9w4c6t8b1n3q5\)/);
    const unknown = await run('workspace', 'nope', 'read', '~/notes.md');
    assert.match(unknown.output, /studio-mac \(OS unknown, offline\)/);
  });
});

test('list says why a saved computer cannot be reached instead of only "offline"', posixOnly, async () => {
  // Nothing listens on port 1: the relay route is refused, as when the computer has no certificate yet.
  const studio = { id: 'relay-k7xq2m4n8p3r5t6v', label: 'Studio Mac', routes: [{
    id: 'relay:https://localhost:1/k7xq', kind: 'relay', source: 'link', baseUrl: 'https://localhost:1/k7xq', token: 'link-token',
    relay: { computerId: 'k7xq2m4n8p3r5t6v', fingerprint: 'unused' },
  }] };
  await withComputer({ computers: () => ({ computers: [studio] }) }, async (run) => {
    const list = await run('workspace', 'list');
    assert.equal(list.status, 0, list.output);
    const line = list.output.split('\n').find((text) => text.startsWith('studio-mac'));
    assert.match(line, /: not reachable: Could not reach Pane on studio-mac \(https:\/\/localhost:1\/k7xq\): .*ECONNREFUSED/);
    assert.doesNotMatch(line, /workspaces on/);
    const json = await run('workspace', 'list', '--json');
    const [listed] = JSON.parse(json.output).machines;
    assert.match(listed.error, /ECONNREFUSED/);
    assert.equal(listed.unreachable, undefined);
  });
});

test('this machine says other computers reach it through Pane relay while Tailscale is signed out', posixOnly, async () => {
  const relay = { enabled: true, phase: 'ready', address: 'https://k3x9linked0000aa.runpane.net', lastError: null };
  await withComputer({ relay, computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.laptop)])] }) }, async (run) => {
    const list = await run('workspace', 'list');
    assert.equal(list.status, 0, list.output);
    assert.match(list.output.split('\n')[0], /\(this machine, \w+\): reachable through Pane relay \(https:\/\/k3x9linked0000aa\.runpane\.net\)\. Tailscale: off \(Tailscale is signed out\)/);
  });
});

test('this machine says new pairings through Pane relay are paused while both certificate services refuse, and points to Tailscale', posixOnly, async () => {
  const relay = { enabled: true, phase: 'error', address: null, lastError: 'refused', certificateLimit: { until: '2026-11-20T22:16:39Z' } };
  await withComputer({ relay, computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.laptop)])] }) }, async (run) => {
    const list = await run('workspace', 'list');
    assert.equal(list.status, 0, list.output);
    assert.match(list.output.split('\n')[0], /\(this machine, \w+\): not accepting new phone pairings through Pane relay until .+: both certificate services are turning away new computers\. Connect with Tailscale instead\. Tailscale: off \(Tailscale is signed out\)/);
    const json = await run('workspace', 'list', '--json');
    assert.deepEqual(JSON.parse(json.output).self.relay.certificateLimit, { until: '2026-11-20T22:16:39Z' });
  });
});

test('when a route does not answer, the next one does, within 10 seconds', posixOnly, async () => {
  const computers = ({ laptop, silent, keys }) => ({
    computers: [travelLaptop([
      { id: `tailscale:${silent}`, kind: 'tailscale', source: 'found', baseUrl: silent, token: '', tailnetMachine: 'travel-laptop', tailnetDomain: 'tail.invalid' },
      relayRoute(laptop, keys.laptop),
    ])],
  });
  await withComputer({ computers }, async (run, requests, { held }) => {
    const read = await run('workspace', 'travel-laptop', 'read', '~/notes.md');
    assert.equal(read.output, 'from the laptop\n');
    assert.ok(read.ms < 10_000, `took ${read.ms} ms`);
    assert.equal(held.length, 1, 'the Tailscale route was tried first');
    assert.deepEqual(requests, [{ authorization: 'Bearer link-token', channel: 'runpane:machine:read' }]);
  });
});

test('a Tailscale route sends its password', posixOnly, async () => {
  const computers = ({ laptop }) => ({
    computers: [travelLaptop([{ id: `tailscale:${laptop}`, kind: 'tailscale', source: 'manual', baseUrl: laptop, token: 'tailscale-password' }])],
  });
  await withComputer({ computers }, async (run, requests) => {
    assert.equal((await run('workspace', 'travel-laptop', 'read', '~/notes.md')).output, 'from the laptop\n');
    assert.deepEqual(requests, [{ authorization: 'Bearer tailscale-password', channel: 'runpane:machine:read' }]);
  });
});

test('a saved computer on the tailnet is one entry, found by its name, relay id, install id, or MagicDNS name', posixOnly, async () => {
  const tailnet = {
    BackendState: 'Running',
    CertDomains: ['parsas-macbook-pro.tail.invalid'],
    Self: peer('parsas-macbook-pro', 'macOS', true, '100.64.0.1'),
    // MagicDNS names under .invalid never resolve, as when Tailscale is signed out on the laptop.
    Peer: { a: peer('travel-laptop', 'linux', true, '100.64.0.2') },
    User: { [owner]: { LoginName: 'parsa@github' } },
  };
  await withComputer({ tailnet, computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.laptop)])] }) }, async (run) => {
    for (const name of ['travel-laptop', 'k3x9linked0000aa', 'install-7f3a2c', 'travel-laptop.tail.invalid', '100.64.0.2']) {
      const read = await run('workspace', name, 'read', '~/notes.md');
      assert.equal(read.output, 'from the laptop\n', name);
    }
    const list = await run('workspace', 'list', '--json');
    assert.equal(list.status, 0, list.output);
    const machines = JSON.parse(list.output).machines;
    assert.deepEqual(machines.map((machine) => machine.name), ['travel-laptop']);
    assert.deepEqual(machines[0].routes.map(({ kind, answered }) => ({ kind, answered })), [
      { kind: 'tailscale', answered: false },
      { kind: 'relay', answered: true },
    ]);
    assert.equal(machines[0].joined, true);
  });
});

test('workspace list shows a saved computer without its route tokens', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [travelLaptop([relayRoute(laptop, keys.laptop)])] }) }, async (run) => {
    for (const args of [['workspace', 'list', '--json'], ['workspace', 'list']]) {
      const list = await run(...args);
      assert.equal(list.status, 0, list.output);
      assert.match(list.output, /travel-laptop/, list.output);
      assert.doesNotMatch(list.output, /link-token/, list.output);
    }
    assert.match((await run('workspace', 'list')).output, /^travel-laptop \(Linux, online\) \[Pane relay\]: joined through Pane relay, shell \/bin\/bash$/m);
  });
});

// ---------------------------------------------------------------- a read-only computer

const readRoute = (baseUrl, fingerprint) => ({ ...relayRoute(baseUrl, fingerprint), token: 'pane_read_token' });

test('list marks a computer whose every saved route is read-only, and learns its OS', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [{ ...travelLaptop([readRoute(laptop, keys.laptop)]), os: undefined }] }) }, async (run) => {
    const list = await run('workspace', 'list');
    assert.match(list.output, /^travel-laptop \(macOS, online, read only\) \[Pane relay\]: joined through Pane relay$/m);
    const [machine] = JSON.parse((await run('workspace', 'list', '--json')).output).machines;
    assert.equal(machine.access, 'read');
    assert.equal(machine.joined, true);
    assert.equal(machine.info, undefined);
    assert.equal(machine.error, undefined);
    assert.deepEqual(machine.routes.map(({ kind, access, answered }) => ({ kind, access, answered })), [{ kind: 'relay', access: 'read', answered: true }]);
  });
  // As `relay:linked-computers` lists it.
  const linkedComputers = ({ laptop, keys }) => ({
    linkedComputers: [{ id: 'k3x9linked0000aa', name: 'Travel Laptop', address: laptop, token: 'pane_read_token', fingerprint: keys.laptop, access: 'read' }],
  });
  await withComputer({ computers: linkedComputers }, async (run) => {
    assert.match((await run('workspace', 'list')).output, /^travel-laptop \(macOS, online, read only\)/m);
  });
});

test('a full-access route goes before read-only ones, and the computer is not read only', posixOnly, async () => {
  const computers = ({ laptop, keys }) => ({ computers: [travelLaptop([
    readRoute(laptop, keys.laptop),
    { id: `tailscale:${laptop}`, kind: 'tailscale', source: 'manual', baseUrl: laptop, token: 'tailscale-password' },
  ])] });
  await withComputer({ computers }, async (run, requests) => {
    assert.equal((await run('workspace', 'travel-laptop', 'read', '~/notes.md')).output, 'from the laptop\n');
    assert.deepEqual(requests.map((request) => request.authorization), ['Bearer tailscale-password']);
    assert.doesNotMatch((await run('workspace', 'list')).output, /read only/);
  });
});

test('a read-only computer answers looking, agents status included', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [travelLaptop([readRoute(laptop, keys.laptop)])] }) }, async (run) => {
    const sessions = await run('workspace', 'travel-laptop', 'sessions', 'list', '--json');
    assert.deepEqual(JSON.parse(sessions.output), { ok: true, sessions: [] });
    const status = await run('workspace', 'travel-laptop', 'agents', 'status', '--panel', 'panel-1', '--json');
    assert.equal(status.status, 0, status.output);
    const answer = JSON.parse(status.output);
    assert.equal(answer.status, 'working');
    assert.equal(answer.screen, 'Compiling');
    assert.equal(answer.link, undefined, 'a pane:// link would open on this machine');
  });
});

test('follow-ups from another computer name it as it was named', posixOnly, async () => {
  await withComputer({ computers: ({ laptop, keys }) => ({ computers: [travelLaptop([readRoute(laptop, keys.laptop)])] }) }, async (run) => {
    const screen = JSON.parse((await run('workspace', 'k3x9linked0000aa', 'panels', 'screen', '--panel', 'panel-1', '--json')).output);
    assert.equal(screen.nextCommand, 'runpane workspace k3x9linked0000aa panels output --panel panel-1 --json');
    const message = JSON.parse((await run('workspace', 'travel-laptop', 'panels', 'last-message', '--panel', 'panel-1', '--json')).output);
    assert.equal(message.message, 'No reply yet. Use `runpane workspace travel-laptop panels screen --panel panel-1`.');
    const none = await run('workspace', 'travel-laptop', 'agents', 'status', '--pane', 'pane-1');
    assert.match(none.output, /Start an agent in it with `runpane workspace travel-laptop agents start --pane pane-1/);
  });
});

test('a read-only computer\'s refusal keeps its code and next step, and no other route is tried', posixOnly, async () => {
  const computers = ({ laptop, keys }) => ({ computers: [travelLaptop([readRoute(laptop, keys.laptop), { ...readRoute(laptop, keys.laptop), id: 'second' }])] });
  await withComputer({ computers }, async (run, requests) => {
    for (const args of [
      ['workspace', 'travel-laptop', 'exec', '--json', '--', 'ls'],
      ['workspace', 'travel-laptop', 'panes', 'create', '--repo', 'active', '--name', 'fix', '--agent', 'claude', '--yes', '--json'],
      ['ask', '--machine', 'travel-laptop', '--agent', 'claude', '--prompt', 'hi', '--json'],
    ]) {
      requests.length = 0;
      const refused = await run(...args);
      assert.equal(refused.status, 1, refused.output);
      const { error } = JSON.parse(refused.output.slice(0, refused.output.indexOf('\n}\n') + 2));
      assert.equal(error.code, 'ERR_READ_ONLY_ACCESS', refused.output);
      assert.match(error.message, /^travel-laptop: This device is paired Read only/);
      assert.equal(error.next, 'Ask the computer\'s owner for full access.');
      assert.equal(requests.length, 1, args.join(' '));
    }
    const text = await run('workspace', 'travel-laptop', 'exec', '--', 'ls');
    assert.match(text.output, /Next: Ask the computer's owner for full access\./);
  });
});

// ---------------------------------------------------------------- runpane link

const LINK = 'https://runpane.net/pair#s=secret&c=k7xq2m4n8p3r5t6v&n=parsa-devbox';

/** This computer's Pane answering a link's preview and redemption. */
async function withLinkPane(preview, check, redeem) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-link-'));
  const pane = await fakeLocalPane(home, (channel) => (channel === 'relay:link-preview'
    ? { expiresAt: '2026-11-15T10:00:00.000Z', ...preview }
    : redeem ?? (preview.access ? { linked: ['parsa-devbox', 'build-box'], access: preview.access } : { linked: ['parsa-devbox', 'build-box'] })));
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'link', ...args, '--pane-dir', home], { env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    await check(run, pane.requests, home);
  } finally {
    await pane.close();
  }
}

const joinsGroups = { maker: 'parsa-devbox', makerGroup: ['parsa-devbox', 'build-box'], here: ['studio-mac'], needsConfirm: true };

test('runpane link on a computer with nothing linked asks too, naming who could run agents here', posixOnly, async () => {
  await withLinkPane({ maker: 'parsa-devbox', makerGroup: ['parsa-devbox', 'build-box'], here: [], needsConfirm: true }, async (run, requests) => {
    const refused = await run(LINK, '--json');
    assert.equal(refused.status, 1);
    assert.match(JSON.parse(refused.stdout).error.message, /lets parsa-devbox's computers \(parsa-devbox and build-box\) run agents on this computer/);
    requests.length = 0;
    const linked = await run(LINK, '--yes');
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(linked.stdout, 'Linked with parsa-devbox and build-box. List them with: runpane workspace list\n');
    assert.deepEqual(requests.map(({ channel }) => channel), ['relay:link-preview', 'relay:redeem-link']);
    assert.deepEqual(requests[1].args, [{ link: LINK, access: 'full' }]);
  });
});

test('runpane link joining two groups needs --yes without a terminal, and spends nothing until then', posixOnly, async () => {
  await withLinkPane(joinsGroups, async (run, requests) => {
    const refused = await run(LINK, '--json');
    assert.equal(refused.status, 1);
    const { error } = JSON.parse(refused.stdout);
    assert.equal(error.code, 'ERR_LINK_NEEDS_CONFIRM');
    assert.match(error.message, /joins your computers \(studio-mac\) with parsa-devbox's \(parsa-devbox and build-box\)/);
    assert.match(error.next, /--yes/);
    assert.deepEqual(requests.map(({ channel }) => channel), ['relay:link-preview']);

    const confirmed = await run(LINK, '--yes', '--json');
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.deepEqual(JSON.parse(confirmed.stdout), { ok: true, maker: 'parsa-devbox', linked: ['parsa-devbox', 'build-box'] });
    assert.deepEqual(requests.slice(1).map(({ channel }) => channel), ['relay:link-preview', 'relay:redeem-link']);
  });
});

test('runpane link asks on a terminal, naming both sides, and links only on yes', posixOnly, async () => {
  const { PassThrough } = require('node:stream');
  const { runLink } = require(path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'pairingLink.js'));
  const { parseRunpaneArgs } = require(path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'commands.js'));
  await withLinkPane(joinsGroups, async (run, requests, home) => {
    const terminal = (answer) => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const output = Object.assign(new PassThrough(), { isTTY: true });
      let shown = '';
      output.on('data', (chunk) => { shown += chunk; });
      input.end(`${answer}\n`);
      return { input, output, shown: () => shown };
    };
    const no = terminal('n');
    await assert.rejects(runLink(parseRunpaneArgs(['link', LINK, '--pane-dir', home]), no), { code: 'ERR_LINK_CANCELLED' });
    assert.match(no.shown(), /joins your computers \(studio-mac\) with parsa-devbox's \(parsa-devbox and build-box\)[^]*Link with parsa-devbox\? \[y\/N\]/);
    assert.deepEqual(requests.map(({ channel }) => channel), ['relay:link-preview']);

    const yes = terminal('y');
    assert.equal(await runLink(parseRunpaneArgs(['link', LINK, '--pane-dir', home]), yes), 0);
    assert.match(yes.shown(), /Linked with parsa-devbox and build-box\./);
    assert.deepEqual(requests.slice(1).map(({ channel }) => channel), ['relay:link-preview', 'relay:redeem-link']);
  });
});

const readOnlyLink = { maker: 'parsa-devbox', makerGroup: ['parsa-devbox', 'build-box'], here: [], needsConfirm: true, access: 'read' };

test('runpane link says Read only and what it means, before and after a read-only link', posixOnly, async () => {
  const meaning = /Read only: this computer sees the Sessions, agents, transcripts and terminal output of parsa-devbox and build-box, .* They can't reach this computer\./;
  await withLinkPane(readOnlyLink, async (run, requests) => {
    const { error } = JSON.parse((await run(LINK, '--json')).stdout);
    assert.equal(error.code, 'ERR_LINK_NEEDS_CONFIRM');
    assert.match(error.message, meaning);
    assert.doesNotMatch(error.message, /run agents on this computer/);
    assert.match((await run(LINK, '--yes')).stdout, meaning);
    assert.deepEqual(requests[requests.length - 1].args, [{ link: LINK, access: 'read' }]);
    assert.deepEqual(JSON.parse((await run(LINK, '--yes', '--json')).stdout), { ok: true, maker: 'parsa-devbox', linked: ['parsa-devbox', 'build-box'], access: 'read' });
  });
});

test('the Python runpane link refuses and links the same way', posixOnly, async () => {
  const runPython = (home, ...args) => new Promise((resolve) => {
    const child = spawn(process.env.PYTHON || 'python3', ['-m', 'runpane', 'link', LINK, ...args, '--pane-dir', home], {
      env: { ...process.env, PYTHONPATH: path.join(__dirname, '..', 'packages', 'runpane-py', 'src'), PYTHONDONTWRITEBYTECODE: '1', RUNPANE_TELEMETRY_DISABLED: '1' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end();
    child.on('close', (status) => resolve({ status, stdout }));
  });
  const changed = { error: { code: 'ERR_LINK_LEVEL_CHANGED', message: 'parsa-devbox answered with another access level than the link showed, so nothing was linked.', next: 'Ask for a new link.' } };
  for (const [preview, redeem] of [[joinsGroups], [readOnlyLink], [joinsGroups, changed]]) await withLinkPane(preview, async (run, requests, home) => {
    for (const args of [['--json'], ['--yes', '--json']]) {
      const [npm, python] = [await run(LINK, ...args), await runPython(home, ...args)];
      assert.deepEqual({ status: python.status, output: JSON.parse(python.stdout) }, { status: npm.status, output: JSON.parse(npm.stdout) }, args.join(' '));
      if (redeem && args.includes('--yes')) assert.deepEqual(JSON.parse(npm.stdout).error, changed.error);
    }
    assert.equal(requests.at(-1).args[0].access, preview.access ?? 'full');
  }, redeem);
});
