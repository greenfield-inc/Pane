const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, 'packages/runpane-py/src'),
  PYTHONDONTWRITEBYTECODE: '1',
  RUNPANE_TELEMETRY_DISABLED: '1',
};

function run(runtime, source) {
  return spawnSync(runtime === 'npm' ? process.execPath : python, [runtime === 'npm' ? '-e' : '-c', source], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
}

for (const runtime of ['npm', 'pip']) {
  test(`${runtime}: loading rejects a contract command without a handler`, () => {
    const result = run(runtime, runtime === 'npm' ? `
      const { RUNPANE_CONTRACT } = require('./packages/runpane/dist/generated/contract');
      RUNPANE_CONTRACT.commands.push({ name: 'missing command', localControl: false });
      require('./packages/runpane/dist/cli');
    ` : `
from runpane.generated_contract import RUNPANE_CONTRACT
RUNPANE_CONTRACT['commands'].append({'name': 'missing command', 'localControl': False})
import runpane.cli
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing command handlers: missing command/);
  });

  test(`${runtime}: loading rejects handlers absent from the contract`, () => {
    const result = run(runtime, runtime === 'npm' ? `
      const { RUNPANE_CONTRACT } = require('./packages/runpane/dist/generated/contract');
      RUNPANE_CONTRACT.commands = RUNPANE_CONTRACT.commands.filter(command => command.name !== 'watch');
      require('./packages/runpane/dist/cli');
    ` : `
from runpane.generated_contract import RUNPANE_CONTRACT
RUNPANE_CONTRACT['commands'] = [command for command in RUNPANE_CONTRACT['commands'] if command['name'] != 'watch']
import runpane.cli
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected command handlers: watch/);
  });

  test(`${runtime}: pin and unpin dispatch preserve their distinct operations and exit codes`, () => {
    const result = run(runtime, runtime === 'npm' ? `
      const local = require('./packages/runpane/dist/localControl');
      local.runPanesPin = async (parsed, pinned) => { console.log(JSON.stringify([parsed.paneId, pinned])); return 7; };
      const { main } = require('./packages/runpane/dist/cli');
      (async () => {
        console.log(await main(['panes', 'pin', '--pane', 'p1', '--yes']));
        console.log(await main(['panes', 'unpin', '--pane', 'p2', '--yes']));
      })();
    ` : `
import json
import runpane.local_control as local

def pin(parsed, pinned):
    print(json.dumps([parsed.pane_id, pinned], separators=(',', ':')))
    return 7

local.run_panes_pin = pin
from runpane.cli import main
print(main(['panes', 'pin', '--pane', 'p1', '--yes']))
print(main(['panes', 'unpin', '--pane', 'p2', '--yes']))
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '["p1",true]\n7\n["p2",false]\n7');
  });
}

test('pip: adopt explicitly reports that the command is unsupported', () => {
  const result = run('pip', `
from runpane.cli import main
raise SystemExit(main(['panes', 'adopt']))
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /panes adopt is not supported by the Python wrapper/);
  assert.equal(result.stdout, '');
});

for (const runtime of ['npm', 'pip']) {
  test(`${runtime}: telemetry identifies exact commands before argument validation`, () => {
    const samples = [
      ['panes', 'archive', '--invalid'], ['panes', 'pin', '--invalid'],
      ['panes', 'rename', '--invalid'], ['panes', 'focus', '--invalid'],
      ['sessions', 'get', '--invalid'], ['panels', 'submit-composer', '--invalid'],
      ['panes', 'nonsense'], ['repos', 'nonsense'], ['--version'],
    ];
    const result = run(runtime, runtime === 'npm' ? `
      const { createInitialTelemetryContext } = require('./packages/runpane/dist/telemetry');
      console.log(JSON.stringify(${JSON.stringify(samples)}.map(args => createInitialTelemetryContext(args).command)));
    ` : `
import json
from runpane.telemetry import create_initial_telemetry_context
print(json.dumps([create_initial_telemetry_context(args)['command'] for args in ${JSON.stringify(samples)}]))
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      'panes archive', 'panes pin', 'panes rename', 'panes focus',
      'sessions get', 'panels submit-composer', 'unknown', 'unknown', 'version',
    ]);
  });

  test(`${runtime}: parser respects local flag classification from the contract`, () => {
    const result = run(runtime, runtime === 'npm' ? `
      const { RUNPANE_CONTRACT } = require('./packages/runpane/dist/generated/contract');
      RUNPANE_CONTRACT.commands.find(command => command.name === 'doctor').localControl = false;
      const { parseRunpaneArgs } = require('./packages/runpane/dist/commands');
      parseRunpaneArgs(['doctor', '--repo', 'isolated']);
    ` : `
from runpane.generated_contract import RUNPANE_CONTRACT
next(command for command in RUNPANE_CONTRACT['commands'] if command['name'] == 'doctor')['localControl'] = False
from runpane.cli import parse_args
parse_args(['doctor', '--repo', 'isolated'])
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option for doctor: --repo/);
  });
}
