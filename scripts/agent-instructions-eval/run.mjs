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
// The validator the MCP SDK client checks a tool's structuredContent with.
const Ajv = require(require.resolve('ajv', { paths: [path.dirname(require.resolve('@modelcontextprotocol/sdk/package.json', { paths: [path.join(repoRoot, 'packages', 'runpane')] }))] }));

const options = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = options.regrade ? path.resolve(options.regrade) : fs.mkdtempSync(path.join(os.tmpdir(), 'pane-agent-instructions-eval-'));
const resultsDir = path.resolve(options.out ?? path.join(repoRoot, 'tmp', 'agent-instructions-eval', stamp));
fs.mkdirSync(resultsDir, { recursive: true });
const scenarios = SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.id));
// A session that reads these could learn a rule from outside the version under test.
const realHome = os.homedir();
const offLimits = [path.join(realHome, '.claude'), path.join(realHome, '.pane'), path.join(realHome, 'Library', 'Keychains'), path.join(root, 'variants')];
const login = loginMode();

let variants;
let results;
if (options.regrade) {
  // Grades the sessions an earlier run saved, with the current scenarios, at no cost.
  ({ variants, runs: options.runs } = JSON.parse(fs.readFileSync(path.join(root, 'eval.json'), 'utf8')));
  results = scenarios.flatMap((scenario) => {
    const dir = path.join(root, 'runs', scenario.id);
    if (!fs.existsSync(dir)) return [];
    const byRun = Object.groupBy(fs.readdirSync(dir).sort(), (name) => name.replace(/-a\d+$/, ''));
    return Object.entries(byRun).map(([key, attempts]) => {
      const [label, run] = key.split('-');
      const graded = attempts.map((name) => grade(scenario, label, Number(run), path.join(dir, name)));
      return { ...(graded.find((o) => !o.void) ?? graded.at(-1)), voids: graded.filter((o) => o.void).length };
    });
  });
} else {
  variants = [prepareVariant('base', options.base), prepareVariant('head', options.head)];
  fs.writeFileSync(path.join(root, 'eval.json'), JSON.stringify({ variants: variants.map(({ label, ref, commit }) => ({ label, ref, commit })), runs: options.runs }));
  const jobs = scenarios.flatMap((scenario) => variants.flatMap((variant) =>
    Array.from({ length: options.runs }, (_, run) => ({ scenario, variant, run }))));
  console.log(`${jobs.length} sessions (${scenarios.length} scenarios x ${variants.length} versions x ${options.runs} runs), ${options.concurrency} at a time; login: ${login}`);
  results = await pool(jobs, options.concurrency, runJob);
}
report(results);

function parseArgs(argv) {
  const parsed = { base: 'origin/main', head: 'WORKTREE', runs: 5, concurrency: 3, only: undefined, model: undefined, out: undefined, regrade: undefined };
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

/** How sessions log in from their own HOME: a key or token from the environment, or this Mac's keychain. */
function loginMode() {
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
  if (process.platform === 'darwin') return 'your keychain login';
  console.error('Each session runs with its own HOME, which needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN off macOS. Set one and run again.');
  process.exit(2);
}

/** Extracts a ref (or uses the working tree), bundles its runpane CLI and MCP server, renders its texts, and checks the scenario scripts against its result schemas. */
function prepareVariant(label, ref) {
  const dir = path.join(root, 'variants', label);
  fs.mkdirSync(dir, { recursive: true });
  let source = repoRoot;
  if (ref !== 'WORKTREE') {
    source = path.join(dir, 'source');
    fs.mkdirSync(source, { recursive: true });
    const archive = execFileSync('git', ['archive', ref, 'main/src', 'shared', 'packages/runpane/src', 'packages/runpane/scripts', 'contracts', 'docs'], { cwd: repoRoot, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', source], { input: archive });
  }
  const nodePaths = ['node_modules', 'main/node_modules', 'packages/runpane/node_modules'].map((p) => path.join(repoRoot, p));
  const bundle = (entry, outfile) => esbuild.buildSync({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', nodePaths, external: ['electron'], logLevel: 'error' });
  bundle(path.join(source, 'packages/runpane/src/cli.ts'), path.join(dir, 'cli.cjs'));
  bundle(path.join(source, 'packages/runpane/src/mcp.ts'), path.join(dir, 'mcp.cjs'));
  bundle(path.join(source, 'packages/runpane/src/mcpTools.ts'), path.join(dir, 'mcpTools.cjs'));
  // `runpane docs` and the MCP docs resources read this version's docs from beside the bundles.
  execFileSync(process.execPath, [path.join(source, 'packages/runpane/scripts/build-docs-index.js'), path.join(dir, 'docs-index.json')]);
  const renderEntry = path.join(dir, 'render.ts');
  fs.writeFileSync(renderEntry, [
    `import { syncNotifyInstructions } from ${JSON.stringify(path.join(source, 'main/src/services/notify/notifyInstructions'))};`,
    `import { buildPaneHomeSkill } from ${JSON.stringify(path.join(source, 'main/src/services/paneHomeSkill'))};`,
    "import fs from 'fs';",
    'const home = process.argv[2];',
    "fs.mkdirSync(home + '/.claude/skills/pane', { recursive: true });",
    'syncNotifyInstructions(true, { homeSkill: true }, {}, home, process.platform);',
    "fs.writeFileSync(home + '/.claude/skills/pane/SKILL.md', buildPaneHomeSkill());",
  ].join('\n'));
  bundle(renderEntry, path.join(dir, 'render.cjs'));
  const tools = require(path.join(dir, 'mcpTools.cjs')).buildMcpTools();
  fs.writeFileSync(path.join(dir, 'examples.json'), JSON.stringify(examples(tools)));
  checkScripts(tools, label);
  const commit = ref === 'WORKTREE' ? `${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}+worktree` : execFileSync('git', ['rev-parse', '--short', ref], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return { label, ref, commit, dir };
}

function validator(schema) {
  const { $schema: _ignored, ...rest } = schema;
  return new Ajv({ allErrors: true, unknownFormats: 'ignore', schemaId: 'auto' }).compile(rest);
}

/** A minimal valid result for every tool, the stub's answer when a scenario scripts none. */
function examples(tools) {
  const exampleOf = (schema, rootSchema, name) => {
    if (schema.$ref) return exampleOf(schema.$ref.split('/').slice(1).reduce((node, key) => node[key], rootSchema), rootSchema, name);
    if ('const' in schema) return schema.const;
    if (schema.enum) return schema.enum[0];
    const branches = schema.oneOf ?? schema.anyOf;
    if (branches) return exampleOf(branches[0], rootSchema, name);
    const type = [schema.type ?? (schema.properties ? 'object' : 'string')].flat().find((t) => t !== 'null');
    if (type === 'object') return Object.fromEntries((schema.required ?? []).map((key) => [key, exampleOf(schema.properties?.[key] ?? {}, rootSchema, key)]));
    if (type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => exampleOf(schema.items ?? {}, rootSchema, name));
    if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
    if (type === 'boolean') return false;
    return schema.format === 'date-time' ? new Date(0).toISOString() : `eval-${name}`;
  };
  return Object.fromEntries(tools.flatMap((tool) => {
    const example = exampleOf(tool.outputSchema, tool.outputSchema, 'value');
    return validator(tool.outputSchema)(example) ? [[tool.command, example]] : [];
  }));
}

/** Fails before any session when a scripted answer would not pass the MCP tool's output schema. */
function checkScripts(tools, label) {
  const problems = scenarios.flatMap((scenario) => {
    const script = scenario.script({ repo: '/eval/repo', sessionDir: '/eval/session', runDir: '/eval/run', worktree: '/eval/worktree' });
    return Object.entries(script).flatMap(([command, answer]) => {
      const tool = tools.find((candidate) => candidate.command === command);
      if (!tool) return [];
      const validate = validator(tool.outputSchema);
      return [answer].flat().filter((one) => !validate(one))
        .map((one) => `${scenario.id}: ${command} answer ${JSON.stringify(one).slice(0, 120)} fails ${tool.name}'s output schema (${validate.errors?.map((e) => `${e.dataPath} ${e.message}`).join('; ')})`);
    });
  });
  if (problems.length > 0) {
    console.error(`Scripted answers that ${label}'s MCP server would reject:\n${problems.join('\n')}`);
    process.exit(2);
  }
}

/** Runs one scenario run, starting again when a session is void, up to three times the run count. */
async function runJob({ scenario, variant, run }) {
  for (let attempt = 0; attempt < options.runs * 3; attempt += 1) {
    const runDir = path.join(root, 'runs', scenario.id, `${variant.label}-${run}${attempt > 0 ? `-a${attempt}` : ''}`);
    await runSession(scenario, variant, runDir);
    const outcome = grade(scenario, variant.label, run, runDir);
    if (!outcome.void) return { ...outcome, voids: attempt };
  }
  return { scenario: scenario.id, variant: variant.label, run, pass: false, error: true, why: 'every attempt was void', voids: options.runs * 3 };
}

/** Stages one session (repo, HOME with the version's instructions, Pane role, stub) and runs claude -p in it. */
async function runSession(scenario, variant, runDir) {
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
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(scenario.script({ repo, sessionDir, runDir, ...extra })));
  const stub = path.join(here, 'stub.cjs');
  for (const name of ['runpane', 'gh']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${name === 'gh' ? 'gh ' : ''}"$@"\n`, { mode: 0o755 });
  }
  const mcpServers = { pane: { type: 'stdio', command: process.execPath, args: [stub, 'mcp'] } };
  const mcpConfig = path.join(runDir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers }));

  // The session's own HOME holds exactly what Pane installs: the Notify block, the pane skill and the MCP server.
  execFileSync(process.execPath, [path.join(variant.dir, 'render.cjs'), home]);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, mcpServers, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  if (login === 'your keychain login') {
    fs.mkdirSync(path.join(home, 'Library'), { recursive: true });
    fs.symlinkSync(path.join(realHome, 'Library', 'Keychains'), path.join(home, 'Library', 'Keychains'));
  }

  // Your environment minus anything Claude Code or Pane set for this shell, so the session starts clean.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|PANE_|ANTHROPIC_|EVAL_)/.test(name)));
  const env = {
    ...inherited,
    HOME: home, PATH: `${bin}:${process.env.PATH}`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    PANE_DIR: path.join(runDir, 'pane-dir'), PANE_RUNPANE_BIN: path.join(bin, 'runpane'),
    EVAL_LOG: log, EVAL_SCRIPT: path.join(runDir, 'script.json'), EVAL_EXAMPLES: path.join(variant.dir, 'examples.json'),
    EVAL_MCP_BUNDLE: path.join(variant.dir, 'mcp.cjs'), EVAL_CLI_BUNDLE: path.join(variant.dir, 'cli.cjs'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ...roleEnv(scenario.role, sessionDir),
  };
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const claudeArgs = ['-p', scenario.prompt({ repo, sessionDir, runDir, ...extra }), '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcpConfig];
  if (options.model) claudeArgs.push('--model', options.model);
  await runClaude(claudeArgs, repo, env, path.join(runDir, 'transcript.jsonl'));
  return extra;
}

/** Grades one saved session from its transcript and call log; a session that read outside its version is void. */
function grade(scenario, label, run, runDir) {
  const observed = observe(fs.readFileSync(path.join(runDir, 'transcript.jsonl'), 'utf8'), path.join(runDir, 'calls.jsonl'), runDir);
  let graded;
  if (observed.error) graded = { pass: false, error: true, why: `session error: ${observed.text.slice(0, 120)}` };
  else if (observed.reachedOut.length > 0) graded = { pass: false, void: true, why: `void: read ${observed.reachedOut[0]}` };
  else graded = scenario.grade(observed);
  const outcome = { scenario: scenario.id, variant: label, run, ...graded, cost: observed.cost, seconds: observed.seconds, model: observed.model, runDir };
  console.log(`${outcome.void ? 'VOID' : outcome.pass ? 'PASS' : 'FAIL'} ${scenario.id} ${label}#${run}: ${outcome.why}`);
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
    child.on('close', () => { clearTimeout(timer); out.end(resolve); });
  });
}

/** What the agent did: its runpane calls (CLI and MCP), tool uses, Bash commands, written files, system-temp paths and reads outside its version. */
function observe(transcript, log, runDir) {
  const events = transcript.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use'));
  const bash = tools.filter((t) => t.name === 'Bash').map((t) => t.input.command ?? '');
  const writes = tools.filter((t) => ['Write', 'Edit', 'NotebookEdit'].includes(t.name)).map((t) => t.input.file_path ?? t.input.notebook_path ?? '');
  const touched = tools.map((t) => JSON.stringify(t.input ?? {}));
  const result = events.find((e) => e.type === 'result') ?? {};
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const normalize = (p) => p.replace(/^\/private/, '');
  // Claude Code keeps its own background-task output under /tmp/claude-<uid>/; reading it is not the agent's scratch.
  const allowed = [normalize(runDir), normalize(root), `/tmp/claude-${process.getuid()}/`];
  // An absolute path into system temp with a name in it; `$R/tmp/x`, `$(pwd)/tmp`, `~/tmp` and an `--exclude '/tmp/'` pattern are not.
  const tempPaths = [...bash, ...writes].flatMap((text) => [
    ...[...text.matchAll(/(?<![\w.$}/)~-])(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"`;|&)}]+/g)].map((m) => m[0]).filter((p) => !allowed.some((dir) => normalize(p).startsWith(dir))),
    ...[...text.matchAll(/\$\{?TMPDIR\}?|\bmktemp\b|tempfile\.|os\.tmpdir\(\)/g)].map((m) => m[0]),
  ]);
  const reachedOut = offLimits.filter((dir) => touched.some((text) => normalize(text).includes(normalize(dir))));
  return { calls, tools, bash, writes, tempPaths, reachedOut, text: result.result ?? '', cost: result.total_cost_usd ?? 0, seconds: Math.round((result.duration_ms ?? 0) / 1000), model: init.model, error: result.is_error === true || !result.type };
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
  const voids = outcomes.reduce((sum, o) => sum + (o.voids ?? 0), 0);
  const verdict = errors.length === 0 && rows.every((row) => row.ok);
  const md = [
    `Base ${variants[0].ref} (${variants[0].commit}) vs head ${variants[1].ref === 'WORKTREE' ? 'working tree' : variants[1].ref} (${variants[1].commit}); ${options.runs} clean runs each; model ${models.join(', ') || 'default'}; each session in its own HOME; ${voids} void session(s) rerun (${((100 * voids) / (outcomes.length + voids)).toFixed(1)}% of ${outcomes.length + voids}); cost of graded sessions $${cost.toFixed(2)}.`,
    '',
    '| Scenario | Base passes | Head passes | Head ≥ base | Why runs failed |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.title} | ${r.base}/${r.runs} | ${r.head}/${r.runs} | ${r.ok ? 'yes' : '**no**'} | ${[...r.baseFails.map((w) => `base: ${w}`), ...r.headFails.map((w) => `head: ${w}`)].join('; ')} |`),
    '',
    errors.length > 0
      ? `Verdict: none. ${errors.length} session(s) errored (${errors[0].why}); fix that and run again.`
      : `Verdict: ${verdict ? 'head does at least as well as base in every scenario' : 'head does worse than base in at least one scenario'}.`,
  ].join('\n');
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify({ variants: variants.map(({ label, ref, commit }) => ({ label, ref, commit })), rows, outcomes, cost, voids }, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'results.md'), `${md}\n`);
  console.log(`\n${md}\n\nResults: ${resultsDir}\nRun folders (transcripts, call logs): ${path.join(root, 'runs')}`);
  process.exitCode = verdict ? 0 : 1;
}
