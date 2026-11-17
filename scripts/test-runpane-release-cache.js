// doctor's release lookup (#1128): the on-disk cache, the GitHub token header, and a failed lookup
// reported as a warning that leaves the top-level `ok` to the daemon. Each case runs against both
// wrappers with the HTTP transport stubbed (fetch for npm, urllib.request.urlopen for pip), so
// nothing reaches api.github.com, and the two `release` reports must match byte for byte.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const rootDir = path.join(__dirname, '..');
const npmDist = path.join(rootDir, 'packages', 'runpane', 'dist');
const pythonSource = path.join(rootDir, 'packages', 'runpane-py', 'src');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const TOKEN = 'ghp_runpaneReleaseCacheTestToken';

const release = {
  tag_name: 'v2.2.8',
  name: 'v2.2.8',
  body: '',
  html_url: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.2.8',
  published_at: '2026-01-01T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    { name: 'Pane-2.2.8-macOS-arm64.dmg', browser_download_url: 'https://example.test/macos-arm64.dmg' },
    { name: 'Pane-2.2.8-linux-x86_64.AppImage', browser_download_url: 'https://example.test/linux-x64.AppImage' },
  ],
};

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-release-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs `body` with only `env` set among the GitHub token variables. */
async function withTokenEnv(env, body) {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Stubs fetch; each call records its headers and gets `respond()`: 'ok' or an HTTP status. */
async function withFetch(respond, body) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const status = respond();
    if (status === 'ok') return { ok: true, status: 200, statusText: 'OK', json: async () => release };
    return { ok: false, status, statusText: status === 403 ? 'rate limit exceeded' : 'Unauthorized', json: async () => ({}) };
  };
  try {
    await body();
  } finally {
    global.fetch = original;
  }
  return calls;
}

function tokenEnvFor(env) {
  const clean = { ...process.env };
  delete clean.GH_TOKEN;
  delete clean.GITHUB_TOKEN;
  return { ...clean, ...env };
}

/** Runs Python with a stubbed urlopen: STATUS ('ok' or an HTTP status) is read from `status.txt` in DIR. */
function runPython(source, input, env = {}) {
  return execFileSync(python, ['-c', `
import io, json, os, sys, urllib.error, urllib.request
import runpane.releases as releases
payload = json.loads(sys.stdin.read())
DIR = payload["dir"]
CALLS = []
class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()
def fake_urlopen(request, timeout=None):
    CALLS.append({"url": request.full_url, "authorization": request.get_header("Authorization")})
    with open(os.path.join(DIR, "status.txt")) as handle:
        status = handle.read().strip()
    if status == "ok":
        return Response(json.dumps(payload["release"]).encode("utf-8"))
    code = int(status)
    raise urllib.error.HTTPError(request.full_url, code, "rate limit exceeded" if code == 403 else "Unauthorized", {}, None)
releases.urllib.request.urlopen = fake_urlopen
${source}
`], {
    cwd: rootDir,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...tokenEnvFor(env), PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource, RUNPANE_TELEMETRY_DISABLED: '1' },
  }).trim();
}

test('a fresh cached lookup skips the network, an expired one refetches, and a failed refresh falls back to it', async (t) => {
  const { fetchReleaseCached } = require(path.join(npmDist, 'releases.js'));
  const directory = scratch(t);
  const cacheFile = path.join(directory, 'runpane', 'release-cache.json');
  let status = 'ok';
  let clock = T0;
  const lookup = () => fetchReleaseCached('latest', { cacheFile, now: () => clock });
  const results = [];
  const calls = await withTokenEnv({}, () => withFetch(() => status, async () => {
    results.push(await lookup()); // empty cache: asks GitHub and saves the answer
    clock = T0 + HOUR / 2;
    results.push(await lookup()); // 30 minutes later: cache hit, no request
    clock = T0 + 2 * HOUR;
    status = 403;
    results.push(await lookup()); // expired, GitHub refuses: the cached lookup stands in
    status = 'ok';
    results.push(await lookup()); // expired, GitHub answers: refetched and saved again
    clock = T0 + 30 * HOUR;
    status = 403;
    await assert.rejects(lookup(), /Failed to fetch Pane release latest: 403 rate limit exceeded/u); // too old to stand in
  }));

  assert.equal(calls.length, 4, 'the fresh cache hit must not reach GitHub');
  assert.deepEqual(results.map(result => [result.cached, result.fetchedAt, result.refreshError]), [
    [false, '2026-11-16T10:00:00.000Z', undefined],
    [true, '2026-11-16T10:00:00.000Z', undefined],
    [true, '2026-11-16T10:00:00.000Z', 'Failed to fetch Pane release latest: 403 rate limit exceeded'],
    [false, '2026-11-16T12:00:00.000Z', undefined],
  ]);
  assert.equal(results[1].release.tag_name, 'v2.2.8');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(saved, { version: 1, entries: { latest: { fetchedAt: '2026-11-16T12:00:00.000Z', release } } });

  // The Python CLI reads the file the npm CLI wrote, and follows the same steps.
  fs.rmSync(cacheFile);
  const pythonResults = JSON.parse(runPython(`
cache_file = os.path.join(DIR, "runpane", "release-cache.json")
T0 = payload["t0"] / 1000
HOUR = 3600
def set_status(value):
    with open(os.path.join(DIR, "status.txt"), "w") as handle:
        handle.write(value)
def lookup(now):
    result = releases.fetch_release_cached("latest", cache_file=cache_file, now=lambda: now)
    return [result.cached, result.fetched_at, result.refresh_error]
set_status("ok")
results = [lookup(T0), lookup(T0 + HOUR / 2)]
set_status("403")
results.append(lookup(T0 + 2 * HOUR))
set_status("ok")
results.append(lookup(T0 + 2 * HOUR))
set_status("403")
try:
    lookup(T0 + 30 * HOUR)
    results.append("no error")
except RuntimeError as error:
    results.append(str(error))
with open(cache_file) as handle:
    saved = json.load(handle)
print(json.dumps({"results": results, "calls": len(CALLS), "saved": saved}))
`, { dir: directory, release, t0: T0 }));
  assert.equal(pythonResults.calls, 4, 'pip: the fresh cache hit must not reach GitHub');
  assert.deepEqual(pythonResults.results, [
    ...results.map(result => [result.cached, result.fetchedAt, result.refreshError ?? null]),
    'Failed to fetch Pane release latest: 403 rate limit exceeded',
  ]);
  assert.deepEqual(pythonResults.saved, saved, 'both CLIs write the same cache file');
});

test('GH_TOKEN, else GITHUB_TOKEN, is sent as a bearer token, and no header is sent without one', async (t) => {
  const { fetchRelease } = require(path.join(npmDist, 'releases.js'));
  const directory = scratch(t);
  fs.writeFileSync(path.join(directory, 'status.txt'), 'ok');
  const cases = [
    { env: {}, expected: undefined },
    { env: { GH_TOKEN: TOKEN }, expected: `Bearer ${TOKEN}` },
    { env: { GITHUB_TOKEN: TOKEN }, expected: `Bearer ${TOKEN}` },
    { env: { GH_TOKEN: ' ', GITHUB_TOKEN: TOKEN }, expected: `Bearer ${TOKEN}` },
    { env: { GH_TOKEN: TOKEN, GITHUB_TOKEN: 'other' }, expected: `Bearer ${TOKEN}` },
  ];
  for (const scenario of cases) {
    const calls = await withTokenEnv(scenario.env, () => withFetch(() => 'ok', () => fetchRelease('latest')));
    assert.equal(calls[0].headers.authorization, scenario.expected, `npm ${JSON.stringify(scenario.env)}`);
    const sent = JSON.parse(runPython(`
releases.fetch_release("latest")
print(json.dumps(CALLS[0]["authorization"]))
`, { dir: directory, release }, scenario.env));
    assert.equal(sent ?? undefined, scenario.expected, `pip ${JSON.stringify(scenario.env)}`);
  }
});

/**
 * Both doctors against a healthy (stubbed) daemon and a GitHub that answers `status`, with
 * `cache` (if any) already saved. Returns each wrapper's exit code and `--json` report.
 */
async function runBothDoctors(t, { status, cache, env = {} }) {
  const directory = scratch(t);
  const paneDir = path.join(directory, 'pane');
  fs.mkdirSync(path.join(paneDir, 'runpane'), { recursive: true });
  if (cache) fs.writeFileSync(path.join(paneDir, 'runpane', 'release-cache.json'), JSON.stringify(cache));
  fs.writeFileSync(path.join(directory, 'status.txt'), String(status));

  const doctor = require(path.join(npmDist, 'doctor.js'));
  const daemon = require(path.join(npmDist, 'daemonClient.js'));
  const platform = require(path.join(npmDist, 'platform.js'));
  const { parseRunpaneArgs } = require(path.join(npmDist, 'commands.js'));
  const original = { invoke: daemon.invokeDaemon, platform: platform.detectPlatform, log: console.log, error: console.error };
  const output = [];
  let npmCode;
  try {
    platform.detectPlatform = () => ({ os: 'darwin', arch: 'arm64' });
    daemon.invokeDaemon = async () => ({ daemon: {}, repos: { count: 0 } });
    console.log = line => output.push(line);
    await withTokenEnv(env, () => withFetch(() => status, async () => {
      npmCode = await doctor.runDoctor(parseRunpaneArgs([
        'doctor', '--pane-dir', paneDir, '--pane-path', path.join(directory, 'missing'), '--json',
      ]));
    }));
  } finally {
    daemon.invokeDaemon = original.invoke;
    platform.detectPlatform = original.platform;
    console.log = original.log;
  }
  if (cache) fs.writeFileSync(path.join(paneDir, 'runpane', 'release-cache.json'), JSON.stringify(cache));

  const pip = JSON.parse(runPython(`
import contextlib
import runpane.doctor as doctor
from runpane.cli import parse_args
from runpane.platforms import PanePlatform
doctor.detect_platform = lambda: PanePlatform(os="darwin", arch="arm64")
doctor.invoke_daemon = lambda *args, **kwargs: {"daemon": {}, "repos": {"count": 0}}
output = io.StringIO()
with contextlib.redirect_stdout(output):
    code = doctor.run_doctor(parse_args(["doctor", "--pane-dir", payload["paneDir"], "--pane-path", payload["missing"], "--json"]))
report = json.loads(output.getvalue())
print(json.dumps({"code": code, "ok": report["ok"], "release": json.dumps(report["release"], indent=2)}))
`, { dir: directory, release, paneDir, missing: path.join(directory, 'missing') }, env));

  const npm = JSON.parse(output.join('\n'));
  return { npm: { code: npmCode, ok: npm.ok, release: npm.release, releaseText: JSON.stringify(npm.release, null, 2) }, pip };
}

test('a rate-limited lookup with no cache and a healthy daemon is a release warning, not ok: false', async (t) => {
  for (const env of [{}, { GH_TOKEN: TOKEN }]) {
    const { npm, pip } = await runBothDoctors(t, { status: 403, env });
    assert.equal(npm.code, 0);
    assert.equal(npm.ok, true, 'a GitHub failure must not fail doctor while the daemon is healthy');
    assert.deepEqual(npm.release, {
      ok: false,
      severity: 'warning',
      code: 'RUNPANE_RELEASE_CHECK_FAILED',
      error: 'Could not look up the latest Pane release, and no recent lookup is cached: Failed to fetch Pane release latest: 403 rate limit exceeded',
      next: env.GH_TOKEN
        ? 'Check that GH_TOKEN or GITHUB_TOKEN holds a valid GitHub token, or rerun runpane doctor later. Pane itself is not affected.'
        : "Set GH_TOKEN or GITHUB_TOKEN to a GitHub token to raise GitHub's rate limit, or rerun runpane doctor later. Pane itself is not affected.",
    });
    assert.equal(pip.code, 0);
    assert.equal(pip.ok, true);
    assert.equal(pip.release, npm.releaseText, 'the two CLIs report the release check identically');
    assert.equal(npm.releaseText.includes(TOKEN), false, 'the token never appears in the report');
  }
});

test('a rate-limited lookup with a recent cache reports the cached release with a warning', async (t) => {
  const fetchedAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const { npm, pip } = await runBothDoctors(t, {
    status: 403,
    cache: { version: 1, entries: { latest: { fetchedAt, release } } },
  });
  assert.equal(npm.code, 0);
  assert.equal(npm.ok, true);
  assert.deepEqual(npm.release, {
    ok: true,
    tagName: 'v2.2.8',
    artifactName: 'Pane-2.2.8-macOS-arm64.dmg',
    format: 'dmg',
    preferredDownloadUrl: npm.release.preferredDownloadUrl,
    fallbackDownloadUrl: 'https://example.test/macos-arm64.dmg',
    cached: true,
    fetchedAt,
    severity: 'warning',
    code: 'RUNPANE_RELEASE_CHECK_CACHED',
    error: `Could not refresh the release lookup (Failed to fetch Pane release latest: 403 rate limit exceeded), so this is the one cached at ${fetchedAt}.`,
    next: "Set GH_TOKEN or GITHUB_TOKEN to a GitHub token to raise GitHub's rate limit, or rerun runpane doctor later. Pane itself is not affected.",
  });
  // The source query parameter differs (npm/pip) by design; the rest must match.
  assert.equal(pip.release.replace('source=pip', 'source=npm'), npm.releaseText);
});

test('a fresh cache answers doctor without a request', async (t) => {
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // A 401 would surface as a warning, so a clean report proves GitHub was never asked.
  const { npm, pip } = await runBothDoctors(t, {
    status: 401,
    cache: { version: 1, entries: { latest: { fetchedAt, release } } },
  });
  assert.equal(npm.ok, true);
  assert.equal(npm.release.cached, true);
  assert.equal(npm.release.fetchedAt, fetchedAt);
  assert.equal(npm.release.severity, undefined);
  assert.equal(pip.release.replace('source=pip', 'source=npm'), npm.releaseText);
});
