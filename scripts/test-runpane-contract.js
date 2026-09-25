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
  const expected = [
    ['agent.ready', 'READY Issue 538 pane pane-1 panel panel-1'],
    ['agent.busy', 'BUSY Issue 538 pane pane-1 panel panel-1'],
    ['agent.blocked', 'BLOCKED Issue 538 pane pane-1 panel panel-1'],
    ['agent.unknown', 'UNKNOWN Issue 538 pane pane-1 panel panel-1'],
    ['agent.idle', 'IDLE Issue 538 10m pane pane-1 panel panel-1', { idleMs: 600000, idleCount: 1 }],
    ['pane.created', 'NEW Issue 538 pane pane-1'],
    ['pane.gone', 'GONE Issue 538 pane pane-1'],
    ['panel.exited', 'EXIT Issue 538 pane pane-1 panel panel-1 code 3', { exitCode: 3 }],
  ];
  for (const [kind, line, extra = {}] of expected) {
    assert.deepStrictEqual(
      lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [{ ...base, kind, ...extra }] }, 'lines'),
      [line],
    );
  }
  assert.deepStrictEqual(
    lines.formatWaitResult({ epoch: 'epoch-1', generation: 7, entries: [{ ...base, kind: 'agent.ready', baseline: true }] }, 'lines'),
    [],
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
  assert.deepStrictEqual(jsonLines[0], { kind: '_reset', reason: 'cursor-truncated', epoch: 'epoch-1' });
  assert.deepStrictEqual(jsonLines[1], { kind: '_dropped', count: 2 });
  assert.deepStrictEqual(jsonLines[2], result.entries[0], 'JSON mode must preserve structured fields');
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

async function withFakeDaemon(paneDir, onRequest, action) {
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

function runWatchCli(runtime, args, paneDir, until, timeoutMs = 8_000) {
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
      if (!matched && !until(stdout, stderr)) {
        reject(new Error(`${runtime} watch exited before expected output (${code}/${signal}). stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr, code, signal });
    });
  });
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
      assert.strictEqual(followRequests[0].idleWindowStartMs, 0);
      assert.ok(followRequests[1].idleWindowStartMs > 0, 'anonymous follow must advance its idle window');

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
            '--kinds', 'agent.ready,agent.blocked', '--settle', '180000', '--blocked-settle', '30000', '--min-interval', '600000', '--idle-backoff'],
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
          ['watch', '--follow', '--self-test', '--settle', '180000', '--min-interval', '600000', '--idle-backoff'],
          paneDir,
          stdout => stdout.includes('WATCH OK gen 4'),
        ),
      );
      assert.strictEqual(selfTestRequests[0].as, undefined, 'self-test must stay anonymous so the daemon applies no cadence');

      for (const badWatchArgs of [
        ['watch', '--heartbeat', 'nope'],
        ['watch', '--follow', '--settle', 'nope'],
        ['watch', '--settle', '5'],
        ['watch', '--follow', '--since', '42', '--settle', '180000'],
      ]) {
        const badWatch = spawnWatchCli(runtime, badWatchArgs);
        assert.strictEqual(badWatch.status, 2, `${badWatchArgs.join(' ')} must fail`);
        assertIncludes(badWatch.stdout, 'WATCH ERROR');
        assertIncludes(badWatch.stderr, 'WATCH ERROR');
      }
    } finally {
      fs.rmSync(paneDir, { recursive: true, force: true });
    }
  }
}

function spawnWatchCli(runtime, args) {
  return runtime === 'npm'
    ? childProcess.spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' } })
    : childProcess.spawnSync(findPython(), ['-m', 'runpane', ...args], {
      encoding: 'utf8',
      cwd: rootDir,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource, RUNPANE_TELEMETRY_DISABLED: '1' },
    });
}

function compareParserParity() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const nodeOutput = parserSamples.map((args) => {
    const parsed = parseRunpaneArgs(args);
    return {
      command: parsed.command,
      helpTopic: parsed.helpTopic ?? null,
      target: parsed.target,
      paneVersion: parsed.paneVersion,
      channel: parsed.channel,
      format: parsed.format,
      downloadDir: parsed.downloadDir ?? null,
      panePath: parsed.panePath ?? null,
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      verbose: parsed.verbose,
      json: parsed.json,
      contextCommand: parsed.contextCommand ?? null,
      paneDir: parsed.paneDir ?? null,
      repo: parsed.repo ?? null,
      paneId: parsed.paneId ?? null,
      panelId: parsed.panelId ?? null,
      repoPath: parsed.repoPath ?? null,
      name: parsed.name ?? null,
      worktreeName: parsed.worktreeName ?? null,
      baseBranch: parsed.baseBranch ?? null,
      agent: parsed.agent ?? null,
      toolCommand: parsed.toolCommand ?? null,
      title: parsed.title ?? null,
      initialInput: parsed.initialInput ?? null,
      initialInputFile: parsed.initialInputFile ?? null,
      panelInput: parsed.panelInput ?? null,
      panelInputFile: parsed.panelInputFile ?? null,
      fromJson: parsed.fromJson ?? null,
      timeoutMs: parsed.timeoutMs ?? null,
      waitReady: parsed.waitReady ?? false,
      readyTimeoutMs: parsed.readyTimeoutMs ?? null,
      concurrency: parsed.concurrency ?? null,
      limit: parsed.limit ?? null,
      waitCondition: parsed.waitCondition ?? null,
      contains: parsed.contains ?? null,
      intervalMs: parsed.intervalMs ?? null,
      source: parsed.source ?? null,
      noFocus: parsed.noFocus ?? false,
      focus: parsed.focus ?? false,
      pinned: parsed.pinned ?? false,
      noPinned: parsed.noPinned ?? false,
      composerStrategy: parsed.composerStrategy ?? null,
      watchAs: parsed.watchAs ?? null,
      watchSince: parsed.watchSince ?? null,
      watchFrom: parsed.watchFrom ?? null,
      watchKinds: parsed.watchKinds ?? [],
      watchPaneIds: parsed.watchPaneIds ?? [],
      watchExcludePaneIds: parsed.watchExcludePaneIds ?? [],
      nameContains: parsed.nameContains ?? null,
      follow: parsed.follow ?? false,
      agentsOnly: parsed.agentsOnly ?? false,
      ackNow: parsed.ackNow ?? false,
      includeHeldInput: parsed.includeHeldInput ?? false,
      watchFormat: parsed.watchFormat ?? null,
      heartbeatSeconds: parsed.heartbeatSeconds ?? null,
      idleAfterMs: parsed.idleAfterMs ?? null,
      settleMs: parsed.settleMs ?? null,
      blockedSettleMs: parsed.blockedSettleMs ?? null,
      minIntervalMs: parsed.minIntervalMs ?? null,
      idleBackoff: parsed.idleBackoff ?? false,
      allManaged: parsed.allManaged ?? false,
      includeShells: parsed.includeShells ?? false,
      noHeldInput: parsed.noHeldInput ?? false,
      selfTest: parsed.selfTest ?? false,
      report: parsed.report ?? false,
      bodyFile: parsed.bodyFile ?? null,
      remoteSetupArgs: parsed.remoteSetupArgs
    };
  });

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args

samples = json.loads(sys.stdin.read())
normalized = []
for args in samples:
    parsed = parse_args(args)
    normalized.append({
        "command": parsed.command,
        "helpTopic": parsed.help_topic,
        "target": parsed.target,
        "paneVersion": parsed.pane_version,
        "channel": parsed.channel,
        "format": parsed.format,
        "downloadDir": parsed.download_dir,
        "panePath": parsed.pane_path,
        "dryRun": parsed.dry_run,
        "yes": parsed.yes,
        "verbose": parsed.verbose,
        "json": parsed.json,
        "contextCommand": parsed.context_command,
        "paneDir": parsed.pane_dir,
        "repo": parsed.repo,
        "paneId": parsed.pane_id,
        "panelId": parsed.panel_id,
        "repoPath": parsed.repo_path,
        "name": parsed.name,
        "worktreeName": parsed.worktree_name,
        "baseBranch": parsed.base_branch,
        "agent": parsed.agent,
        "toolCommand": parsed.tool_command,
        "title": parsed.title,
        "initialInput": parsed.initial_input,
        "initialInputFile": parsed.initial_input_file,
        "panelInput": parsed.panel_input,
        "panelInputFile": parsed.panel_input_file,
        "fromJson": parsed.from_json,
        "timeoutMs": parsed.timeout_ms,
        "waitReady": parsed.wait_ready,
        "readyTimeoutMs": parsed.ready_timeout_ms,
        "concurrency": parsed.concurrency,
        "limit": parsed.limit,
        "waitCondition": parsed.wait_condition,
        "contains": parsed.contains,
        "intervalMs": parsed.interval_ms,
        "source": parsed.source,
        "noFocus": parsed.no_focus,
        "focus": parsed.focus,
        "pinned": parsed.pinned,
        "noPinned": parsed.no_pinned,
        "composerStrategy": parsed.composer_strategy,
        "watchAs": parsed.watch_as,
        "watchSince": parsed.watch_since,
        "watchFrom": parsed.watch_from,
        "watchKinds": parsed.watch_kinds,
        "watchPaneIds": parsed.watch_pane_ids,
        "watchExcludePaneIds": parsed.watch_exclude_pane_ids,
        "nameContains": parsed.name_contains,
        "follow": parsed.follow,
        "agentsOnly": parsed.agents_only,
        "ackNow": parsed.ack_now,
        "includeHeldInput": parsed.include_held_input,
        "watchFormat": parsed.watch_format,
        "heartbeatSeconds": parsed.heartbeat_seconds,
        "idleAfterMs": parsed.idle_after_ms,
        "settleMs": parsed.settle_ms,
        "blockedSettleMs": parsed.blocked_settle_ms,
        "minIntervalMs": parsed.min_interval_ms,
        "idleBackoff": parsed.idle_backoff,
        "allManaged": parsed.all_managed,
        "includeShells": parsed.include_shells,
        "noHeldInput": parsed.no_held_input,
        "selfTest": parsed.self_test,
        "report": parsed.report,
        "bodyFile": parsed.body_file,
        "remoteSetupArgs": parsed.remote_setup_args,
    })
print(json.dumps(normalized))
`, JSON.stringify(parserSamples));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
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

  const nodeBrief = JSON.parse(runNode(['agent-context', '--json']));
  const pyBrief = JSON.parse(runPython(['agent-context', '--json']));
  assert.deepStrictEqual(pyBrief, nodeBrief);
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
  assert.ok(nodeDetail.command.summary.includes('Pane-managed worktrees'));
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
  assert.ok(nodePanelsDetail.command.details.includes("shares the existing Pane's worktree"));
  assert.ok(nodePanelsDetail.command.notes.some((note) => note.includes("share the existing Pane's worktree")));

  const managedBlock = nodeBrief.source === 'runpane-contract'
    ? require(path.join(rootDir, 'packages', 'runpane', 'dist', 'generated', 'contract.js')).RUNPANE_CONTRACT.agentContext.managedBlock.join('\n')
    : '';
  assert.ok(managedBlock.includes('Typical workflow: register the saved base repository once'));
  assert.ok(managedBlock.includes('one Pane (Pane session) per feature/PR'));
  assert.ok(managedBlock.includes('clean up its managed worktree when applicable'));
  assert.ok(managedBlock.includes('created by [runpane.com](https://runpane.com)'));
  assert.ok(managedBlock.includes('[Pane repository](https://github.com/dcouple/Pane)'));
  assert.ok(managedBlock.includes('Do not delete or overwrite this block'));
  assert.ok(managedBlock.includes('Default happy path when the user asks you to use Pane or RunPane'));
  assert.ok(managedBlock.includes('resolve the saved base repository'));
  assert.ok(managedBlock.includes('runpane panes create --repo <repo> --name <name> --agent <agent> --prompt'));
  assert.ok(managedBlock.includes('equivalent `--tool-command <command>` form'));
  assert.ok(!managedBlock.includes('with `runpane panes create --source agent --no-focus --wait-ready --yes --json`'));
  assert.ok(managedBlock.includes('Skill routing reference:'));
  assert.ok(managedBlock.includes('<PANE_DIR>/skills/pane-chat/skills/'));
  assert.ok(managedBlock.includes('<PANE_DIR>/skills/pane-chat/pane-orchestrator/SKILL.md'));
  assert.ok(!managedBlock.includes('runpane-orchestrator.md'));
  assert.ok(!managedBlock.includes('.sources/dcouple-skills'));
  assert.ok(managedBlock.includes('Choose the phase from the request'));
  assert.ok(managedBlock.includes('main/src/services/skillCacheManager.ts'));
  assert.ok(managedBlock.includes('main/src/services/paneChatBundle/'));
  assert.ok(managedBlock.includes('main/src/services/paneChatManager.ts'));
  assert.ok(managedBlock.includes('tiny bootstrap prompt that tells the selected Pane Chat agent to read it'));
  assert.ok(managedBlock.includes('Do not hardcode a specific assistant brand'));
  assert.ok(managedBlock.includes('Pane agent or custom tool command the user selected'));
  assert.ok(managedBlock.includes('runpane watch --follow'));
  assert.ok(managedBlock.includes('For ongoing supervision'));

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
  assert.deepStrictEqual(agents, ['claude', 'codex', 'cursor']);
  for (const agent of RUNPANE_CONTRACT.enums.agents) {
    const template = RUNPANE_CONTRACT.agentTemplates[agent];
    assert.ok(template, `agentTemplates missing entry for ${agent}`);
    assert.ok(template.title.trim().length > 0, `agentTemplates.${agent}.title is empty`);
    assert.ok(template.command.trim().length > 0, `agentTemplates.${agent}.command is empty`);
    assert.ok(template.description.trim().length > 0, `agentTemplates.${agent}.description is empty`);
  }
  assert.strictEqual(RUNPANE_CONTRACT.agentTemplates.cursor.command, 'cursor-agent --force --trust');

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

async function checkSessionChildPinDefaults() {
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

async function runChecks() {
  checkGeneratedContractFresh();
  ensureBuiltCli();
  compareParserParity();
  checkWatchFormatterGoldens();
  await checkWatchStreamParity();
  compareLegacyRemoteDaemonHealthParity();
  compareDaemonRepairJsonParity();
  await checkLinuxPackageCompatibilityAlias();
  comparePlatformParity();
  compareDaemonEndpointParity();
  checkPythonUnixEndpointSeparatorsAreHostIndependent();
  compareArtifactSelectionParity();
  await checkPreferredDownloadUrls();
  compareWrapperTelemetrySanitizers();
  compareExistingReusePolicy();
  compareDaemonLaunchEnvironmentParity();
  compareDaemonLaunchArgsParity();
  compareRemoteSetupDiagnosticParity();
  checkPlatformMatchingEdgeCases();
  await checkExistingDaemonShortCircuit();
  checkWindowsPaneVersionDoesNotLaunchExecutable();
  await checkFromJsonAcceptsBom();
  await checkPaneArchiveDryRunParity();
  await checkPanePinParity();
  await checkSessionChildPinDefaults();
  await checkPanesCostParity();
  await checkPaneRenameParity();
  await checkAgentTemplateParity();
  checkHelpOutput();
  compareAgentContextParity();
  await checkNodeReleaseTimeout();
  checkNoArgsAndSetupFallback();
  checkDoctorReportSafety();
  console.log('runpane CLI contract checks passed');
}

runChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
