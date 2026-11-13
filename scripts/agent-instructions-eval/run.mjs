#!/usr/bin/env node
// Runs real Claude Code sessions under two versions of the instructions Pane gives agents (the
// user-level Notify block, the `pane` MCP server and its tools, the `pane` skill) and compares what
// the agents do. See scripts/README.md for usage and cost, and scenarios.mjs for what each checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(repoRoot, 'node_modules', 'esbuild'));

const options = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = options.regrade ? path.resolve(options.regrade) : fs.mkdtempSync(path.join(os.tmpdir(), 'pane-agent-instructions-eval-'));
const resultsDir = path.resolve(options.out ?? path.join(repoRoot, 'tmp', 'agent-instructions-eval', stamp));
fs.mkdirSync(resultsDir, { recursive: true });
const isolatedLogin = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const scenarios = SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.id));

let variants;
let results;
if (options.regrade) {
  // Grades the sessions an earlier run saved, with the current scenarios, at no cost.
  ({ variants, isolated: options.isolated, runs: options.runs } = JSON.parse(fs.readFileSync(path.join(root, 'eval.json'), 'utf8')));
  results = scenarios.flatMap((scenario) => fs.readdirSync(path.join(root, 'runs', scenario.id)).map((name) => {
    const [label, run] = name.split('-');
    return grade(scenario, label, Number(run), path.join(root, 'runs', scenario.id, name));
  }));
} else {
  variants = [prepareVariant('base', options.base), prepareVariant('head', options.head)];
  options.isolated = isolatedLogin;
  fs.writeFileSync(path.join(root, 'eval.json'), JSON.stringify({ variants: variants.map(({ label, ref, commit }) => ({ label, ref, commit })), isolated: isolatedLogin, runs: options.runs }));
  const jobs = scenarios.flatMap((scenario) => variants.flatMap((variant) =>
    Array.from({ length: options.runs }, (_, run) => ({ scenario, variant, run }))));
  console.log(`${jobs.length} sessions (${scenarios.length} scenarios x ${variants.length} variants x ${options.runs} runs), ${options.concurrency} at a time; login: ${isolatedLogin ? 'isolated HOME' : 'your Claude Code login, user settings off'}`);
  results = await pool(jobs, options.concurrency, runJob);
}
report(results);

function parseArgs(argv) {
  const parsed = { base: 'origin/main', head: 'WORKTREE', runs: 3, concurrency: 3, only: undefined, model: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--base') parsed.base = value;
    else if (flag === '--head') parsed.head = value;
    else if (flag === '--runs') parsed.runs = Number(value);
    else if (flag === '--concurrency') parsed.concurrency = Number(value);
    else if (flag === '--only') parsed.only = value.split(',');
    else if (flag === '--model') parsed.model = value;
    else if (flag === '--out') parsed.out = value;
    else if (flag === '--regrade') parsed.regrade = value;
    else { console.error(`Unknown option ${flag}. See the agent-instructions-eval section of scripts/README.md.`); process.exit(2); }
    i += 1;
  }
  return parsed;
}

/** Extracts a ref (or uses the working tree), bundles its runpane CLI and MCP server, and renders its instruction texts. */
function prepareVariant(label, ref) {
  const dir = path.join(root, 'variants', label);
  let source = repoRoot;
  if (ref !== 'WORKTREE') {
    source = path.join(dir, 'source');
    fs.mkdirSync(source, { recursive: true });
    const archive = execFileSync('git', ['archive', ref, 'main/src', 'shared', 'packages/runpane/src', 'contracts'], { cwd: repoRoot, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', source], { input: archive });
  }
  const nodePaths = ['node_modules', 'main/node_modules', 'packages/runpane/node_modules'].map((p) => path.join(repoRoot, p));
  const bundle = (entry, outfile) => esbuild.buildSync({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', nodePaths, external: ['electron'], logLevel: 'error' });
  bundle(path.join(source, 'packages/runpane/src/cli.ts'), path.join(dir, 'cli.cjs'));
  bundle(path.join(source, 'packages/runpane/src/mcp.ts'), path.join(dir, 'mcp.cjs'));
  const renderEntry = path.join(dir, 'render.ts');
  fs.writeFileSync(renderEntry, [
    `import { syncNotifyInstructions } from ${JSON.stringify(path.join(source, 'main/src/services/notify/notifyInstructions'))};`,
    `import { buildPaneHomeSkill } from ${JSON.stringify(path.join(source, 'main/src/services/paneHomeSkill'))};`,
    `import { RUNPANE_CONTRACT } from ${JSON.stringify(path.join(source, 'shared/types/generatedRunpaneContract'))};`,
    "import fs from 'fs';",
    'const home = process.argv[2];',
    "fs.mkdirSync(home + '/.claude', { recursive: true });",
    'syncNotifyInstructions(true, { homeSkill: true }, {}, home, process.platform);',
    "process.stdout.write(JSON.stringify({ block: fs.readFileSync(home + '/.claude/CLAUDE.md', 'utf8'), skill: buildPaneHomeSkill(), managedBlock: RUNPANE_CONTRACT.agentContext.managedBlock }));",
  ].join('\n'));
  bundle(renderEntry, path.join(dir, 'render.cjs'));
  const texts = JSON.parse(execFileSync(process.execPath, [path.join(dir, 'render.cjs'), path.join(dir, 'render-home')], { encoding: 'utf8' }));
  const commit = ref === 'WORKTREE' ? `${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}+worktree` : execFileSync('git', ['rev-parse', '--short', ref], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return { label, ref, commit, dir, ...texts };
}

/** Stages one session (repo, Pane role, stub, instructions), runs claude -p and grades it. */
async function runJob({ scenario, variant, run }) {
  const runDir = path.join(root, 'runs', scenario.id, `${variant.label}-${run}`);
  const repo = path.join(runDir, 'repo');
  const sessionDir = path.join(runDir, 'session');
  const home = path.join(runDir, 'home');
  const bin = path.join(runDir, 'bin');
  for (const dir of [repo, sessionDir, home, bin, path.join(runDir, 'pane-dir')]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const extra = scenario.setup({ repo, sessionDir, runDir }) ?? {};
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=eval@example.com', '-c', 'user.name=eval', 'commit', '-qm', 'start', '--allow-empty'], { cwd: repo });

  const log = path.join(runDir, 'calls.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(scenario.script({ repo, sessionDir, ...extra })));
  const stub = path.join(here, 'stub.cjs');
  for (const name of ['runpane', 'gh']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${name === 'gh' ? 'gh ' : ''}"$@"\n`, { mode: 0o755 });
  }
  const mcpConfig = path.join(runDir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pane: { type: 'stdio', command: process.execPath, args: [stub, 'mcp'] } } }));

  // Your environment minus anything Claude Code or Pane set for this shell, so the session starts clean.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|PANE_|ANTHROPIC_|EVAL_)/.test(name)));
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH}`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    HOME: isolatedLogin ? home : process.env.HOME,
    PANE_DIR: path.join(runDir, 'pane-dir'), PANE_RUNPANE_BIN: path.join(bin, 'runpane'),
    EVAL_LOG: log, EVAL_SCRIPT: path.join(runDir, 'script.json'),
    EVAL_MCP_BUNDLE: path.join(variant.dir, 'mcp.cjs'), EVAL_CLI_BUNDLE: path.join(variant.dir, 'cli.cjs'),
    ...roleEnv(scenario.role, sessionDir),
  };
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Nothing of the run is kept in your Claude Code config: no saved session, no auto memory.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  const claudeArgs = ['-p', scenario.prompt({ repo, sessionDir, runDir, ...extra }), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence'];
  if (options.model) claudeArgs.push('--model', options.model);
  if (isolatedLogin) {
    // The agent sees exactly what Pane installs for the user: the Notify block, the pane skill and the MCP server.
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'pane'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), variant.block);
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'pane', 'SKILL.md'), variant.skill);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, mcpServers: JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  } else {
    // Your login, but none of your user settings, memory, skills, hooks or MCP servers: the Notify block
    // stands in as a local memory file and the pane skill is left out for both variants.
    fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), variant.block);
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'CLAUDE.local.md\n');
    claudeArgs.push('--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', mcpConfig, '--disable-slash-commands');
  }

  await runClaude(claudeArgs, repo, env, path.join(runDir, 'transcript.jsonl'));
  return grade(scenario, variant.label, run, runDir);
}

/** Grades one saved session from its transcript and call log. */
function grade(scenario, label, run, runDir) {
  const observed = observe(fs.readFileSync(path.join(runDir, 'transcript.jsonl'), 'utf8'), path.join(runDir, 'calls.jsonl'), [runDir, root]);
  const graded = observed.error ? { pass: false, error: true, why: `session error: ${observed.text.slice(0, 120)}` } : scenario.grade(observed);
  const outcome = { scenario: scenario.id, variant: label, run, ...graded, cost: observed.cost, seconds: observed.seconds, model: observed.model, runDir };
  console.log(`${outcome.pass ? 'PASS' : 'FAIL'} ${scenario.id} ${label}#${run}: ${outcome.why}`);
  return outcome;
}

function roleEnv(role, sessionDir) {
  if (role === 'worker') return { PANE_SESSION_ID: 'p-worker', PANE_PANEL_ID: 'pl-worker', PANE_SESSION_DIR: sessionDir };
  if (role === 'orchestrator') return { PANE_SESSION_ID: 'p-orch', PANE_PANEL_ID: 'pl-orch', PANE_SESSION_DIR: sessionDir, PANE_ORCHESTRATION_SESSION_ID: 's-eval' };
  if (role === 'pane') return { PANE_SESSION_ID: 'p-feature', PANE_PANEL_ID: 'pl-feature' };
  return {};
}

function runClaude(args, cwd, env, transcriptFile) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(transcriptFile);
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 6 * 60 * 1000);
    child.stdout.pipe(out);
    child.on('close', () => { clearTimeout(timer); out.end(() => resolve(fs.readFileSync(transcriptFile, 'utf8'))); });
  });
}

/** What the agent did: its runpane calls (CLI and MCP), tool uses, Bash commands, written files and system-temp paths. */
function observe(transcript, log, allowedRoots) {
  const events = transcript.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use'));
  const bash = tools.filter((t) => t.name === 'Bash').map((t) => t.input.command ?? '');
  const writes = tools.filter((t) => ['Write', 'Edit', 'NotebookEdit'].includes(t.name)).map((t) => t.input.file_path ?? t.input.notebook_path ?? '');
  const result = events.find((e) => e.type === 'result') ?? {};
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const normalize = (p) => p.replace(/^\/private/, '');
  // Claude Code keeps its own background-task output under /tmp/claude-<uid>/; reading it is not the agent's scratch.
  const allowed = [...allowedRoots.map(normalize), `/tmp/claude-${process.getuid()}/`];
  // An absolute path into system temp with a name in it; `$R/tmp/x` and an `--exclude '/tmp/'` pattern are not.
  const tempPaths = [...bash, ...writes].flatMap((text) => [
    ...[...text.matchAll(/(?<![\w.$}/-])(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"`;|&)}]+/g)].map((m) => m[0]).filter((p) => !allowed.some((dir) => normalize(p).startsWith(dir))),
    ...[...text.matchAll(/\$\{?TMPDIR\}?|\bmktemp\b|tempfile\.|os\.tmpdir\(\)/g)].map((m) => m[0]),
  ]);
  return { calls, tools, bash, writes, tempPaths, text: result.result ?? '', cost: result.total_cost_usd ?? 0, seconds: Math.round((result.duration_ms ?? 0) / 1000), model: init.model, error: result.is_error === true || !result.type };
}

async function pool(items, size, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      results.push(await worker(item));
    }
  }));
  return results;
}

/** Per scenario, head must pass at least as often as base. Writes results.json and results.md. */
function report(outcomes) {
  const rows = scenarios.map((scenario) => {
    const count = (label) => outcomes.filter((o) => o.scenario === scenario.id && o.variant === label);
    const [base, head] = [count('base'), count('head')];
    const passes = (list) => list.filter((o) => o.pass).length;
    const fails = (list) => [...new Set(list.filter((o) => !o.pass).map((o) => o.why))];
    return { id: scenario.id, title: scenario.title, base: passes(base), head: passes(head), runs: options.runs, ok: passes(head) >= passes(base), baseFails: fails(base), headFails: fails(head) };
  });
  const cost = outcomes.reduce((sum, o) => sum + (o.cost ?? 0), 0);
  const models = [...new Set(outcomes.map((o) => o.model).filter(Boolean))];
  const errors = outcomes.filter((o) => o.error);
  const verdict = errors.length === 0 && rows.every((row) => row.ok);
  const md = [
    `Base ${variants[0].ref} (${variants[0].commit}) vs head ${variants[1].ref === 'WORKTREE' ? 'working tree' : variants[1].ref} (${variants[1].commit}); ${options.runs} runs each; model ${models.join(', ') || 'default'}; login ${options.isolated ? 'isolated HOME' : 'yours, user settings and skills off'}; session cost $${cost.toFixed(2)}.`,
    '',
    '| Scenario | Base passes | Head passes | Head ≥ base | Why runs failed |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.title} | ${r.base}/${r.runs} | ${r.head}/${r.runs} | ${r.ok ? 'yes' : '**no**'} | ${[...r.baseFails.map((w) => `base: ${w}`), ...r.headFails.map((w) => `head: ${w}`)].join('; ') || '' } |`),
    '',
    errors.length > 0
      ? `Verdict: none. ${errors.length} session(s) errored (${errors[0].why}); fix that and run again.`
      : `Verdict: ${verdict ? 'head does at least as well as base in every scenario' : 'head does worse than base in at least one scenario'}.`,
  ].join('\n');
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify({ variants: variants.map(({ label, ref, commit }) => ({ label, ref, commit })), rows, outcomes, cost }, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'results.md'), `${md}\n`);
  console.log(`\n${md}\n\nResults: ${resultsDir}\nRun folders (transcripts, call logs): ${path.join(root, 'runs')}`);
  process.exitCode = verdict ? 0 : 1;
}
