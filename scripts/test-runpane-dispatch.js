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
  test(`${runtime}: wrapper failure reports are sanitized and respect local opt-out`, () => {
    const result = run(runtime, runtime === 'npm' ? `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-telemetry-'));
      process.env.PANE_DIR = dir;
      delete process.env.CI;
      delete process.env.RUNPANE_TELEMETRY_DISABLED;
      const events = [];
      global.fetch = async (_, options) => { events.push(JSON.parse(options.body)); return {}; };
      let exit = 0;
      const local = require('./packages/runpane/dist/localControl');
      local.runPanesPin = async () => exit;
      const { main } = require('./packages/runpane/dist/cli');
      (async () => {
        try {
          await main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes']);
          if (events.length !== 0) throw new Error('Successful command emitted telemetry');
          exit = 7;
          if (await main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes']) !== 7) throw new Error('Exit code changed');
          fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ analytics: { enabled: false } }));
          await main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes']);
          console.log(JSON.stringify(events));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    ` : `
import json, os, tempfile
import runpane.telemetry as telemetry
import runpane.local_control as local
events = []
telemetry._post_telemetry = events.append
exit_code = 0
local.run_panes_pin = lambda parsed, pinned: exit_code
from runpane.cli import main
os.environ.pop('CI', None)
os.environ.pop('RUNPANE_TELEMETRY_DISABLED', None)
with tempfile.TemporaryDirectory(prefix='pane-telemetry-') as directory:
    os.environ['PANE_DIR'] = directory
    assert main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes']) == 0
    assert events == [], 'Successful command emitted telemetry'
    exit_code = 7
    assert main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes']) == 7
    with open(os.path.join(directory, 'config.json'), 'w') as target:
        json.dump({'analytics': {'enabled': False}}, target)
    main(['panes', 'pin', '--pane', 'secret-repo-path', '--yes'])
    print(json.dumps(events))
`);
    assert.equal(result.status, 0, result.stderr);
    const events = JSON.parse(result.stdout);
    assert.equal(events.length, 1);
    const { install_id: installId, wrapper_version: wrapperVersion, invocation, wrapper, download_source, ...properties } = events[0].properties;
    assert.equal(events[0].event, 'runpane_wrapper_command_failed');
    assert.match(installId, /^install_[0-9a-f-]{36}$/);
    assert.match(wrapperVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(wrapper, runtime);
    assert.equal(download_source, runtime);
    assert.deepEqual(properties, {
      command: 'panes pin', target: 'client', pane_version: 'latest', channel: 'stable',
      format: 'auto', dry_run: false, failure_stage: 'unknown', failure_category: 'process_exit', exit_code: 7,
    });
    assert.equal(JSON.stringify(events).includes('secret-repo-path'), false);
  });

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
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['["p1",true]', '7', '["p2",false]', '7']);
  });
}

test('pip: adopt dispatch forwards supported selectors and returns the handler exit code', () => {
  const result = run('pip', `
import json
import runpane.local_control as local

def adopt(parsed):
    print(json.dumps([parsed.repo, parsed.repo_path, parsed.name, parsed.base_branch, parsed.folder, parsed.resume, parsed.launch, parsed.no_focus, parsed.source], separators=(',', ':')))
    return 7

local.run_panes_adopt = adopt
from runpane.cli import main
print(main(['panes', 'adopt', '--repo', 'r1', '--path', '/tmp/wt', '--name', 'adopted', '--agent', 'codex', '--folder', 'f1', '--resume', 'resume1', '--launch', '--no-focus', '--source', 'agent', '--yes']))
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['["r1","/tmp/wt","adopted",null,"f1","resume1",true,true,"agent"]', '7']);
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
