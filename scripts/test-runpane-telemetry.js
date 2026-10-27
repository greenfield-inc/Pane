// Wrapper failure telemetry, driven through each wrapper's main() against a fake Pane daemon.
// The HTTP transport is stubbed (fetch for npm, urllib.request.urlopen for pip), so every event a
// command would send is captured here and nothing reaches runpane.com.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const rootDir = path.join(__dirname, '..');
const npmDist = path.join(rootDir, 'packages', 'runpane', 'dist');
const pythonSource = path.join(rootDir, 'packages', 'runpane-py', 'src');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const OPT_OUTS = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'TF_BUILD', 'JENKINS_URL', 'TEAMCITY_VERSION', 'CODEBUILD_BUILD_ID', 'DO_NOT_TRACK', 'RUNPANE_TELEMETRY_DISABLED'];
const WRAPPERS = ['npm', 'pip'];

const notReady = {
  ok: false, condition: 'ready', matched: false, timedOut: true, elapsedMs: 30000,
  state: { initialized: true }, panelId: 'panel-1', screen: { source: 'empty', text: '', hasMore: false },
};
const permissionDenied = { code: 'EACCES', message: 'EACCES: permission denied, open /Users/someone/private-repo/.git/config' };

/** Each request gets `respond(channel, requestNumber)`: `{ result }` or `{ error }`. */
async function withFakeDaemon(paneDir, respond, action) {
  const { getPaneDaemonEndpoint } = require(path.join(npmDist, 'daemonClient.js'));
  const endpoint = getPaneDaemonEndpoint(paneDir);
  if (endpoint.transport === 'unix') {
    fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
    fs.rmSync(endpoint.path, { force: true });
  }
  let requests = 0;
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (frame.type !== 'request' || frame.id !== 1) continue;
        const response = respond(frame.channel, requests++);
        socket.end(`${JSON.stringify({ type: 'response', id: 1, ok: !response.error, ...response })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint.path, resolve);
  });
  try {
    return await action();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function telemetryEnv(paneDir, extra = {}) {
  const env = { ...process.env, PANE_DIR: paneDir, ...extra };
  for (const key of OPT_OUTS) if (!(key in extra)) delete env[key];
  return env;
}

/** Runs each argv through the npm wrapper's main() in this process; returns exit codes and posted events. */
async function runNpm(argvs, env) {
  const events = [];
  const saved = { env: process.env, fetch: globalThis.fetch, log: console.log, error: console.error };
  process.env = env;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://runpane.com/api/runpane/telemetry');
    events.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  };
  console.log = () => {};
  console.error = () => {};
  try {
    delete require.cache[require.resolve(path.join(npmDist, 'cli.js'))];
    const { main } = require(path.join(npmDist, 'cli.js'));
    const codes = [];
    for (const argv of argvs) codes.push(await main(argv).catch(() => 1));
    return { codes, events };
  } finally {
    process.env = saved.env;
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    console.error = saved.error;
  }
}

const PIP_RUNNER = `
import contextlib, io, json, sys, urllib.request
events = []
class Response:
    def close(self): pass
def urlopen(request, timeout=None):
    assert request.full_url == "https://runpane.com/api/runpane/telemetry"
    events.append(json.loads(request.data))
    return Response()
urllib.request.urlopen = urlopen
from runpane.cli import main
codes = []
for argv in json.loads(sys.argv[1]):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        codes.append(main(argv))
print(json.dumps({"codes": codes, "events": events}))
`;

/** Runs each argv through the pip wrapper's main() in one Python process; returns exit codes and posted events. */
function runPip(argvs, env) {
  return new Promise((resolve, reject) => {
    execFile(python, ['-c', PIP_RUNNER, JSON.stringify(argvs)], {
      cwd: rootDir, encoding: 'utf8', timeout: 60_000,
      env: { ...env, PYTHONPATH: pythonSource, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout)));
  });
}

function run(wrapper, argvs, env) {
  return wrapper === 'npm' ? runNpm(argvs, env) : runPip(argvs, env);
}

function freshPaneDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-telemetry-'));
}

for (const wrapper of WRAPPERS) {
  test(`${wrapper}: panels wait that is not ready exits 1 and sends nothing`, async () => {
    const paneDir = freshPaneDir();
    const { codes, events } = await withFakeDaemon(paneDir, () => ({ result: notReady }),
      () => run(wrapper, [['panels', 'wait', '--panel', 'panel-1', '--json']], telemetryEnv(paneDir)));
    assert.deepEqual(codes, [1]);
    assert.deepEqual(events, []);
  });

  test(`${wrapper}: a daemon failure sends one event with its code, category and command`, async () => {
    const paneDir = freshPaneDir();
    const { codes, events } = await withFakeDaemon(paneDir, () => ({ error: permissionDenied }),
      () => run(wrapper, [['panes', 'list', '--json']], telemetryEnv(paneDir)));
    assert.deepEqual(codes, [1]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'runpane_wrapper_command_failed');
    assert.equal(events[0].properties.command, 'panes list');
    assert.equal(events[0].properties.error_code, 'EACCES');
    assert.equal(events[0].properties.failure_category, 'permission');
    assert.doesNotMatch(JSON.stringify(events[0]), /private-repo|\/Users\//);
  });

  test(`${wrapper}: an unknown command is a validation failure, not a network one`, async () => {
    const paneDir = freshPaneDir();
    const { codes, events } = await run(wrapper, [['frobnicate']], telemetryEnv(paneDir));
    assert.deepEqual(codes, [1]);
    assert.equal(events.length, 1);
    assert.equal(events[0].properties.failure_stage, 'parse');
    assert.equal(events[0].properties.failure_category, 'validation');
  });

  test(`${wrapper}: a loop of failures sends one event per cause and at most 10 an hour`, async () => {
    const paneDir = freshPaneDir();
    const sameCause = await withFakeDaemon(paneDir, () => ({ error: permissionDenied }),
      () => run(wrapper, Array.from({ length: 20 }, () => ['panes', 'list', '--json']), telemetryEnv(paneDir)));
    assert.equal(sameCause.codes.length, 20);
    assert.equal(sameCause.events.length, 1);

    const otherPaneDir = freshPaneDir();
    const distinctCauses = await withFakeDaemon(otherPaneDir, (_channel, n) => ({ error: { code: `ERR_TEST_${n}`, message: 'failed' } }),
      () => run(wrapper, Array.from({ length: 15 }, () => ['panes', 'list', '--json']), telemetryEnv(otherPaneDir)));
    assert.equal(distinctCauses.events.length, 10);
  });

  test(`${wrapper}: CI and opt-outs send nothing`, async () => {
    const optOuts = [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { DO_NOT_TRACK: '1' }, { RUNPANE_TELEMETRY_DISABLED: '1' }, { analytics: 'off' }];
    for (const optOut of optOuts) {
      const paneDir = freshPaneDir();
      const { analytics, ...env } = optOut;
      if (analytics) fs.writeFileSync(path.join(paneDir, 'config.json'), JSON.stringify({ analytics: { enabled: false } }));
      const { codes, events } = await run(wrapper, [['frobnicate']], telemetryEnv(paneDir, env));
      assert.deepEqual(codes, [1]);
      assert.deepEqual(events, [], `${JSON.stringify(optOut)} must send nothing`);
    }
  });
}
