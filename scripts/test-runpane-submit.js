const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
for (const runtime of ['npm', 'pip']) {
  test(`${runtime}: submit forwards interrupt and explains queued delivery`, () => {
    const result = { ok: true, panelId: 'qa', inputBytes: 5, enter: 'tab', sequenceName: 'tab', verifiedSubmitted: true, delivery: { state: 'queued', evidence: 'screen', message: 'The agent sees this only after its current turn ends. Do not resend.' }, sentAt: '2026-10-06T00:00:00Z' };
    const source = runtime === 'npm' ? `
      const daemon = require('./packages/runpane/dist/daemonClient');
      daemon.invokeDaemon = async (channel, args) => { require('node:assert/strict').equal(args[0].interrupt, true); return ${JSON.stringify(result)}; };
      require('./packages/runpane/dist/cli').main(['panels','submit','--panel','qa','--text','hello','--interrupt','--yes']).then(code => process.exitCode = code);
    ` : `
from runpane.cli import main
import runpane.local_control as local
import json
def invoke(channel, args, **kwargs):
    assert args[0]['interrupt'] is True
    return json.loads(${JSON.stringify(JSON.stringify(result))})
local.invoke_daemon = invoke
raise SystemExit(main(['panels','submit','--panel','qa','--text','hello','--interrupt','--yes']))
`;
    const command = runtime === 'npm' ? process.execPath : (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
    const output = spawnSync(command, [runtime === 'npm' ? '-e' : '-c', source], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PYTHONPATH: path.join(root, 'packages/runpane-py/src'), RUNPANE_TELEMETRY_DISABLED: '1' },
    });
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /^Queued 5 bytes/m);
    assert.match(output.stdout, /agent sees this only after its current turn ends/);
  });
}
