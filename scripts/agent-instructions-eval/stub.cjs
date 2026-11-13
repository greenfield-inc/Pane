#!/usr/bin/env node
// One stand-in for Pane in an eval run. As `stub.cjs mcp` it serves the variant's real `pane` MCP
// server, whose tools re-run this file (process.argv[1]); as `runpane` on PATH it is the CLI. Every
// call is logged, `--help` and `agent-context` come from the variant's real CLI, and everything else
// gets the scenario's scripted answer, so no real Pane, card or secret is touched.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const env = process.env;
const args = process.argv.slice(2);

if (args[0] === 'mcp') {
  env.EVAL_VIA = 'mcp';
  require(env.EVAL_MCP_BUNDLE).runMcpServer({ toolsets: ['core'] });
} else if (args.includes('--help') || args.includes('-h') || args[0] === 'agent-context' || args[0] === 'help') {
  log();
  const real = spawnSync(process.execPath, [env.EVAL_CLI_BUNDLE, ...args], { stdio: 'inherit', env });
  process.exit(real.status ?? 1);
} else {
  const count = log();
  const answer = respond(count);
  process.stdout.write(`${JSON.stringify(answer.body ?? answer)}\n`);
  process.exit(answer.code ?? 0);
}

/** Appends this call to the run's log and returns how many earlier calls had the same command. */
function log() {
  const line = { t: Date.now(), via: env.EVAL_VIA === 'mcp' ? 'mcp' : 'cli', argv: args };
  fs.appendFileSync(env.EVAL_LOG, `${JSON.stringify(line)}\n`);
  const earlier = fs.readFileSync(env.EVAL_LOG, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
  return earlier.filter((entry) => entry.argv[0] === args[0]).length - 1;
}

/** The scenario's scripted answer for this call; `nth` counts earlier calls of the same command. */
function respond(nth) {
  const script = JSON.parse(fs.readFileSync(env.EVAL_SCRIPT, 'utf8'));
  const command = args.slice(0, 2).join(' ');
  const flag = (name) => args.includes(name);
  if (args[0] === 'notify') {
    if (flag('--took')) return { took: args.includes('question') ? 'question' : 'answer', id: 'n-1' };
    const replies = script.notify ?? [];
    const scripted = replies[Math.min(nth, replies.length - 1)];
    if (scripted) return scripted;
    const ui = optionValue('--ui');
    if (ui === 'approve') return { approved: true };
    if (ui === 'info') return { delivered: 'screen' };
    return { answer: firstChoice() };
  }
  if (script[command]) return script[command];
  if (script[args[0]]) return script[args[0]];
  if (args[0] === 'panes' && args[1] === 'create') return { ok: true, paneId: 'p-new', panelId: 'pl-new', link: 'pane://pane/p-new' };
  if (args[0] === 'panels' && args[1] === 'create') return { ok: true, panelId: 'pl-tab', paneId: optionValue('--pane') ?? 'p-new' };
  if (args[0] === 'agents' && args[1] === 'start') return { ok: true, paneId: optionValue('--pane') ?? 'p-new', panelId: 'pl-agent', link: 'pane://pane/p-new' };
  if (args[0] === 'sessions' && args[1] === 'create') return { ok: true, sessionId: 's-new', name: optionValue('--name') ?? 'session', sessionDir: path.join(path.dirname(env.EVAL_LOG), 'session-new') };
  if (args[0] === 'docs') return { results: [] };
  return { ok: true };
}

function optionValue(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function firstChoice() {
  try {
    const choices = JSON.parse(optionValue('--choices') ?? '[]');
    return choices.find((choice) => choice.recommended)?.label ?? choices[0]?.label ?? 'yes';
  } catch {
    return 'yes';
  }
}
