#!/usr/bin/env node
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const npmCli = path.join(rootDir, 'packages', 'runpane', 'dist', 'cli.js');
const pythonSource = path.join(rootDir, 'packages', 'runpane-py', 'src');
const contractPath = path.join(rootDir, 'contracts', 'runpane', 'contract.json');
const contractFixturePath = path.join(rootDir, 'scripts', 'fixtures', 'runpane-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const contractFixture = JSON.parse(fs.readFileSync(contractFixturePath, 'utf8'));
const parserSamples = contractFixture.parserSamples;

process.env.RUNPANE_TELEMETRY_DISABLED = '1';

const platformCases = [
  { platform: { os: 'darwin', arch: 'arm64' }, target: 'client' },
  { platform: { os: 'darwin', arch: 'arm64' }, target: 'daemon' },
  { platform: { os: 'linux', arch: 'x64' }, target: 'client' },
  { platform: { os: 'linux', arch: 'arm64' }, target: 'daemon' },
  { platform: { os: 'win32', arch: 'x64' }, target: 'client' },
  { platform: { os: 'win32', arch: 'arm64' }, target: 'daemon' }
];

const daemonEndpointCases = [
  { appDirectory: '/Users/parsa/.pane', platform: 'darwin' },
  { appDirectory: '/tmp/.pane-test', platform: 'linux' },
  { appDirectory: 'C:\\Users\\Parsa\\.pane', platform: 'win32' },
  { appDirectory: 'c:\\users\\parsa\\.pane', platform: 'win32' }
];

const artifactRelease = {
  tag_name: 'v2.2.8',
  name: 'v2.2.8',
  body: '',
  html_url: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.2.8',
  published_at: '2026-01-01T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    { name: 'Pane-2.2.8-linux-x86_64.AppImage', browser_download_url: 'https://example.test/linux-x64.AppImage' },
    { name: 'Pane-2.2.8-linux-arm64.AppImage', browser_download_url: 'https://example.test/linux-arm64.AppImage' },
    { name: 'Pane-2.2.8-linux-x86_64.deb', browser_download_url: 'https://example.test/linux-x64.deb' },
    { name: 'Pane-2.2.8-linux-arm64.deb', browser_download_url: 'https://example.test/linux-arm64.deb' },
    { name: 'Pane-2.2.8-macOS-arm64.dmg', browser_download_url: 'https://example.test/macos-arm64.dmg' },
    { name: 'Pane-2.2.8-macOS-arm64.zip', browser_download_url: 'https://example.test/macos-arm64.zip' },
    { name: 'Pane-2.2.8-macOS-x64.dmg', browser_download_url: 'https://example.test/macos-x64.dmg' },
    { name: 'Pane-2.2.8-macOS-x64.zip', browser_download_url: 'https://example.test/macos-x64.zip' },
    { name: 'Pane-2.2.8-Windows-x64.exe', browser_download_url: 'https://example.test/win-x64.exe' },
    { name: 'Pane-2.2.8-Windows-arm64.exe', browser_download_url: 'https://example.test/win-arm64.exe' }
  ]
};

const artifactCases = [
  { platform: { os: 'linux', arch: 'x64' }, format: 'appimage' },
  { platform: { os: 'linux', arch: 'arm64' }, format: 'appimage' },
  { platform: { os: 'linux', arch: 'x64' }, format: 'deb' },
  { platform: { os: 'darwin', arch: 'arm64' }, format: 'dmg' },
  { platform: { os: 'darwin', arch: 'x64' }, format: 'zip' },
  { platform: { os: 'win32', arch: 'x64' }, format: 'exe' },
  { platform: { os: 'win32', arch: 'arm64' }, format: 'exe' }
];

const existingReuseCases = [
  { args: ['install', 'daemon', '--pane-path', '/tmp/pane'], expected: true },
  { args: ['install', 'client', '--pane-path', '/tmp/pane'], expected: false },
  { args: ['install', '--pane-path', '/tmp/pane'], expected: false },
  { args: ['update', '--pane-path', '/tmp/pane'], expected: false }
];

const platformEdgeRelease = {
  tag_name: 'v2.2.8',
  name: 'v2.2.8',
  body: '',
  html_url: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.2.8',
  published_at: '2026-01-01T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    { name: 'Pane-2.2.8-darwin-x64.zip', browser_download_url: 'https://example.test/darwin-x64.zip' },
    { name: 'Pane-2.2.8-Windows-x64.zip', browser_download_url: 'https://example.test/windows-x64.zip' }
  ]
};

function ensureBuiltCli() {
  if (!fs.existsSync(npmCli)) {
    throw new Error('packages/runpane/dist/cli.js is missing. Run "pnpm --filter runpane build" first.');
  }
}

function checkGeneratedContractFresh() {
  childProcess.execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'generate-runpane-contract.js'), '--check'], {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

function checkContractDocListsEveryCommand() {
  const doc = fs.readFileSync(path.join(rootDir, 'docs', 'RUNPANE_CLI_CONTRACT.md'), 'utf8');
  const missing = contract.commands
    .flatMap((command) => command.usage)
    .filter((usage) => !doc.includes(usage));
  assert.deepStrictEqual(missing, [], 'docs/RUNPANE_CLI_CONTRACT.md is missing command usages');
}

function findPython() {
  for (const command of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      childProcess.execFileSync(command, ['--version'], { stdio: 'ignore' });
      return command;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not find a Python executable. Set PYTHON to override.');
}

function runPythonSnippet(source, input) {
  return childProcess.execFileSync(findPython(), ['-c', source], {
    cwd: rootDir,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: pythonSource
    }
  }).trim();
}

function assertIncludes(text, expected) {
  assert.ok(text.includes(expected), `Expected output to include: ${expected}`);
}

function matchesJsonSchema(value, schema) {
  if (schema.oneOf) {
    return schema.oneOf.filter((candidate) => matchesJsonSchema(value, candidate)).length === 1;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    return false;
  }
  if (schema.type === 'string') {
    return Object.prototype.toString.call(value) === '[object String]' && (!schema.minLength || value.length >= schema.minLength);
  }
  if (schema.type === 'number') {
    return Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value);
  }
  if (schema.type === 'object') {
    if (Object.prototype.toString.call(value) !== '[object Object]') return false;
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    return Object.entries(properties).every(([key, propertySchema]) => (
      !Object.prototype.hasOwnProperty.call(value, key) || matchesJsonSchema(value[key], propertySchema)
    ));
  }
  return true;
}

function assertMatchesJsonSchema(value, schema, label) {
  assert.ok(matchesJsonSchema(value, schema), `${label} does not match its JSON schema: ${JSON.stringify(value)}`);
}

function checkWatchFormatterGoldens() {
  const lines = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'watchLines.js'));
  assert.strictEqual(lines.effectiveWatchHeartbeatMs(180), 120_000);
  assert.strictEqual(lines.effectiveWatchHeartbeatMs(60), 60_000);
  const pythonHeartbeat = JSON.parse(runPythonSnippet(`
import json
from runpane.local_control import effective_watch_heartbeat_ms
print(json.dumps([effective_watch_heartbeat_ms(180), effective_watch_heartbeat_ms(60)]))
`));
  assert.deepStrictEqual(pythonHeartbeat, [120_000, 60_000]);
  const base = {
    gen: 7,
    at: '2026-08-28T00:00:00.000Z',
    paneId: 'pane-1',
    paneName: 'Issue\n538',
    panelId: 'panel-1',
  };
  const pr = { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc123' };
  const expected = [
    ['agent.ready', 'READY Issue 538 pane pane-1 panel panel-1'],
    ['agent.busy', 'BUSY Issue 538 pane pane-1 panel panel-1'],
    ['agent.blocked', 'BLOCKED Issue 538 pane pane-1 panel panel-1'],
    ['agent.unknown', 'UNKNOWN Issue 538 pane pane-1 panel panel-1'],
    ['agent.idle', 'IDLE Issue 538 10m pane pane-1 panel panel-1', { idleMs: 600000, idleCount: 1 }],
    ['pane.created', 'NEW Issue 538 pane pane-1'],
    ['pane.gone', 'GONE Issue 538 pane pane-1'],
    ['panel.exited', 'EXIT Issue 538 pane pane-1 panel panel-1 code 3', { exitCode: 3 }],
    ['panel.stopped', 'STOPPED Issue 538 pane pane-1 panel panel-1', { running: false }],
    ['panel.stopped', 'STOPPED Issue 538 pane pane-1 panel panel-1', { running: false, baseline: true, changedWhileAway: true }],
    ['pane.associated', 'JOINED Issue 538 pane pane-1 session session-9', { sessionId: 'session-9' }],
    ['pane.detached', 'LEFT Issue 538 pane pane-1 session session-9', { sessionId: 'session-9' }],
    ['pr.conflicted', 'PR Issue 538 pane pane-1 #747 CONFLICTED', { panelId: undefined, pr }],
    ['pr.checks', 'PR Issue 538 pane pane-1 #747 CHECKS PASSED', { panelId: undefined, pr, checks: 'passed' }],
    [
      'pr.checks',
      'PR Issue 538 pane pane-1 #747 CHECKS FAILED lint,unit_tests,e2e_a',
      { panelId: undefined, pr, checks: 'failed', failingChecks: ['lint', 'unit tests', 'e2e\na'] },
    ],
    ['pr.merged', 'PR Issue 538 pane pane-1 #747 MERGED', { panelId: undefined, pr }],
    [
      'pr.base_changed',
      'PR Issue 538 pane pane-1 #747 BASE CHANGED: The base changed from release/monday to main.',
      { panelId: undefined, pr, base: { from: 'release/monday', to: 'main' }, reason: 'The base changed from release/monday to main.' },
    ],
    [
      'pr.base_deleted',
      'PR Issue 538 pane pane-1 #747 BASE DELETED: The base branch release/monday was deleted.',
      { panelId: undefined, pr, base: { from: 'release/monday', to: 'release/monday' }, reason: 'The base branch release/monday was deleted.' },
    ],
    [
      'agent.report',
      'REPORT Issue 538 pane pane-1 panel panel-1 ready pr#747 fc5dce9',
      { source: 'agent', report: { state: 'ready', pr: 747, head: 'fc5dce9a0b1c', reportedAt: 'T' } },
    ],
    [
      'agent.report',
      `REPORT Issue 538 pane pane-1 panel panel-1 blocked: Which API version? ${'x'.repeat(180)}…`,
      { source: 'agent', report: { state: 'blocked', question: `Which API\nversion? ${'x'.repeat(400)}`, reportedAt: 'T' } },
    ],
    ['agent.report', 'REPORT Issue 538 pane pane-1 panel panel-1 done', { source: 'agent', report: { state: 'done', reportedAt: 'T' } }],
    ['agent.report.missing', 'MISSING REPORT Issue 538 pane pane-1 panel panel-1 ready', { source: 'agent', reason: 'ready', lastOutput: 'Done.' }],
    ['agent.report.missing', 'MISSING REPORT Issue 538 pane pane-1 panel panel-1 exited', { source: 'agent', reason: 'exited' }],
  ];
  for (const [kind, line, extra = {}] of expected) {
    assert.deepStrictEqual(
      lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [{ ...base, kind, ...extra }] }, 'lines'),
      [line],
    );
  }
  const pythonLines = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.local_control import format_workspace_entry_line
print(json.dumps([format_workspace_entry_line(entry) for entry in json.loads(sys.stdin.read())]))
`, JSON.stringify(expected.map(([kind, , extra = {}]) => ({ ...base, kind, ...extra })))));
  assert.deepStrictEqual(pythonLines, expected.map(([, line]) => line), 'Python watch lines must match npm');
  assert.deepStrictEqual(
    lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [{ ...base, kind: 'agent.ready', baseline: true }] }, 'lines'),
    [],
  );
  // A replayed baseline entry keeps its replay flag in JSON and prints nothing in lines mode.
  const replayed = { ...base, kind: 'agent.ready', baseline: true, replay: true };
  assert.deepStrictEqual(lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [replayed] }, 'lines'), []);
  assert.deepStrictEqual(
    lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [replayed] }, 'json').map(JSON.parse),
    [{ ...replayed, epoch: 'epoch-1' }],
  );
  assert.deepStrictEqual(
    lines.formatWaitResult({
      epoch: 'epoch-1',
      generation: 7,
      entries: [{ ...base, kind: 'agent.ready', baseline: true, changedWhileAway: true }],
    }, 'lines'),
    ['CHANGED Issue 538 pane pane-1 panel panel-1'],
  );
  const result = {
    epoch: 'epoch-1',
    generation: 7,
    reset: { reason: 'cursor-truncated' },
    dropped: 2,
    entries: [{ ...base, kind: 'agent.ready', heldInput: '[REDACTED]' }],
  };
  assert.deepStrictEqual(lines.formatWaitResult(result, 'lines'), [
    'RESET cursor-truncated epoch epoch-1',
    'DROPPED 2',
    'READY Issue 538 pane pane-1 panel panel-1',
    'STUCK Issue 538 pane pane-1 panel panel-1 held-input-present',
  ]);
  const jsonLines = lines.formatWaitResult(result, 'json').map(JSON.parse);
  assert.deepStrictEqual(jsonLines[0], { kind: '_reset', reason: 'cursor-truncated', epoch: 'epoch-1', generation: result.generation });
  assert.deepStrictEqual(jsonLines[1], { kind: '_dropped', count: 2, epoch: 'epoch-1', generation: result.generation });
  assert.deepStrictEqual(jsonLines[2], { ...result.entries[0], epoch: result.epoch }, 'JSON mode must preserve structured fields');
  assert.strictEqual(lines.formatNonEntry('_ok', { generation: 7, epoch: 'epoch-1' }, 'lines'), 'WATCH OK gen 7 epoch epoch-1');
  assert.strictEqual(lines.formatNonEntry('_heartbeat', { generation: 7, at: 'T' }, 'lines'), 'HEARTBEAT gen 7 at T');
  assert.strictEqual(lines.formatNonEntry('_reconnected', { generation: 8 }, 'lines'), 'WATCH RECONNECTED gen 8');
  assert.strictEqual(
    lines.formatNonEntry('_error', { code: 'E_BAD\nCODE', message: 'unsafe\nmessage' }, 'lines'),
    'WATCH ERROR E_BAD CODE: unsafe message',
  );
}

function watchResult(generation) {
  return {
    ok: true,
    epoch: 'test-epoch',
    generation,
    entries: [],
    timedOut: true,
    nextCommand: `runpane watch --since ${generation}`,
  };
}

function isExpectedClientDisconnect(error, socket) {
  if (error === null || error === undefined) return false;
  if (error.code === 'EPIPE' && error.syscall === 'write') return true;
  if (error.code === 'ECONNRESET' && error.syscall === 'read') return true;
  return error.code === 'ERR_STREAM_DESTROYED' && socket.destroyed;
}

async function withFakeDaemon(paneDir, onRequest, action, onFrame = () => {}) {
  const { getPaneDaemonEndpoint } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const endpoint = getPaneDaemonEndpoint(paneDir);
  if (endpoint.transport === 'unix') {
    fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
    fs.rmSync(endpoint.path, { force: true });
  }
  const pendingResponseTimers = new Map();
  const unexpectedSocketErrors = [];
  const rememberSocketError = (error, socket) => {
    if (isExpectedClientDisconnect(error, socket)) return;
    unexpectedSocketErrors.push(error);
  };
  const clearResponseTimers = (socket) => {
    const timers = pendingResponseTimers.get(socket);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    pendingResponseTimers.delete(socket);
  };
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', (error) => rememberSocketError(error, socket));
    socket.once('close', () => clearResponseTimers(socket));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!raw.trim()) continue;
        const frame = JSON.parse(raw);
        onFrame(frame);
        if (frame.type !== 'request' || frame.id !== 1) continue;
        const response = onRequest(frame);
        if (response.destroy) {
          socket.destroy();
          continue;
        }
        const timer = setTimeout(() => {
          const timers = pendingResponseTimers.get(socket);
          timers?.delete(timer);
          if (timers?.size === 0) pendingResponseTimers.delete(socket);
          if (!socket.destroyed) {
            socket.end(`${JSON.stringify({ type: 'response', id: 1, ok: true, result: response.result })}\n`, (error) => {
              if (error) rememberSocketError(error, socket);
            });
          }
        }, response.delayMs || 0);
        const timers = pendingResponseTimers.get(socket) ?? new Set();
        timers.add(timer);
        pendingResponseTimers.set(socket, timers);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint.path, resolve);
  });
  let actionResult;
  let actionError;
  let actionFailed = false;
  try {
    actionResult = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally {
    for (const timers of pendingResponseTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    pendingResponseTimers.clear();
    await new Promise((resolve) => server.close(resolve));
    if (endpoint.transport === 'unix') {
      fs.rmSync(endpoint.path, { force: true });
      fs.rmSync(path.dirname(endpoint.path), { recursive: true, force: true });
    }
  }
  if (actionFailed) throw actionError;
  if (unexpectedSocketErrors.length > 0) throw unexpectedSocketErrors[0];
  return actionResult;
}

/** Run watch until it exits by itself, for checking its exit code. */
function runWatchToExit(runtime, args, paneDir, timeoutMs = 8_000) {
  return runWatchCli(runtime, args, paneDir, () => false, timeoutMs, {}, true);
}

function runWatchCli(runtime, args, paneDir, until, timeoutMs = 8_000, extraEnv = {}, toExit = false) {
  const python = runtime === 'pip' ? findPython() : undefined;
  const command = runtime === 'npm' ? process.execPath : python;
  const commandArgs = runtime === 'npm' ? [npmCli, ...args] : ['-m', 'runpane', ...args];
  const env = {
    ...process.env,
    PANE_DIR: paneDir,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource,
    RUNPANE_TELEMETRY_DISABLED: '1',
  };
  delete env.PANE_PANEL_ID;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, commandArgs, { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let matched = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${runtime} watch timed out. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    const inspect = () => {
      if (!matched && until(stdout, stderr)) {
        matched = true;
        child.kill();
      }
    };
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); inspect(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); inspect(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!toExit && !matched && !until(stdout, stderr)) {
        reject(new Error(`${runtime} watch exited before expected output (${code}/${signal}). stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr, code, signal });
    });
  });
}

function runCliOnce(runtime, args, paneDir, timeoutMs = 20_000, extraEnv = {}) {
  const command = runtime === 'npm' ? process.execPath : findPython();
  const commandArgs = runtime === 'npm' ? [npmCli, ...args] : ['-m', 'runpane', ...args];
  const env = {
    ...process.env,
    PANE_DIR: paneDir,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource,
    RUNPANE_TELEMETRY_DISABLED: '1',
  };
  delete env.PANE_PANEL_ID;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, commandArgs, { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${runtime} ${args.join(' ')} timed out. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkPanesAdoptCliParity() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-adopt-'));
  const args = [
    'panes', 'adopt', '--repo', 'active', '--path', path.join(paneDir, 'existing-worktree'),
    '--name', 'adopted', '--agent', 'claude', '--resume', 'agent-session-1', '--folder', 'Imported',
    '--launch', '--yes', '--json',
  ];
  const daemonResult = {
    ok: true,
    repo: { id: 1, name: 'Pane', path: '/repo', active: true, sessionCount: 1 },
    items: [{ ok: true, index: 0, name: 'adopted', pinned: true, sessionId: 'session-1' }],
  };
  const frames = {};
  try {
    for (const runtime of ['npm', 'pip']) {
      const run = await withFakeDaemon(
        paneDir,
        (frame) => {
          frames[runtime] = frame;
          return { result: daemonResult };
        },
        () => runCliOnce(runtime, args, paneDir),
      );
      assert.strictEqual(run.code, 0, `${runtime} panes adopt exited ${run.code}. stdout=${run.stdout} stderr=${run.stderr}`);
      assert.deepStrictEqual(JSON.parse(run.stdout), daemonResult, `${runtime} panes adopt printed the wrong result`);
    }
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
  assert.strictEqual(frames.npm.channel, 'runpane:panes:adopt');
  assert.deepStrictEqual(frames.pip, frames.npm, 'Python and Node panes adopt sent different daemon requests');
}

async function checkPanesCreateBaseNotice() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-create-base-'));
  const notice = 'Could not refresh origin/main before creating this Pane (git fetch timed out after 10s). '
    + 'It starts from the local origin/main at b08541d, which may be behind the remote. '
    + 'Check the network or credentials, then run `git pull --rebase origin main` in the Pane if it needs newer commits.';
  const item = {
    ok: true, index: 0, name: 'worker', pinned: false, sessionId: 'session-1', paneId: 'session-1',
    base: { ref: 'origin/main', commit: 'b08541d7', refresh: 'failed', notice },
  };
  const daemonResult = { ok: true, repo: { id: 1, name: 'Pane', path: '/repo', active: true, sessionCount: 1 }, items: [item] };
  // A field this CLI doesn't know yet is dropped, not rejected: that is how an
  // older CLI reads `base`.
  const futureResult = { ...daemonResult, items: [{ ...item, fromAFutureDaemon: { anything: true } }] };
  try {
    for (const runtime of ['npm', 'pip']) {
      const run = (args) => withFakeDaemon(paneDir, () => ({ result: futureResult }), () => runCliOnce(runtime, args, paneDir));
      const human = await run(['panes', 'create', '--repo', 'active', '--name', 'worker', '--agent', 'claude', '--yes']);
      assert.strictEqual(human.code, 0, `${runtime} panes create exited ${human.code}. stdout=${human.stdout} stderr=${human.stderr}`);
      assertIncludes(human.stdout.replace(/\r\n/g, '\n'), `\n  ! ${notice}\n`);
      const json = await run(['panes', 'create', '--repo', 'active', '--name', 'worker', '--agent', 'claude', '--yes', '--json']);
      assert.strictEqual(json.code, 0, `${runtime} panes create --json exited ${json.code}. stderr=${json.stderr}`);
      assert.deepStrictEqual(JSON.parse(json.stdout).items[0].base, item.base, `${runtime} panes create --json lost base`);
      if (runtime === 'npm') {
        assert.deepStrictEqual(JSON.parse(json.stdout), daemonResult, 'npm panes create --json kept an unknown field');
      }
    }
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

async function checkWatchStreamParity() {
  for (const runtime of ['npm', 'pip']) {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), `runpane-watch-${runtime}-`));
    const requests = [];
    try {
      const selfTest = await withFakeDaemon(
        paneDir,
        (frame) => {
          requests.push(frame.args[0]);
          return { result: watchResult(5) };
        },
        () => runWatchCli(runtime, ['watch', '--self-test', '--as', 'named-backlog'], paneDir, stdout => stdout.includes('WATCH OK gen 5 epoch test-epoch')),
      );
      assertIncludes(selfTest.stdout, 'WATCH OK gen 5 epoch test-epoch');
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].as, undefined, 'self-test must not use or advance a named cursor');
      assert.strictEqual(requests[0].since, undefined);
      assert.strictEqual(requests[0].from, 'now');
      assert.strictEqual(requests[0].timeoutMs, 0);
      assert.strictEqual(requests[0].idleAfterMs, 0);

      const oneShot = await withFakeDaemon(
        paneDir,
        () => ({ result: {
          ...watchResult(6),
          entries: [{
            gen: 6,
            at: '2026-08-28T00:00:00.000Z',
            kind: 'agent.ready',
            paneId: 'pane-1',
            paneName: 'One',
            panelId: 'panel-1',
            source: 'agent',
          }],
        } }),
        () => runWatchCli(runtime, ['watch', '--json', '--timeout-ms', '0'], paneDir, stdout => stdout.includes('"kind":"agent.ready"')),
      );
      assert.ok(!oneShot.stdout.includes('"kind":"_ok"'), 'one-shot JSON must retain its legacy entry-only shape');

      const healthyTimeouts = [];
      const healthy = await withFakeDaemon(
        paneDir,
        frame => {
          healthyTimeouts.push(frame.args[0].timeoutMs);
          return { result: watchResult(7), delayMs: Math.min(700, frame.args[0].timeoutMs) };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--heartbeat', '1', '--idle-after', '0', '--no-held-input'],
          paneDir,
          stdout => stdout.includes('HEARTBEAT gen 7 at '),
        ),
      );
      assertIncludes(healthy.stdout, 'HEARTBEAT gen 7 at ');
      assert.ok(healthyTimeouts.length >= 2, 'healthy follow must issue a second wait after the early response');
      assert.ok(healthyTimeouts[1] <= 600, 'second wait must use the remaining heartbeat deadline');

      let requestCount = 0;
      const followRequests = [];
      const follow = await withFakeDaemon(
        paneDir,
        (frame) => {
          followRequests.push(frame.args[0]);
          requestCount += 1;
          if (requestCount === 2) return { destroy: true };
          return { result: watchResult(requestCount === 1 ? 1 : 2), delayMs: requestCount >= 3 ? 1_100 : 0 };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--heartbeat', '1', '--idle-after', '0', '--no-held-input', '--timeout-ms', '1000'],
          paneDir,
          stdout => stdout.includes('WATCH RECONNECTED gen 2') && stdout.includes('HEARTBEAT gen 2 at '),
        ),
      );
      const markers = follow.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        if (line.startsWith('WATCH OK')) return 'OK';
        if (line.startsWith('WATCH ERROR')) return 'ERROR';
        if (line.startsWith('WATCH RECONNECTED')) return 'RECONNECTED';
        if (line.startsWith('HEARTBEAT')) return 'HEARTBEAT';
        return line;
      });
      assert.deepStrictEqual(markers.slice(0, 4), ['OK', 'ERROR', 'RECONNECTED', 'HEARTBEAT']);
      assert.ok(followRequests[0].as.startsWith('follow-'));
      assert.strictEqual(followRequests[1].idleWindowStartMs, undefined, 'follow cadence uses a named cursor');

      const cadenceRequests = [];
      await withFakeDaemon(
        paneDir,
        (frame) => {
          cadenceRequests.push(frame.args[0]);
          return { result: watchResult(3), delayMs: 0 };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--heartbeat', '1', '--idle-after', '0', '--no-held-input', '--timeout-ms', '1000',
            '--kinds', 'agent.ready,agent.blocked', '--ready-settle', '180000', '--blocked-settle', '30000', '--min-interval', '600000'],
          paneDir,
          stdout => stdout.includes('WATCH OK gen 3'),
        ),
      );
      assert.deepStrictEqual(
        {
          settleMs: cadenceRequests[0].settleMs,
          blockedSettleMs: cadenceRequests[0].blockedSettleMs,
          minIntervalMs: cadenceRequests[0].minIntervalMs,
          idleBackoff: cadenceRequests[0].idleBackoff,
          kinds: cadenceRequests[0].kinds,
        },
        { settleMs: 180000, blockedSettleMs: 30000, minIntervalMs: 600000, idleBackoff: true, kinds: ['agent.ready', 'agent.blocked'] },
      );
      assert.ok(String(cadenceRequests[0].as).startsWith('follow-'), 'cadence follow must name its consumer');

      const selfTestRequests = [];
      await withFakeDaemon(
        paneDir,
        (frame) => {
          selfTestRequests.push(frame.args[0]);
          return { result: watchResult(4) };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--self-test', '--ready-settle', '180000', '--min-interval', '600000'],
          paneDir,
          stdout => stdout.includes('WATCH OK gen 4'),
        ),
      );
      assert.strictEqual(selfTestRequests[0].as, undefined, 'self-test must stay anonymous so the daemon applies no cadence');

      // --quiet drops HEARTBEAT and RECONNECTED but keeps WATCH OK once, WATCH ERROR, and entries.
      let quietCount = 0;
      const quiet = await withFakeDaemon(
        paneDir,
        () => {
          quietCount += 1;
          if (quietCount === 2) return { destroy: true };
          const entries = quietCount >= 4 ? [{
            gen: quietCount, at: '2026-09-27T00:00:00.000Z', kind: 'agent.ready', paneId: 'pane-1', paneName: 'Quiet', panelId: 'panel-1', source: 'agent',
          }] : [];
          return { result: { ...watchResult(quietCount), entries }, delayMs: quietCount >= 3 ? 1_100 : 0 };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--heartbeat', '1', '--idle-after', '0', '--no-held-input', '--timeout-ms', '1000'],
          paneDir,
          stdout => stdout.includes('READY Quiet pane pane-1 panel panel-1'),
        ),
      );
      assertIncludes(quiet.stdout, 'WATCH ERROR');
      assert.strictEqual(quiet.stdout.split('WATCH OK').length - 1, 1, `${runtime} --quiet must print WATCH OK exactly once: ${quiet.stdout}`);
      assertIncludes(quiet.stdout, 'WATCH RECONNECTED');

      // --expire-after ends a quiet follow with WATCH EXPIRED and exit 0; IDLE re-fires don't count as activity.
      const idleOnly = await withFakeDaemon(
        paneDir,
        (frame) => ({ result: { ...watchResult(20), entries: [{
          gen: 20, at: '2026-09-27T00:00:00.000Z', kind: 'agent.idle', paneId: 'pane-1', paneName: 'Idle', panelId: 'panel-1', source: 'agent',
        }] }, delayMs: Math.min(frame.args[0].timeoutMs, 300) }),
        () => runWatchToExit(runtime, ['watch', '--follow', '--json', '--idle-after', '0', '--no-held-input', '--expire-after', '1500'], paneDir),
      );
      assert.strictEqual(idleOnly.code, 0, `${runtime} --expire-after must exit 0: ${idleOnly.stdout} ${idleOnly.stderr}`);
      const idleKinds = idleOnly.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).kind);
      assert.strictEqual(idleKinds[0], '_ok', `${runtime} must arm with _ok first: ${idleOnly.stdout}`);
      assert.strictEqual(idleKinds.at(-1), '_expired', `${runtime} must end with _expired: ${idleOnly.stdout}`);
      assert.ok(idleKinds.includes('agent.idle'), `${runtime} must still print IDLE lines: ${idleOnly.stdout}`);

      // Visible events and activity hidden by output filters both reset quiet expiry.
      for (const hiddenActivity of [false, true]) {
      let resetCount = 0;
      const startedAt = Date.now();
      const reset = await withFakeDaemon(
        paneDir,
        (frame) => {
          resetCount += 1;
          const entries = !hiddenActivity && resetCount === 2 ? [{
            gen: 21, at: '2026-09-27T00:00:00.000Z', kind: 'agent.ready', paneId: 'pane-1', paneName: 'Busy', panelId: 'panel-1', source: 'agent',
          }] : [];
          return { result: { ...watchResult(21), entries, activityGeneration: resetCount === 1 ? 20 : 21 }, delayMs: resetCount === 1 ? 0 : Math.min(frame.args[0].timeoutMs, 1_000) };
        },
        () => runWatchToExit(runtime, ['watch', '--follow', '--idle-after', '0', '--no-held-input', '--expire-after', '1500'], paneDir),
      );
      const elapsedMs = Date.now() - startedAt;
      assert.strictEqual(reset.code, 0, `${runtime}: ${reset.stdout} ${reset.stderr}`);
      if (!hiddenActivity) assertIncludes(reset.stdout, 'READY Busy pane pane-1 panel panel-1');
      assertIncludes(reset.stdout, 'WATCH EXPIRED after 1500ms quiet');
      assert.ok(elapsedMs >= 2_400, `${runtime} activity (hidden=${hiddenActivity}) must reset expiry (exited after ${elapsedMs}ms)`);
      }

      for (const [args, message] of [
        [['watch', '--expire-after', '1000'], '--expire-after require --follow'],
      ]) {
        const invalid = await runCliOnce(runtime, args, paneDir);
        assert.notStrictEqual(invalid.status ?? invalid.code, 0, `${runtime} ${args.join(' ')} must fail`);
        assertIncludes(`${invalid.stdout}${invalid.stderr}`, message);
      }

      const quietSelfTest = await withFakeDaemon(
        paneDir,
        () => ({ result: watchResult(9) }),
        () => runWatchCli(runtime, ['watch', '--self-test'], paneDir, stdout => stdout.includes('WATCH OK gen 9')),
      );
      assertIncludes(quietSelfTest.stdout, 'WATCH OK gen 9');

      // JSON follow requests held-input presence (STUCK's JSON form) and shortens a long PANE_PANEL_ID cursor.
      const longPanelId = `__orchestration_panel___orchestration_session_${'a'.repeat(36)}__terminal___claude`;
      const jsonRequests = [];
      const jsonFollow = await withFakeDaemon(
        paneDir,
        (frame) => {
          jsonRequests.push(frame.args[0]);
          return { result: {
            ...watchResult(11),
            entries: [{
              gen: 11, at: '2026-09-27T00:00:00.000Z', kind: 'agent.ready', paneId: 'pane-1', paneName: 'Held', panelId: 'panel-1', source: 'agent', heldInputPresent: true,
            }],
          } };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--follow', '--json', '--idle-after', '0'],
          paneDir,
          stdout => stdout.includes('"heldInputPresent":true'),
          8_000,
          { PANE_PANEL_ID: longPanelId },
        ),
      );
      assert.strictEqual(jsonFollow.stdout.split('"kind":"_ok"').length - 1, 1, `${runtime} --quiet must keep exactly one _ok in JSON`);
      assert.strictEqual(jsonRequests[0].includeHeldInputPresence, true, `${runtime} JSON follow must request held-input presence`);
      const expectedCursor = `panel-${require('crypto').createHash('sha256').update(longPanelId).digest('hex').slice(0, 12)}`;
      assert.strictEqual(jsonRequests[0].as, expectedCursor, `${runtime} must shorten a long derived cursor name`);

      // --session forwards the selector to the daemon, names its cursor session-<uuid>, and prints JOINED/LEFT.
      const sessionId = `__orchestration_session_${'b'.repeat(8)}-2fa1-11d2-883f-0016d3cca427__`;
      const sessionRequests = [];
      const sessionFollow = await withFakeDaemon(
        paneDir,
        (frame) => {
          sessionRequests.push(frame.args[0]);
          return { result: {
            ...watchResult(12),
            session: { id: sessionId, name: 'Release' },
            entries: [
              { gen: 12, at: '2026-09-27T00:00:00.000Z', kind: 'pane.associated', paneId: 'pane-2', paneName: 'Worker', source: 'session', sessionId, sessionName: 'Release' },
              { gen: 13, at: '2026-09-27T00:00:00.000Z', kind: 'pane.detached', paneId: 'pane-2', paneName: 'Worker', source: 'session', sessionId, sessionName: 'Release' },
              { gen: 14, at: '2026-09-27T00:00:00.000Z', kind: 'pr.conflicted', paneId: 'pane-3', paneName: 'Worker 3', source: 'github', pr: { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc' } },
              { gen: 15, at: '2026-09-27T00:00:00.000Z', kind: 'pr.checks', paneId: 'pane-3', paneName: 'Worker 3', source: 'github', pr: { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc' }, checks: 'failed', failingChecks: ['lint', 'test'] },
              { gen: 16, at: '2026-09-27T00:00:00.000Z', kind: 'pr.merged', paneId: 'pane-3', paneName: 'Worker 3', source: 'github', pr: { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc' } },
            ],
          } };
        },
        () => runWatchCli(
          runtime,
          ['watch', '--session', sessionId, '--follow', '--idle-after', '0', '--no-held-input'],
          paneDir,
          stdout => stdout.includes('#747 MERGED'),
          8_000,
          { PANE_PANEL_ID: 'panel-orchestrator' },
        ),
      );
      assertIncludes(sessionFollow.stdout, `JOINED Worker pane pane-2 session ${sessionId}`);
      assertIncludes(sessionFollow.stdout, 'LEFT Worker pane pane-2');
      assertIncludes(sessionFollow.stdout, 'PR Worker 3 pane pane-3 #747 CONFLICTED');
      assertIncludes(sessionFollow.stdout, 'PR Worker 3 pane pane-3 #747 CHECKS FAILED lint,test');
      assertIncludes(sessionFollow.stdout, 'PR Worker 3 pane pane-3 #747 MERGED');
      assert.strictEqual(sessionRequests[0].session, sessionId, `${runtime} must forward --session to the daemon`);
      assert.strictEqual(sessionRequests[0].paneIds, undefined);
      assert.strictEqual(sessionRequests[0].as, 'session-bbbbbbbb-2fa1-11d2-883f-0016d3cca427', `${runtime} must default the cursor to session-<uuid>`);

      const namedSessionRequests = [];
      const namedSession = await withFakeDaemon(
        paneDir,
        (frame) => {
          namedSessionRequests.push(frame.args[0]);
          return { result: { ...watchResult(14), session: { id: sessionId, name: 'Release train' } } };
        },
        () => runWatchCli(runtime, ['watch', '--session', 'Release train', '--follow', '--json'], paneDir, stdout => stdout.includes('"kind":"_ok"')),
      );
      assertIncludes(namedSession.stdout, '"kind":"_ok"');
      const expectedNamedCursor = `session-${require('crypto').createHash('sha256').update('session-Release train').digest('hex').slice(0, 12)}`;
      assert.strictEqual(namedSessionRequests[0].as, expectedNamedCursor, `${runtime} must shorten a Session name that is not a portable cursor`);

      const oldDaemon = await withFakeDaemon(
        paneDir,
        () => ({ result: watchResult(15) }),
        () => runWatchCli(runtime, ['watch', '--session', sessionId, '--follow'], paneDir, stdout => stdout.includes('WATCH ERROR')),
      );
      assertIncludes(oldDaemon.stdout, 'does not support runpane watch --session');
      assert.ok(!oldDaemon.stdout.includes('WATCH OK'), `${runtime} must not arm a --session watch on a daemon that ignores it`);

      for (const badWatchArgs of [
        ['watch', '--heartbeat', 'nope'],
        ['watch', '--follow', '--ready-settle', 'nope'],
        ['watch', '--ready-settle', '5'],
        ['watch', '--follow', '--since', '42', '--ready-settle', '180000'],
        ['watch', '--follow', '--session', 'my-session', '--pane', 'pane-1'],
        ['watch', '--until-event', '--follow'],
        ['watch', '--until-event', '--self-test'],
        ['watch', '--until-event', '--timeout-ms', '0'],
      ]) {
        const badWatch = spawnWatchCli(runtime, badWatchArgs, paneDir);
        assert.strictEqual(badWatch.status, 2, `${badWatchArgs.join(' ')} must fail`);
        assertIncludes(badWatch.stdout, 'WATCH ERROR');
        assertIncludes(badWatch.stderr, 'WATCH ERROR');
      }
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

/** Python prints CRLF on Windows; exact-output checks compare lines. */
function lf(text) {
  return text.replace(/\r\n/g, '\n');
}

function reportEntry(gen, panelId, extra = {}) {
  return {
    gen, at: '2026-10-14T20:00:00.000Z', kind: 'agent.report', paneId: 'pane-1', paneName: 'Worker', panelId, source: 'agent',
    report: { state: 'blocked', question: 'q', reportedAt: '2026-10-14T20:00:00.000Z' }, ...extra,
  };
}

/** A fake daemon that answers the n-th watch request with `responses[n]` (the last one repeats). */
function scriptedWatch(responses, requests) {
  return (frame) => {
    requests.push(frame.args[0]);
    return responses[Math.min(requests.length, responses.length) - 1];
  };
}

/** `panels submit --wait`: deliver, then follow the journal from the daemon's pre-delivery position, on that panel only. */
async function checkDispatchWait() {
  const submitted = {
    ok: true, epoch: 'dispatch-epoch', generation: 10, panelId: 'panel-2', paneId: 'pane-1', inputBytes: 7, enter: 'cr', sequenceName: 'enter-cr',
    verifiedSubmitted: true, sentAt: '2026-10-16T19:00:00.000Z', expectedReport: { since: '2026-10-16T19:00:00.000Z' },
  };
  const at = '2026-10-16T19:01:00.000Z';
  const otherPanel = { gen: 11, at, kind: 'agent.blocked', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-9', source: 'agent', screenLines: ['Allow?'] };
  const missing = {
    gen: 12, at, kind: 'agent.report.missing', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-2', source: 'agent',
    reason: 'ready', lastOutput: 'DONE', lastOutputSource: 'transcript', expectedSince: submitted.expectedReport.since,
  };
  const report = { ...reportEntry(12, 'panel-2'), report: { state: 'done', pr: 7, head: 'abc1234', summary: 'Shipped.', summaryPath: '/tmp/s.md', reportedAt: at } };
  const dispatch = ['panels', 'submit', '--panel', 'panel-2', '--text', 'ship it', '--wait', '--yes'];
  for (const runtime of ['npm', 'pip']) {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), `runpane-dispatch-${runtime}-`));
    try {
      const daemon = (waits, requests) => (frame) => {
        requests.push({ channel: frame.channel, ...frame.args[0] });
        if (frame.channel === 'runpane:panels:submit') return { result: submitted };
        const index = requests.filter(request => request.channel === 'runpane:workspace:wait').length;
        return waits[Math.min(index, waits.length) - 1];
      };

      let requests = [];
      let run = await withFakeDaemon(paneDir, daemon([
        { result: { ...watchResult(11), timedOut: false, entries: [otherPanel] } },
        { result: { ...watchResult(12), timedOut: false, entries: [missing] }, delayMs: 100 },
      ], requests), () => runCliOnce(runtime, dispatch, paneDir));
      assert.strictEqual(run.code, 3, `${runtime} --wait exits 3 for a missing report. stdout=${run.stdout} stderr=${run.stderr}`);
      assert.deepStrictEqual(JSON.parse(run.stdout), {
        ok: false, outcome: 'missing', paneId: 'pane-1', paneName: 'Worker', generation: 12, at, panelId: 'panel-2',
        lastOutput: 'DONE', lastOutputSource: 'transcript', reason: 'ready',
      }, `${runtime} prints one compact line and skips another panel's prompt`);
      assert.strictEqual(lf(run.stdout).split('\n').filter(Boolean).length, 1);
      assert.strictEqual(requests[0].expectReport, true, `${runtime} --wait turns the expected report on`);
      const waits = requests.filter(request => request.channel === 'runpane:workspace:wait');
      assert.deepStrictEqual(waits.map(request => request.since), [10, 11], `${runtime} follows from the pre-delivery generation`);
      assert.strictEqual(waits[0].epoch, 'dispatch-epoch');
      assert.strictEqual(waits[1].epoch, 'test-epoch');
      assert.deepStrictEqual(waits[0].paneIds, ['pane-1']);
      assert.deepStrictEqual(waits[0].kinds, ['agent.report', 'agent.report.missing', 'agent.blocked', 'panel.exited', 'pane.gone']);

      requests = [];
      run = await withFakeDaemon(paneDir, daemon([{ result: { ...watchResult(12), timedOut: false, entries: [report] } }], requests),
        () => runCliOnce(runtime, dispatch, paneDir));
      assert.strictEqual(run.code, 0, `${runtime} --wait exits 0 for a report. stderr=${run.stderr}`);
      assert.deepStrictEqual(JSON.parse(run.stdout).report, { state: 'done', pr: 7, head: 'abc1234', summary: 'Shipped.', summaryPath: '/tmp/s.md' });

      // Dispatch promises one JSON record even when its watch reconnects.
      for (const flags of [[], ['--json']]) {
        requests = [];
        run = await withFakeDaemon(paneDir, daemon([
          { destroy: true },
          { result: { ...watchResult(12), timedOut: false, entries: [report] } },
        ], requests), () => runCliOnce(runtime, [...dispatch, ...flags], paneDir));
        assert.strictEqual(run.code, 0, `${runtime} reconnects dispatch successfully: ${run.stderr}`);
        assert.strictEqual(lf(run.stdout).split('\n').filter(Boolean).length, 1,
          `${runtime} reconnect diagnostics must not pollute the single dispatch result: ${run.stdout}`);
        assert.strictEqual(JSON.parse(run.stdout).outcome, 'report');
        assert.strictEqual(requests.filter(request => request.channel === 'runpane:workspace:wait').length, 2);
      }

      requests = [];
      run = await withFakeDaemon(paneDir, daemon([{ result: { ...watchResult(10), timedOut: true }, delayMs: 50 }], requests),
        () => runCliOnce(runtime, [...dispatch, '--timeout', '1s'], paneDir));
      assert.strictEqual(run.code, 124, `${runtime} --wait --timeout exits 124. stdout=${run.stdout} stderr=${run.stderr}`);
      assert.strictEqual(JSON.parse(run.stdout).outcome, 'timeout');

      for (const reset of ['cursor-truncated', 'epoch-changed']) {
        requests = [];
        run = await withFakeDaemon(paneDir, daemon([{ result: {
          ...watchResult(20), reset: { reason: reset }, dropped: reset === 'cursor-truncated' ? 4 : undefined,
          entries: [{ ...report, replay: true }],
        } }], requests), () => runCliOnce(runtime, [...dispatch, '--timeout', '1s'], paneDir));
        assert.strictEqual(run.code, 6, `${runtime} reports lost history without accepting replay or timing out: ${run.stdout} ${run.stderr}`);
        assert.strictEqual(JSON.parse(run.stdout).outcome, 'indeterminate');
        assert.match(JSON.parse(run.stdout).nextCommand, /inbox|screen/);
        assert.strictEqual(requests.filter(request => request.channel === 'runpane:workspace:wait').length, 1);
      }
      requests = [];
      const multiPaneFile = path.join(paneDir, 'multi.json');
      fs.writeFileSync(multiPaneFile, JSON.stringify({ repo: 'active', panes: [
        { name: 'one', tool: { agent: 'claude' } }, { name: 'two', tool: { agent: 'claude' } },
      ] }));
      run = await withFakeDaemon(paneDir, daemon([], requests), () => runCliOnce(runtime, [
        'panes', 'create', '--from-json', multiPaneFile, '--wait', '--yes',
      ], paneDir));
      assert.notStrictEqual(run.code, 0);
      assert.match(run.stderr, /accepts one Pane/);
      assert.deepStrictEqual(requests, [], `${runtime} rejects multi-Pane wait before any daemon mutation`);

      for (const args of [[...dispatch, '--no-expect-report'], ['panels', 'submit', '--panel', 'panel-2', '--text', 'x', '--timeout', '1s', '--yes']]) {
        run = await runCliOnce(runtime, args, paneDir);
        assert.notStrictEqual(run.code, 0, `${runtime} refuses ${args.slice(-2).join(' ')}`);
      }
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

async function checkWatchUntilEvent() {
  const quietJson = ['watch', '--as', 'orch', '--until-event', '--json', '--kinds', 'agent.report'];
  for (const runtime of ['npm', 'pip']) {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), `runpane-until-${runtime}-`));
    try {
      // Exit-to-wake: the first event is printed alone and the process exits 0 by itself.
      const entry = reportEntry(6, 'panel-2');
      let requests = [];
      let run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(6), timedOut: false, entries: [entry] }, delayMs: 200 },
      ], requests), () => runCliOnce(runtime, quietJson, paneDir));
      assert.strictEqual(run.code, 0, `${runtime} --until-event must exit 0 on its event. stdout=${run.stdout} stderr=${run.stderr}`);
      assert.strictEqual(lf(run.stdout), `${JSON.stringify({ ...entry, epoch: watchResult(6).epoch })}\n`, `${runtime} --until-event --json prints the event and its epoch`);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].as, 'orch');
      assert.deepStrictEqual(requests[0].kinds, ['agent.report']);
      assert.strictEqual(requests[0].agentsOnly, true, `${runtime} --until-event keeps the --follow agents-only default`);
      for (const field of ['settleMs', 'blockedSettleMs', 'minIntervalMs']) {
        assert.strictEqual(requests[0][field], undefined, `${runtime} --until-event must not send follow cadence`);
      }
      assert.ok(!requests[0].idleBackoff, `${runtime} --until-event must not enable follow backoff`);

      requests = [];
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(6), timedOut: false, entries: [entry] } },
      ], requests), () => runCliOnce(runtime, ['watch', '--as', 'orch', '--until-event', '--kinds', 'agent.report'], paneDir));
      assert.strictEqual(run.code, 0);
      assert.strictEqual(lf(run.stdout), 'REPORT Worker pane pane-1 panel panel-2 blocked: q\n', `${runtime} lines mode prints the REPORT line`);

      // A new cursor's RESET is printed and does not end the wait.
      requests = [];
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(5), timedOut: false, reset: { reason: 'first-use' } } },
        { result: { ...watchResult(6), timedOut: false, entries: [entry] }, delayMs: 100 },
      ], requests), () => runCliOnce(runtime, quietJson, paneDir));
      assert.strictEqual(run.code, 0);
      assert.ok(lf(run.stdout).endsWith(`${JSON.stringify({ ...entry, epoch: watchResult(6).epoch })}\n`), `${runtime} must keep waiting past RESET`);
      assertIncludes(run.stdout, '_reset');
      assert.deepStrictEqual(requests.map(request => request.as), ['orch', 'orch'], `${runtime} re-arms the same named cursor`);

      // A numeric cursor detects epoch rollover even if the new journal has caught up.
      requests = [];
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(8), epoch: 'new-epoch', reset: { reason: 'epoch-changed' }, timedOut: false,
          entries: [reportEntry(8, 'panel-2', { replay: true, baseline: true })] } },
        { result: { ...watchResult(9), epoch: 'new-epoch', timedOut: false, entries: [reportEntry(9, 'panel-2')] } },
      ], requests), () => runCliOnce(runtime, ['watch', '--since', '6', '--epoch', 'old-epoch', '--until-event', '--json', '--kinds', 'agent.report'], paneDir));
      assert.strictEqual(run.code, 0);
      const resetOutput = run.stdout.trim().split('\n').map(JSON.parse);
      assert.deepStrictEqual(resetOutput[0], { kind: '_reset', reason: 'epoch-changed', epoch: 'new-epoch', generation: 8 });
      assert.deepStrictEqual(requests.map(request => [request.since, request.epoch, request.as]), [[6, 'old-epoch', undefined], [8, 'new-epoch', undefined]]);
      assert.strictEqual(resetOutput.at(-1).gen, 9);
      assert.strictEqual(resetOutput.at(-1).epoch, 'new-epoch');

      // A new process resumes after exactly the processed gen, not the response watermark.
      requests = [];
      const delivered = resetOutput.at(-1);
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(11), epoch: delivered.epoch, timedOut: false, entries: [reportEntry(10, 'panel-2'), reportEntry(11, 'panel-2')] } },
      ], requests), () => runCliOnce(runtime, ['watch', '--since', String(delivered.gen), '--epoch', delivered.epoch, '--until-event', '--json', '--kinds', 'agent.report'], paneDir));
      assert.strictEqual(run.code, 0);
      assert.deepStrictEqual(run.stdout.trim().split('\n').map(JSON.parse).map(event => [event.gen, event.epoch]), [[10, 'new-epoch'], [11, 'new-epoch']]);
      assert.strictEqual(requests[0].since, 9);

      // Waits past the per-call cap: empty, timed-out calls re-arm with no overall limit.
      requests = [];
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: watchResult(5) },
        { result: watchResult(5) },
        { result: { ...watchResult(6), timedOut: false, entries: [entry] } },
      ], requests), () => runCliOnce(runtime, quietJson, paneDir));
      assert.strictEqual(run.code, 0);
      assert.strictEqual(requests.length, 3, `${runtime} must re-arm after an empty call`);
      assert.ok(requests.every(request => request.timeoutMs > 0 && request.timeoutMs <= 120_000), `${runtime} per-call wait stays capped`);

      // The caller's own panel never ends the wait; another panel's entry does.
      requests = [];
      const ownEntry = reportEntry(5, 'panel-own');
      run = await withFakeDaemon(paneDir, scriptedWatch([
        { result: { ...watchResult(5), timedOut: false, entries: [ownEntry] } },
        { result: { ...watchResult(6), timedOut: false, entries: [entry] } },
      ], requests), () => runCliOnce(runtime, ['watch', '--until-event', '--json', '--kinds', 'agent.report'], paneDir, 20_000, { PANE_PANEL_ID: 'panel-own' }));
      assert.strictEqual(run.code, 0);
      assert.strictEqual(lf(run.stdout), `${JSON.stringify({ ...entry, epoch: watchResult(6).epoch })}\n`, `${runtime} must drop its own panel's entries`);
      assert.strictEqual(requests.length, 2);
      // Without --as, a Pane terminal gets a stable cursor apart from its --follow cursor (the panel id).
      assert.strictEqual(requests[0].as, 'until-panel-own', `${runtime} derives a stable --until-event cursor`);
      assert.strictEqual(requests[1].as, 'until-panel-own');

      // --timeout-ms is a total deadline: exit 124 with a timeout control line.
      for (const [format, expected] of [['lines', 'WATCH TIMEOUT'], ['json', '"kind":"_timeout"']]) {
        requests = [];
        const startedAt = Date.now();
        run = await withFakeDaemon(paneDir, (frame) => {
          requests.push(frame.args[0]);
          return { result: watchResult(5), delayMs: Math.min(700, frame.args[0].timeoutMs) };
        }, () => runCliOnce(runtime, ['watch', '--until-event', ...(format === 'json' ? ['--json'] : []), '--timeout-ms', '2s'], paneDir));
        const elapsed = Date.now() - startedAt;
        assert.strictEqual(run.code, 124, `${runtime} --until-event deadline must exit 124. stdout=${run.stdout} stderr=${run.stderr}`);
        assertIncludes(run.stdout, expected);
        assert.ok(elapsed >= 1_900 && elapsed < 6_000, `${runtime} deadline took ${elapsed}ms`);
        assert.ok(requests.every(request => request.timeoutMs <= 2_000), `${runtime} never waits past the deadline`);
      }
      run = await withFakeDaemon(paneDir, () => ({ result: watchResult(5), delayMs: 100 }),
        () => runCliOnce(runtime, ['watch', '--until-event', '--timeout-ms', '500'], paneDir));
      assert.strictEqual(run.code, 124);
      assertIncludes(run.stdout, 'WATCH TIMEOUT');

      // A closed reader ends a --follow watch at its next write, with exit 0 and no stack trace.
      let served = 0;
      const closed = await withFakeDaemon(paneDir, () => {
        served += 1;
        return { result: { ...watchResult(10 + served), timedOut: false, entries: [reportEntry(10 + served, 'panel-2')] }, delayMs: 50 };
      }, () => new Promise((resolve, reject) => {
        const command = runtime === 'npm' ? process.execPath : findPython();
        const commandArgs = runtime === 'npm' ? [npmCli] : ['-m', 'runpane'];
        const child = childProcess.spawn(command, [...commandArgs, 'watch', '--follow', '--json', '--kinds', 'agent.report'], {
          cwd: rootDir,
          env: { ...process.env, PANE_DIR: paneDir, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource, RUNPANE_TELEMETRY_DISABLED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${runtime} watch kept running after its reader closed`)); }, 10_000);
        child.stdout.once('data', () => child.stdout.destroy());
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
      }));
      assert.strictEqual(closed.code, 0, `${runtime} closed reader must exit 0 (${closed.signal}). stderr=${closed.stderr}`);
      assert.strictEqual(closed.stderr, '', `${runtime} closed reader must not print a stack trace`);
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

/** A reader closed under a socket pair (macOS) fails the write with ENOTCONN, not EPIPE; Python must exit 0 for both. */
function checkPythonWatchReaderClosedErrnos() {
  const result = runPythonSnippet(`
import errno, json, os, sys, tempfile
import runpane.local_control as local_control
from runpane.cli import parse_args

entry = {"gen": 6, "at": "T", "kind": "agent.report", "paneId": "pane-1", "paneName": "Worker", "panelId": "panel-2", "source": "agent"}
local_control.invoke_daemon = lambda *args, **kwargs: {"ok": True, "epoch": "e", "generation": 6, "entries": [entry], "timedOut": False}

class ClosedReader:
    def __init__(self, code):
        self.code = code
        self.spare = tempfile.TemporaryFile()
    def write(self, text):
        raise OSError(self.code, os.strerror(self.code))
    def flush(self):
        pass
    def fileno(self):
        return self.spare.fileno()

codes = {}
real = sys.stdout
# errno.errorcode names ENOTCONN WSAENOTCONN on Windows, so name the codes here.
for name, code in (("EPIPE", errno.EPIPE), ("ENOTCONN", errno.ENOTCONN), ("EINVAL", errno.EINVAL)):
    sys.stdout = ClosedReader(code)
    try:
        codes[name] = local_control.run_watch(parse_args(["watch", "--until-event", "--json"]))
    finally:
        sys.stdout = real
print(json.dumps(codes))
`);
  assert.deepStrictEqual(JSON.parse(result), { EPIPE: 0, ENOTCONN: 0, EINVAL: 0 }, `Python watch must exit 0 when its reader is gone: ${result}`);
}

async function checkReportDeliveryLine() {
  const report = { state: 'blocked', reportedAt: '2026-10-14T20:00:00.000Z' };
  const base = { ok: true, paneId: 'pane-1', panelId: 'panel-1', report, sessionIds: [] };
  const hint = 'No Session recorded this report and no watcher was waiting for it. It is stored on the panel '
    + '(runpane agents status --panel panel-1), and a watch with a named cursor '
    + '(runpane watch --as <name> --kinds agent.report) still receives it when it next waits.';
  const cases = [
    [{ ...base, liveWatchers: 1 }, 'Reported blocked for panel panel-1. Delivered to 1 waiting watcher.\n'],
    [{ ...base, report: { ...report, state: 'done' }, sessionIds: ['s-1', 's-2'], liveWatchers: 2 },
      'Reported done for panel panel-1. Recorded on Session s-1, s-2. Delivered to 2 waiting watchers.\n'],
    [{ ...base, liveWatchers: 0 }, `Reported blocked for panel panel-1.\n${hint}\n`],
    [{ ...base, sessionIds: ['s-1'], liveWatchers: 0 }, 'Reported blocked for panel panel-1. Recorded on Session s-1.\n'],
    [base, 'Reported blocked for panel panel-1.\nNo Session recorded this report. It is stored on the panel '
      + '(runpane agents status --panel panel-1), and only watchers that list agent.report receive it.\n'],
  ];
  for (const runtime of ['npm', 'pip']) {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), `runpane-report-line-${runtime}-`));
    try {
      for (const [result, expected] of cases) {
        const run = await withFakeDaemon(paneDir, () => ({ result }),
          () => runCliOnce(runtime, ['report', '--state', result.report.state, '--question', 'q', '--panel', 'panel-1'], paneDir));
        assert.strictEqual(run.code, 0, `${runtime} report exits 0. stderr=${run.stderr}`);
        assert.strictEqual(lf(run.stdout), expected, `${runtime} report line for ${JSON.stringify(result)}`);
      }
      const json = await withFakeDaemon(paneDir, () => ({ result: { ...base, liveWatchers: 3 } }),
        () => runCliOnce(runtime, ['report', '--state', 'blocked', '--question', 'q', '--panel', 'panel-1', '--json'], paneDir));
      assert.strictEqual(JSON.parse(json.stdout).liveWatchers, 3, `${runtime} --json passes liveWatchers through`);
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

function spawnWatchCli(runtime, args, paneDir) {
  return runtime === 'npm'
    ? childProcess.spawnSync(process.execPath, [npmCli, ...args, '--pane-dir', paneDir], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PANE_DIR: paneDir, RUNPANE_TELEMETRY_DISABLED: '1' } })
    : childProcess.spawnSync(findPython(), ['-m', 'runpane', ...args, '--pane-dir', paneDir], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: rootDir,
      env: { ...process.env, PANE_DIR: paneDir, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource, RUNPANE_TELEMETRY_DISABLED: '1' },
    });
}

// Python materializes optional defaults while TypeScript leaves them absent.
// Only these known false/empty defaults may differ in representation. Null and
// undefined both mean an unset optional value; all populated fields are compared.
const PARSER_DEFAULT_DIFFERENCES = {
  waitReady: false, noFocus: false, focus: false, pinned: false, noPinned: false,
  force: false, follow: false, untilEvent: false, agentsOnly: false, ackNow: false,
  includeHeldInput: false, idleBackoff: false, allManaged: false, allStopped: false,
  includeShells: false, noHeldInput: false, selfTest: false, report: false,
  watchKinds: [], watchPaneIds: [], watchExcludePaneIds: [], attachments: [],
  asFilePointer: false, interrupt: false, noAssociate: false, removeWorktree: false, merged: false,
  quiet: false, readOnly: false, launch: false,
  all: false, inboxIds: [], waitForResult: false,
};

function normalizeParsedArgs(value) {
  if (Array.isArray(value)) return value.map(normalizeParsedArgs);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Test-only serialization of parser snapshots from both languages, including nested JSON values.
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), normalizeParsedArgs(item)]));
}

function compareParserParity() {
  require('./test-runpane-watch-defaults.js');
  const doctor = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'doctor.js'));
  const defaults = doctor.watchDefaults();
  assert.deepStrictEqual(Object.keys(defaults).sort(), ['follow', 'untilEvent']);
  const pythonDefaults = JSON.parse(runPythonSnippet(`
import json
from runpane.doctor import watch_defaults, format_watch_defaults
print(json.dumps({"defaults": watch_defaults(), "text": format_watch_defaults(watch_defaults())}))
`));
  assert.deepStrictEqual(pythonDefaults.defaults, defaults);
  assert.strictEqual(pythonDefaults.text, doctor.formatWatchDefaults(defaults));
  assert.deepStrictEqual(contract.jsonSchemas.doctorResult.properties.watchDefaults.required, ['follow', 'untilEvent']);
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const nodeOutput = parserSamples.map((args) => normalizeParsedArgs({
    ...PARSER_DEFAULT_DIFFERENCES,
    ...parseRunpaneArgs(args),
  }));
  const pythonOutput = JSON.parse(runPythonSnippet(`
from dataclasses import asdict
import json
import sys
from runpane.cli import parse_args

print(json.dumps([asdict(parse_args(args)) for args in json.loads(sys.stdin.read())]))
`, JSON.stringify(parserSamples))).map(parsed => ({
    ...PARSER_DEFAULT_DIFFERENCES,
    ...normalizeParsedArgs(parsed),
  }));

  parserSamples.forEach((args, index) => {
    assert.deepStrictEqual(pythonOutput[index], nodeOutput[index], `Parser parity: ${args.join(' ')}`);
  });
  const invalidWatchArgs = [
    ['watch', '--present'],
    ['watch', '--until-event', '--present'],
    ['watch', '--profile', 'present'],
    ['watch', '--until-event', '--profile', 'unattended'],
    ['watch', '--follow', '--profile', 'invalid'],
    ...['--present', '--present=true', '--profile', '--profile=present', '--profile=unattended'].flatMap(flag =>
      [[], ['--follow'], ['--until-event']].map(mode => ['watch', ...mode, flag])),
    ['watch', '--epoch', 'e'],
    ['watch', '--as', 'c', '--since', '0', '--epoch', 'e'],
    ['watch', '--since', '0', '--epoch', ''],
  ];
  const invalidPythonErrors = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args
errors = []
for args in json.loads(sys.stdin.read()):
    try:
        parse_args(args)
        errors.append(None)
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
`, JSON.stringify(invalidWatchArgs)));
  invalidWatchArgs.forEach((args, index) => {
    assert.throws(() => parseRunpaneArgs(args), error => {
      assert.equal(error.message, invalidPythonErrors[index]);
      return true;
    });
  });
  const removedFlags = ['--settle', '--format', '--quiet', '--no-control-lines', '--agents-only', '--all-managed', '--idle-backoff', '--present', '--profile'];
  const pythonErrors = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args
errors = []
for flag in json.loads(sys.stdin.read()):
    try:
        parse_args(["watch", "--follow", flag])
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
`, JSON.stringify(removedFlags)));
  removedFlags.forEach((flag, index) => {
    assert.throws(() => parseRunpaneArgs(['watch', '--follow', flag]), error => {
      assert.match(error.message, /was removed.*Use /);
      assert.equal(error.message, pythonErrors[index]);
      return true;
    });
  });
}

function compareLegacyRemoteDaemonHealthParity() {
  const fixture = path.join(rootDir, 'main', 'src', 'daemon', '__fixtures__', 'remote-daemon-start-v2.4.30.sh');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-doctor-'));
  const installedPath = path.join(temporaryDirectory, 'pane');
  fs.writeFileSync(installedPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const doctor = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'doctor.js'));
    const nodeHealth = doctor.inspectLegacyRemoteDaemonHealth(temporaryDirectory, true, {
      platform: 'linux',
      launcherPath: fixture,
      installedCandidates: [installedPath],
      runtimePath: '/opt/Pane/Pane (deleted)',
      checkedAt: '2026-08-17T00:00:00.000Z'
    });
    const pythonHealth = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.doctor import inspect_legacy_remote_daemon_health

request = json.loads(sys.stdin.read())
print(json.dumps(inspect_legacy_remote_daemon_health(
    request["paneDir"],
    True,
    platform_name="linux",
    launcher_path=request["launcherPath"],
    installed_candidates=[request["installedPath"]],
    runtime_path_marker="/opt/Pane/Pane (deleted)",
    checked_at="2026-08-17T00:00:00.000Z",
)))
`, JSON.stringify({ paneDir: temporaryDirectory, launcherPath: fixture, installedPath })));
    assert.deepStrictEqual(pythonHealth, nodeHealth);
    assert.strictEqual(nodeHealth.processImage.status, 'deleted');
    assert.strictEqual(nodeHealth.restart.status, 'broken');
    assert.strictEqual(nodeHealth.diagnosticCode, 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED');

    const lockedHealth = {
      ...nodeHealth,
      processImage: {
        ...nodeHealth.processImage,
        runtimePath: '/opt/Pane/Pane',
        installedPath: '/opt/Pane/pane'
      },
      recoveryCommand: 'runpane daemon repair --pane-dir ~/.pane_remote'
    };
    const diagnostic = doctor.createRemoteDaemonHealthDiagnostic({
      paneDir: path.join(os.homedir(), '.pane_remote'),
      managed: true,
      reachable: true,
      endpoint: { transport: 'unix', path: '/tmp/daemon.sock' },
      executableHealth: lockedHealth
    });
    assert.strictEqual(
      `${diagnostic.code}: ${diagnostic.message}`,
      'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED: Remote daemon is reachable but unsafe to restart. It is running /opt/Pane/Pane from a deleted inode; Pane is now installed at /opt/Pane/pane, and the saved launcher still references the old path. The daemon will not return after reboot or service restart. Run runpane daemon repair --pane-dir ~/.pane_remote before restarting, then rerun doctor.'
    );
    const pythonDiagnostic = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.doctor import add_remote_daemon_health_diagnostic

service = json.loads(sys.stdin.read())
setup = {"ready": True, "diagnostics": []}
add_remote_daemon_health_diagnostic(setup, service)
print(json.dumps(setup["diagnostics"][0]))
`, JSON.stringify({
      paneDir: path.join(os.homedir(), '.pane_remote'),
      managed: true,
      reachable: true,
      endpoint: { transport: 'unix', path: '/tmp/daemon.sock' },
      executableHealth: lockedHealth
    })));
    assert.deepStrictEqual(pythonDiagnostic, diagnostic);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function compareDaemonRepairJsonParity() {
  // This fixture relies on a POSIX shebang. Windows exercises the same JSON
  // contract through parser/schema checks; production repair launches Pane.exe.
  if (process.platform === 'win32') return;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-repair-'));
  const fakePane = path.join(temporaryDirectory, 'pane');
  const paneDir = path.join(temporaryDirectory, '.pane_remote');
  const result = {
    ok: true,
    changed: true,
    paneDir,
    strategy: 'systemd-user',
    launcherPath: path.join(paneDir, 'remote-daemon', 'start.sh'),
    before: { launcherCurrent: false },
    after: { launcherCurrent: true },
    message: 'Repaired and restarted the user systemd service.'
  };
  fs.writeFileSync(fakePane, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(result)}'\n`, { mode: 0o755 });
  const args = ['daemon', 'repair', '--pane-path', fakePane, '--pane-dir', paneDir, '--yes', '--json'];
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };
  try {
    const nodeOutput = childProcess.execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8' });
    const pythonOutput = childProcess.execFileSync(findPython(), ['-m', 'runpane', ...args], {
      encoding: 'utf8',
      env: pythonEnv,
      cwd: rootDir
    });
    assert.deepStrictEqual(JSON.parse(nodeOutput), result);
    assert.deepStrictEqual(JSON.parse(pythonOutput), result);

    for (const command of [
      [process.execPath, [npmCli, ...args.filter((arg) => arg !== '--yes')], process.env],
      [findPython(), ['-m', 'runpane', ...args.filter((arg) => arg !== '--yes')], pythonEnv]
    ]) {
      const refused = childProcess.spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2], cwd: rootDir });
      assert.notStrictEqual(refused.status, 0);
      assertIncludes(`${refused.stdout}${refused.stderr}`, 'Rerun with --yes to confirm');
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function checkLinuxPackageCompatibilityAlias() {
  // macOS's default case-insensitive filesystem cannot represent pane and Pane
  // as distinct entries. Linux CI exercises this package invariant.
  if (process.platform !== 'linux') return;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-linux-package-'));
  const appDirectory = path.join(temporaryDirectory, 'linux-unpacked');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'pane'), 'binary', { mode: 0o755 });
  try {
    // The alias step, not the whole afterPack hook: the hook also verifies the
    // packaged icons, which this fixture deliberately does not have.
    const { createLinuxCompatibilityAlias } = require(path.join(rootDir, 'scripts', 'after-pack.js'));
    createLinuxCompatibilityAlias(appDirectory);
    createLinuxCompatibilityAlias(appDirectory);
    childProcess.execFileSync(process.execPath, [
      path.join(rootDir, 'scripts', 'verify-linux-package-executables.js'),
      temporaryDirectory
    ]);
    assert.strictEqual(fs.readlinkSync(path.join(appDirectory, 'Pane')), 'pane');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function comparePlatformParity() {
  const { archAliases, defaultFormat, platformParam } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'platform.js'));
  const nodeOutput = platformCases.map(({ platform, target }) => ({
    platform,
    target,
    defaultFormat: defaultFormat(platform, target),
    platformParam: platformParam(platform),
    archAliases: archAliases(platform)
  }));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform, arch_aliases, default_format, platform_param

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    platform = PanePlatform(**case["platform"])
    normalized.append({
        "platform": case["platform"],
        "target": case["target"],
        "defaultFormat": default_format(platform, case["target"]),
        "platformParam": platform_param(platform),
        "archAliases": arch_aliases(platform),
    })
print(json.dumps(normalized))
`, JSON.stringify(platformCases));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

function compareDaemonEndpointParity() {
  const { getPaneDaemonEndpoint } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const nodeOutput = daemonEndpointCases.map(({ appDirectory, platform }) =>
    getPaneDaemonEndpoint(appDirectory, platform)
  );

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.daemon_client import get_pane_daemon_endpoint

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    normalized.append(get_pane_daemon_endpoint(case["appDirectory"], case["platform"]))
print(json.dumps(normalized))
`, JSON.stringify(daemonEndpointCases));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

function checkPythonUnixEndpointSeparatorsAreHostIndependent() {
  const pythonOutput = runPythonSnippet(`
import json
import ntpath
import runpane.daemon_client as daemon_client

original_os_path = daemon_client.os.path
daemon_client.os.path = ntpath
try:
    endpoint = daemon_client.get_pane_daemon_endpoint("/Users/parsa/.pane", "linux")
finally:
    daemon_client.os.path = original_os_path

print(json.dumps(endpoint))
`);
  const endpoint = JSON.parse(pythonOutput);
  assert.strictEqual(endpoint.transport, 'unix');
  assert.ok(endpoint.path.startsWith('/tmp/'), `Expected Unix socket path to start with /tmp/: ${endpoint.path}`);
  assert.ok(endpoint.path.endsWith('/daemon.sock'), `Expected Unix socket path to end with /daemon.sock: ${endpoint.path}`);
  assert.strictEqual(endpoint.path.includes('\\'), false, `Expected Unix socket path to use forward slashes: ${endpoint.path}`);
}

function compareArtifactSelectionParity() {
  const { findArtifact } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const nodeOutput = artifactCases.map(({ platform, format }) => ({
    platform,
    format,
    artifact: findArtifact(artifactRelease, platform, format).name
  }));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform
from runpane.releases import find_artifact

payload = json.loads(sys.stdin.read())
release = payload["release"]
cases = payload["cases"]
normalized = []
for case in cases:
    platform = PanePlatform(**case["platform"])
    normalized.append({
        "platform": case["platform"],
        "format": case["format"],
        "artifact": find_artifact(release, platform, case["format"])["name"],
    })
print(json.dumps(normalized))
`, JSON.stringify({ release: artifactRelease, cases: artifactCases }));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

/** With Pane not running, update installs the release instead; --cli-only and --status never reach that path. */
async function checkUpdateInstallsWhenPaneIsNotRunning() {
  const { main } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'cli.js'));
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-update-fallback-'));
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalTelemetry = process.env.RUNPANE_TELEMETRY_DISABLED;
  const lines = [];
  let fetches = 0;
  global.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => artifactRelease };
  };
  console.log = (...args) => lines.push(args.join(' '));
  process.env.RUNPANE_TELEMETRY_DISABLED = '1';
  const fellBack = () => lines.some((line) => line.includes('Pane is not running on this machine'));
  try {
    assert.strictEqual(await main(['update', '--pane-only', '--dry-run', '--pane-dir', paneDir]), 0);
    assert.ok(fellBack(), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('Artifact: Pane-2.2.8-')), lines.join('\n'));

    lines.length = 0;
    fetches = 0;
    await assert.rejects(main(['update', '--status', 'no-such-operation', '--pane-dir', paneDir]));
    await main(['update', '--cli-only', '--dry-run', '--pane-dir', paneDir]).catch(() => 1);
    assert.ok(!fellBack(), lines.join('\n'));
    assert.strictEqual(fetches, 0);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    if (originalTelemetry === undefined) delete process.env.RUNPANE_TELEMETRY_DISABLED;
    else process.env.RUNPANE_TELEMETRY_DISABLED = originalTelemetry;
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

async function checkPreferredDownloadUrls() {
  const releases = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    json: async () => artifactRelease
  });

  let nodeUrl;
  try {
    const resolved = await releases.resolveRelease({
      version: 'latest',
      channel: 'stable',
      source: 'npm',
      platform: { os: 'linux', arch: 'x64' },
      format: 'appimage',
      target: 'client'
    });
    nodeUrl = resolved.preferredDownloadUrl;
  } finally {
    global.fetch = originalFetch;
  }

  const parsedNodeUrl = new URL(nodeUrl);
  assert.strictEqual(`${parsedNodeUrl.origin}${parsedNodeUrl.pathname}`, 'https://runpane.com/api/download');
  assert.strictEqual(parsedNodeUrl.searchParams.get('platform'), 'linux');
  assert.strictEqual(parsedNodeUrl.searchParams.get('arch'), 'x64');
  assert.strictEqual(parsedNodeUrl.searchParams.get('format'), 'appimage');
  assert.strictEqual(parsedNodeUrl.searchParams.get('version'), 'v2.2.8');
  assert.strictEqual(parsedNodeUrl.searchParams.get('file'), null);
  assert.strictEqual(parsedNodeUrl.searchParams.get('channel'), 'stable');
  assert.strictEqual(parsedNodeUrl.searchParams.get('source'), 'npm');

  const pythonUrl = runPythonSnippet(`
import json
import sys
import runpane.releases as releases
from runpane.platforms import PanePlatform

release = json.loads(sys.stdin.read())
releases.fetch_release = lambda version, **kwargs: release
resolved = releases.resolve_release(
    version="latest",
    channel="stable",
    source="pip",
    platform=PanePlatform(os="linux", arch="x64"),
    format_name="appimage",
    target="client",
)
print(resolved.preferred_download_url)
`, JSON.stringify(artifactRelease));

  const parsedPythonUrl = new URL(pythonUrl);
  assert.strictEqual(`${parsedPythonUrl.origin}${parsedPythonUrl.pathname}`, 'https://runpane.com/api/download');
  assert.strictEqual(parsedPythonUrl.searchParams.get('platform'), 'linux');
  assert.strictEqual(parsedPythonUrl.searchParams.get('arch'), 'x64');
  assert.strictEqual(parsedPythonUrl.searchParams.get('format'), 'appimage');
  assert.strictEqual(parsedPythonUrl.searchParams.get('version'), 'v2.2.8');
  assert.strictEqual(parsedPythonUrl.searchParams.get('file'), null);
  assert.strictEqual(parsedPythonUrl.searchParams.get('channel'), 'stable');
  assert.strictEqual(parsedPythonUrl.searchParams.get('source'), 'pip');
}

async function checkNodeReleaseTimeout() {
  const releases = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const originalFetch = global.fetch;

  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    await assert.rejects(
      () => releases.fetchRelease('latest', 1),
      /Timed out fetching Pane release latest after 1ms/
    );
  } finally {
    global.fetch = originalFetch;
  }
}

function assertNoSensitiveTelemetryValues(properties) {
  for (const [key, value] of Object.entries(properties)) {
    if (Object.prototype.toString.call(value) !== '[object String]') {
      continue;
    }
    assert.strictEqual(value.includes('/Users/'), false, `Telemetry property ${key} leaked a POSIX path`);
    assert.strictEqual(value.includes('C:\\'), false, `Telemetry property ${key} leaked a Windows path`);
    assert.strictEqual(value.includes('secret'), false, `Telemetry property ${key} leaked a secret marker`);
    assert.strictEqual(value.includes('token'), false, `Telemetry property ${key} leaked a token marker`);
  }
}

function compareWrapperTelemetrySanitizers() {
  const telemetry = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'telemetry.js'));
  const installId = 'install_11111111-1111-4111-8111-111111111111';
  const wrapperVersion = '2.3.2';
  const failureCases = [
    'Checksum mismatch for Pane.AppImage',
    'Request timed out',
    'Pane.exe not found',
    'EACCES permission denied',
    'Unsupported OS',
    'Invalid --format value',
    'socket hang up',
    'plain failure'
  ];
  const nodeContext = {
    command: 'install',
    resolvedCommand: 'install',
    target: 'daemon',
    paneVersion: 'latest',
    channel: 'stable',
    format: 'auto',
    platform: { os: 'linux', arch: 'x64' },
    resolvedFormat: 'appimage',
    dryRun: false,
    installKind: 'installed',
    usedFallback: true,
    failureStage: 'download',
    failureCategory: telemetry.categorizeFailure(new Error(failureCases[0])),
    exitCode: 1
  };
  const nodeProps = telemetry.buildWrapperTelemetryProperties({
    installId,
    wrapperVersion,
    invocation: 'npx',
    context: nodeContext
  });
  const unsafeNodeProps = telemetry.buildWrapperTelemetryProperties({
    installId,
    wrapperVersion,
    invocation: 'npx',
    context: {
      ...nodeContext,
      paneVersion: '/Users/parsa/secret-token/v2.3.2',
      exitCode: 999
    }
  });
  const nodeCategories = failureCases.map((message) => telemetry.categorizeFailure(new Error(message)));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.telemetry import build_wrapper_telemetry_properties, categorize_failure

payload = json.loads(sys.stdin.read())

class Platform:
    os = "linux"
    arch = "x64"

context = {
    "command": "install",
    "resolved_command": "install",
    "target": "daemon",
    "pane_version": "latest",
    "channel": "stable",
    "format": "auto",
    "platform": Platform(),
    "resolved_format": "appimage",
    "dry_run": False,
    "install_kind": "installed",
    "used_fallback": True,
    "failure_stage": "download",
    "failure_category": categorize_failure(payload["failureCases"][0]),
    "exit_code": 1,
}
unsafe_context = dict(context)
unsafe_context["pane_version"] = "/Users/parsa/secret-token/v2.3.2"
unsafe_context["exit_code"] = 999

print(json.dumps({
    "props": build_wrapper_telemetry_properties(
        install_id=payload["installId"],
        invocation="pipx",
        context=context,
        version=payload["wrapperVersion"],
    ),
    "unsafeProps": build_wrapper_telemetry_properties(
        install_id=payload["installId"],
        invocation="pipx",
        context=unsafe_context,
        version=payload["wrapperVersion"],
    ),
    "categories": [categorize_failure(message) for message in payload["failureCases"]],
}))
`, JSON.stringify({ installId, wrapperVersion, failureCases }));
  const python = JSON.parse(pythonOutput);

  const normalize = ({ wrapper, invocation, download_source: downloadSource, ...properties }) => properties;
  assert.deepStrictEqual(normalize(python.props), normalize(nodeProps));
  assert.strictEqual(nodeProps.wrapper, 'npm');
  assert.strictEqual(nodeProps.download_source, 'npm');
  assert.strictEqual(python.props.wrapper, 'pip');
  assert.strictEqual(python.props.download_source, 'pip');
  assert.strictEqual(Object.hasOwn(unsafeNodeProps, 'pane_version'), false);
  assert.strictEqual(Object.hasOwn(unsafeNodeProps, 'exit_code'), false);
  assert.strictEqual(Object.hasOwn(python.unsafeProps, 'pane_version'), false);
  assert.strictEqual(Object.hasOwn(python.unsafeProps, 'exit_code'), false);
  assert.deepStrictEqual(python.categories, nodeCategories);
  assertNoSensitiveTelemetryValues(nodeProps);
  assertNoSensitiveTelemetryValues(unsafeNodeProps);
  assertNoSensitiveTelemetryValues(python.props);
  assertNoSensitiveTelemetryValues(python.unsafeProps);
}

function compareExistingReusePolicy() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { shouldReuseExistingPane } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js'));
  const nodeOutput = existingReuseCases.map(({ args }) => {
    const parsed = parseRunpaneArgs(args);
    const target = parsed.command === 'update' ? 'client' : parsed.target;
    return shouldReuseExistingPane(parsed, target);
  });

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args
from runpane.installers import should_reuse_existing_pane

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    parsed = parse_args(case["args"])
    target = "client" if parsed.command == "update" else parsed.target
    normalized.append(should_reuse_existing_pane(parsed, target))
print(json.dumps(normalized))
`, JSON.stringify(existingReuseCases));

  const expected = existingReuseCases.map((testCase) => testCase.expected);
  assert.deepStrictEqual(nodeOutput, expected);
  assert.deepStrictEqual(JSON.parse(pythonOutput), expected);
}

function compareDaemonLaunchEnvironmentParity() {
  const { buildPaneDaemonEnvironment } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js'));
  const baseEnvironment = { PATH: '/test/bin', DISPLAY: '' };

  assert.deepStrictEqual(buildPaneDaemonEnvironment('linux', baseEnvironment), {
    ...baseEnvironment,
    ELECTRON_OZONE_PLATFORM_HINT: 'headless'
  });
  assert.deepStrictEqual(buildPaneDaemonEnvironment('darwin', baseEnvironment), baseEnvironment);

  const pythonOutput = runPythonSnippet(`
import json
from runpane.installers import build_pane_daemon_environment

base = {"PATH": "/test/bin", "DISPLAY": ""}
print(json.dumps({
    "linux": build_pane_daemon_environment("Linux", base),
    "darwin": build_pane_daemon_environment("Darwin", base),
}))
`);
  const pythonJson = JSON.parse(pythonOutput.split(/\r?\n/).filter(Boolean).pop());
  assert.deepStrictEqual(pythonJson.linux, buildPaneDaemonEnvironment('linux', baseEnvironment));
  assert.deepStrictEqual(pythonJson.darwin, baseEnvironment);
}

function compareDaemonLaunchArgsParity() {
  const { buildPaneDaemonArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js'));
  const baseArgs = ['--remote-setup', '--label', 'VM'];

  // Ozone reads its platform from argv before the app boots, so the headless
  // flags must lead the argument list on Linux and be absent elsewhere.
  assert.deepStrictEqual(buildPaneDaemonArgs(baseArgs, 'linux'), [
    '--ozone-platform=headless',
    '--disable-gpu',
    ...baseArgs
  ]);
  assert.deepStrictEqual(buildPaneDaemonArgs(baseArgs, 'darwin'), baseArgs);

  const pythonOutput = runPythonSnippet(`
import json
from runpane.installers import build_pane_daemon_args

base = ["--remote-setup", "--label", "VM"]
print(json.dumps({
    "linux": build_pane_daemon_args(base, "Linux"),
    "darwin": build_pane_daemon_args(base, "Darwin"),
}))
`);
  const pythonJson = JSON.parse(pythonOutput.split(/\r?\n/).filter(Boolean).pop());
  assert.deepStrictEqual(pythonJson.linux, buildPaneDaemonArgs(baseArgs, 'linux'));
  assert.deepStrictEqual(pythonJson.darwin, buildPaneDaemonArgs(baseArgs, 'darwin'));
}

function compareRemoteSetupDiagnosticParity() {
  const { collectRemoteSetupCheck } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'doctor.js'));
  const probes = {
    displayAvailable: false,
    hasFuseRuntime: false,
    isRoot: false,
    unprivilegedUserNamespaceDisabled: true,
    hasSystemctl: false
  };
  const nodeResult = collectRemoteSetupCheck({ os: 'linux', arch: 'x64' }, 'appimage', probes);
  assert.strictEqual(nodeResult.ready, false);
  assert.strictEqual(nodeResult.displayAvailable, false);
  assert.strictEqual(nodeResult.headlessEnvironmentApplied, true);
  assert.deepStrictEqual(nodeResult.diagnostics.map((item) => item.code), [
    'PANE_APPIMAGE_FUSE_MISSING',
    'PANE_ELECTRON_SANDBOX_UNAVAILABLE',
    'PANE_USER_SERVICE_UNAVAILABLE'
  ]);

  const pythonOutput = runPythonSnippet(`
import json
from runpane.doctor import collect_remote_setup_check
from runpane.platforms import PanePlatform

probes = {
    "displayAvailable": False,
    "hasFuseRuntime": False,
    "isRoot": False,
    "unprivilegedUserNamespaceDisabled": True,
    "hasSystemctl": False,
}
print(json.dumps(collect_remote_setup_check(PanePlatform(os="linux", arch="x64"), "appimage", probes)))
`);
  assert.deepStrictEqual(JSON.parse(pythonOutput.split(/\r?\n/).filter(Boolean).pop()), nodeResult);
}

function checkPlatformMatchingEdgeCases() {
  const { findArtifact } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const nodeArtifact = findArtifact(platformEdgeRelease, { os: 'win32', arch: 'x64' }, 'zip').name;

  const pythonArtifact = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform
from runpane.releases import find_artifact

release = json.loads(sys.stdin.read())
artifact = find_artifact(release, PanePlatform(os="win32", arch="x64"), "zip")
print(artifact["name"])
`, JSON.stringify(platformEdgeRelease));

  assert.strictEqual(nodeArtifact, 'Pane-2.2.8-Windows-x64.zip');
  assert.strictEqual(pythonArtifact, 'Pane-2.2.8-Windows-x64.zip');
}

async function checkGuidedRemoteSetup() {
  const promptsPath = path.join(rootDir, 'packages/runpane/dist/setupPrompts.js');
  const originalPrompts = require(promptsPath);
  const installers = require(path.join(rootDir, 'packages/runpane/dist/installers.js'));
  const originalResolve = installers.resolveExistingPanePath;
  const originalSpawn = installers.spawnPane;
  const originalCI = process.env.CI;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    for (const argv of [[], ['setup']]) {
      for (const cancelAt of [null, 'action', 'name']) {
        let finished = false;
        let spawned = false;
        let cancelled = false;
        let success = false;
        let failure = false;
        const exitCode = argv.length ? 0 : 7;
        const hostName = argv.length ? '' : 'My Server';
        const cancellation = Symbol('cancel');
        require.cache[require.resolve(promptsPath)].exports = {
          intro() {},
          select: async () => cancelAt === 'action' ? cancellation : 'daemon',
          text: async options => {
            assert.ok(options.validate('   '));
            assert.strictEqual(options.validate(''), undefined);
            return cancelAt === 'name' ? cancellation : hostName;
          },
          isCancel: value => value === cancellation,
          cancel: () => { cancelled = true; },
          outro: () => { finished = true; },
          log: { info() {}, success: () => { success = true; }, error: () => { failure = true; } }
        };
        installers.resolveExistingPanePath = () => '/test/pane';
        installers.spawnPane = async (_executable, args) => {
          assert.ok(finished, 'Prompts must finish before interactive setup');
          assert.deepStrictEqual(args, [
            '--remote-setup', '--label', hostName || os.hostname() || 'Remote Host', '--prefer-tunnel', 'tailscale',
            '--interactive-tailscale-setup', '--auto-listen-port'
          ]);
          spawned = true;
          return exitCode;
        };
        delete require.cache[require.resolve(npmCli)];
        const { main } = require(npmCli);
        assert.strictEqual(await main(argv), cancelAt ? 0 : exitCode);
        assert.strictEqual(success, !cancelAt && exitCode === 0);
        assert.strictEqual(failure, !cancelAt && exitCode !== 0);
        assert.strictEqual(spawned, !cancelAt);
        assert.strictEqual(cancelled, Boolean(cancelAt));
      }
    }
  } finally {
    require.cache[require.resolve(promptsPath)].exports = originalPrompts;
    delete require.cache[require.resolve(npmCli)];
    installers.resolveExistingPanePath = originalResolve;
    installers.spawnPane = originalSpawn;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else delete process.stdin.isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else delete process.stdout.isTTY;
  }
  runPythonSnippet(`
from unittest.mock import patch
from runpane.cli import run_interactive_wizard
from runpane.telemetry import create_initial_telemetry_context

with patch("builtins.input", side_effect=["2", "My Server"]), patch("runpane.cli.install_or_update") as install:
    install.return_value = 7
    assert run_interactive_wizard(create_initial_telemetry_context([])) == 7
    parsed = install.call_args.args[0]
    assert parsed.target == "daemon"
    assert parsed.remote_setup_args == [
        "--label", "My Server", "--prefer-tunnel", "tailscale",
        "--interactive-tailscale-setup", "--auto-listen-port"
    ]
`);
}

async function checkExistingDaemonShortCircuit() {
  const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-existing-'));
  const existingPath = path.join(existingDir, process.platform === 'win32' ? 'Pane.exe' : 'pane');
  fs.writeFileSync(existingPath, '');

  const releasesPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js');
  const downloadPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'download.js');
  const installersPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js');
  const cliPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'cli.js');
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const releases = require(releasesPath);
  const download = require(downloadPath);
  const installers = require(installersPath);
  const originalResolveRelease = releases.resolveRelease;
  const originalDownloadArtifact = download.downloadArtifact;
  const originalSpawnPane = installers.spawnPane;
  let spawned = null;

  releases.resolveRelease = async () => {
    throw new Error('resolveRelease should not be called for existing daemon reuse');
  };
  download.downloadArtifact = async () => {
    throw new Error('downloadArtifact should not be called for existing daemon reuse');
  };
  installers.spawnPane = async (executablePath, args) => {
    spawned = { executablePath, args };
    return 0;
  };

  try {
    delete require.cache[require.resolve(cliPath)];
    const { installOrUpdate } = require(cliPath);
    const parsed = parseRunpaneArgs(['install', 'daemon', '--pane-path', existingPath, '--label', 'Existing', '--print-only']);
    const code = await installOrUpdate(parsed);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(spawned, {
      executablePath: existingPath,
      args: ['--remote-setup', '--label', 'Existing', '--print-only']
    });
  } finally {
    releases.resolveRelease = originalResolveRelease;
    download.downloadArtifact = originalDownloadArtifact;
    installers.spawnPane = originalSpawnPane;
    delete require.cache[require.resolve(cliPath)];
    fs.rmSync(existingDir, { recursive: true, force: true });
  }

  const pythonOutput = runPythonSnippet(`
import json
import os
import tempfile
import runpane.cli as cli
from runpane.cli import install_or_update, parse_args

handle = tempfile.NamedTemporaryFile(delete=False)
handle.close()
captured = {}

def fail_resolve(*args, **kwargs):
    raise AssertionError("resolve_release should not be called for existing daemon reuse")

def fail_download(*args, **kwargs):
    raise AssertionError("download_artifact should not be called for existing daemon reuse")

def fake_spawn(executable_path, args):
    captured["matchesExisting"] = executable_path == handle.name
    captured["args"] = args
    return 0

cli.resolve_release = fail_resolve
cli.download_artifact = fail_download
cli.spawn_pane = fake_spawn

try:
    parsed = parse_args(["install", "daemon", "--pane-path", handle.name, "--label", "Existing", "--print-only"])
    code = install_or_update(parsed)
    print(json.dumps({"code": code, "captured": captured}))
finally:
    os.unlink(handle.name)
`);
  const pythonJson = pythonOutput.split(/\r?\n/).filter(Boolean).pop();
  assert.deepStrictEqual(JSON.parse(pythonJson), {
    code: 0,
    captured: {
      matchesExisting: true,
      args: ['--remote-setup', '--label', 'Existing', '--print-only']
    }
  });
}

function checkWindowsPaneVersionDoesNotLaunchExecutable() {
  if (process.platform === 'win32') {
    const versionModule = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'version.js'));
    const originalSpawnSync = childProcess.spawnSync;
    const paneExe = 'C:\\Program Files\\Pane\\Pane.exe';
    const calls = [];

    try {
      childProcess.spawnSync = (command, args, options) => {
        calls.push({ command, args, options });
        assert.notStrictEqual(command, paneExe);
        assert.strictEqual(command, 'powershell.exe');
        assert.strictEqual(options.env.RUNPANE_PANE_VERSION_PATH, paneExe);
        return { stdout: '2.3.19\r\n', stderr: '', status: 0 };
      };

      assert.strictEqual(versionModule.getPaneVersion(paneExe), '2.3.19');
      assert.strictEqual(calls.length, 1);

      childProcess.spawnSync = (command) => {
        assert.notStrictEqual(command, paneExe);
        return { error: new Error('metadata unavailable'), stdout: '', stderr: '' };
      };
      assert.strictEqual(versionModule.getPaneVersion(paneExe), undefined);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }
  }

  const pythonOutput = runPythonSnippet(`
import json
import runpane.version as version

original_platform = version.sys.platform
original_run = version.subprocess.run
pane_exe = r"C:\\Program Files\\Pane\\Pane.exe"
calls = []

class Result:
    def __init__(self, stdout):
        self.stdout = stdout
        self.stderr = ""

def fake_run(args, **kwargs):
    calls.append(args)
    assert args[0] == "powershell.exe"
    assert kwargs["env"]["RUNPANE_PANE_VERSION_PATH"] == pane_exe
    return Result("2.3.19\\n")

try:
    version.sys.platform = "win32"
    version.subprocess.run = fake_run
    first = version.pane_version(pane_exe)

    def missing_metadata(args, **kwargs):
        assert args[0] == "powershell.exe"
        return Result("")

    version.subprocess.run = missing_metadata
    second = version.pane_version(pane_exe)
finally:
    version.sys.platform = original_platform
    version.subprocess.run = original_run

print(json.dumps({"first": first, "second": second, "calls": len(calls)}))
`);

  assert.deepStrictEqual(JSON.parse(pythonOutput), {
    first: '2.3.19',
    second: null,
    calls: 1
  });
}

async function checkFromJsonAcceptsBom() {
  const payloadPath = path.join(os.tmpdir(), `runpane-from-json-bom-${process.pid}.json`);
  const payload = {
    repo: 'active',
    panes: [{
      name: 'bom-test',
      pinned: true,
      tool: {
        command: 'echo hello'
      }
    }]
  };
  fs.writeFileSync(payloadPath, `\uFEFF\uFEFF${JSON.stringify(payload)}`, 'utf8');

  const daemonClientPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js');
  const localControlPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js');
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const daemonClient = require(daemonClientPath);
  const { runPanesCreate } = require(localControlPath);
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  let capturedNodeRequest;

  daemonClient.invokeDaemon = async (_channel, args) => {
    capturedNodeRequest = args[0];
    return { ok: true, dryRun: true, preview: { panes: [] }, items: [] };
  };
  console.log = () => {};

  try {
    const parsed = parseRunpaneArgs(['panes', 'create', '--from-json', payloadPath, '--dry-run', '--yes', '--json']);
    const code = await runPanesCreate(parsed);
    assert.strictEqual(code, 0);
    assert.strictEqual(capturedNodeRequest.repo, 'active');
    assert.strictEqual(capturedNodeRequest.panes[0].name, 'bom-test');
    assert.strictEqual(capturedNodeRequest.panes[0].pinned, true);
    assert.strictEqual(capturedNodeRequest.dryRun, true);
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    fs.rmSync(payloadPath, { force: true });
  }

  const pythonOutput = runPythonSnippet(`
import json
import os
import tempfile
import runpane.local_control as local_control
from runpane.cli import parse_args

payload = {
    "repo": "active",
    "panes": [{
        "name": "bom-test",
        "pinned": True,
        "tool": {"command": "echo hello"},
    }],
}
handle = tempfile.NamedTemporaryFile(delete=False, mode="w", encoding="utf-8")
handle.write("\\ufeff\\ufeff")
json.dump(payload, handle)
handle.close()
captured = {}

def fake_invoke(channel, args, **kwargs):
    captured["request"] = args[0]
    return {"ok": True, "dryRun": True, "preview": {"panes": []}, "items": []}

local_control.invoke_daemon = fake_invoke
try:
    parsed = parse_args(["panes", "create", "--from-json", handle.name, "--dry-run", "--yes", "--json"])
    code = local_control.run_panes_create(parsed)
    print(json.dumps({"code": code, "request": captured["request"]}))
finally:
    os.unlink(handle.name)
`);
  const pythonJson = pythonOutput.split(/\r?\n/).filter(Boolean).pop();
  assert.deepStrictEqual(JSON.parse(pythonJson), {
    code: 0,
    request: {
      repo: 'active',
      panes: [{
        name: 'bom-test',
        pinned: true,
        tool: {
          command: 'echo hello'
        }
      }],
      dryRun: true
    }
  });
}

async function checkCreateAssociationSource() {
  const payloadPath = path.join(os.tmpdir(), `runpane-association-${process.pid}.json`);
  const previousSession = process.env.PANE_ORCHESTRATION_SESSION_ID;
  fs.writeFileSync(payloadPath, JSON.stringify({
    repo: 'active',
    panes: [{ name: 'child', tool: { command: 'echo ready' } }],
    associateSession: 'explicit-session',
  }));
  try {
    const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
    const { buildPaneCreateRequest } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
    const request = async (...flags) => buildPaneCreateRequest(parseRunpaneArgs(['panes', 'create', '--from-json', payloadPath, ...flags]));
    delete process.env.PANE_ORCHESTRATION_SESSION_ID;
    assert.strictEqual((await request()).associateSession, 'explicit-session');
    process.env.PANE_ORCHESTRATION_SESSION_ID = 'current-session';
    assert.strictEqual((await request()).associateSession, 'current-session');
    assert.strictEqual((await request('--no-associate')).associateSession, undefined);
  } finally {
    if (previousSession === undefined) delete process.env.PANE_ORCHESTRATION_SESSION_ID;
    else process.env.PANE_ORCHESTRATION_SESSION_ID = previousSession;
    fs.rmSync(payloadPath, { force: true });
  }

  runPythonSnippet(`
import json
import os
import tempfile
from runpane.cli import parse_args
from runpane.local_control import build_pane_create_request

with tempfile.NamedTemporaryFile(delete=False, mode="w", encoding="utf-8") as handle:
    json.dump({"repo": "active", "panes": [{"name": "child", "tool": {"command": "echo ready"}}], "associateSession": "explicit-session"}, handle)
try:
    args = ["panes", "create", "--from-json", handle.name]
    os.environ.pop("PANE_ORCHESTRATION_SESSION_ID", None)
    assert build_pane_create_request(parse_args(args))["associateSession"] == "explicit-session"
    os.environ["PANE_ORCHESTRATION_SESSION_ID"] = "current-session"
    assert build_pane_create_request(parse_args(args))["associateSession"] == "current-session"
    assert "associateSession" not in build_pane_create_request(parse_args(args + ["--no-associate"]))
finally:
    os.unlink(handle.name)
`);
}

async function checkPaneCreateBlockedReadiness() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesCreate } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const stdout = [];
  daemonClient.invokeDaemon = async () => ({
    ok: false,
    repo: { id: 1, name: 'repo', path: '/repo', active: true, environment: 'macos', sessionCount: 1 },
    items: [{
      ok: false,
      index: 0,
      name: 'trust',
      pinned: true,
      sessionId: 'session-1',
      panelId: 'panel-1',
      readiness: {
        ok: false,
        condition: 'ready',
        matched: false,
        timedOut: false,
        elapsedMs: 5,
        state: { initialized: true, isCliPanel: true, isCliReady: true, agentType: 'claude' },
        blocked: { kind: 'agent-prompt', message: 'The terminal is waiting at an interactive prompt.' },
      },
    }],
  });
  console.log = (line) => stdout.push(String(line));
  try {
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'trust', '--agent', 'claude', '--wait-ready', '--yes'
    ]));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }
  assert.ok(stdout.some(line => line.includes('Ready: blocked')), stdout.join('\n'));
}

async function checkPanelResumeCommandExitedReadiness() {
  const exitedReadiness = {
    ok: false,
    condition: 'ready',
    matched: false,
    timedOut: false,
    elapsedMs: 40,
    state: { initialized: true, isCliPanel: true, running: false, agentType: 'claude' },
    reason: { code: 'command-exited', message: 'The command exited with code 127 before it became ready: claude: command not found' },
  };
  const single = {
    ok: false,
    panelId: 'panel-1',
    paneId: 'session-1',
    action: 'resumed',
    message: 'Relaunched claude.',
    panel: { id: 'panel-1', panelId: 'panel-1', paneId: 'session-1', type: 'terminal', title: 'Claude', active: true },
    readiness: exitedReadiness,
    nextCommand: 'runpane panels screen --panel panel-1',
  };
  const many = {
    ok: false,
    scope: { kind: 'all-stopped' },
    resumed: 1,
    alreadyRunning: 0,
    failed: 0,
    notReady: 1,
    concurrency: 4,
    items: [{ ok: false, panelId: 'panel-1', paneId: 'session-1', paneName: 'worker', action: 'resumed', readiness: exitedReadiness }],
  };
  const expectedSingle = ['Ready: command exited after 40ms', `Why: ${exitedReadiness.reason.message}`];
  const expectedMany = `FAIL worker panel panel-1: command exited: ${exitedReadiness.reason.message}`;

  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanelsResume } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const stdout = [];
  daemonClient.invokeDaemon = async (channel) => channel === 'runpane:panels:resume-many' ? many : single;
  console.log = (line) => stdout.push(String(line));
  try {
    await runPanelsResume(parseRunpaneArgs(['panels', 'resume', '--panel', 'panel-1', '--wait-ready', '--yes']));
    await runPanelsResume(parseRunpaneArgs(['panels', 'resume', '--all-stopped', '--wait-ready', '--yes']));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  const pythonStdout = runPythonSnippet(`
import contextlib
import io
import json
import sys
import runpane.local_control as local_control
from runpane.cli import parse_args

results = json.load(sys.stdin)
local_control.invoke_daemon = lambda channel, args, **kwargs: results[channel]
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panels_resume(parse_args(["panels", "resume", "--panel", "panel-1", "--wait-ready", "--yes"]))
    local_control.run_panels_resume(parse_args(["panels", "resume", "--all-stopped", "--wait-ready", "--yes"]))
print(json.dumps(stdout.getvalue().splitlines()))
`, JSON.stringify({ 'runpane:panels:resume': single, 'runpane:panels:resume-many': many }));

  for (const [runtime, lines] of [['npm', stdout], ['pip', JSON.parse(pythonStdout)]]) {
    const text = lines.join('\n');
    for (const line of expectedSingle) {
      assert.ok(lines.includes(line), `${runtime} resume output is missing "${line}":\n${text}`);
    }
    assert.ok(!lines.some(line => line.startsWith('Ready: blocked')), `${runtime} resume calls an exited command blocked:\n${text}`);
    assert.ok(lines.includes(expectedMany), `${runtime} bulk resume output is missing "${expectedMany}":\n${text}`);
  }
}

async function checkPanePinParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesCreate, runPanesPin } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  const stdout = [];

  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    if (channel === 'runpane:panes:create') {
      return { ok: true, repo: {}, items: [] };
    }
    return { ok: true, paneId: args[0].paneId, pinned: args[0].pinned };
  };
  console.log = (line) => stdout.push(String(line));

  try {
    await runPanesPin(parseRunpaneArgs(['panes', 'pin', '--pane', 'session-1', '--yes', '--json']), true);
    await runPanesPin(parseRunpaneArgs(['panes', 'unpin', '--pane', 'session-1', '--yes', '--json']), false);
    await runPanesPin(parseRunpaneArgs(['panes', 'pin', '--pane', 'session-1', '--dry-run', '--json']), true);
    await runPanesPin(parseRunpaneArgs(['panes', 'unpin', '--pane', 'session-1', '--dry-run', '--json']), false);
    await assert.rejects(
      runPanesPin(parseRunpaneArgs(['panes', 'pin', '--pane', 'session-1']), true),
      /Rerun with --yes in non-interactive shells/,
    );
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'pinned-pane', '--agent', 'codex',
      '--pinned', '--dry-run', '--yes', '--json'
    ]));
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'default-pane', '--agent', 'codex',
      '--dry-run', '--yes', '--json'
    ]));
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'unpinned-pane', '--agent', 'codex',
      '--no-pinned', '--dry-run', '--yes', '--json'
    ]));
    await assert.rejects(
      runPanesCreate(parseRunpaneArgs([
        'panes', 'create', '--repo', 'active', '--name', 'conflicted-pane', '--agent', 'codex',
        '--pinned', '--no-pinned', '--dry-run', '--yes', '--json'
      ])),
      /Use either --pinned or --no-pinned, not both/,
    );
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  assert.deepStrictEqual(calls.slice(0, 2), [{
    channel: 'runpane:panes:pin',
    request: { paneId: 'session-1', pinned: true }
  }, {
    channel: 'runpane:panes:pin',
    request: { paneId: 'session-1', pinned: false }
  }]);
  assert.deepStrictEqual(calls.slice(2, 4), [{
    channel: 'runpane:panes:pin',
    request: { paneId: 'session-1', pinned: true, dryRun: true }
  }, {
    channel: 'runpane:panes:pin',
    request: { paneId: 'session-1', pinned: false, dryRun: true }
  }]);
  assert.strictEqual(calls[4].channel, 'runpane:panes:create');
  assert.strictEqual(calls[4].request.panes[0].pinned, true);
  assert.strictEqual(calls[5].request.panes[0].pinned, true);
  assert.strictEqual(calls[6].request.panes[0].pinned, false);
  assert.deepStrictEqual(stdout.slice(0, 4).map(line => JSON.parse(line)), [{
    ok: true,
    paneId: 'session-1',
    pinned: true
  }, {
    ok: true,
    paneId: 'session-1',
    pinned: false
  }, {
    ok: true,
    paneId: 'session-1',
    pinned: true
  }, {
    ok: true,
    paneId: 'session-1',
    pinned: false
  }]);

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    if channel == "runpane:panes:create":
        return {"ok": True, "repo": {}, "items": []}
    return {"ok": True, "paneId": args[0]["paneId"], "pinned": args[0]["pinned"]}

local_control.invoke_daemon = fake_invoke
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_pin(parse_args(["panes", "pin", "--pane", "session-1", "--yes", "--json"]), True)
    local_control.run_panes_pin(parse_args(["panes", "unpin", "--pane", "session-1", "--yes", "--json"]), False)
    local_control.run_panes_pin(parse_args(["panes", "pin", "--pane", "session-1", "--dry-run", "--json"]), True)
    local_control.run_panes_pin(parse_args(["panes", "unpin", "--pane", "session-1", "--dry-run", "--json"]), False)
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "pinned-pane", "--agent", "codex",
        "--pinned", "--dry-run", "--yes", "--json"
    ]))
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "default-pane", "--agent", "codex",
        "--dry-run", "--yes", "--json"
    ]))
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "unpinned-pane", "--agent", "codex",
        "--no-pinned", "--dry-run", "--yes", "--json"
    ]))

pin_conflict_refused = False
try:
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "conflicted-pane", "--agent", "codex",
        "--pinned", "--no-pinned", "--dry-run", "--yes", "--json"
    ]))
except ValueError as error:
    pin_conflict_refused = "Use either --pinned or --no-pinned, not both." in str(error)

refused = False
try:
    local_control.run_panes_pin(parse_args(["panes", "pin", "--pane", "session-1"]), True)
except ValueError as error:
    refused = "Rerun with --yes in non-interactive shells" in str(error)

print(json.dumps({"calls": calls, "stdout": stdout.getvalue().splitlines(), "refused": refused, "pinConflictRefused": pin_conflict_refused}))
`);
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.calls, JSON.parse(JSON.stringify(calls)));
  const pythonJsonResults = JSON.parse(`[${python.stdout.join('\n').replace(/}\n{/g, '},{')}]`);
  assert.deepStrictEqual(
    pythonJsonResults.slice(0, 4),
    stdout.slice(0, 4).map(line => JSON.parse(line)),
  );
  assert.strictEqual(python.refused, true);
  assert.strictEqual(python.pinConflictRefused, true);
}

async function checkWrapperAgentParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesCreate, runPanelsCreate, runPanelsList, runPanesAdopt } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  const stdout = [];
  const panelList = {
    ok: true,
    paneId: 'session-1',
    panels: [{
      id: 'panel-1', panelId: 'panel-1', paneId: 'session-1', type: 'terminal', title: 'Claude Code', active: true,
      initialized: true, agentType: 'claude', agentDetection: 'process', launchCommand: 'agent-farm run free-range', isCliPanel: true,
      resumeId: 'farm-launch-1', resumeSource: 'agent-farm',
    }],
  };
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    if (channel === 'runpane:panels:list') return panelList;
    if (channel === 'runpane:panels:create') return { ok: true, paneId: 'session-1', panelId: 'panel-2', title: 'Claude Code', active: false, focused: false };
    return { ok: true, repo: { id: 1, name: 'repo', path: '/repo', active: true, sessionCount: 1 }, items: [] };
  };
  console.log = (line) => stdout.push(String(line));
  try {
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'farm', '--tool-command', 'agent-farm run free-range',
      '--agent', 'claude', '--dry-run', '--yes', '--json'
    ]));
    await runPanelsCreate(parseRunpaneArgs([
      'panels', 'create', '--pane', 'session-1', '--tool-command', 'agent-farm run free-range', '--agent', 'claude', '--yes', '--json'
    ]));
    await runPanelsList(parseRunpaneArgs(['panels', 'list', '--pane', 'session-1', '--json']));
    await runPanelsList(parseRunpaneArgs(['panels', 'list', '--pane', 'session-1']));
    await runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--repo', 'active', '--path', '/repo/wt', '--name', 'farm', '--tool-command', 'agent-farm run free-range',
      '--agent', 'claude', '--launch', '--dry-run', '--yes', '--json'
    ]));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  const wrappedTool = { command: 'agent-farm run free-range', agentType: 'claude' };
  const wireCalls = JSON.parse(JSON.stringify(calls));
  assert.deepStrictEqual(wireCalls[0].request.panes[0].tool, wrappedTool);
  assert.deepStrictEqual(wireCalls[1].request.tool, wrappedTool);
  assert.deepStrictEqual(JSON.parse(stdout[2]).panels[0], panelList.panels[0]);
  assert.ok(stdout.includes('* panel-1\tterminal\tClaude Code initialized claude (process) resume farm-launch-1'), stdout.join('\n'));
  assert.deepStrictEqual(wireCalls[4].request.panes[0].tool, wrappedTool);

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

panel_list = json.loads(${JSON.stringify(JSON.stringify(panelList))})
calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    if channel == "runpane:panels:list":
        return panel_list
    if channel == "runpane:panels:create":
        return {"ok": True, "paneId": "session-1", "panelId": "panel-2", "title": "Claude Code", "active": False, "focused": False}
    return {"ok": True, "repo": {"id": 1, "name": "repo", "path": "/repo", "active": True, "sessionCount": 1}, "items": []}

local_control.invoke_daemon = fake_invoke
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "farm", "--tool-command", "agent-farm run free-range",
        "--agent", "claude", "--dry-run", "--yes", "--json"
    ]))
    local_control.run_panels_create(parse_args([
        "panels", "create", "--pane", "session-1", "--tool-command", "agent-farm run free-range", "--agent", "claude", "--yes", "--json"
    ]))
    local_control.run_panels_list(parse_args(["panels", "list", "--pane", "session-1"]))

print(json.dumps({"calls": calls, "stdout": stdout.getvalue().splitlines()}))
`);
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.calls[0].request.panes[0].tool, wrappedTool);
  assert.deepStrictEqual(python.calls[1].request.tool, wrappedTool);
  assert.ok(python.stdout.includes('* panel-1\tterminal\tClaude Code initialized claude (process) resume farm-launch-1'), python.stdout.join('\n'));
}

async function checkFilePointerParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { buildPanelInputRequest, runPanesAdopt, runPanesCreate, runPanelsSubmit } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const { runAgentsSend } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'agentTasks.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const adoptPromptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-adopt-prompt-')), 'brief.md');
  fs.writeFileSync(adoptPromptFile, 'Step one\nStep two\n');
  const promptFile = '/home/me/.pane/prompts/session-1/2026-09-27T18-00-00-000Z-abc123.md';
  const warnings = [{ code: 'leading-bang-runs-shell', message: 'The text starts with `!`.' }];
  const submitResult = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', inputBytes: 90, enter: 'cr', sequenceName: 'enter-cr',
    verifiedSubmitted: true, verification: 'observed', sentAt: '2026-09-27T18:00:00.000Z', promptFile, warnings,
  };
  const createResult = {
    ok: true,
    repo: { id: 1, name: 'repo', path: '/repo', active: true, sessionCount: 1 },
    items: [{ ok: true, index: 0, name: 'long', pinned: true, sessionId: 'session-1', panelId: 'panel-1', promptFile, warnings }],
  };
  const screenResult = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', source: 'scrollback', limit: 1, returnedLineCount: 0, hasMore: false,
    text: '', state: { initialized: true }, composer: { isPresent: true, hasUndeliveredText: false },
  };
  const calls = [];
  const stdout = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    if (channel === 'runpane:panels:submit') return submitResult;
    if (channel === 'runpane:panels:screen') return screenResult;
    return createResult;
  };
  console.log = (line) => stdout.push(String(line));
  try {
    await runPanelsSubmit(parseRunpaneArgs([
      'panels', 'submit', '--panel', 'panel-1', '--text', 'Line one\nLine two', '--as-file-pointer', '--yes', '--json',
    ]));
    await runPanesCreate(parseRunpaneArgs([
      'panes', 'create', '--repo', 'active', '--name', 'long', '--agent', 'claude', '--prompt', 'Line one\nLine two',
      '--as-file-pointer', '--dry-run', '--yes', '--json',
    ]));
    await runAgentsSend(parseRunpaneArgs([
      'agents', 'send', '--panel', 'panel-1', '--text', 'Line one', '--as-file-pointer', '--yes', '--json',
    ]));
    await runPanelsSubmit(parseRunpaneArgs([
      'panels', 'submit', '--panel', 'panel-1', '--text', '!ls', '--yes',
    ]));
    // A wrapped adopt takes the same prompt flags as create (the Python wrapper has no panes adopt).
    await runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--repo', 'active', '--path', '/tmp/farm-worktree', '--name', 'farm',
      '--tool-command', 'agent-farm run free-range', '--agent', 'claude', '--launch', '--prompt-file', adoptPromptFile,
      '--as-file-pointer', '--wait-ready', '--yes', '--json',
    ]));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  const wireCalls = JSON.parse(JSON.stringify(calls));
  const adoptCall = wireCalls.find(call => call.channel === 'runpane:panes:adopt');
  assert.deepStrictEqual(adoptCall.request.panes[0].tool, {
    command: 'agent-farm run free-range',
    agentType: 'claude',
    initialInput: 'Step one\nStep two\n',
    initialInputAsFilePointer: true,
  });
  assert.strictEqual(adoptCall.request.panes[0].launch, true);
  assert.strictEqual(adoptCall.request.waitReady, true);
  const submitCalls = wireCalls.filter(call => call.channel === 'runpane:panels:submit');
  assert.match(submitCalls[0].request.operationId, /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(submitCalls[0].request.operationId, submitCalls[1].request.operationId);
  const { operationId: _npmOperationId, ...npmSubmit } = submitCalls[0].request;
  assert.deepStrictEqual(npmSubmit, { panelId: 'panel-1', input: 'Line one\nLine two', asFilePointer: true });
  assert.strictEqual(submitCalls[2].request.asFilePointer, undefined);
  const createCall = wireCalls.find(call => call.channel === 'runpane:panes:create');
  assert.deepStrictEqual(createCall.request.panes[0].tool, { agent: 'claude', initialInput: 'Line one\nLine two', initialInputAsFilePointer: true });
  const printed = stdout.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.strictEqual(printed[0].promptFile, promptFile);
  assert.deepStrictEqual(printed[0].warnings, warnings);
  assert.strictEqual(printed[1].items[0].promptFile, promptFile);
  assert.deepStrictEqual(printed[1].items[0].warnings, warnings);
  assert.strictEqual(printed[2].promptFile, promptFile);
  assert.ok(stdout.includes(`Prompt file: ${promptFile}`), stdout.join('\n'));
  assert.ok(stdout.includes('Warning (leading-bang-runs-shell): The text starts with `!`.'), stdout.join('\n'));
  assert.throws(
    () => buildPanelInputRequest(parseRunpaneArgs(['panels', 'input', '--panel', 'panel-1', '--text', 'x', '--as-file-pointer', '--yes']), 'input'),
    /--as-file-pointer is for panels submit/,
  );

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

submit_result = json.loads(${JSON.stringify(JSON.stringify(submitResult))})
create_result = json.loads(${JSON.stringify(JSON.stringify(createResult))})
calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    return submit_result if channel == "runpane:panels:submit" else create_result

local_control.invoke_daemon = fake_invoke
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panels_submit(parse_args([
        "panels", "submit", "--panel", "panel-1", "--text", "Line one\\nLine two", "--as-file-pointer", "--yes"
    ]))
    local_control.run_panes_create(parse_args([
        "panes", "create", "--repo", "active", "--name", "long", "--agent", "claude", "--prompt", "Line one\\nLine two",
        "--as-file-pointer", "--dry-run", "--yes", "--json"
    ]))
refused = False
try:
    local_control.build_tool_spec(parse_args(["panes", "create", "--repo", "active", "--name", "x", "--agent", "claude", "--as-file-pointer"]))
except ValueError as error:
    refused = "--as-file-pointer needs a prompt" in str(error)

print(json.dumps({"calls": calls, "stdout": stdout.getvalue().splitlines(), "refused": refused}))
`);
  const python = JSON.parse(pythonOutput);
  assert.match(python.calls[0].request.operationId, /^[0-9a-f-]{36}$/);
  const { operationId: _pythonOperationId, ...pythonSubmit } = python.calls[0].request;
  assert.deepStrictEqual(pythonSubmit, { panelId: 'panel-1', input: 'Line one\nLine two', asFilePointer: true });
  assert.deepStrictEqual(python.calls[1].request.panes[0].tool, { agent: 'claude', initialInput: 'Line one\nLine two', initialInputAsFilePointer: true });
  assert.ok(python.stdout.includes(`Prompt file: ${promptFile}`), python.stdout.join('\n'));
  assert.ok(python.stdout.includes('Warning (leading-bang-runs-shell): The text starts with `!`.'), python.stdout.join('\n'));
  assert.strictEqual(python.refused, true);
}

function checkAttachParity() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { buildPanelInputRequest, buildPanelCreateRequest } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-attach-')));
  const mockup = path.join(directory, 'mockup.png');
  const plan = path.join(directory, 'plan.html');
  fs.writeFileSync(mockup, 'png');
  fs.writeFileSync(plan, '<p>plan</p>');
  const submitArgs = ['panels', 'submit', '--panel', 'panel-1', '--text', 'Build it', '--as-file-pointer', '--attach', 'mockup.png', '--attach', plan, '--yes'];
  const originalCwd = process.cwd();
  process.chdir(directory);
  try {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(buildPanelInputRequest(parseRunpaneArgs(submitArgs), 'submit'))), {
      panelId: 'panel-1', input: 'Build it', asFilePointer: true, attachments: [mockup, plan],
    });
    assert.throws(
      () => buildPanelInputRequest(parseRunpaneArgs(['panels', 'submit', '--panel', 'panel-1', '--text', 'x', '--attach', plan, '--yes']), 'submit'),
      /--attach needs --as-file-pointer/,
    );
    assert.throws(
      () => buildPanelInputRequest(parseRunpaneArgs(['panels', 'submit', '--panel', 'panel-1', '--text', 'x', '--as-file-pointer', '--attach', 'missing.png', '--yes']), 'submit'),
      /--attach missing\.png: no such file/,
    );
  } finally {
    process.chdir(originalCwd);
  }
  return buildPanelCreateRequest(parseRunpaneArgs([
    'panels', 'create', '--pane', 'pane-1', '--agent', 'claude', '--prompt', 'Build it', '--as-file-pointer', '--attach', mockup, '--yes',
  ])).then((request) => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(request.tool)), { agent: 'claude', initialInput: 'Build it', initialInputAsFilePointer: true, initialInputAttachments: [mockup] });
    const python = JSON.parse(runPythonSnippet(`
import json, os
import runpane.local_control as local_control
from runpane.cli import parse_args

os.chdir(${JSON.stringify(directory)})
submit = local_control.build_panel_input_request(parse_args(${JSON.stringify(submitArgs)}), "submit")
tool = local_control.build_tool_spec(parse_args([
    "panels", "create", "--pane", "pane-1", "--agent", "claude", "--prompt", "Build it", "--as-file-pointer", "--attach", ${JSON.stringify(mockup)}, "--yes"
]), "panels create")
refused = []
for args in (["panels", "submit", "--panel", "panel-1", "--text", "x", "--attach", "plan.html", "--yes"],
             ["panels", "submit", "--panel", "panel-1", "--text", "x", "--as-file-pointer", "--attach", "missing.png", "--yes"]):
    try:
        local_control.build_panel_input_request(parse_args(args), "submit")
    except ValueError as error:
        refused.append(str(error))
print(json.dumps({"submit": submit, "tool": tool, "refused": refused}))
`));
    assert.deepStrictEqual(python.submit, { panelId: 'panel-1', input: 'Build it', asFilePointer: true, attachments: [mockup, plan] });
    assert.deepStrictEqual(python.tool, JSON.parse(JSON.stringify(request.tool)));
    assert.match(python.refused[0], /--attach needs --as-file-pointer/);
    assert.match(python.refused[1], /--attach missing\.png: no such file/);
  });
}

async function checkDeliveryParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const localControl = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const { runAgentsSend } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'agentTasks.js'));
  const output = process.stdout;
  const schemas = contract.jsonSchemas;
  const queued = { state: 'queued', evidence: 'transcript' };
  const submitResult = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', inputBytes: 18, enter: 'cr', sequenceName: 'enter-cr',
    verifiedSubmitted: true, verification: 'observed', delivery: queued, sentAt: '2026-09-27T18:00:00.000Z',
  };
  const composerResult = {
    ok: false, panelId: 'panel-1', paneId: 'session-1', inputBytes: 2, strategy: 'enter', sequenceName: 'enter-cr',
    verifiedSubmitted: false, delivery: { state: 'in-composer', evidence: 'screen' }, sentAt: '2026-09-27T18:00:00.000Z',
    blocked: { kind: 'agent-prompt', message: 'Still in the composer.' },
  };
  const screenText = `${'─'.repeat(20)}\n❯ merge it\n${'─'.repeat(20)}\n  ? for shortcuts`;
  const screenResult = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', source: 'alternateScreen', limit: 80, returnedLineCount: 4, hasMore: false,
    text: screenText, state: { initialized: true, agentType: 'claude' },
    composer: { isPresent: true, hasUndeliveredText: false, ghostText: 'merge it' },
  };
  const createResult = {
    ok: true,
    repo: { id: 1, name: 'repo', path: '/repo', active: true, sessionCount: 1 },
    items: [{
      ok: true, index: 0, name: 'task', pinned: true, sessionId: 'session-1', panelId: 'panel-1',
      initialInput: {
        delivered: true, submitted: true, inputBytes: 12, strategy: 'argument', sequenceName: 'argument',
        verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'argv' },
      },
    }],
  };
  assertMatchesJsonSchema(submitResult, schemas.panelSubmitResult, 'panel submit result with delivery');
  assertMatchesJsonSchema(composerResult, schemas.panelSubmitComposerResult, 'submit-composer result with delivery');
  assertMatchesJsonSchema(screenResult, schemas.panelScreenResult, 'panel screen result with ghostText');
  assert.strictEqual(matchesJsonSchema({ ...submitResult, delivery: { ...queued, file: '/t.jsonl' } }, schemas.panelSubmitResult), false);
  assert.strictEqual(matchesJsonSchema({ ...screenResult, composer: { ...screenResult.composer, ghostText: 3 } }, schemas.panelScreenResult), false);

  const calls = [];
  const stdout = [];
  const written = [];
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const originalWrite = output.write;
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    if (channel === 'runpane:panels:submit') return submitResult;
    if (channel === 'runpane:panels:submit-composer') return composerResult;
    if (channel === 'runpane:panels:screen') return screenResult;
    return createResult;
  };
  console.log = (line) => stdout.push(String(line));
  output.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    await localControl.runPanelsSubmit(parseRunpaneArgs(['panels', 'submit', '--panel', 'panel-1', '--text', 'Also run the linter', '--yes', '--json']));
    await localControl.runPanelsSubmit(parseRunpaneArgs(['panels', 'submit', '--panel', 'panel-1', '--text', 'Also run the linter', '--yes']));
    await localControl.runPanelsSubmitComposer(parseRunpaneArgs(['panels', 'submit-composer', '--panel', 'panel-1', '--yes', '--json']));
    await localControl.runPanelsScreen(parseRunpaneArgs(['panels', 'screen', '--panel', 'panel-1', '--json']));
    await localControl.runPanelsScreen(parseRunpaneArgs(['panels', 'screen', '--panel', 'panel-1']));
    await runAgentsSend(parseRunpaneArgs(['agents', 'send', '--panel', 'panel-1', '--text', 'Also run the linter', '--yes', '--json']));
    await runAgentsSend(parseRunpaneArgs(['agents', 'send', '--panel', 'panel-1', '--text', 'Also run the linter', '--yes']));
    await localControl.runPanesCreate(parseRunpaneArgs(['panes', 'create', '--repo', 'active', '--name', 'task', '--agent', 'claude', '--prompt', 'Start task', '--yes']));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    output.write = originalWrite;
  }

  const printed = stdout.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  // Boundary decoders drop undeclared keys, so these prove the decoders declare them.
  assert.deepStrictEqual(printed[0].delivery, queued);
  assert.deepStrictEqual(printed[1].delivery, composerResult.delivery);
  assert.strictEqual(printed[2].composer.ghostText, 'merge it');
  assert.deepStrictEqual(printed[3].delivery, queued);
  assert.strictEqual(printed[3].delivered, true);
  assert.ok(stdout.includes('Delivery: queued (transcript) — The agent sees this only after its current turn ends. Do not resend.'), stdout.join('\n'));
  assert.ok(stdout.includes('Delivered to panel-1 (queued, from the transcript).'), stdout.join('\n'));
  assert.ok(stdout.includes('  Delivery: taken (argv)'), stdout.join('\n'));
  const screenOut = written.join('');
  assert.ok(screenOut.includes('❯ merge it  ⟨suggestion⟩\n'), screenOut);

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

results = {
    "runpane:panels:submit": json.loads(${JSON.stringify(JSON.stringify(submitResult))}),
    "runpane:panels:submit-composer": json.loads(${JSON.stringify(JSON.stringify(composerResult))}),
    "runpane:panels:screen": json.loads(${JSON.stringify(JSON.stringify(screenResult))}),
    "runpane:panes:create": json.loads(${JSON.stringify(JSON.stringify(createResult))}),
}
local_control.invoke_daemon = lambda channel, args, **kwargs: results[channel]
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panels_submit(parse_args(["panels", "submit", "--panel", "panel-1", "--text", "Also run the linter", "--yes"]))
    local_control.run_panels_submit_composer(parse_args(["panels", "submit-composer", "--panel", "panel-1", "--yes"]))
    local_control.run_panels_screen(parse_args(["panels", "screen", "--panel", "panel-1"]))
    local_control.run_panes_create(parse_args(["panes", "create", "--repo", "active", "--name", "task", "--agent", "claude", "--prompt", "Start task", "--yes"]))
print(json.dumps({"stdout": stdout.getvalue().splitlines()}))
`);
  const python = JSON.parse(pythonOutput);
  assert.ok(python.stdout.includes('Delivery: queued (transcript) — The agent sees this only after its current turn ends. Do not resend.'), python.stdout.join('\n'));
  assert.ok(python.stdout.includes('Delivery: in-composer (screen)'), python.stdout.join('\n'));
  assert.ok(python.stdout.includes('❯ merge it  ⟨suggestion⟩'), python.stdout.join('\n'));
  assert.ok(python.stdout.includes('  Delivery: taken (argv)'), python.stdout.join('\n'));
}

async function checkReportParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const localControl = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const { runAgentsStatus } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'agentTasks.js'));
  const { decodeBoundary } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'boundaryDecoder.js'));
  const schemas = contract.jsonSchemas;
  const report = {
    state: 'ready', pr: 747, head: 'fc5dce9', summary: 'Tests pass.', summaryPath: '/tmp/report.md', reportedAt: '2026-09-27T18:00:00.000Z',
  };
  const reportResult = { ok: true, generation: 41, paneId: 'session-1', panelId: 'panel-1', report, sessionIds: ['session-a'], extra: 'dropped' };
  const lastMessage = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', agentType: 'claude', text: 'Opened PR #747.', length: 15, limit: 20000, truncated: false,
  };
  const unavailable = {
    ok: false, panelId: 'panel-2', paneId: 'session-1', reason: 'transcript-unavailable', message: 'No claude transcript reply found.',
  };
  const panelList = {
    ok: true, paneId: 'session-1',
    panels: [{ id: 'panel-1', panelId: 'panel-1', paneId: 'session-1', type: 'terminal', title: 'Claude', active: true, report }],
  };
  const stateResult = {
    ok: true, epoch: 'e', generation: 3,
    entries: [{ gen: 3, at: 'T', kind: 'agent.ready', paneId: 'session-1', paneName: 'fix-login', panelId: 'panel-1', source: 'agent', baseline: true }],
  };
  const screenResult = {
    ok: true, panelId: 'panel-1', paneId: 'session-1', source: 'alternateScreen', limit: 40, returnedLineCount: 1, hasMore: false,
    text: 'done', state: { initialized: true }, composer: { isPresent: false, hasUndeliveredText: false },
  };
  assertMatchesJsonSchema({ ...reportResult, extra: undefined, report }, { ...schemas.reportResult, additionalProperties: true }, 'report result');
  assertMatchesJsonSchema(report, schemas.agentReport, 'agent report');
  assertMatchesJsonSchema(lastMessage, schemas.panelLastMessageResult, 'last-message result');
  assertMatchesJsonSchema(unavailable, schemas.panelLastMessageResult, 'last-message unavailable result');
  assert.strictEqual(matchesJsonSchema({ ...unavailable, reason: 'screen' }, schemas.panelLastMessageResult), false);
  assert.strictEqual(matchesJsonSchema({ ...lastMessage, fromScreen: true }, schemas.panelLastMessageResult), false);
  assert.ok(schemas.workspaceEntry.properties.kind.enum.includes('agent.report'));

  // Identity: explicit flags win, then the Pane terminal's environment, else a clear error.
  const identity = async (args, env) => {
    const originalInvoke = daemonClient.invokeDaemon;
    const originalLog = console.log;
    let request;
    daemonClient.invokeDaemon = async (_channel, callArgs) => {
      request = callArgs[0];
      return reportResult;
    };
    console.log = () => {};
    try {
      await localControl.runReport(parseRunpaneArgs(['report', '--state', 'done', ...args]), env);
    } finally {
      daemonClient.invokeDaemon = originalInvoke;
      console.log = originalLog;
    }
    return JSON.parse(JSON.stringify({ paneId: request.paneId, panelId: request.panelId }));
  };
  assert.deepStrictEqual(await identity([], { PANE_SESSION_ID: 'session-1', PANE_PANEL_ID: 'panel-1' }), { paneId: 'session-1', panelId: 'panel-1' });
  assert.deepStrictEqual(await identity(['--panel', 'panel-9'], { PANE_SESSION_ID: 'session-1', PANE_PANEL_ID: 'panel-1' }), { panelId: 'panel-9' });
  assert.deepStrictEqual(await identity(['--pane', 'session-2', '--panel', 'panel-9'], {}), { paneId: 'session-2', panelId: 'panel-9' });
  await assert.rejects(identity([], {}), /cannot tell which panel is reporting/);
  await assert.rejects(identity(['--pane', 'session-2'], { PANE_PANEL_ID: 'panel-1' }), /--pane also needs --panel/);
  const pythonIdentity = JSON.parse(runPythonSnippet(`
import json
from runpane.cli import parse_args
from runpane.local_control import resolve_report_identity

def identity(args, env):
    try:
        return resolve_report_identity(parse_args(["report", "--state", "done", *args]), env)
    except ValueError as error:
        return {"error": str(error)}

print(json.dumps([
    identity([], {"PANE_SESSION_ID": "session-1", "PANE_PANEL_ID": "panel-1"}),
    identity(["--panel", "panel-9"], {"PANE_SESSION_ID": "session-1", "PANE_PANEL_ID": "panel-1"}),
    identity(["--pane", "session-2", "--panel", "panel-9"], {}),
    identity([], {}),
    identity(["--pane", "session-2"], {"PANE_PANEL_ID": "panel-1"}),
]))
`));
  assert.deepStrictEqual(pythonIdentity.slice(0, 3), [
    { paneId: 'session-1', panelId: 'panel-1' },
    { panelId: 'panel-9' },
    { paneId: 'session-2', panelId: 'panel-9' },
  ]);
  assert.match(pythonIdentity[3].error, /cannot tell which panel is reporting/);
  assert.match(pythonIdentity[4].error, /--pane also needs --panel/);

  // Argument errors match across wrappers.
  const parseErrors = [
    [['report'], /requires --state/],
    [['report', '--state', 'waiting'], /--state must be one of: ready, blocked, failed, done/],
    [['report', '--state', 'blocked'], /--state blocked requires --question/],
    [['report', '--state', 'ready', '--pr', '0'], /--pr must be a positive integer/],
    [['report', '--state', 'ready', '--pr', '12a'], /--pr must be a positive integer/],
    [['report', '--state', 'ready', '--head', 'abc'], /--head must be a commit SHA of 7 to 40 hex characters/],
    [['report', '--state', 'ready', '--head', 'zzzzzzz'], /--head must be a commit SHA/],
    [['report', '--state', 'ready', '--summary', 'a', '--summary-file', '/tmp/x'], /either --summary or --summary-file/],
  ];
  for (const [args, pattern] of parseErrors) {
    assert.throws(() => parseRunpaneArgs(args), pattern, args.join(' '));
  }
  const pythonErrors = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args

errors = []
for args in json.loads(sys.stdin.read()):
    try:
        parse_args(args)
        errors.append(None)
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
`, JSON.stringify(parseErrors.map(([args]) => args))));
  parseErrors.forEach(([args, pattern], index) => {
    assert.ok(pythonErrors[index] && pattern.test(pythonErrors[index]), `python ${args.join(' ')}: ${pythonErrors[index]}`);
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-report-'));
  const summaryFile = path.join(tempDir, 'report.md');
  fs.writeFileSync(summaryFile, `\uFEFF${'s'.repeat(20_000)}`);
  const calls = [];
  const stdout = [];
  const stderr = [];
  const written = [];
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalWrite = process.stdout.write;
  const respond = (channel, request) => {
    if (channel === 'runpane:report') return reportResult;
    if (channel === 'runpane:panels:last-message') return request.panelId === 'panel-2' ? unavailable : lastMessage;
    if (channel === 'runpane:panels:list') return panelList;
    if (channel === 'runpane:workspace:state') return stateResult;
    if (channel === 'runpane:panels:screen') return screenResult;
    throw new Error(`unexpected channel ${channel}`);
  };
  // Decode with the caller's boundary schema, as the real client does, so dropped keys show.
  daemonClient.invokeDaemon = async (channel, args, schema) => {
    calls.push({ channel, request: args[0] });
    return decodeBoundary(respond(channel, args[0]), schema);
  };
  console.log = (line) => stdout.push(String(line));
  console.error = (line) => stderr.push(String(line));
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  const exitCodes = [];
  try {
    exitCodes.push(await localControl.runReport(parseRunpaneArgs([
      'report', '--state', 'ready', '--pr', '747', '--head', 'FC5DCE9', '--summary-file', summaryFile, '--json',
    ]), { PANE_SESSION_ID: 'session-1', PANE_PANEL_ID: 'panel-1' }));
    exitCodes.push(await localControl.runReport(parseRunpaneArgs([
      'report', '--state', 'blocked', '--question', 'Which API version?', '--panel', 'panel-1',
    ]), {}));
    exitCodes.push(await localControl.runPanelsLastMessage(parseRunpaneArgs(['panels', 'last-message', '--panel', 'panel-1', '--json'])));
    exitCodes.push(await localControl.runPanelsLastMessage(parseRunpaneArgs(['panels', 'last-message', '--panel', 'panel-1'])));
    exitCodes.push(await localControl.runPanelsLastMessage(parseRunpaneArgs(['panels', 'last-message', '--panel', 'panel-2', '--limit', '500'])));
    exitCodes.push(await runAgentsStatus(parseRunpaneArgs(['agents', 'status', '--panel', 'panel-1', '--json'])));
    exitCodes.push(await runAgentsStatus(parseRunpaneArgs(['agents', 'status', '--panel', 'panel-1'])));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.stdout.write = originalWrite;
  }

  assert.deepStrictEqual(exitCodes, [0, 0, 0, 0, 1, 0, 0]);
  // Requests travel as JSON, which drops undefined fields.
  const reportRequests = calls.filter((call) => call.channel === 'runpane:report').map((call) => JSON.parse(JSON.stringify(call.request)));
  assert.strictEqual(reportRequests[0].paneId, 'session-1');
  assert.strictEqual(reportRequests[0].panelId, 'panel-1');
  assert.strictEqual(reportRequests[0].head, 'fc5dce9');
  assert.strictEqual(reportRequests[0].pr, 747);
  assert.strictEqual(reportRequests[0].summaryPath, summaryFile);
  assert.strictEqual(reportRequests[0].summary.length, 16_001, 'the CLI bounds the summary one past the daemon limit');
  assert.ok(!reportRequests[0].summary.startsWith('\uFEFF'));
  assert.deepStrictEqual(reportRequests[1], { panelId: 'panel-1', state: 'blocked', question: 'Which API version?' });
  assert.deepStrictEqual(calls.find((call) => call.channel === 'runpane:panels:last-message').request, { panelId: 'panel-1', limit: undefined });
  assert.strictEqual(calls.filter((call) => call.channel === 'runpane:panels:last-message')[2].request.limit, 500);

  const printed = stdout.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  // Boundary decoders drop undeclared keys, so these prove the decoders declare them.
  assert.deepStrictEqual(printed[0].report, report);
  assert.deepStrictEqual(printed[0].sessionIds, ['session-a']);
  assert.strictEqual(printed[0].extra, undefined);
  assert.deepStrictEqual(printed[1], lastMessage);
  assert.deepStrictEqual(printed[2].report, report, 'agents status includes the panel report');
  assert.ok(stdout.includes('Reported ready pr#747 fc5dce9 for panel panel-1. Recorded on Session session-a.'), stdout.join('\n'));
  assert.ok(stdout.some((line) => line.includes('Report: ready pr#747 fc5dce9 (2026-09-27T18:00:00.000Z)')), stdout.join('\n'));
  assert.ok(written.join('').includes('Opened PR #747.\n'), written.join(''));
  assert.ok(stderr.includes('transcript-unavailable: No claude transcript reply found.'), stderr.join('\n'));

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

calls = []
results = {
    "runpane:report": json.loads(${JSON.stringify(JSON.stringify(reportResult))}),
    "runpane:panels:last-message": json.loads(${JSON.stringify(JSON.stringify(lastMessage))}),
}
unavailable = json.loads(${JSON.stringify(JSON.stringify(unavailable))})

def invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    if channel == "runpane:panels:last-message" and args[0]["panelId"] == "panel-2":
        return unavailable
    return results[channel]

local_control.invoke_daemon = invoke
stdout = io.StringIO()
stderr = io.StringIO()
codes = []
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    codes.append(local_control.run_report(parse_args(["report", "--state", "ready", "--pr", "747", "--head", "FC5DCE9", "--summary-file", ${JSON.stringify(summaryFile)}]), {"PANE_SESSION_ID": "session-1", "PANE_PANEL_ID": "panel-1"}))
    codes.append(local_control.run_report(parse_args(["report", "--state", "blocked", "--question", "Which API version?", "--panel", "panel-1"]), {}))
    codes.append(local_control.run_panels_last_message(parse_args(["panels", "last-message", "--panel", "panel-1"])))
    codes.append(local_control.run_panels_last_message(parse_args(["panels", "last-message", "--panel", "panel-2"])))
print(json.dumps({"codes": codes, "calls": calls, "stdout": stdout.getvalue().splitlines(), "stderr": stderr.getvalue().splitlines()}))
`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.codes, [0, 0, 0, 1]);
  const pythonReports = python.calls.filter((call) => call.channel === 'runpane:report').map((call) => call.request);
  assert.deepStrictEqual(
    { ...pythonReports[0], summary: pythonReports[0].summary.length },
    { ...reportRequests[0], summary: reportRequests[0].summary.length },
    'Python sends the same report request as npm',
  );
  assert.deepStrictEqual(pythonReports[1], reportRequests[1]);
  assert.ok(python.stdout.includes('Reported ready pr#747 fc5dce9 for panel panel-1. Recorded on Session session-a.'), python.stdout.join('\n'));
  assert.ok(python.stdout.includes('Opened PR #747.'), python.stdout.join('\n'));
  assert.ok(python.stderr.includes('transcript-unavailable: No claude transcript reply found.'), python.stderr.join('\n'));
}

async function checkPanesCostParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesCost } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const totals = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheCreationTokens: 0,
    totalTokens: 170,
    messageCount: 1,
    estimatedCostUsd: 0.004,
    costIncomplete: false,
    cacheSavingsUsd: 0.0001,
  };
  const model = { ...totals, model: 'claude-sonnet-5', provider: 'claude' };
  const payload = {
    ok: true,
    fromMs: 1,
    toMs: 2,
    pricingAsOf: 'test',
    panes: [{
      ...totals,
      paneId: 'p1',
      paneName: 'Pane one',
      worktreePath: '/tmp/p1',
      repoId: 1,
      archived: false,
      createdAtMs: 1,
      uncachedCostUsd: 0.003,
      uncachedInputTokens: 100,
      cacheHitRate: 0.25,
      byModel: [model],
    }],
    unattributed: {
      ...totals,
      uncachedCostUsd: 0.003,
      uncachedInputTokens: 100,
      cacheHitRate: 0.25,
      byModel: [model],
    },
    totals,
  };
  const incompleteModel = { ...model, estimatedCostUsd: 0, costIncomplete: true };
  const incompletePayload = {
    ...payload,
    panes: payload.panes.map((pane) => ({
      ...pane,
      estimatedCostUsd: 0,
      costIncomplete: true,
      byModel: [incompleteModel],
    })),
    unattributed: {
      ...payload.unattributed,
      estimatedCostUsd: 0,
      costIncomplete: true,
      byModel: [incompleteModel],
    },
    totals: { ...totals, estimatedCostUsd: 0, costIncomplete: true },
  };
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  const jsonOutputs = [];
  const textOutput = [];
  const incompleteTextOutput = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    return calls.length === 5 ? incompletePayload : payload;
  };
  try {
    for (const args of [
      ['panes', 'cost', '--json'],
      ['panes', 'cost', '--pane', 'p1', '--json'],
      ['panes', 'cost', '--repo', 'active', '--json'],
    ]) {
      console.log = line => jsonOutputs.push(String(line));
      await runPanesCost(parseRunpaneArgs(args));
    }
    console.log = line => textOutput.push(String(line));
    await runPanesCost(parseRunpaneArgs(['panes', 'cost']));
    console.log = line => incompleteTextOutput.push(String(line));
    await runPanesCost(parseRunpaneArgs(['panes', 'cost']));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  const python = JSON.parse(runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

payload = json.loads(${JSON.stringify(JSON.stringify(payload))})
incomplete_payload = json.loads(${JSON.stringify(JSON.stringify(incompletePayload))})
calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    return incomplete_payload if len(calls) == 5 else payload

local_control.invoke_daemon = fake_invoke
json_outputs = []
for args in [
    ["panes", "cost", "--json"],
    ["panes", "cost", "--pane", "p1", "--json"],
    ["panes", "cost", "--repo", "active", "--json"],
]:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        local_control.run_panes_cost(parse_args(args))
    json_outputs.append(stdout.getvalue().rstrip("\\n"))

stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_cost(parse_args(["panes", "cost"]))
incomplete_stdout = io.StringIO()
with contextlib.redirect_stdout(incomplete_stdout):
    local_control.run_panes_cost(parse_args(["panes", "cost"]))
print(json.dumps({"calls": calls, "jsonOutputs": json_outputs, "textOutput": stdout.getvalue().splitlines(), "incompleteTextOutput": incomplete_stdout.getvalue().splitlines()}))
`));

  assert.strictEqual(calls.length, 5);
  assert.ok(calls.every(call => call.channel === 'runpane:panes:cost'));
  const nodeCalls = JSON.parse(JSON.stringify(calls));
  assert.deepStrictEqual(nodeCalls.slice(0, 3), [
    { channel: 'runpane:panes:cost', request: {} },
    { channel: 'runpane:panes:cost', request: { paneId: 'p1' } },
    { channel: 'runpane:panes:cost', request: { repo: 'active' } },
  ]);
  assert.deepStrictEqual(python.calls, nodeCalls);
  const paneCostRequestSchema = contract.jsonSchemas.paneCostRequest;
  for (const [index, call] of [...nodeCalls, ...python.calls].entries()) {
    assertMatchesJsonSchema(call.request, paneCostRequestSchema, `panes cost request ${index + 1}`);
  }
  assertMatchesJsonSchema({ repo: { active: true } }, paneCostRequestSchema, 'object repo selector');
  assert.strictEqual(matchesJsonSchema({ repo: 1 }, paneCostRequestSchema), false);
  assert.deepStrictEqual(python.jsonOutputs, jsonOutputs);
  assert.ok(textOutput.some(line => line.includes('p1\tPane one')));
  assert.ok(textOutput.some(line => line.includes('  claude-sonnet-5')));
  assert.deepStrictEqual(python.textOutput, textOutput);
  assert.ok(incompleteTextOutput.some(line => line.includes('p1\tPane one\tn/a uncached\tn/a total')));
  assert.ok(incompleteTextOutput.some(line => line.includes('Unattributed\tn/a uncached\tn/a total')));
  assert.ok(incompleteTextOutput.some(line => line.includes('Total\tn/a\t')));
  assert.deepStrictEqual(python.incompleteTextOutput, incompleteTextOutput);
}

function checkComposerStrategyRequests() {
  const python = JSON.parse(runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

requests = []
def fake_invoke(channel, args, **kwargs):
    assert channel == "runpane:panels:submit-composer"
    requests.append(args[0])
    return {"ok": True}

local_control.invoke_daemon = fake_invoke
with contextlib.redirect_stdout(io.StringIO()):
    for flags in [[], ["--strategy", "enter"], ["--strategy", "auto"], ["--strategy", "codex-ctrl-enter"]]:
        result = local_control.run_panels_submit_composer(parse_args([
            "panels", "submit-composer", "--panel", "panel-1", "--yes", "--json", *flags
        ]))
        assert result == 0
print(json.dumps(requests))
`));
  assert.deepStrictEqual(python, [
    { panelId: 'panel-1' },
    { panelId: 'panel-1', strategy: 'enter' },
    { panelId: 'panel-1', strategy: 'auto' },
    { panelId: 'panel-1', strategy: 'codex-ctrl-enter' },
  ], 'omitting --strategy must leave selection to the daemon, while explicit strategies are preserved');
}

async function checkPaneAdoptOverrides() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesAdopt } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-adopt-'));
  const inputPath = path.join(directory, 'adopt.json');
  const payload = {
    repo: 'active', dryRun: false, noFocus: true, focus: false, source: 'agent',
    panes: [
      { name: 'Existing work', path: '/work/tree', pinned: true, launch: false, tool: { agent: 'codex' } },
      { name: 'Other work', path: '/work/other', pinned: true, launch: false, tool: { command: 'echo ready' } },
    ],
  };
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const requests = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    assert.strictEqual(channel, 'runpane:panes:adopt');
    requests.push(JSON.parse(JSON.stringify(args[0])));
    return { ok: true, repo: {}, items: [] };
  };
  console.log = () => {};
  try {
    fs.writeFileSync(inputPath, JSON.stringify(payload));
    // No --yes: dry-run must be forwarded when it bypasses confirmation.
    await runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--from-json', inputPath, '--dry-run', '--focus', '--source', 'user',
      '--no-pinned', '--launch', '--json',
    ]));
    assert.deepStrictEqual(requests.pop(), {
      repo: 'active', dryRun: true, noFocus: false, focus: true, source: 'user',
      panes: [
        { name: 'Existing work', path: '/work/tree', pinned: false, launch: true, tool: { agent: 'codex' } },
        { name: 'Other work', path: '/work/other', pinned: false, launch: true, tool: { command: 'echo ready' } },
      ],
    });
    await runPanesAdopt(parseRunpaneArgs(['panes', 'adopt', '--from-json', inputPath, '--yes', '--json']));
    assert.deepStrictEqual(requests.pop(), payload, 'absent flags preserve the JSON request');

    fs.writeFileSync(inputPath, JSON.stringify({
      ...payload, noFocus: false, focus: true, source: 'user',
      panes: payload.panes.map(pane => ({ ...pane, pinned: false })),
    }));
    await runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--from-json', inputPath, '--dry-run', '--no-focus', '--source', 'agent',
      '--pinned', '--json',
    ]));
    assert.deepStrictEqual(requests.pop(), { ...payload, dryRun: true });
    await assert.rejects(runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--from-json', inputPath, '--dry-run', '--focus', '--no-focus',
    ])), /Use either --focus or --no-focus/);
    await assert.rejects(runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--from-json', inputPath, '--dry-run', '--pinned', '--no-pinned',
    ])), /Use either --pinned or --no-pinned/);
    assert.strictEqual(requests.length, 0, 'conflicting overrides must not reach the daemon');
    await runPanesAdopt(parseRunpaneArgs([
      'panes', 'adopt', '--repo', 'active', '--path', '/work/tree', '--name', 'Existing work',
      '--agent', 'codex', '--dry-run', '--no-pinned', '--no-focus', '--source', 'agent', '--launch', '--json',
    ]));
    assert.deepStrictEqual(requests.pop(), {
      repo: 'active', dryRun: true, noFocus: true, focus: false, source: 'agent',
      panes: [{ name: 'Existing work', path: '/work/tree', pinned: false, launch: true, tool: { agent: 'codex' } }],
    });
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function checkPaneArchiveDryRunParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesArchive } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const result = {
    ok: true,
    paneId: 'session-1',
    dryRun: true,
    wouldArchive: false,
    forced: false,
    safetyCheck: {
      performed: true,
      hasUpstream: true,
      upstream: 'origin/main',
      upstreamRefreshed: true,
      unpushedCommits: 1,
      unpushedCommitDetails: [{ sha: 'abc123', subject: 'local change' }],
    },
    blocked: {
      code: 'unpushed-commits',
      message: 'Pane has 1 commit not pushed to any remote.',
      safetyCheck: {
        performed: true,
        hasUpstream: true,
        upstream: 'origin/main',
        upstreamRefreshed: true,
        unpushedCommits: 1,
        unpushedCommitDetails: [{ sha: 'abc123', subject: 'local change' }],
      },
    },
  };
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  const stdout = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    return result;
  };
  console.log = line => stdout.push(String(line));

  try {
    await runPanesArchive(parseRunpaneArgs(['panes', 'archive', '--pane', 'session-1', '--dry-run', '--json']));
    await runPanesArchive(parseRunpaneArgs(['panes', 'archive', '--pane', 'session-1', '--dry-run']));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  assert.deepStrictEqual(calls, [{
    channel: 'runpane:panes:archive',
    request: { paneId: 'session-1', dryRun: true },
  }, {
    channel: 'runpane:panes:archive',
    request: { paneId: 'session-1', dryRun: true },
  }]);
  assert.deepStrictEqual(JSON.parse(stdout[0]), result);
  assertIncludes(stdout.slice(1).join('\n'), 'Would refuse to archive pane session-1.');
  assertIncludes(stdout.slice(1).join('\n'), 'Upstream: origin/main (refreshed)');
  assertIncludes(stdout.slice(1).join('\n'), 'Unpushed: abc123 local change');

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

result = json.loads(${JSON.stringify(JSON.stringify(result))})
calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    return result

local_control.invoke_daemon = fake_invoke
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_archive(parse_args(["panes", "archive", "--pane", "session-1", "--dry-run", "--json"]))
    local_control.run_panes_archive(parse_args(["panes", "archive", "--pane", "session-1", "--dry-run"]))
print(json.dumps({"calls": calls, "stdout": stdout.getvalue().splitlines()}))
`);
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.calls, JSON.parse(JSON.stringify(calls)));
  const humanOutputIndex = python.stdout.indexOf('Would refuse to archive pane session-1.');
  assert.ok(humanOutputIndex > 0);
  assert.deepStrictEqual(JSON.parse(python.stdout.slice(0, humanOutputIndex).join('\n')), result);
  const pythonHumanOutput = python.stdout.slice(humanOutputIndex).join('\n');
  assertIncludes(pythonHumanOutput, 'Would refuse to archive pane session-1.');
  assertIncludes(pythonHumanOutput, 'Upstream: origin/main (refreshed)');
  assertIncludes(pythonHumanOutput, 'Unpushed: abc123 local change');

  // An archive that leaves an adopted worktree says why, in JSON and in text.
  const external = {
    ok: true,
    paneId: 'session-2',
    archived: true,
    forced: false,
    worktreeCleanup: 'not-applicable',
    worktreePath: '/tmp/adopted',
    safetyCheck: { performed: false, reason: 'external-worktree', worktreeWillRemain: true },
  };
  const externalStdout = [];
  daemonClient.invokeDaemon = async () => external;
  console.log = line => externalStdout.push(String(line));
  try {
    await runPanesArchive(parseRunpaneArgs(['panes', 'archive', '--pane', 'session-2', '--yes', '--json']));
    await runPanesArchive(parseRunpaneArgs(['panes', 'archive', '--pane', 'session-2', '--yes']));
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }
  assert.deepStrictEqual(JSON.parse(externalStdout[0]), external);
  const skipLine = 'Safety check skipped: external-worktree; the worktree stays on disk.';
  assertIncludes(externalStdout.slice(1).join('\n'), skipLine);
  const pythonExternal = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

result = json.loads(${JSON.stringify(JSON.stringify(external))})
local_control.invoke_daemon = lambda channel, args, **kwargs: result
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_archive(parse_args(["panes", "archive", "--pane", "session-2", "--yes"]))
print(stdout.getvalue())
`);
  assertIncludes(pythonExternal, skipLine);
}

async function checkPaneRenameParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesRename } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  const stdout = [];

  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    return {
      ok: true,
      dryRun: args[0].dryRun ? true : undefined,
      pane: { paneId: args[0].paneId, name: args[0].name },
    };
  };
  console.log = (line) => stdout.push(String(line));

  try {
    await runPanesRename(parseRunpaneArgs(['panes', 'rename', '--pane', 'session-1', '--name', '  renamed pane  ', '--yes', '--json']));
    await runPanesRename(parseRunpaneArgs(['panes', 'rename', '--pane', 'session-1', '--name', 'preview', '--dry-run', '--json']));
    await assert.rejects(
      runPanesRename(parseRunpaneArgs(['panes', 'rename', '--pane', 'session-1', '--name', 'renamed pane'])),
      /Rerun with --yes in non-interactive shells/,
    );
    await assert.rejects(
      runPanesRename(parseRunpaneArgs(['panes', 'rename', '--pane', 'session-1', '--name', '   ', '--yes'])),
      /non-empty --name/,
    );
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  assert.deepStrictEqual(calls, [{
    channel: 'runpane:panes:rename',
    request: { paneId: 'session-1', name: 'renamed pane' }
  }, {
    channel: 'runpane:panes:rename',
    request: { paneId: 'session-1', name: 'preview', dryRun: true }
  }]);

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import runpane.local_control as local_control
from runpane.cli import parse_args

calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    return {"ok": True, **({"dryRun": True} if args[0].get("dryRun") else {}), "pane": {"paneId": args[0]["paneId"], "name": args[0]["name"]}}

local_control.invoke_daemon = fake_invoke
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    local_control.run_panes_rename(parse_args(["panes", "rename", "--pane", "session-1", "--name", "  renamed pane  ", "--yes", "--json"]))
    local_control.run_panes_rename(parse_args(["panes", "rename", "--pane", "session-1", "--name", "preview", "--dry-run", "--json"]))

refused = False
try:
    local_control.run_panes_rename(parse_args(["panes", "rename", "--pane", "session-1", "--name", "renamed pane"]))
except ValueError as error:
    refused = "Rerun with --yes in non-interactive shells" in str(error)

empty_rejected = False
try:
    local_control.run_panes_rename(parse_args(["panes", "rename", "--pane", "session-1", "--name", "   ", "--yes"]))
except ValueError as error:
    empty_rejected = "non-empty --name" in str(error)

print(json.dumps({"calls": calls, "stdout": stdout.getvalue().splitlines(), "refused": refused, "emptyRejected": empty_rejected}))
`);
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.calls, calls);
  const parseJsonObjects = (lines) => JSON.parse(`[${lines.join('\n').replace(/}\n{/g, '},{')}]`);
  assert.deepStrictEqual(parseJsonObjects(python.stdout), parseJsonObjects(stdout));
  assert.strictEqual(python.refused, true);
  assert.strictEqual(python.emptyRejected, true);
}

async function checkLockParity() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runLockAcquire, runLockRelease, runLockList } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const originalEnv = { PANE_SESSION_ID: process.env.PANE_SESSION_ID, PANE_PANEL_ID: process.env.PANE_PANEL_ID };
  const lock = {
    name: 'testing-account',
    scope: 'session',
    sessionId: 'orch-1',
    owner: { kind: 'pane', paneId: 'pane-a', panelId: 'panel-a' },
    acquiredAt: '2026-09-27T12:00:00.000Z',
    expiresAt: '2026-09-27T12:30:00.000Z',
    ttlMs: 1_800_000,
  };
  const contended = (timedOut) => ({ ok: false, acquired: false, timedOut, waitedMs: 0, heldBy: lock.owner, expiresAt: lock.expiresAt, lock });
  const scripted = [
    contended(true),
    { ok: true, acquired: true, renewed: false, waitedMs: 0, lock },
    contended(false),
    { ok: true, released: true, forced: true, lock },
    { ok: true, locks: [lock] },
  ];
  const calls = [];
  const codes = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, request: args[0] });
    return scripted[calls.length - 1];
  };
  console.log = () => {};
  const setEnv = (paneId, panelId) => {
    if (paneId) process.env.PANE_SESSION_ID = paneId; else delete process.env.PANE_SESSION_ID;
    if (panelId) process.env.PANE_PANEL_ID = panelId; else delete process.env.PANE_PANEL_ID;
  };

  try {
    setEnv('pane-b', 'panel-b');
    codes.push(await runLockAcquire(parseRunpaneArgs(['lock', 'acquire', '--name', 'testing-account', '--ttl', '30m', '--wait', '250000', '--note', 'call QA', '--json'])));
    setEnv();
    codes.push(await runLockAcquire(parseRunpaneArgs(['lock', 'acquire', '--name', 'testing-account', '--ttl', '90s', '--note', 'nightly QA', '--json'])));
    codes.push(await runLockRelease(parseRunpaneArgs(['lock', 'release', '--name', 'testing-account', '--force', '--session', 'Release QA', '--json'])));
    codes.push(await runLockList(parseRunpaneArgs(['lock', 'list', '--session', 'Release QA', '--json'])));
    await assert.rejects(
      runLockAcquire(parseRunpaneArgs(['lock', 'acquire', '--name', 'testing-account', '--ttl', '30m'])),
      /pass --note/,
    );
    assert.throws(() => parseRunpaneArgs(['lock', 'acquire', '--name', 'x', '--ttl', '30']), /between 1s and 24h/);
    assert.throws(() => parseRunpaneArgs(['lock', 'acquire', '--name', 'x', '--ttl', '30 minutes']), /duration such as/);
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    setEnv(originalEnv.PANE_SESSION_ID, originalEnv.PANE_PANEL_ID);
  }

  assert.deepStrictEqual(codes, [0, 1, 0, 0]);
  const acquireRequest = { name: 'testing-account', ttlMs: 1_800_000, note: 'call QA', owner: { paneId: 'pane-b', panelId: 'panel-b' } };
  assert.deepStrictEqual(calls.map((call) => call.channel), [
    'runpane:locks:acquire',
    'runpane:locks:acquire',
    'runpane:locks:acquire',
    'runpane:locks:release',
    'runpane:locks:list',
  ]);
  assert.deepStrictEqual(calls[0].request, { ...acquireRequest, waitMs: 120_000 });
  assert.deepStrictEqual(calls[1].request, { ...acquireRequest, waitMs: 120_000 });
  assert.deepStrictEqual(calls[2].request, { name: 'testing-account', ttlMs: 90_000, note: 'nightly QA', owner: { label: 'nightly QA' }, waitMs: 0 });
  assert.deepStrictEqual(calls[3].request, { name: 'testing-account', force: true, sessionId: 'Release QA', owner: {} });
  assert.deepStrictEqual(calls[4].request, { sessionId: 'Release QA' });

  const pythonOutput = runPythonSnippet(`
import contextlib
import io
import json
import os
import sys
import runpane.local_control as local_control
from runpane.cli import parse_args

scripted = json.loads(sys.stdin.read())
calls = []
def fake_invoke(channel, args, **kwargs):
    calls.append({"channel": channel, "request": args[0]})
    return scripted[len(calls) - 1]

def set_env(pane_id=None, panel_id=None):
    for key, value in (("PANE_SESSION_ID", pane_id), ("PANE_PANEL_ID", panel_id)):
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)

local_control.invoke_daemon = fake_invoke
codes = []
with contextlib.redirect_stdout(io.StringIO()):
    set_env("pane-b", "panel-b")
    codes.append(local_control.run_lock_acquire(parse_args(["lock", "acquire", "--name", "testing-account", "--ttl", "30m", "--wait", "250000", "--note", "call QA", "--json"])))
    set_env()
    codes.append(local_control.run_lock_acquire(parse_args(["lock", "acquire", "--name", "testing-account", "--ttl", "90s", "--note", "nightly QA", "--json"])))
    codes.append(local_control.run_lock_release(parse_args(["lock", "release", "--name", "testing-account", "--force", "--session", "Release QA", "--json"])))
    codes.append(local_control.run_lock_list(parse_args(["lock", "list", "--session", "Release QA", "--json"])))

errors = []
try:
    local_control.run_lock_acquire(parse_args(["lock", "acquire", "--name", "testing-account", "--ttl", "30m"]))
except ValueError as error:
    errors.append("pass --note" in str(error))
for ttl, expected in (("30", "between 1s and 24h"), ("30 minutes", "duration such as")):
    try:
        parse_args(["lock", "acquire", "--name", "x", "--ttl", ttl])
    except ValueError as error:
        errors.append(expected in str(error))

print(json.dumps({"calls": calls, "codes": codes, "errors": errors}))
`, JSON.stringify(scripted));
  const python = JSON.parse(pythonOutput);
  assert.deepStrictEqual(python.calls, calls);
  assert.deepStrictEqual(python.codes, codes);
  assert.deepStrictEqual(python.errors, [true, true, true]);
}

/** `sessions overview` carries both a Pane's worker report (#839) and the Session's named locks (#834). */
async function checkOverviewReportsAndLocks() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runSessionsOverview } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const at = '2026-09-27T12:00:00.000Z';
  const report = { state: 'ready', pr: 747, head: 'fc5dce9', summary: 'Tests pass.', reportedAt: at, panelId: 'panel-a' };
  const lock = {
    name: 'testing-account',
    scope: 'session',
    sessionId: 'orch-1',
    owner: { kind: 'pane', paneId: 'pane-a', panelId: 'panel-a' },
    note: 'call QA',
    acquiredAt: at,
    expiresAt: '2026-09-27T12:30:00.000Z',
    ttlMs: 1_800_000,
  };
  const overview = {
    ok: true,
    session: {
      id: 'orch-1',
      name: 'Release QA',
      agent: 'claude',
      internalSessionId: '__orchestration_session_release__',
      panelIds: { claude: 'orch-claude', codex: 'orch-codex', cursor: 'orch-cursor' },
      goal: '',
      context: '',
      decisions: [],
      blockers: [],
      nextAction: '',
      evidence: [],
      outputs: [],
      associations: [{ paneId: 'pane-a', panelIds: [], attachedAt: at }],
      activity: [],
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    status: 'idle',
    panes: [{
      paneId: 'pane-a',
      name: 'Worker A',
      archived: false,
      missing: false,
      panels: [{ panelId: 'panel-a', title: 'Claude Code', agentType: 'claude', state: 'idle', initialized: true }],
      report,
    }],
    activity: [],
    refreshedAt: at,
    locks: [lock],
  };
  assert.ok(matchesJsonSchema(overview, contract.jsonSchemas.sessionOverviewResult), 'overview fixture matches the contract schema');

  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const printed = [];
  daemonClient.invokeDaemon = async () => overview;
  console.log = (line) => printed.push(String(line));
  try {
    assert.strictEqual(await runSessionsOverview(parseRunpaneArgs(['sessions', 'overview', '--session', 'Release QA', '--json'])), 0);
    const decoded = JSON.parse(printed.join('\n'));
    assert.deepStrictEqual(decoded.panes[0].report, report);
    assert.deepStrictEqual(decoded.locks, [lock]);
    printed.length = 0;
    assert.strictEqual(await runSessionsOverview(parseRunpaneArgs(['sessions', 'overview', '--session', 'Release QA'])), 0);
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }
  const text = printed.join('\n');
  assertIncludes(text, 'report ready pr#747 fc5dce9 (panel panel-a');
  assertIncludes(text, 'lock testing-account');

  const pythonText = runPythonSnippet(`
import json
import sys
import runpane.local_control as local_control
from runpane.cli import parse_args

overview = json.loads(sys.stdin.read())
local_control.invoke_daemon = lambda channel, args, **kwargs: overview
local_control.run_sessions_overview(parse_args(["sessions", "overview", "--session", "Release QA"]))
`, JSON.stringify(overview));
  assertIncludes(pythonText, 'report ready pr#747 fc5dce9 (panel panel-a');
  assertIncludes(pythonText, 'lock testing-account');

  // Each panel carries its own report; a JSON object summary also comes back as `data`, as given.
  const status = { profile: 'implementer', state: 'running', checks: { pass: ['S-1'] } };
  const panelReport = { state: 'ready', pr: 747, head: 'fc5dce9', summary: JSON.stringify(status), reportedAt: at, data: status };
  const withPanelReports = structuredClone(overview);
  withPanelReports.panes[0].panels = [
    { ...overview.panes[0].panels[0], report: panelReport },
    { panelId: 'panel-b', title: 'Reviewer', agentType: 'codex', state: 'working', initialized: true, lastActivityAt: at },
  ];
  assert.ok(matchesJsonSchema(panelReport, contract.jsonSchemas.panelReport), 'panel report fixture matches the contract schema');
  daemonClient.invokeDaemon = async () => withPanelReports;
  console.log = (line) => printed.push(String(line));
  printed.length = 0;
  try {
    assert.strictEqual(await runSessionsOverview(parseRunpaneArgs(['sessions', 'overview', '--session', 'Release QA', '--json'])), 0);
    const decoded = JSON.parse(printed.join('\n'));
    assert.deepStrictEqual(decoded.panes[0].panels[0].report, panelReport);
    assert.deepStrictEqual(decoded.panes[0].report, report);
    printed.length = 0;
    // F-2: JSON keys named __proto__, top level and nested, survive the CLI's decoder and printing.
    const protoSummary = '{"__proto__":{"state":"changed","__proto__":{"deep":true}},"ok":true}';
    withPanelReports.panes[0].panels[0].report = { ...panelReport, summary: protoSummary, data: JSON.parse(protoSummary) };
    assert.strictEqual(await runSessionsOverview(parseRunpaneArgs(['sessions', 'overview', '--session', 'Release QA', '--json'])), 0);
    const protoData = JSON.parse(printed.join('\n')).panes[0].panels[0].report.data;
    assert.ok(Object.hasOwn(protoData, '__proto__'), 'report.data keeps a __proto__ key');
    assert.strictEqual(JSON.stringify(protoData), protoSummary);
    withPanelReports.panes[0].panels[0].report = panelReport;
    printed.length = 0;
    assert.strictEqual(await runSessionsOverview(parseRunpaneArgs(['sessions', 'overview', '--session', 'Release QA'])), 0);
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }
  const panelText = printed.join('\n');
  const pythonPanelText = runPythonSnippet(`
import json
import sys
import runpane.local_control as local_control
from runpane.cli import parse_args

overview = json.loads(sys.stdin.read())
local_control.invoke_daemon = lambda channel, args, **kwargs: overview
local_control.run_sessions_overview(parse_args(["sessions", "overview", "--session", "Release QA"]))
`, JSON.stringify(withPanelReports));
  for (const output of [panelText, pythonPanelText]) {
    assertIncludes(output, `Claude Code (panel panel-a): idle, report ready pr#747 fc5dce9 at ${at}`);
    assertIncludes(output, 'Reviewer (panel panel-b): working');
    assert.ok(!output.includes('Reviewer (panel panel-b): working, report'), 'a panel without a report shows only its state');
  }
  assert.strictEqual(pythonPanelText.replace(/\r\n/g, '\n').trim(), panelText.trim());
}

function checkHelpOutput() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };
  const nodeHelp = childProcess.execFileSync(process.execPath, [npmCli, '--help'], { encoding: 'utf8' });
  const nodeInstallHelp = childProcess.execFileSync(process.execPath, [npmCli, 'help', 'install'], { encoding: 'utf8' });
  const nodePanesHelp = childProcess.execFileSync(process.execPath, [npmCli, 'panes', '--help'], { encoding: 'utf8' });
  const nodePanelsHelp = childProcess.execFileSync(process.execPath, [npmCli, 'panels', '--help'], { encoding: 'utf8' });
  const pyHelp = childProcess.execFileSync(python, ['-m', 'runpane', '--help'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir });
  const pyInstallHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'help', 'install'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });
  const pyPanesHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'panes', '--help'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });
  const pyPanelsHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'panels', '--help'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });

  for (const output of [nodeHelp, pyHelp]) {
    for (const text of contractFixture.help.topLevelIncludes) {
      assertIncludes(output, text);
    }
  }

  for (const text of contractFixture.help.npmIncludes) {
    assertIncludes(nodeHelp, text);
  }
  for (const text of contractFixture.help.pipIncludes) {
    assertIncludes(pyHelp, text);
  }

  for (const output of [nodeInstallHelp, pyInstallHelp]) {
    for (const text of contractFixture.help.installIncludes) {
      assertIncludes(output, text);
    }
  }

  for (const output of [nodePanesHelp, pyPanesHelp]) {
    assertIncludes(output, 'Pane session commands.');
    assertIncludes(output, 'runpane panes list');
    assertIncludes(output, 'runpane panes cost');
    assertIncludes(output, 'runpane panes create');
    assertIncludes(output, 'runpane panes pin');
    assertIncludes(output, 'runpane panes unpin');
    assertIncludes(output, 'runpane panes rename');
  }

  for (const output of [nodePanelsHelp, pyPanelsHelp]) {
    assertIncludes(output, 'Terminal-backed panel commands.');
    assertIncludes(output, 'runpane panels create');
    assertIncludes(output, 'runpane panels submit-composer');
    assertIncludes(output, 'runpane panels wait');
  }
}

/** Both wrappers' workspaces block, on a tailnet with my machine and a teammate's, matches the contract. */
function checkWorkspacesSummarySchema() {
  if (process.platform === 'win32') return; // The fake tailscale is a shell script.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-summary-'));
  const peer = (name, UserID) => ({ DNSName: `${name}.tail.invalid.`, OS: 'linux', Online: true, UserID, TailscaleIPs: ['100.64.0.9'] });
  const status = {
    BackendState: 'Running',
    Self: { ...peer('this-box', 1), OS: 'macOS' },
    Peer: { a: peer('my-devbox', 1), b: peer('teammate-box', 2) },
    User: { 1: { LoginName: 'me@example.com' }, 2: { LoginName: 'teammate@example.com' } },
  };
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PANE_DIR: bin, RUNPANE_TELEMETRY_DISABLED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource };
  const schema = contract.jsonSchemas.workspacesSummary;
  for (const [label, command, args] of [
    ['node', process.execPath, [npmCli, 'agent-context', '--json']],
    ['python', findPython(), ['-m', 'runpane', 'agent-context', '--json']],
  ]) {
    const { workspaces } = JSON.parse(childProcess.execFileSync(command, args, { encoding: 'utf8', env, cwd: rootDir }));
    assertMatchesJsonSchema(workspaces, schema, `${label} workspaces summary`);
    assert.deepStrictEqual(workspaces.otherMachines.map((machine) => [machine.name, machine.owner, machine.mine]), [
      ['my-devbox', 'me@example.com', true],
      ['teammate-box', 'teammate@example.com', false],
    ], `${label} lists my machine and the teammate's`);
    for (const machine of workspaces.otherMachines) {
      assertMatchesJsonSchema(machine, schema.properties.otherMachines.items, `${label} workspaces machine row`);
    }
  }
  fs.rmSync(bin, { recursive: true, force: true });
}

function compareAgentContextParity() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };
  const runNode = (args) => childProcess.execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8' }).trim();
  const runPython = (args) => childProcess.execFileSync(python, ['-m', 'runpane', ...args], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  }).trim();

  // The workspaces block reports live Tailscale and Pane state, which can change between the two runs.
  const { workspaces: nodeWorkspaces, ...nodeBrief } = JSON.parse(runNode(['agent-context', '--json']));
  const { workspaces: pyWorkspaces, ...pyBrief } = JSON.parse(runPython(['agent-context', '--json']));
  assert.deepStrictEqual(pyBrief, nodeBrief);
  for (const workspaces of [nodeWorkspaces, pyWorkspaces]) assert.match(workspaces.lines[0], /^Workspaces: (on|off)/);
  assert.strictEqual(nodeBrief.mode, 'brief');
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('runpane doctor --json')));
  assert.ok(nodeBrief.summary.includes('Pane-managed git worktree'));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('Happy path for any user request to use Pane/RunPane')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('read `runpane agent-context --json`')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('runpane panes create --repo <repo> --name <name> --agent <agent> --prompt')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('`--tool-command <command>` instead of `--agent <agent>`')));
  assert.ok(!nodeBrief.rules.some((rule) => rule.includes('with `panes create --source agent --no-focus --wait-ready --yes --json`')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes("user's visible cockpit")));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('do not register a pre-created worktree')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('normal subagent/worktree mechanism')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('<PANE_DIR>/skills/pane-chat/skills/')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('<PANE_DIR>/skills/pane-chat/pane-orchestrator/SKILL.md')));
  assert.ok(!nodeBrief.rules.some((rule) => rule.includes('runpane-orchestrator.md')));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('creates Panes or panels')));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'doctor'));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'panes create'));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'panes pin'));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'panes unpin'));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'panes rename'));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes("pins the new Pane into the UI's favorite/pin set by default")));
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('`--no-pinned`')));
  assert.ok(!nodeBrief.rules.some((rule) => rule.includes('add `--pinned` when')));

  const nodeDetail = JSON.parse(runNode(['agent-context', '--command', 'panes create', '--json']));
  const pyDetail = JSON.parse(runPython(['agent-context', '--command', 'panes create', '--json']));
  assert.deepStrictEqual(pyDetail, nodeDetail);
  assert.strictEqual(nodeDetail.mode, 'command');
  assert.strictEqual(nodeDetail.command.name, 'panes create');
  assert.ok(nodeDetail.command.summary.includes('1 feature = 1 worktree = 1 branch = 1 Pane'));
  assert.ok(nodeDetail.command.details.includes('do not pre-create a git worktree'));
  assert.ok(nodeDetail.command.notes.some((note) => note.includes("not the agent's default private delegation mechanism")));
  assert.ok(nodeDetail.command.notes.some((note) => note.includes('panels create')));
  assert.ok(nodeDetail.command.arguments.some((argument) => argument.name === '--pinned'));
  assert.ok(nodeDetail.command.arguments.some((argument) => argument.name === '--no-pinned'));
  assert.ok(nodeDetail.command.notes.some((note) => note.includes('pins the new Pane by default')));

  const nodePinDetail = JSON.parse(runNode(['agent-context', '--command', 'panes pin', '--json']));
  const pyPinDetail = JSON.parse(runPython(['agent-context', '--command', 'panes pin', '--json']));
  assert.deepStrictEqual(pyPinDetail, nodePinDetail);
  assert.strictEqual(nodePinDetail.command.name, 'panes pin');
  assert.ok(nodePinDetail.command.details.includes('idempotent'));
  assert.ok(nodePinDetail.command.arguments.some((argument) => argument.name === '--dry-run'));

  const nodeUnpinDetail = JSON.parse(runNode(['agent-context', '--command', 'panes unpin', '--json']));
  const pyUnpinDetail = JSON.parse(runPython(['agent-context', '--command', 'panes unpin', '--json']));
  assert.deepStrictEqual(pyUnpinDetail, nodeUnpinDetail);
  assert.strictEqual(nodeUnpinDetail.command.name, 'panes unpin');
  assert.ok(nodeUnpinDetail.command.arguments.some((argument) => argument.name === '--dry-run'));

  const nodeRenameDetail = JSON.parse(runNode(['agent-context', '--command', 'panes rename', '--json']));
  const pyRenameDetail = JSON.parse(runPython(['agent-context', '--command', 'panes rename', '--json']));
  assert.deepStrictEqual(pyRenameDetail, nodeRenameDetail);
  assert.strictEqual(nodeRenameDetail.command.name, 'panes rename');
  assert.ok(nodeRenameDetail.command.arguments.some((argument) => argument.name === '--name'));
  assert.ok(nodeRenameDetail.command.jsonSchemas.includes('paneRenameResult'));

  const nodePanelsDetail = JSON.parse(runNode(['agent-context', '--command', 'panels create', '--json']));
  const pyPanelsDetail = JSON.parse(runPython(['agent-context', '--command', 'panels create', '--json']));
  assert.deepStrictEqual(pyPanelsDetail, nodePanelsDetail);
  assert.strictEqual(nodePanelsDetail.command.name, 'panels create');
  assert.ok(nodePanelsDetail.command.details.includes("shares the Pane's worktree"));
  assert.ok(nodePanelsDetail.command.notes.some((note) => note.includes("share the existing Pane's worktree")));

  const nodeOpenDetail = JSON.parse(runNode(['agent-context', '--command', 'panels open', '--json']));
  const pyOpenDetail = JSON.parse(runPython(['agent-context', '--command', 'panels open', '--json']));
  assert.deepStrictEqual(pyOpenDetail, nodeOpenDetail);
  assert.strictEqual(nodeOpenDetail.command.name, 'panels open');
  assert.ok(nodeOpenDetail.command.details.includes('split view'));
  assert.ok(nodeOpenDetail.command.jsonSchemas.includes('panelOpenResult'));

  const managedBlock = nodeBrief.source === 'runpane-contract'
    ? require(path.join(rootDir, 'packages', 'runpane', 'dist', 'generated', 'contract.js')).RUNPANE_CONTRACT.agentContext.managedBlock.join('\n')
    : '';
  assert.ok(managedBlock.includes('npm i -g runpane'));
  assert.ok(managedBlock.includes('npx --yes runpane@latest'));
  assert.ok(managedBlock.includes('runpane doctor --json'));
  assert.ok(managedBlock.includes('runpane agent-context --json'));
  assert.ok(managedBlock.includes('claude mcp add --scope user pane -- npx --yes runpane@latest mcp'));
  assert.ok(managedBlock.includes('[mcp_servers.pane]'));
  assert.ok(managedBlock.includes('command = "npx"'));
  assert.ok(managedBlock.includes('runpane@latest'));
  assert.ok(managedBlock.includes('claude mcp list'));
  assert.ok(managedBlock.includes('codex mcp list'));
  assert.ok(managedBlock.includes('agent mcp list'));
  assert.ok(managedBlock.includes('agent mcp enable pane'));
  assert.ok(!managedBlock.includes('Typical workflow: register the saved base repository once'));
  assert.ok(!managedBlock.includes('Skill routing reference:'));
  assert.ok(!managedBlock.includes('main/src/services/skillCacheManager.ts'));

  const nodeDottedDetail = JSON.parse(runNode(['agent-context', '--command', 'panes.create', '--json']));
  const pyDottedDetail = JSON.parse(runPython(['agent-context', '--command', 'panes.create', '--json']));
  assert.deepStrictEqual(nodeDottedDetail, nodeDetail);
  assert.deepStrictEqual(pyDottedDetail, nodeDetail);

  const nodePrefixedDetail = JSON.parse(runNode(['agent-context', '--command', 'runpane panels submit-composer', '--json']));
  const pyPrefixedDetail = JSON.parse(runPython(['agent-context', '--command', 'runpane panels submit-composer', '--json']));
  assert.deepStrictEqual(pyPrefixedDetail, nodePrefixedDetail);
  assert.strictEqual(nodePrefixedDetail.command.name, 'panels submit-composer');

  assertIncludes(runNode(['agent-context']), 'Detailed definitions: runpane agent-context --command <command> [--json]');
  assertIncludes(runPython(['agent-context', '--command', 'panes create']), 'runpane panes create');

  // --pane-dir only picks which Pane the workspaces block asks; the rest of the brief is offline.
  const withoutWorkspaces = ({ workspaces, ...brief }) => brief;
  assert.deepStrictEqual(withoutWorkspaces(JSON.parse(runNode(['agent-context', '--json', '--pane-dir', '/tmp/pane']))), nodeBrief);
  assert.deepStrictEqual(withoutWorkspaces(JSON.parse(runPython(['agent-context', '--json', '--pane-dir', '/tmp/pane']))), nodeBrief);
  assertIncludes(runNode(['version', '--pane-dir', '/tmp/pane']), 'runpane');
  assertIncludes(runPython(['version', '--pane-dir', '/tmp/pane']), 'runpane');

  // An unknown command is a structured error with ranked candidates, exit 2.
  const spawnContext = (runtime, args) => (runtime === 'npm'
    ? childProcess.spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' } })
    : childProcess.spawnSync(python, ['-m', 'runpane', ...args], { encoding: 'utf8', env: { ...pythonEnv, RUNPANE_TELEMETRY_DISABLED: '1' }, cwd: rootDir }));
  const unknownResults = ['npm', 'pip'].map((runtime) => spawnContext(runtime, ['agent-context', '--command', 'panes creat', '--json']));
  for (const unknown of unknownResults) {
    assert.strictEqual(unknown.status, 2, unknown.stderr);
    const parsed = JSON.parse(unknown.stdout);
    assertMatchesJsonSchema(parsed, contract.jsonSchemas.agentContextUnknownCommandError, 'agent-context unknown command');
    assert.strictEqual(parsed.code, 'unknown_command');
    assert.strictEqual(parsed.candidates[0], 'panes create');
  }
  assert.deepStrictEqual(JSON.parse(unknownResults[1].stdout), JSON.parse(unknownResults[0].stdout));
  for (const runtime of ['npm', 'pip']) {
    const text = spawnContext(runtime, ['agent-context', '--command', 'sesions lst']);
    assert.strictEqual(text.status, 2);
    assert.strictEqual(text.stdout, '');
    assertIncludes(text.stderr, 'Unknown runpane command: sesions lst.');
    assertIncludes(text.stderr, 'Closest commands: sessions list');
  }
}

function checkNoArgsAndSetupFallback() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };

  const outputs = [
    childProcess.execFileSync(process.execPath, [npmCli], { encoding: 'utf8' }),
    childProcess.execFileSync(process.execPath, [npmCli, 'setup'], { encoding: 'utf8' }),
    childProcess.execFileSync(python, ['-m', 'runpane'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir }),
    childProcess.execFileSync(python, ['-m', 'runpane', 'setup'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir })
  ];

  for (const output of outputs) {
    assertIncludes(output, 'Usage:');
    assertIncludes(output, 'runpane setup');
    assertIncludes(output, 'runpane help');
    assertIncludes(output, 'runpane install');
    assertIncludes(output, 'runpane doctor --json');
    assertIncludes(output, 'runpane agent-context --json');
    assertIncludes(output, 'Agent discovery:');
    assertIncludes(output, 'Quick start:');
  }
}

function checkDoctorReportSafety() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-report-test-'));
  const evidencePath = path.join(temporaryDirectory, 'evidence.txt');
  const ghLog = path.join(temporaryDirectory, 'gh.log');
  const binDirectory = path.join(temporaryDirectory, 'bin');
  fs.mkdirSync(binDirectory);
  const evidence = [
    'command: runpane watch --follow',
    'exit: 2',
    `path: ${os.homedir()}/.pane`,
    'Authorization: Bearer do-not-leak',
    'api_key=also-secret',
    'OPENAI_API_KEY=sk-prefixed-secret',
    'GH_TOKEN="two word secret"',
    'Authorization=Bearer assignment-secret',
    'authToken=camel-secret',
    'url=https://example.test/path?token=secret&next=value',
    '```',
    '![untrusted](https://example.test/tracker.png)',
  ].join('\n');
  fs.writeFileSync(evidencePath, evidence);
  const fakeDoctor = {
    ok: false,
    source: 'npm',
    wrapper: {
      runtime: 'node',
      version: '2.4.80',
      paneDir: `${os.homedir()}/.pane`,
      endpoint: { transport: 'unix', path: `${os.homedir()}/.pane/daemon.sock` },
    },
    platform: { os: 'linux', arch: 'x64' },
    release: { ok: false, error: 'offline' },
    installedPane: { found: false },
    daemon: {
      reachable: false,
      endpoint: { transport: 'unix', path: `${os.homedir()}/.pane/daemon.sock` },
      error: 'daemon unreachable',
    },
    remoteDaemonService: {
      paneDir: `${os.homedir()}/.pane`,
      managed: false,
      reachable: false,
      endpoint: { transport: 'unix', path: `${os.homedir()}/.pane/daemon.sock` },
    },
    remoteSetup: { ready: true, displayAvailable: true, headlessEnvironmentApplied: false, diagnostics: [] },
    nextCommands: [],
  };
  const doctor = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'doctor.js'));
  const requestedTitle = 'watch failed GITHUB_TOKEN=title-secret';
  const parsed = { bodyFile: evidencePath, title: requestedTitle };
  const first = doctor.prepareDoctorFailureReport(parsed, fakeDoctor);
  const second = doctor.prepareDoctorFailureReport(parsed, fakeDoctor);
  const safeTitle = doctor.prepareDoctorFailureReport({ bodyFile: evidencePath, title: 'watch failed' }, fakeDoctor);
  let pythonReportPath;

  try {
    assert.strictEqual(first.sha256, second.sha256, 'doctor report hash must be deterministic');
    assert.strictEqual(first.filed, false);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(first.path).mode & 0o777, 0o600);
    }
    const contents = fs.readFileSync(first.path, 'utf8');
    assert.ok(contents.includes('daemon unreachable'));
    assert.ok(contents.includes('~/.pane'));
    assert.ok(!contents.includes(os.homedir()));
    assert.ok(!contents.includes('do-not-leak'));
    assert.ok(!contents.includes('also-secret'));
    assert.ok(!contents.includes('sk-prefixed-secret'));
    assert.ok(!contents.includes('two word secret'));
    assert.ok(!contents.includes('assignment-secret'));
    assert.ok(!contents.includes('camel-secret'));
    assert.ok(!contents.includes('title-secret'));
    assert.ok(!contents.includes('token=secret'));
    assert.match(contents, /```\n!\[untrusted\]\([^\n]+\)\n`{4,}\n/u);
    assert.strictEqual(first.redactionCount, safeTitle.redactionCount + 1, 'title secret must count exactly once');
    assert.ok(!first.title.includes('title-secret'));
    assert.ok(!first.proposedCommand.includes('title-secret'));
    assert.ok(!fs.existsSync(ghLog), 'report preparation must not invoke gh');

    const pythonPrepared = JSON.parse(runPythonSnippet(`
import json
import sys
from types import SimpleNamespace
from runpane.doctor import prepare_doctor_failure_report

request = json.loads(sys.stdin.read())
parsed = SimpleNamespace(body_file=request["bodyFile"], title=request["title"])
print(json.dumps(prepare_doctor_failure_report(parsed, request["doctor"])))
`, JSON.stringify({ bodyFile: evidencePath, title: requestedTitle, doctor: fakeDoctor })));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(pythonPrepared.path).mode & 0o777, 0o600);
    }
    pythonReportPath = pythonPrepared.path;
    assert.strictEqual(pythonPrepared.sha256, first.sha256, 'npm and pip report bodies must match');
    assert.strictEqual(pythonPrepared.redactionCount, first.redactionCount);

    let restoreSpawnSync = () => {};
    if (process.platform === 'win32') {
      const originalSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (command, args) => {
        assert.strictEqual(command, 'gh');
        const commandArgs = Array.isArray(args) ? args : [];
        fs.appendFileSync(ghLog, `${commandArgs.join('\n')}\n--call--\n`);
        return {
          status: 0,
          stdout: commandArgs[0] === 'auth' ? '' : 'https://github.com/greenfield-inc/Pane/issues/999\n',
          stderr: '',
        };
      };
      restoreSpawnSync = () => {
        childProcess.spawnSync = originalSpawnSync;
      };
    } else {
      const stubPath = path.join(binDirectory, 'gh');
      fs.writeFileSync(stubPath, [
        '#!/bin/sh',
        'printf "%s\\n" "$@" >> "$RUNPANE_GH_LOG"',
        'printf "%s\\n" "--call--" >> "$RUNPANE_GH_LOG"',
        '[ "$1" = "auth" ] && exit 0',
        'printf "%s\\n" "https://github.com/greenfield-inc/Pane/issues/999"',
      ].join('\n'), { mode: 0o755 });
    }

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDirectory}${path.delimiter}${originalPath || ''}`;
    process.env.RUNPANE_GH_LOG = ghLog;
    try {
      doctor.fileDoctorFailureReport(first);
      assert.strictEqual(first.filed, true);
      assert.strictEqual(first.issueUrl, 'https://github.com/greenfield-inc/Pane/issues/999');
      const log = fs.readFileSync(ghLog, 'utf8');
      const calls = log.split(/--call--\r?\n/u).map(call => call.trim().split(/\r?\n/u)).filter(call => call[0]);
      assert.deepStrictEqual(calls[0], ['auth', 'status']);
      assert.strictEqual(calls.length, 2, 'confirmed filing must authenticate once and create once');
      assert.ok(log.includes('--body-file'));
      assert.ok(log.includes(first.path));
      assert.ok(!log.includes('do-not-leak'));
      assert.ok(!log.includes('also-secret'));
      assert.ok(!log.includes('title-secret'));
      assert.strictEqual((log.match(/^issue$/gm) || []).length, 1, 'confirmed filing must create one issue');

      fs.writeFileSync(ghLog, '');
      const pythonWindowsSpawnStub = process.platform === 'win32' ? `
import os
import runpane.doctor as doctor_module
from types import SimpleNamespace

def fake_run(args, **_kwargs):
    with open(os.environ["RUNPANE_GH_LOG"], "a", encoding="utf-8") as log:
        log.write("\\n".join(args[1:]) + "\\n--call--\\n")
    return SimpleNamespace(
        returncode=0,
        stdout="" if args[1] == "auth" else "https://github.com/greenfield-inc/Pane/issues/999\\n",
        stderr="",
    )

doctor_module.subprocess.run = fake_run
` : '';
      const pythonFiled = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.doctor import file_doctor_failure_report
${pythonWindowsSpawnStub}

prepared = json.loads(sys.stdin.read())
file_doctor_failure_report(prepared)
print(json.dumps(prepared))
`, JSON.stringify(pythonPrepared)));
      assert.strictEqual(pythonFiled.filed, true);
      assert.strictEqual(pythonFiled.issueUrl, 'https://github.com/greenfield-inc/Pane/issues/999');
      const pythonLog = fs.readFileSync(ghLog, 'utf8');
      const pythonCalls = pythonLog.split(/--call--\r?\n/u).map(call => call.trim().split(/\r?\n/u)).filter(call => call[0]);
      assert.deepStrictEqual(pythonCalls[0], ['auth', 'status']);
      assert.strictEqual(pythonCalls.length, 2, 'Python filing must authenticate once and create once');
      assert.ok(pythonLog.includes('--body-file'));
      assert.ok(pythonLog.includes(pythonPrepared.path));
      assert.ok(!pythonLog.includes('title-secret'));
      assert.strictEqual((pythonLog.match(/^issue$/gm) || []).length, 1, 'Python filing must create one issue');
    } finally {
      restoreSpawnSync();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.RUNPANE_GH_LOG;
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    fs.rmSync(path.dirname(first.path), { recursive: true, force: true });
    fs.rmSync(path.dirname(second.path), { recursive: true, force: true });
    fs.rmSync(path.dirname(safeTitle.path), { recursive: true, force: true });
    if (pythonReportPath) fs.rmSync(path.dirname(pythonReportPath), { recursive: true, force: true });
  }
}

async function checkAgentTemplateParity() {
  const { RUNPANE_CONTRACT } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'generated', 'contract.js'));
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runPanesCreate } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));

  const agents = [...RUNPANE_CONTRACT.enums.agents].sort();
  assert.deepStrictEqual(agents, ['claude', 'codex', 'cursor', 'opencode']);
  for (const agent of RUNPANE_CONTRACT.enums.agents) {
    const template = RUNPANE_CONTRACT.agentTemplates[agent];
    assert.ok(template, `agentTemplates missing entry for ${agent}`);
    assert.ok(template.title.trim().length > 0, `agentTemplates.${agent}.title is empty`);
    assert.ok(template.command.trim().length > 0, `agentTemplates.${agent}.command is empty`);
    assert.ok(template.description.trim().length > 0, `agentTemplates.${agent}.description is empty`);
  }
  assert.strictEqual(RUNPANE_CONTRACT.agentTemplates.cursor.command, 'cursor-agent --force --trust');
  assert.strictEqual(RUNPANE_CONTRACT.agentTemplates.opencode.command, 'opencode --auto');

  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  const calls = [];
  try {
    daemonClient.invokeDaemon = async (channel, args) => {
      calls.push({ channel, request: args[0] });
      return { ok: true, repo: {}, items: [] };
    };
    console.log = () => {};
    for (const agent of RUNPANE_CONTRACT.enums.agents) {
      await runPanesCreate(parseRunpaneArgs([
        'panes', 'create', '--repo', 'active', '--name', `agent-${agent}`, '--agent', agent,
        '--dry-run', '--yes', '--json'
      ]));
    }
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
  }

  assert.strictEqual(calls.length, RUNPANE_CONTRACT.enums.agents.length);
  RUNPANE_CONTRACT.enums.agents.forEach((agent, index) => {
    assert.strictEqual(calls[index].channel, 'runpane:panes:create');
    assert.strictEqual(calls[index].request.panes[0].tool.agent, agent);
  });
}

async function checkCreatePayloadErrorPaths() {
  const { runPanesCreate } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-invalid-payload-'));
  const inputPath = path.join(directory, 'request.json');
  try {
    for (const [payload, expected] of [
      [{ repo: 'active', panes: [{ name: false, tool: { agent: 'codex' } }] }, /input\.panes\.0\.name: expected string/],
      [{ repo: 'active', panes: [{ name: 'Work', pinned: 'yes', tool: { agent: 'codex' } }] }, /input\.panes\.0\.pinned: expected boolean/],
      [[], /input: expected object/],
    ]) {
      fs.writeFileSync(inputPath, JSON.stringify(payload));
      await assert.rejects(runPanesCreate(parseRunpaneArgs([
        'panes', 'create', '--from-json', inputPath, '--dry-run', '--yes',
      ])), expected);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function checkInstallerFailures() {
  const { installPaneArtifact } = require(path.join(rootDir, 'packages/runpane', 'dist', 'installers.js'));
  const originalSpawn = childProcess.spawnSync;
  const originalExists = fs.existsSync;
  const artifact = { path: '/fixture/installer', fileName: 'fixture', usedFallback: false };
  try {
    // An older Pane executable exists. It must not disguise a failed update.
    fs.existsSync = () => true;
    for (const platform of [{ os: 'linux', arch: 'x64' }, { os: 'win32', arch: 'x64' }]) {
      const options = { parsed: { command: 'update' }, platform, format: platform.os === 'linux' ? 'deb' : 'exe', target: 'client' };
      for (const outcome of [{ status: 7 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('Permission denied') }]) {
        childProcess.spawnSync = command => command === 'sudo' || command === artifact.path ? outcome : { status: 0 };
        await assert.rejects(installPaneArtifact(artifact, options), /installer exited|Permission denied/);
      }
      childProcess.spawnSync = () => ({ status: 0 });
      const result = await installPaneArtifact(artifact, options);
      assert.strictEqual(result.installKind, platform.os === 'linux' ? 'installed' : 'launched-installer');
    }
  } finally {
    childProcess.spawnSync = originalSpawn;
    fs.existsSync = originalExists;
  }
  runPythonSnippet(`
from types import SimpleNamespace
import runpane.installers as installers
from runpane.download import DownloadedArtifact
from runpane.platforms import PanePlatform
installers.os.path.exists = lambda path: True
installers.shutil.which = lambda command: "/fixture/apt"
artifact = DownloadedArtifact(path="/fixture/installer", file_name="fixture", used_fallback=False)
for platform_name in ["linux", "win32"]:
    for status in [7, -15, "error", 0]:
        def call(args, **kwargs):
            if status == "error":
                raise OSError("Permission denied")
            return status
        installers.subprocess.call = call
        try:
            result = installers.install_pane_artifact(artifact, SimpleNamespace(command="update", pane_path=None), PanePlatform(os=platform_name, arch="x64"), "deb" if platform_name == "linux" else "exe", "client")
            assert status == 0, "Failed installer was reported as successful"
            assert result.install_kind == ("installed" if platform_name == "linux" else "launched-installer")
        except (RuntimeError, OSError) as error:
            assert status != 0
            assert "installer exited" in str(error) or "Permission denied" in str(error)
`);
}

async function checkDoctorExitStatus() {
  const doctor = require(path.join(rootDir, 'packages/runpane', 'dist', 'doctor.js'));
  const releases = require(path.join(rootDir, 'packages/runpane', 'dist', 'releases.js'));
  const daemon = require(path.join(rootDir, 'packages/runpane', 'dist', 'daemonClient.js'));
  const platform = require(path.join(rootDir, 'packages/runpane', 'dist', 'platform.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages/runpane', 'dist', 'commands.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-doctor-status-'));
  const cases = [
    { reachable: false, releaseAvailable: true, expectedCode: 1 },
    { reachable: true, releaseAvailable: true, expectedCode: 0 },
    { reachable: true, releaseAvailable: false, expectedCode: 1 },
  ];
  const original = { release: releases.resolveRelease, invoke: daemon.invokeDaemon, platform: platform.detectPlatform, log: console.log };
  try {
    platform.detectPlatform = () => ({ os: 'darwin', arch: 'arm64' });
    for (const scenario of cases) {
      releases.resolveRelease = async () => {
        if (!scenario.releaseAvailable) throw new Error('Release service unavailable');
        return { release: { tag_name: 'v1' }, artifact: { name: 'Pane.dmg' }, format: 'dmg' };
      };
      daemon.invokeDaemon = async () => {
        if (!scenario.reachable) throw new Error('Daemon unavailable');
        return { daemon: {}, repos: { count: 0 } };
      };
      for (const json of [true, false]) {
        const output = [];
        console.log = line => output.push(line);
        const code = await doctor.runDoctor(parseRunpaneArgs([
          'doctor', '--pane-dir', directory, '--pane-path', path.join(directory, 'missing'), ...(json ? ['--json'] : []),
        ]));
        if (json) assert.strictEqual(JSON.parse(output.join('\n')).ok, scenario.expectedCode === 0);
        assert.strictEqual(code, scenario.expectedCode, `doctor ${json ? 'JSON' : 'text'} status must match overall health`);
      }
    }
    runPythonSnippet(`
import contextlib
import io
import json
import sys
from types import SimpleNamespace
import runpane.doctor as doctor
from runpane.cli import parse_args
from runpane.platforms import PanePlatform
payload = json.loads(sys.stdin.read())
doctor.detect_platform = lambda: PanePlatform(os="darwin", arch="arm64")
for scenario in payload["cases"]:
    def release(**kwargs):
        if not scenario["releaseAvailable"]:
            raise RuntimeError("Release service unavailable")
        return SimpleNamespace(release={"tag_name": "v1"}, artifact={"name": "Pane.dmg"}, format="dmg", preferred_download_url=None, fallback_download_url=None)
    def invoke(*args, **kwargs):
        if not scenario["reachable"]:
            raise RuntimeError("Daemon unavailable")
        return {"daemon": {}, "repos": {"count": 0}}
    doctor.resolve_release = release
    doctor.invoke_daemon = invoke
    for json_output in [True, False]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = doctor.run_doctor(parse_args(["doctor", "--pane-dir", payload["directory"], "--pane-path", payload["missing"], *(["--json"] if json_output else [])]))
        if json_output:
            assert json.loads(output.getvalue())["ok"] == (scenario["expectedCode"] == 0)
        assert code == scenario["expectedCode"], (scenario, json_output, code)
`, JSON.stringify({ cases, directory, missing: path.join(directory, 'missing') }));
  } finally {
    releases.resolveRelease = original.release;
    daemon.invokeDaemon = original.invoke;
    platform.detectPlatform = original.platform;
    console.log = original.log;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function checkFollowRequiresPositiveTimeout() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  for (const args of [['watch', '--follow', '--timeout-ms', '0'], ['watch', '--timeout-ms', '0', '--follow']]) {
    assert.throws(() => parseRunpaneArgs(args), /--timeout-ms must be greater than 0 with --follow/);
  }
  assert.strictEqual(parseRunpaneArgs(['watch', '--timeout-ms', '0']).timeoutMs, 0);
  assert.strictEqual(parseRunpaneArgs(['watch', '--follow', '--timeout-ms', '1']).timeoutMs, 1);
  runPythonSnippet(`
from runpane.cli import parse_args
for args in [["watch", "--follow", "--timeout-ms", "0"], ["watch", "--timeout-ms", "0", "--follow"]]:
    try:
        parse_args(args)
        raise AssertionError("follow accepted zero timeout")
    except ValueError as error:
        assert "--timeout-ms must be greater than 0 with --follow" in str(error)
assert parse_args(["watch", "--timeout-ms", "0"]).timeout_ms == 0
assert parse_args(["watch", "--follow", "--timeout-ms", "1"]).timeout_ms == 1
`);
}

async function checkCliEventSubscriptions() {
  for (const runtime of ['npm', 'pip']) {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-event-filter-'));
    const frames = [];
    try {
      await withFakeDaemon(paneDir, () => ({ result: { ok: true, repos: [] } }),
        () => runWatchCli(runtime, ['repos', 'list', '--json'], paneDir, stdout => stdout.includes('"repos"')),
        frame => frames.push(frame));
      assert.deepStrictEqual(frames, [
        { type: 'request', id: 0, channel: 'daemon:events', args: [{ include: [] }] },
        { type: 'request', id: 1, channel: 'runpane:repos:list', args: [] },
      ], `${runtime} ordinary commands must opt out of unrelated daemon events before invoking`);
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

async function checkSessionChildPinDefaults() {
  const { helpText } = require(path.join(rootDir, 'packages/runpane/dist/commands.js'));
  assert.match(helpText('panes create'), /Session.*unpinned/);
  const daemonClient = require(path.join(rootDir, 'packages/runpane/dist/daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages/runpane/dist/commands.js'));
  const { runPanesCreate } = require(path.join(rootDir, 'packages/runpane/dist/localControl.js'));
  const oldInvoke = daemonClient.invokeDaemon;
  const oldLog = console.log;
  const oldSession = process.env.PANE_ORCHESTRATION_SESSION_ID;
  const pins = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-child-pins-'));
  const batch = path.join(directory, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ repo: 'active', panes: [{ name: 'child', tool: { agent: 'codex' } }] }));
  try {
    process.env.PANE_ORCHESTRATION_SESSION_ID = 'session-test';
    daemonClient.invokeDaemon = async (_channel, args) => {
      pins.push(args[0].panes[0].pinned);
      return { ok: true, repo: {}, items: [] };
    };
    console.log = () => {};
    for (const extra of [[], ['--pinned'], ['--no-pinned']]) {
      await runPanesCreate(parseRunpaneArgs(['panes', 'create', '--repo', 'active', '--name', 'child', '--agent', 'codex', '--yes', '--json', ...extra]));
    }
    await runPanesCreate(parseRunpaneArgs(['panes', 'create', '--from-json', batch, '--yes', '--json']));
    assert.deepStrictEqual(pins, [false, true, false, false]);
    const pythonPins = runPythonSnippet(`
import json
from runpane.cli import parse_args
from runpane.local_control import build_pane_create_request
base = ["panes", "create", "--repo", "active", "--name", "child", "--agent", "codex"]
print(json.dumps([build_pane_create_request(parse_args(base + extra))["panes"][0]["pinned"] for extra in [[], ["--pinned"], ["--no-pinned"]]]))
`);
    assert.deepStrictEqual(JSON.parse(pythonPins), [false, true, false]);
  } finally {
    daemonClient.invokeDaemon = oldInvoke;
    console.log = oldLog;
    if (oldSession === undefined) delete process.env.PANE_ORCHESTRATION_SESSION_ID;
    else process.env.PANE_ORCHESTRATION_SESSION_ID = oldSession;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function checkSessionPinCommands() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-session-pins-'));
  try {
    for (const runtime of ['npm', 'pip']) {
      for (const action of ['pin', 'pin', 'unpin', 'unpin']) {
        const args = ['sessions', action, '--session', 'coordinator', '--json'];
        const output = await withFakeDaemon(paneDir, frame => {
          assert.strictEqual(frame.channel, 'runpane:sessions:update');
          assert.deepStrictEqual(frame.args, [{ selector: { sessionId: 'coordinator' }, input: { isPinned: action === 'pin' } }]);
          return { result: { ok: true, session: { id: 'coordinator', name: 'Coordinator', isPinned: action === 'pin', agent: 'codex',
            internalSessionId: 'owner', panelIds: { claude: 'claude-panel', codex: 'codex-panel', cursor: 'cursor-panel' },
            goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
            activity: [], revision: 1, createdAt: '2026-10-06T03:00:00Z', updatedAt: '2026-10-06T03:00:00Z' } } };
        }, () => runControlProcess(runtime, runtime === 'npm' ? args : ['-m', 'runpane', ...args], paneDir));
        assert.strictEqual(JSON.parse(output).session.isPinned, action === 'pin');
      }
    }
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

async function checkSessionRuntime() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runSessionsCreate } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runtime-contract-'));
  const file = path.join(directory, 'session.json');
  const input = { name: 'WSL planning', runtime: 'wsl', wslDistribution: 'Ubuntu-24.04', isPinned: true };
  fs.writeFileSync(file, JSON.stringify(input));
  const originalInvoke = daemonClient.invokeDaemon;
  const originalLog = console.log;
  let received;
  daemonClient.invokeDaemon = async (channel, args) => {
    assert.strictEqual(channel, 'runpane:sessions:create');
    received = args[0];
    return { ok: true, session: { ...input, id: 'session', associations: [] } };
  };
  console.log = () => {};
  try {
    assert.strictEqual(await runSessionsCreate(parseRunpaneArgs(['sessions', 'create', '--from-json', file, '--json'])), 0);
    assert.strictEqual(received.runtime, 'wsl');
    assert.strictEqual(received.wslDistribution, 'Ubuntu-24.04');
    assert.strictEqual(received.isPinned, true);
  } finally {
    daemonClient.invokeDaemon = originalInvoke;
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Collecting mode of the CLI decoder copy: every problem at once, "missing" for absent fields. */
function checkBoundaryDecoderCollectsEveryIssue() {
  const { boundary, decodeBoundary, decodeBoundaryAll, BoundaryDecodeIssues } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'boundaryDecoder.js'));
  const schema = boundary.object({
    items: boundary.array(boundary.object({
      label: boundary.nonEmptyString,
      url: boundary.refine(boundary.nonEmptyString, (url) => url.startsWith('https://'), 'expected an https URL'),
    })),
    tags: boundary.optional(boundary.array(boundary.string)),
    choice: boundary.optional(boundary.union(boundary.literal('a'), boundary.object({ label: boundary.string }))),
  });
  assert.throws(() => decodeBoundaryAll({ items: [{}, { label: 'x', url: 'ftp://x' }], tags: [1], choice: {} }, schema), (error) => {
    assert.ok(error instanceof BoundaryDecodeIssues);
    assert.deepStrictEqual(error.issues.map((issue) => `${issue.where}: ${issue.message}`), [
      'items[0].label: missing',
      'items[0].url: missing',
      'items[1].url: expected an https URL',
      'tags[0]: expected string',
      'choice: did not match any allowed shape',
    ]);
    return true;
  });
  assert.throws(() => decodeBoundaryAll('x', schema), /^BoundaryDecodeIssues: input: expected object$/);
  const valid = { items: [{ label: 'x', url: 'https://x' }], tags: ['t'], choice: 'a' };
  assert.deepStrictEqual(decodeBoundaryAll(valid, schema), decodeBoundary(valid, schema));
  assert.throws(() => decodeBoundary({ items: [{}] }, schema), /input\.items\.0\.label: expected string/);
}

/** `sessions update --from-json` names every payload problem in one error before reaching the daemon. */
async function checkSessionPayloadErrors() {
  const daemonClient = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { runSessionsUpdate, runSessionsCreate } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-session-payload-'));
  const file = path.join(directory, 'update.json');
  const originalInvoke = daemonClient.invokeDaemon;
  const originalLog = console.log;
  const calls = [];
  daemonClient.invokeDaemon = async (channel, args) => {
    calls.push({ channel, args });
    return { ok: true, session: { id: 'coordinator', name: 'Coordinator', associations: [] } };
  };
  console.log = () => {};
  try {
    fs.writeFileSync(file, JSON.stringify({
      outputs: [{}],
      evidence: [{ label: 'x', url: 'ftp://x', addedAt: 'now' }],
      decisions: [1],
    }));
    await assert.rejects(runSessionsUpdate(parseRunpaneArgs(['sessions', 'update', '--session', 'coordinator', '--from-json', file])), (error) => {
      assert.strictEqual(error.code, 'ERR_SESSION_PAYLOAD_INVALID');
      assert.strictEqual(error.message, 'The Session update payload has 6 problems: decisions[0]: expected string; '
        + 'evidence[0].url: expected a URL starting with https://, http://, file:// or grain://; '
        + 'evidence[0].addedAt: expected an ISO 8601 date such as 2026-10-14T09:30:00Z; '
        + 'outputs[0].label: missing; outputs[0].url: missing; outputs[0].addedAt: missing. Nothing was changed.');
      assertIncludes(error.next, 'outputs and evidence items are {"label": string, "url": https/http/file/grain URL, "addedAt": ISO 8601 date');
      assertIncludes(error.next, 'runpane agent-context --command "sessions update"');
      return true;
    });
    assert.strictEqual(calls.length, 0, 'an invalid payload must not reach the daemon');

    fs.writeFileSync(file, JSON.stringify({ name: 'Bad', outputs: 'x' }));
    await assert.rejects(runSessionsCreate(parseRunpaneArgs(['sessions', 'create', '--from-json', file])), /The Session create payload has 1 problem: outputs: expected array\./);

    const valid = {
      decisions: ['Ship'],
      blockers: [],
      outputs: [{ label: 'PR', url: 'https://github.com/o/r/pull/1', addedAt: '2026-10-14T09:30:00Z', kind: 'pull-request' }],
      evidence: [{ label: 'Log', url: 'file:///tmp/log.txt', addedAt: '2026-10-14', provenance: 'qa' }],
      report: {
        summary: 'Done', status: 'verified', reportedAt: '2026-10-14T09:31:00Z', provenance: 'qa agent',
        evidence: [{ label: 'Page', url: 'grain://page', addedAt: '2026-10-14T09:30:00Z' }],
      },
      expectedRevision: 3,
    };
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.strictEqual(await runSessionsUpdate(parseRunpaneArgs(['sessions', 'update', '--session', 'coordinator', '--from-json', file, '--json'])), 0);
    assert.deepStrictEqual(calls[0].args[0], { selector: { sessionId: 'coordinator' }, input: valid });
  } finally {
    daemonClient.invokeDaemon = originalInvoke;
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runControlProcess(runtime, args, paneDir) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(runtime === 'npm' ? process.execPath : findPython(),
      runtime === 'npm' ? [npmCli, ...args] : args,
      {
        cwd: rootDir, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PANE_DIR: paneDir, PYTHONPATH: pythonSource, PYTHONDONTWRITEBYTECODE: '1' },
      },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim()));
  });
}

async function checkPythonDaemonTimeouts() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-timeout-'));
  try {
    let requests = 0;
    const output = await withFakeDaemon(paneDir, () => ({
      result: { recovered: true }, delayMs: ++requests === 1 ? 250 : 0,
    }), () => runControlProcess('pip', ['-c', `
import json
from runpane.daemon_client import invoke_daemon
try:
    invoke_daemon("test:timeout", timeout_ms=50)
    code = None
except Exception as error:
    code = getattr(error, "code", type(error).__name__)
result = invoke_daemon("test:recovery", timeout_ms=1000)
print(json.dumps({"code": code, "recovered": result["recovered"]}))
`], paneDir));
    assert.deepStrictEqual(JSON.parse(output), { code: 'ERR_RUNPANE_DAEMON_TIMEOUT', recovered: true });

    requests = 0;
    const follow = await withFakeDaemon(paneDir, () => ({
      result: watchResult(9), delayMs: ++requests === 1 ? 6500 : 0,
    }), () => runWatchCli('pip', ['watch', '--follow', '--timeout-ms', '1', '--heartbeat', '0'], paneDir,
      stdout => stdout.includes('WATCH RECONNECTED gen 9'), 12_000));
    assertIncludes(follow.stdout, 'WATCH ERROR ERR_RUNPANE_DAEMON_TIMEOUT:');
    assertIncludes(follow.stdout, 'WATCH RECONNECTED gen 9');
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

function checkLeadingDashTextArguments() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const cases = [
    ['--text', 'panelInput', 'panel_input'], ['--prompt', 'initialInput', 'initial_input'],
    ['--initial-input', 'initialInput', 'initial_input'], ['--title', 'title', 'title'],
    ['--name', 'name', 'name'], ['--name-contains', 'nameContains', 'name_contains'],
  ];
  for (const [flag, nodeKey] of cases) {
    assert.strictEqual(parseRunpaneArgs(['panels', 'submit', flag, '- fix the tests'])[nodeKey], '- fix the tests');
    assert.strictEqual(parseRunpaneArgs(['panels', 'submit', flag, '--yes'])[nodeKey], '--yes');
    assert.throws(() => parseRunpaneArgs(['panels', 'submit', flag]), /requires a value/);
  }
  assert.throws(() => parseRunpaneArgs(['watch', '--timeout-ms', '--json']), /requires a value/);
  const python = JSON.parse(runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args
results = []
for flag, _node_key, key in json.loads(sys.stdin.read()):
    results.append([getattr(parse_args(["panels", "submit", flag, value]), key) for value in ["- fix the tests", "--yes"]])
    try:
        parse_args(["panels", "submit", flag])
        raise AssertionError("Missing value was accepted")
    except ValueError:
        pass
try:
    parse_args(["watch", "--timeout-ms", "--json"])
    raise AssertionError("Missing timeout was accepted")
except ValueError:
    pass
print(json.dumps(results))
`, JSON.stringify(cases)));
  assert.deepStrictEqual(python, cases.map(() => ['- fix the tests', '--yes']));
}

async function checkDryRunMessages() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-dry-run-messages-'));
  try {
    for (const runtime of ['npm', 'pip']) {
      for (const command of ['pin', 'unpin', 'create', 'adopt']) {
        const args = ['panes', command, '--dry-run'];
        if (command === 'pin' || command === 'unpin') args.push('--pane', 's1');
        else args.push('--repo', 'active', '--name', 'Work', '--agent', 'codex');
        if (command === 'adopt') args.push('--path', '/work/tree');
        const output = await withFakeDaemon(paneDir, () => ({ result: command === 'pin' || command === 'unpin'
          ? { ok: true, dryRun: true, paneId: 's1', pinned: command === 'pin' }
          : { ok: true, repo: { id: 1, name: 'Example', path: '/repo', active: true, sessionCount: 0 },
            items: [{ ok: true, index: 0, name: 'Work', pinned: true }] },
        }), () => runControlProcess(runtime, runtime === 'npm' ? args : ['-m', 'runpane', ...args], paneDir));
        assert.strictEqual(output, `Would ${command} ${command === 'pin' || command === 'unpin' ? 's1' : 'Work'}`);
      }
      const inputPath = path.join(paneDir, 'create.json');
      fs.writeFileSync(inputPath, JSON.stringify({ repo: 'active', dryRun: true,
        panes: [{ name: 'Preview', tool: { agent: 'codex' } }] }));
      const args = ['panes', 'create', '--from-json', inputPath, '--yes'];
      const output = await withFakeDaemon(paneDir, () => ({ result: {
        ok: true, repo: { id: 1, name: 'Example', path: '/repo', active: true, sessionCount: 0 },
        items: [{ ok: true, index: 0, name: 'Preview', pinned: true }],
      } }), () => runControlProcess(runtime, runtime === 'npm' ? args : ['-m', 'runpane', ...args], paneDir));
      assert.strictEqual(output, 'Would create Preview', 'JSON dryRun requests must also print as previews');
    }
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

async function checkPaneCreateResultFields() {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-result-fields-'));
  const result = {
    ok: true, repo: { id: 1, name: 'Example', path: '/repo', active: true, sessionCount: 1 },
    items: [{ ok: true, index: 0, name: 'Work', pinned: false, sessionId: 's1', paneId: 's1', panelId: 'p1',
      tool: { title: 'Codex', command: 'codex --yolo', agent: 'codex' }, active: false, focused: true }],
  };
  try {
    for (const command of ['create', 'adopt']) {
      const args = ['panes', command, '--repo', 'active', '--name', 'Work', '--agent', 'codex', '--yes', '--json'];
      if (command === 'adopt') args.push('--path', '/work/tree');
      const output = await withFakeDaemon(paneDir, () => ({ result }), () => runControlProcess('npm', args, paneDir));
      assert.deepStrictEqual(JSON.parse(output), result, `${command} JSON must preserve documented result fields`);
    }
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
}

async function runChecks() {
  checkGeneratedContractFresh();
  ensureBuiltCli();
  await checkCliEventSubscriptions();
  checkFollowRequiresPositiveTimeout();
  await checkDoctorExitStatus();
  await checkInstallerFailures();
  await checkCreatePayloadErrorPaths();
  await checkPaneCreateResultFields();
  await checkDryRunMessages();
  checkLeadingDashTextArguments();
  await checkPythonDaemonTimeouts();
  compareParserParity();
  checkWatchFormatterGoldens();
  await checkWatchStreamParity();
  await checkWatchUntilEvent();
  await checkDispatchWait();
  checkPythonWatchReaderClosedErrnos();
  compareLegacyRemoteDaemonHealthParity();
  compareDaemonRepairJsonParity();
  await checkLinuxPackageCompatibilityAlias();
  comparePlatformParity();
  compareDaemonEndpointParity();
  checkPythonUnixEndpointSeparatorsAreHostIndependent();
  compareArtifactSelectionParity();
  await checkPreferredDownloadUrls();
  await checkUpdateInstallsWhenPaneIsNotRunning();
  compareWrapperTelemetrySanitizers();
  compareExistingReusePolicy();
  compareDaemonLaunchEnvironmentParity();
  compareDaemonLaunchArgsParity();
  compareRemoteSetupDiagnosticParity();
  checkPlatformMatchingEdgeCases();
  await checkGuidedRemoteSetup();
  runPythonSnippet('import runpy; runpy.run_path("scripts/test-runpane-setup-pty.py", run_name="__main__")');
  await checkExistingDaemonShortCircuit();
  checkWindowsPaneVersionDoesNotLaunchExecutable();
  await checkFromJsonAcceptsBom();
  await checkCreateAssociationSource();
  checkComposerStrategyRequests();
  await checkPaneAdoptOverrides();
  await checkPaneArchiveDryRunParity();
  await checkPanePinParity();
  await checkWrapperAgentParity();
  await checkFilePointerParity();
  await checkAttachParity();
  await checkDeliveryParity();
  await checkReportParity();
  await checkReportDeliveryLine();
  await checkPaneCreateBlockedReadiness();
  await checkPanelResumeCommandExitedReadiness();
  await checkSessionChildPinDefaults();
  await checkPanesCostParity();
  await checkPaneRenameParity();
  await checkLockParity();
  await checkOverviewReportsAndLocks();
  await checkSessionRuntime();
  checkBoundaryDecoderCollectsEveryIssue();
  await checkSessionPayloadErrors();
  await checkSessionPinCommands();
  await checkPanesAdoptCliParity();
  await checkPanesCreateBaseNotice();
  checkContractDocListsEveryCommand();
  await checkAgentTemplateParity();
  checkHelpOutput();
  checkWorkspacesSummarySchema();
  compareAgentContextParity();
  await checkNodeReleaseTimeout();
  checkNoArgsAndSetupFallback();
  checkDoctorReportSafety();
  childProcess.execFileSync(process.execPath, ['--test', path.join(__dirname, 'test-runpane-dispatch.js')], {
    cwd: rootDir,
    env: { ...process.env, PYTHON: findPython() },
    stdio: 'inherit',
  });
  childProcess.execFileSync(process.execPath, ['--test', path.join(__dirname, 'test-runpane-python-parity.js')], {
    cwd: rootDir,
    env: { ...process.env, PYTHON: findPython() },
    stdio: 'inherit',
  });
  console.log('runpane CLI contract checks passed');
}

runChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
