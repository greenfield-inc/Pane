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
    const output = runPython(`
import json, sys
import runpane.local_control as local
from runpane.cli import main
for delivery in json.load(sys.stdin):
    item = {'ok': True, 'index': 0, 'name': 'Example', 'sessionId': 'p1', 'paneId': 'p1', 'panelId': 't1', 'title': 'Agent', 'active': False, 'initialInput': delivery}
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
          const item = { ok: true, index: 0, name: 'Example', sessionId: 'p1', paneId: 'p1', panelId: 't1', title: 'Agent', active: false, focused: false, pinned: false, tool: {title: 'Agent', command: 'codex'}, initialInput: delivery };
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
