#!/usr/bin/env node
// Records real Claude Code and Codex terminal screens as raw bytes with their timing, for the
// Session activity fixtures (main/src/services/agentStatus/__fixtures__/screens). Each scenario
// runs the real agent in a pseudo-terminal under a throwaway HOME, CODEX_HOME and working folder:
// Claude signs in through this Mac's keychain (linked read-only into the throwaway HOME, as
// scripts/agent-instructions-eval/run.mjs does) and Codex through a read-only copy of
// ~/.codex/auth.json. Nothing reads or writes your ~/.pane, ~/.claude or ~/.codex otherwise.
// It spends real model turns (a few cents with the cheap models it picks).
//
//   node scripts/agent-screens/capture.mjs [--only name,name] [--out dir]
//
// Each fixture is JSON: { agent, version, cols, rows, scenario, recordedAt, frames: [{ t, data }],
// marks: [{ t, label }] }, where t is ms since spawn and marks name the states the replay tests read.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(path.join(repoRoot, 'main', 'package.json'));
const pty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');

const realHome = os.homedir();
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const only = option('--only')?.split(',');
const outDir = path.resolve(option('--out') ?? path.join(repoRoot, 'main/src/services/agentStatus/__fixtures__/screens'));
const COLS = 120;
const ROWS = 40;

// ---------------------------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------------------------

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-agent-screens-')));
const home = path.join(root, 'home');
const work = path.join(root, 'repo');
const codexHome = path.join(root, 'codex');
for (const dir of [home, work, codexHome]) fs.mkdirSync(dir, { recursive: true });

function assertIsolated(env) {
  const real = [path.join(realHome, '.pane'), path.join(realHome, '.claude'), path.join(realHome, '.codex')];
  const inReal = entry => real.some(dir => entry === dir || entry.startsWith(`${dir}${path.sep}`));
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && String(value).split(path.delimiter).some(inReal)) {
      throw new Error(`Refusing to run: ${key} points at ${value}, a real agent or Pane folder. Nothing was started.`);
    }
  }
  if (env.HOME === realHome) throw new Error('Refusing to run: HOME is your real home folder. Nothing was started.');
}

function isolatedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PANE_|RUNPANE_|CLAUDE|AGENT_FARM|CODEX_|ANTHROPIC_|OPENAI_)/.test(key)) continue;
    if (/TOKEN|SECRET|API_KEY|PASSWORD|ELECTRON_RUN_AS_NODE|^ZDOTDIR$/i.test(key)) continue;
    env[key] = value;
  }
  // Pane's own bin (runpane) stays out: nothing here may reach your Pane.
  env.PATH = (env.PATH ?? '').split(path.delimiter).filter(entry => !entry.startsWith(path.join(realHome, '.pane'))).join(path.delimiter);
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1',
  });
  assertIsolated(env);
  return env;
}

function prepare() {
  execFileSync('git', ['init', '-q', work]);
  fs.writeFileSync(path.join(work, 'README.md'), '# scratch\n');
  // Claude: onboarding done, this folder trusted, bypass mode accepted; sign-in from the keychain.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, autoUpdates: false,
    projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true });
  fs.symlinkSync(path.join(realHome, 'Library', 'Keychains'), path.join(home, 'Library', 'Keychains'));
  // Codex: a read-only copy of the sign-in, and this folder trusted.
  const auth = path.join(codexHome, 'auth.json');
  fs.copyFileSync(path.join(realHome, '.codex', 'auth.json'), auth);
  fs.chmodSync(auth, 0o400);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'check_for_update_on_startup = false',
    `[projects."${work}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function record(name, agent, command, argv, steps, extraEnv = {}) {
  const env = { ...isolatedEnv(), ...extraEnv };
  assertIsolated(env);
  const version = execFileSync(command, ['--version'], { env, encoding: 'utf8' }).trim();
  console.log(`[${name}] ${version}`);
  const start = Date.now();
  const frames = [];
  const marks = [];
  // Waits read the screen as a terminal shows it, the last 60 lines.
  const screen = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
  const screenText = () => {
    const buffer = screen.buffer.active;
    const lines = [];
    for (let row = Math.max(0, buffer.length - 60); row < buffer.length; row += 1) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  const child = pty.spawn(command, argv, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
  child.onData(data => {
    frames.push({ t: Date.now() - start, data });
    screen.write(data);
  });
  let exited = false;
  child.onExit(() => { exited = true; });
  const mark = label => { marks.push({ t: Date.now() - start, label }); console.log(`[${name}] ${label} @${Date.now() - start}ms`); };
  const waitFor = async (re, timeoutMs, label) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !exited) {
      if (re.test(screenText())) return;
      await sleep(100);
    }
    throw new Error(`[${name}] timed out waiting for ${label ?? re}. The screen was:\n${screenText().split('\n').filter(line => line.trim()).slice(-25).join('\n')}`);
  };
  const type = async (text, delayMs = 60) => { for (const ch of text) { child.write(ch); await sleep(delayMs); } };
  let failed = false;
  try {
    // In each step: wait, markBefore, type, write, mark, then sleep.
    for (const step of steps) {
      if (step.wait) await waitFor(step.wait, step.timeout ?? 60_000, step.label);
      if (step.markBefore) mark(step.markBefore);
      if (step.type) await type(step.type, step.delay);
      if (step.write) child.write(step.write);
      if (step.mark) mark(step.mark);
      if (step.sleep) await sleep(step.sleep);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    mark('end');
    child.kill();
    screen.dispose();
    if (failed) saveFixture(`${name}.failed`, { agent, version, cols: COLS, rows: ROWS, scenario: name, recordedAt: new Date().toISOString(), frames, marks });
  }
  saveFixture(name, { agent, version, cols: COLS, rows: ROWS, scenario: name, recordedAt: new Date().toISOString(), frames, marks });
  console.log(`[${name}] saved ${frames.length} frames`);
}

function saveFixture(name, fixture) {
  fs.mkdirSync(outDir, { recursive: true });
  // The throwaway paths say nothing; keep them out of the fixture.
  const text = JSON.stringify(fixture).split(work).join('/tmp/repo').split(root).join('/tmp/capture');
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${text}\n`);
}


// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const CLAUDE_READY = /❯/;
const CODEX_READY = /›/;
const ENTER = '\r';

// Prompts ask for a reply that never appears in the prompt (the command's output in capitals),
// so a wait never matches the prompt's own echo.
const scenarios = {
  // A turn that thinks, runs a 45 s silent Bash call, replies, then compacts. Claude Code 2.1
  // refuses a foreground `sleep` this long, so the call is a Python sleep standing in for a slow test.
  'claude-long-bash': () => record('claude-long-bash', 'claude', 'claude', ['--dangerously-skip-permissions', '--model', 'haiku'], [
    { wait: CLAUDE_READY, label: 'composer', timeout: 60_000, sleep: 2000 },
    { markBefore: 'idle', type: `Use the Bash tool once, in the foreground, to run exactly: python3 -c "import time; time.sleep(45); print('finished')" (it is a stand-in for a slow test run). Wait for it, then reply with only its output in capital letters.` },
    { sleep: 500 },
    { write: ENTER, mark: 'turn-start' },
    // Claude folds the call into "Running…" / "Ran 1 shell command", so marks inside it go by time.
    { wait: /esc to interrupt/, label: 'the working line', timeout: 60_000, sleep: 8000 },
    { mark: 'bash-start', sleep: 15_000 },
    { mark: 'bash-mid', sleep: 15_000 },
    { mark: 'bash-late' },
    { wait: /⏺ FINISHED|• FINISHED|^\s*FINISHED\s*$/m, label: 'the reply', timeout: 150_000, mark: 'turn-end', sleep: 5000 },
    { markBefore: 'idle-after', type: '/compact', delay: 80 },
    { sleep: 600 },
    { write: ENTER, mark: 'compact-start' },
    { wait: /Compacted|compacted/, label: 'compaction', timeout: 120_000, mark: 'compact-end', sleep: 4000 },
  ]),
  // The permission prompt for a command, left on screen, then dismissed.
  'claude-permission': () => record('claude-permission', 'claude', 'claude', ['--model', 'haiku', '--permission-mode', 'default'], [
    { wait: CLAUDE_READY, label: 'composer', timeout: 60_000, sleep: 2000 },
    { type: 'Use the Bash tool to run: touch made-by-claude.txt. Do nothing else.' },
    { sleep: 500 },
    { write: ENTER, mark: 'turn-start' },
    { wait: /Do you want to proceed/, label: 'the permission prompt', timeout: 90_000, mark: 'permission', sleep: 25_000 },
    { write: '\x1b', mark: 'dismissed', sleep: 5000 },
  ]),
  // A selection menu (/model), and typing into an idle composer.
  'claude-menu-typing': () => record('claude-menu-typing', 'claude', 'claude', ['--model', 'haiku'], [
    { wait: CLAUDE_READY, label: 'composer', timeout: 60_000, sleep: 2000 },
    { markBefore: 'typing', type: 'this is someone typing slowly into an idle prompt box', delay: 180 },
    { mark: 'typed', sleep: 1000 },
    { write: '\x15', sleep: 1000 },
    { type: '/model', delay: 100 },
    { sleep: 500 },
    { write: ENTER },
    { wait: /Select model/, label: 'the model menu', timeout: 20_000, mark: 'menu', sleep: 20_000 },
    { write: '\x1b', mark: 'menu-closed', sleep: 3000 },
  ]),
  // An API retry: the API host does not resolve, so Claude retries and shows its retry line.
  'claude-api-retry': () => record('claude-api-retry', 'claude', 'claude', ['--model', 'haiku'], [
    { wait: CLAUDE_READY, label: 'composer', timeout: 60_000, sleep: 2000 },
    { type: 'Say hi.' },
    { sleep: 500 },
    { write: ENTER, mark: 'turn-start' },
    { wait: /Retrying|retry|attempt \d/i, label: 'the retry line', timeout: 120_000, mark: 'retrying', sleep: 30_000 },
    { write: '\x1b', mark: 'interrupted', sleep: 5000 },
  ], { ANTHROPIC_BASE_URL: 'https://api.anthropic.invalid' }),
  // Codex: a long silent command, then the reply.
  'codex-long-command': () => record('codex-long-command', 'codex', 'codex', ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="low"'], [
    { wait: CODEX_READY, label: 'composer', timeout: 60_000, sleep: 3000 },
    { markBefore: 'idle', type: 'Run exactly this one shell command: sleep 45; echo finished. Then reply with only its output, in capital letters.' },
    { sleep: 500 },
    { write: ENTER, mark: 'turn-start' },
    { wait: /esc to interrupt/i, label: 'the working line', timeout: 60_000, mark: 'working', sleep: 20_000 },
    { mark: 'command-mid', sleep: 15_000 },
    { mark: 'command-late' },
    { wait: /⏺ FINISHED|• FINISHED|^\s*FINISHED\s*$/m, label: 'the reply', timeout: 150_000, mark: 'turn-end', sleep: 5000 },
  ]),
  // Codex asking to approve a command, then typing into its idle composer.
  'codex-approval-typing': () => record('codex-approval-typing', 'codex', 'codex', ['-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort="low"'], [
    { wait: CODEX_READY, label: 'composer', timeout: 60_000, sleep: 3000 },
    { markBefore: 'typing', type: 'someone typing slowly into an idle composer', delay: 180 },
    { mark: 'typed', sleep: 1000 },
    { write: '\x15', sleep: 1000 },
    { type: 'Run the shell command: touch made-by-codex.txt' },
    { sleep: 500 },
    { write: ENTER, mark: 'turn-start' },
    { wait: /Would you like to run|Allow command|approve/i, label: 'the approval', timeout: 120_000, mark: 'approval', sleep: 25_000 },
    { write: '\x1b', mark: 'dismissed', sleep: 5000 },
  ]),
};

prepare();
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    try { await run(); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
