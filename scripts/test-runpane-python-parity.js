const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function runPython(source, input) {
  const result = spawnSync(python, ['-c', source], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(input), timeout: 10000,
    env: { ...process.env, PYTHONPATH: path.join(root, 'packages/runpane-py/src'), PYTHONDONTWRITEBYTECODE: '1', RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('Python rejects empty and non-finite flag values before daemon requests', () => {
  const cases = [
    ['panels', 'submit', '--text', ''],
    ['panels', 'wait', '--timeout-ms', 'nan'],
    ['panels', 'wait', '--timeout-ms', 'inf'],
    ['panels', 'wait', '--ready-timeout-ms', 'NaN'],
    ['panels', 'wait', '--ready-timeout-ms', 'Infinity'],
    ['panels', 'wait', '--interval-ms', 'nan'],
    ['panels', 'wait', '--interval-ms', 'inf'],
  ];
  const output = JSON.parse(runPython(`
import json, sys
from runpane.cli import parse_args
results = []
for args in json.load(sys.stdin):
    try:
        parse_args(args)
        results.append('accepted')
    except ValueError as error:
        results.append(str(error))
print(json.dumps(results))
`, cases));
  const { parseRunpaneArgs } = require(path.join(root, 'packages/runpane/dist/commands'));
  const nodeOutput = cases.map(args => {
    try {
      parseRunpaneArgs(args);
      return 'accepted';
    } catch (error) {
      return error.message;
    }
  });
  assert.deepEqual(output, nodeOutput);
  assert.deepEqual(output, [
    '--text requires a value.',
    '--timeout-ms must be a positive number (watch also accepts 0).',
    '--timeout-ms must be a positive number (watch also accepts 0).',
    '--ready-timeout-ms must be a positive number.',
    '--ready-timeout-ms must be a positive number.',
    '--interval-ms must be a positive number.',
    '--interval-ms must be a positive number.',
  ]);
});

test('--pane-dir is accepted before, after, and between command flags', () => {
  const cases = [
    ['--pane-dir', '/tmp/pane-x', 'doctor', '--json'],
    ['--pane-dir=/tmp/pane-x', 'repos', 'list', '--json'],
    ['--pane-dir', '/tmp/pane-x', 'install', 'daemon', '--print-only'],
    ['doctor', '--pane-dir', '/tmp/pane-x', '--json'],
    ['repos', 'list', '--json', '--pane-dir=/tmp/pane-x'],
    ['--pane-dir', '/tmp/pane-x', 'version'],
  ];
  const output = JSON.parse(runPython(`
import json, sys
from runpane.cli import parse_args
results = []
for args in json.load(sys.stdin):
    parsed = parse_args(args)
    results.append([parsed.command, parsed.pane_dir, parsed.remote_setup_args])
print(json.dumps(results))
`, cases));
  const { parseRunpaneArgs } = require(path.join(root, 'packages/runpane/dist/commands'));
  const nodeOutput = cases.map(args => {
    const parsed = parseRunpaneArgs(args);
    return [parsed.command, parsed.paneDir ?? null, parsed.remoteSetupArgs ?? []];
  });
  assert.deepEqual(output, nodeOutput);
  assert.deepEqual(output, [
    ['doctor', '/tmp/pane-x', []],
    ['repos list', '/tmp/pane-x', []],
    // install daemon forwards --pane-dir to the remote setup it launches.
    ['install', null, ['--pane-dir', '/tmp/pane-x', '--print-only']],
    ['doctor', '/tmp/pane-x', []],
    ['repos list', '/tmp/pane-x', []],
    ['version', '/tmp/pane-x', []],
  ]);
});

test('Python reports every Session create payload problem in one ERR_SESSION_PAYLOAD_INVALID, like Node', () => {
  // A create payload missing its name and two link fields: Node names all three at once.
  const payload = { outputs: [{ label: 'result' }] };
  // PANE_DIR points nowhere, so the Node CLI fails before any daemon request if it does not reject locally.
  const nodeResult = spawnSync(process.execPath, [path.join(root, 'packages/runpane/dist/cli.js'), 'sessions', 'create', '--from-json', '-', '--json'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(payload), timeout: 10000,
    env: { ...process.env, PANE_DIR: path.join(root, 'tmp', 'runpane-parity-no-daemon'), RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(nodeResult.status, 1, nodeResult.stderr);
  const nodeFailure = JSON.parse(nodeResult.stdout).error;
  assert.equal(nodeFailure.code, 'ERR_SESSION_PAYLOAD_INVALID');
  assert.equal(nodeFailure.message, 'The Session create payload has 3 problems: name: missing; '
    + 'outputs[0].url: missing; outputs[0].addedAt: missing. Nothing was changed.');

  // Python leaves validation to the daemon, whose decoder keeps the same rules and wording
  // (main/src/ipc/runpane.test.ts); the fake answers the way that decoder does.
  const output = JSON.parse(runPython(`
import contextlib, io, json, sys
import runpane.local_control as local
from runpane.cli import main
from runpane.daemon_client import PaneDaemonClientError
fixture = json.load(sys.stdin)
requests = []
def fake_invoke(channel, args, **kwargs):
    requests.append([channel, args[0]])
    failure = fixture["daemonFailure"]
    raise PaneDaemonClientError(failure["message"], failure["code"], failure["next"])
local.invoke_daemon = fake_invoke
sys.stdin = io.StringIO(json.dumps(fixture["payload"]))
stdout, stderr = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    code = main(["sessions", "create", "--from-json", "-", "--json"])
print(json.dumps({"code": code, "requests": requests, "failure": json.loads(stdout.getvalue())["error"]}))
`, { payload, daemonFailure: nodeFailure }));
  assert.equal(output.code, 1);
  assert.deepEqual(output.failure, nodeFailure);
  assert.deepEqual(output.requests, [['runpane:sessions:create', payload]]);
});

test('Python daemon diagnostics distinguish stale Unix sockets from unopened Pane', () => {
  const output = JSON.parse(runPython(`
import json, os, tempfile
import runpane.doctor as doctor

def fail(*args, **kwargs):
    raise RuntimeError('daemon unavailable')
doctor.invoke_daemon = fail
with tempfile.TemporaryDirectory() as directory:
    endpoint_path = os.path.join(directory, 'stale.sock')
    open(endpoint_path, 'w').close()
    existing = doctor.collect_daemon_health(directory, {'transport': 'unix', 'path': endpoint_path})
    os.remove(endpoint_path)
    missing = doctor.collect_daemon_health(directory, {'transport': 'unix', 'path': endpoint_path})
    windows = doctor.collect_daemon_health(directory, {'transport': 'pipe', 'path': endpoint_path})
    def refused(*args, **kwargs):
        raise ConnectionRefusedError('Connection refused')
    doctor.invoke_daemon = refused
    refused_result = doctor.collect_daemon_health(directory, {'transport': 'unix', 'path': endpoint_path})
    print(json.dumps([entry['nextCommand'] for entry in [existing, missing, windows, refused_result]]))
`));
  assert.deepEqual(output, [
    'Quit Pane completely, reopen Pane, then rerun runpane doctor --json',
    'Open Pane, then rerun runpane doctor --json',
    'Open Pane, then rerun runpane doctor --json',
    'Quit Pane completely, reopen Pane, then rerun runpane doctor --json',
  ]);
});

for (const kind of ['panes', 'panels']) {
  test(`Python ${kind} create explains initial-input delivery in text output`, () => {
    const deliveries = [
      { inputBytes: 3, submitted: false, delivered: false, attempts: 0, staged: false, blocked: { kind: 'unknown', message: 'Terminal not ready' }, error: { message: 'Input rejected' } },
      { inputBytes: 3, submitted: false, delivered: true, sequenceName: 'enter-cr', attempts: 1, staged: true },
      { inputBytes: 3, submitted: true, delivered: true, attempts: 2 },
    ];
    for (const [index, delivery] of deliveries.entries()) delivery.delivery = { state: ['unknown', 'in-composer', 'taken'][index], evidence: ['screen', 'screen', 'transcript'][index] };
    const output = runPython(`
import json, sys
import runpane.local_control as local
from runpane.cli import main
for delivery in json.load(sys.stdin):
    item = {'ok': True, 'index': 0, 'name': 'Example', 'sessionId': 'p1', 'paneId': 'p1', 'panelId': 't1', 'title': 'Agent', 'active': False, 'initialInput': delivery, 'association': {'ok': True, 'sessionId': 'orchestration-1'}, 'promptFile': '/tmp/prompt.md', 'warnings': [{'code': 'terminal-not-ready', 'message': 'Fixture warning'}]}
    result = {'ok': True, 'items': [item]} if '${kind}' == 'panes' else item
    local.invoke_daemon = lambda *args, **kwargs: result
    args = ['panes', 'create', '--repo', 'repo', '--name', 'Example', '--agent', 'codex', '--yes'] if '${kind}' == 'panes' else ['panels', 'create', '--pane', 'p1', '--agent', 'codex', '--yes']
    assert main(args) == 0
`, deliveries);
    const nodeResult = spawnSync(process.execPath, ['-e', `
      const daemon = require('./packages/runpane/dist/daemonClient');
      const { main } = require('./packages/runpane/dist/cli');
      (async () => {
        for (const delivery of ${JSON.stringify(deliveries)}) {
          const item = { ok: true, index: 0, name: 'Example', sessionId: 'p1', paneId: 'p1', panelId: 't1', title: 'Agent', active: false, focused: false, pinned: false, tool: {title: 'Agent', command: 'codex'}, initialInput: delivery, association: {ok: true, sessionId: 'orchestration-1'}, promptFile: '/tmp/prompt.md', warnings: [{code: 'terminal-not-ready', message: 'Fixture warning'}] };
          daemon.invokeDaemon = async () => '${kind}' === 'panes'
            ? {ok: true, repo: {id: 1, name: 'Repo', path: '/repo', active: true, sessionCount: 0}, items: [item]}
            : item;
          const args = '${kind}' === 'panes'
            ? ['panes', 'create', '--repo', 'repo', '--name', 'Example', '--agent', 'codex', '--yes']
            : ['panels', 'create', '--pane', 'p1', '--agent', 'codex', '--yes'];
          if (await main(args) !== 0) throw new Error('Create failed');
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, encoding: 'utf8', timeout: 10000, env: {...process.env, RUNPANE_TELEMETRY_DISABLED: '1'} });
    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.equal(output.replace(/\r\n/g, '\n'), nodeResult.stdout.trim().replace(/\r\n/g, '\n'));
    const lines = output.split('\n').filter(line => line.includes('Initial input')).map(line => line.trim());
    assert.deepEqual(lines, [
      'Initial input: not delivered after 0 attempts; staged: no',
      'Initial input blocked: Terminal not ready',
      'Initial input error: Input rejected',
      'Initial input: delivered but not verified submitted via enter-cr after 1 attempt; staged: yes',
      'Initial input: submitted after 2 attempts',
    ]);
  });
}

test('Python forwards update installer options so the shared preflight can reject unsupported choices', () => {
  const argv = JSON.parse(runPython(`
import json
from unittest.mock import patch
from runpane.cli import parse_args
from runpane.update import run_update
parsed = parse_args(['update', '--pane-only', '--format', 'dmg', '--download-dir', 'custom cache'])
with patch('runpane.update.Path.is_file', return_value=True), patch('runpane.update.shutil.which', return_value='node'), patch('runpane.update.subprocess.call', return_value=0) as call:
    run_update(parsed)
    print(json.dumps(call.call_args[0][0]))
`, null));
  assert.equal(argv[argv.indexOf('--format') + 1], 'dmg');
  assert.equal(argv[argv.indexOf('--download-dir') + 1], 'custom cache');
  assert.ok(argv.includes('--pane-only'));
});

test('Python update without the engine refuses installer options before handing off, like the npm CLI', () => {
  const cases = [['update', '--download-dir', 'downloads'], ['update', '--format', 'dmg']];
  const output = JSON.parse(runPython(`
import json, sys, tempfile
from runpane import update
from runpane.cli import parse_args
calls = []
update.invoke_daemon = lambda channel, *args, **kwargs: calls.append(channel)
results = []
for args in json.load(sys.stdin):
    parsed = parse_args(args + ['--pane-dir', tempfile.mkdtemp()])
    try:
        update.run_update(parsed)
        results.append('handed off')
    except update.PaneDaemonClientError as error:
        results.append([error.code, str(error)])
print(json.dumps({'results': results, 'calls': calls}))
`, cases));
  const { parseRunpaneArgs } = require(path.join(root, 'packages/runpane/dist/commands'));
  const { assertUpdateOptions } = require(path.join(root, 'packages/runpane/dist/updatePreflight'));
  const nodeOutput = cases.map(args => {
    try {
      assertUpdateOptions(parseRunpaneArgs(args));
      return 'accepted';
    } catch (error) {
      return [error.code, error.message];
    }
  });
  assert.deepEqual(output, { results: nodeOutput, calls: [] });
});

test('Python update without the engine waits for the relaunched Pane with --wait', () => {
  const stdout = runPython(`
import json, tempfile
from runpane import update
from runpane.cli import parse_args
versions = iter(['2.4.201', '2.4.201', '2.4.202'])
def fake(channel, *args, **kwargs):
    if channel == 'runpane:update:in-app':
        return {'state': 'installing', 'fromVersion': '2.4.201', 'version': '2.4.202'}
    return {'version': next(versions)}
update.invoke_daemon = fake
update.time.sleep = lambda seconds: None
update.run_update(parse_args(['update', '--wait', '--json', '--pane-dir', tempfile.mkdtemp()]))
print(json.dumps(next(versions, 'all versions read')))
`, {});
  assert.match(stdout, /"phase": "complete"/);
  assert.equal(JSON.parse(stdout.split('\n').slice(-1)[0]), 'all versions read');
});
