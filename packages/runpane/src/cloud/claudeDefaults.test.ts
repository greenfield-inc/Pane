import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultClaudeModelSource, probeCommand, readLocalClaudeModel } from './claudeDefaults';

function homeWithSettings(settings: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-claude-home-'));
  if (settings !== null) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude/settings.json'), settings);
  }
  return home;
}

test('reads the user\'s default the way Claude Code does: ANTHROPIC_MODEL, then settings.json model', async () => {
  const home = homeWithSettings(JSON.stringify({ model: 'claude-opus-5-5', theme: 'dark' }));
  assert.equal(await readLocalClaudeModel({}, home), 'claude-opus-5-5');
  assert.equal(await readLocalClaudeModel({ ANTHROPIC_MODEL: ' sonnet ' }, home), 'sonnet');
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ model: 'claude-opus-5-5[1m]' }))), 'claude-opus-5-5[1m]');
});

test('honours CLAUDE_CONFIG_DIR', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-claude-config-'));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  assert.equal(await readLocalClaudeModel({ CLAUDE_CONFIG_DIR: configDir }, homeWithSettings(JSON.stringify({ model: 'sonnet' }))), 'opus');
});

test('null when nothing is set or the value is unusable', async () => {
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(null)), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ theme: 'dark' }))), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings('{ not json')), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ model: 'opus; rm -rf /' }))), null);
  assert.equal(await readLocalClaudeModel({ ANTHROPIC_MODEL: '$(id)' }, homeWithSettings(null)), null);
});

/**
 * A stand-in `claude`: logs how it was started (as JSON lines in FAKE_LOG), makes the project folder Claude makes for
 * its cwd, then prints what FAKE_MODE says. In `init` mode it keeps printing api_retry until it is killed.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mode = process.env.FAKE_MODE;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(),
  https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY, all: process.env.ALL_PROXY, noProxy: process.env.NO_PROXY ?? null,
}) + '\\n');
const projects = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), 'memory');
fs.mkdirSync(projects, { recursive: true });
process.stdin.once('data', () => {
  if (mode === 'hang') return;
  if (mode === 'no-init') { console.log('not json'); process.exit(3); }
  console.log(JSON.stringify({ type: 'system', subtype: 'hook_started' }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: process.env.FAKE_MODEL, session_id: 'x' }));
  setInterval(() => console.log(JSON.stringify({ type: 'system', subtype: 'api_retry' })), 50);
});
setInterval(() => {}, 1000);
`;

function fakeClaude(mode: 'init' | 'no-init' | 'hang', model = 'claude-opus-5-5') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-fake-claude-'));
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  const home = homeWithSettings(JSON.stringify({ theme: 'dark' }));
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(configDir, 'projects/-home-user-real-project'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects/-home-user-real-project/session.jsonl'), '{}\n');
  const log = path.join(dir, 'log.jsonl');
  const notices: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_MODE: mode,
    FAKE_MODEL: model,
    FAKE_LOG: log,
    NO_PROXY: 'example.com',
    HTTPS_PROXY: 'http://corporate-proxy:3128',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-SECRET',
  };
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { claude, home, configDir, env, notices, runs, onNotice: (message: string) => notices.push(message) };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('with no explicit default, detects the model from the user\'s own claude, offline, and cleans up after it', async () => {
  const fake = fakeClaude('init');
  const source = createDefaultClaudeModelSource({ env: fake.env, home: fake.home, platform: 'linux', onNotice: fake.onNotice });
  assert.equal(await source(), 'claude-opus-5-5');
  const [run] = fake.runs();
  assert.deepEqual(run.args, ['-p', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  // Every proxy variable points at a closed local port, so the placeholder message can't reach the API.
  assert.deepEqual([run.https, run.http, run.all, run.noProxy], ['http://127.0.0.1:9', 'http://127.0.0.1:9', 'http://127.0.0.1:9', null]);
  assert.match(path.basename(run.cwd), /^pane-claude-probe-/u);
  assert.equal(fs.existsSync(run.cwd), false, 'the probe\'s temp dir is gone');
  assert.deepEqual(fs.readdirSync(path.join(fake.configDir, 'projects')), ['-home-user-real-project'], 'only the probe\'s empty project folder is removed');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isAlive(run.pid), false, 'the probe is killed after its init line');
  assert.deepEqual(fake.notices, []);
});

test('detection is cached per claude executable and settings mtime; an explicit default always wins', async () => {
  const fake = fakeClaude('init');
  const source = createDefaultClaudeModelSource({ env: fake.env, home: fake.home, platform: 'linux', onNotice: fake.onNotice });
  assert.equal(await source(), 'claude-opus-5-5');
  assert.equal(await source(), 'claude-opus-5-5');
  assert.equal(fake.runs().length, 1, 'a second call reuses the detection');

  const settings = path.join(fake.configDir, 'settings.json');
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(settings, later, later);
  assert.equal(await source(), 'claude-opus-5-5');
  assert.equal(fake.runs().length, 2, 'edited settings detect again');

  fs.writeFileSync(settings, JSON.stringify({ model: 'claude-haiku-4-5' }));
  assert.equal(await source(), 'claude-haiku-4-5');
  assert.equal(fake.runs().length, 2, 'an explicit default needs no probe');
});

test('a failed detection sends nothing and says why, without secrets', async () => {
  const silent = fakeClaude('no-init');
  assert.equal(await createDefaultClaudeModelSource({ env: silent.env, home: silent.home, platform: 'linux', onNotice: silent.onNotice })(), null);
  assert.match(silent.notices[0], /^Could not detect your Claude Code default model \(claude exited \(3\) before reporting its model\)/u);

  const hanging = fakeClaude('hang');
  const started = Date.now();
  assert.equal(await createDefaultClaudeModelSource({ env: hanging.env, home: hanging.home, platform: 'linux', timeoutMs: 300, onNotice: hanging.onNotice })(), null);
  assert.ok(Date.now() - started < 5_000);
  assert.match(hanging.notices[0], /no answer from claude within 0 s/u);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isAlive(hanging.runs()[0].pid), false, 'a probe that times out is killed too');

  const bogus = fakeClaude('init', 'opus; rm -rf /');
  assert.equal(await createDefaultClaudeModelSource({ env: bogus.env, home: bogus.home, platform: 'linux', onNotice: bogus.onNotice })(), null);
  assert.match(bogus.notices[0], /claude reported no usable model/u);

  const missing = fakeClaude('init');
  const notices: string[] = [];
  assert.equal(await createDefaultClaudeModelSource({
    env: { ...missing.env, PATH: '/nonexistent' }, home: missing.home, platform: 'linux', onNotice: (message) => notices.push(message),
  })(), null);
  assert.match(notices[0], /claude was not found on PATH/u);

  for (const notice of [...silent.notices, ...hanging.notices, ...bogus.notices, ...notices]) assert.doesNotMatch(notice, /SECRET/u);
});

test('Windows: an npm .cmd shim runs through cmd.exe with fixed arguments; claude.exe runs directly', () => {
  const shim = probeCommand('C:\\Users\\red\\AppData\\Roaming\\npm\\claude.cmd', 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(shim.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(shim.args[3], '""C:\\Users\\red\\AppData\\Roaming\\npm\\claude.cmd" -p --no-session-persistence --input-format stream-json --output-format stream-json --verbose"');
  assert.equal(shim.windowsVerbatimArguments, true);
  const native = probeCommand('C:\\Users\\red\\.local\\bin\\claude.exe', 'win32');
  assert.equal(native.command, 'C:\\Users\\red\\.local\\bin\\claude.exe');
  assert.equal(native.windowsVerbatimArguments, false);
});
