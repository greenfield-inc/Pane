#!/usr/bin/env node
// One stand-in for Pane in an eval run. As `stub.cjs mcp` it serves the variant's real `pane` MCP
// server, whose tools re-run this file (process.argv[1]); as `runpane` on PATH it is the CLI. Every
// call is logged. `--help`, `agent-context` and `docs` come from the variant's real CLI; everything
// else gets the scenario's scripted answer or a valid example of the command's result, so no real
// Pane, card or secret is touched.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const env = process.env;
// The MCP server passes `--flag=value`; the CLI form is `--flag value`. Log and answer one form.
const args = process.argv.slice(2).flatMap((arg) => (/^--[a-z][a-z-]*=/.test(arg) ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg]));
const isHelp = args.includes('--help') || args.includes('-h') || ['agent-context', 'help', 'docs'].includes(args[0]);

if (args[0] === 'mcp') {
  env.EVAL_VIA = 'mcp';
  require(env.EVAL_MCP_BUNDLE).runMcpServer({ toolsets: ['core'] });
} else if (isHelp) {
  log();
  const real = spawnSync(process.execPath, [env.EVAL_CLI_BUNDLE, ...args], { stdio: 'inherit', env });
  process.exit(real.status ?? 1);
} else {
  const nth = log();
  const answer = respond(nth);
  if (answer.run) {
    const real = spawnSync(answer.run[0], answer.run.slice(1), { stdio: 'inherit', env: { ...env, ...answer.env } });
    process.exit(real.status ?? 1);
  }
  process.stdout.write(`${JSON.stringify(answer.body)}\n`);
  process.exit(answer.code ?? 0);
}

/** Appends this call to the run's log; returns how many earlier answered calls had the same command. */
function log() {
  const line = { t: Date.now(), via: env.EVAL_VIA === 'mcp' ? 'mcp' : 'cli', help: isHelp, argv: args };
  fs.appendFileSync(env.EVAL_LOG, `${JSON.stringify(line)}\n`);
  const earlier = fs.readFileSync(env.EVAL_LOG, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
  return earlier.filter((entry) => !entry.help && entry.argv[0] === args[0]).length - 1;
}

/** The scenario's scripted answer, else a valid example of the command's result, else a failure. */
function respond(nth) {
  const script = JSON.parse(fs.readFileSync(env.EVAL_SCRIPT, 'utf8'));
  const examples = JSON.parse(fs.readFileSync(env.EVAL_EXAMPLES, 'utf8'));
  const command = commandName(examples);
  if (args[0] === 'notify') return { body: notify(script.notify ?? [], nth) };
  if (command === 'secrets exec') {
    const rest = args.indexOf('--');
    return { run: args.slice(rest + 1), env: script['secrets exec']?.env ?? {} };
  }
  const scripted = script[command] ?? script[args[0]];
  if (scripted) return { body: scripted };
  if (examples[command]) return { body: examples[command] };
  return { code: 1, body: { ok: false, error: { code: 'ERR_EVAL_NO_ANSWER', message: `runpane ${command} has no scripted answer in this eval.` } } };
}

function notify(replies, nth) {
  if (args.includes('--took')) return { took: args.includes('question') ? 'question' : 'answer', id: 'n-1' };
  const scripted = replies[Math.min(nth, replies.length - 1)];
  if (scripted) return scripted;
  const ui = optionValue('--ui');
  if (ui === 'approve') return { approved: true };
  if (ui === 'info') return { delivered: 'screen' };
  return { answer: firstChoice() };
}

/** The longest command name (one or two words) the arguments start with. */
function commandName(examples) {
  const two = args.slice(0, 2).join(' ');
  return examples[two] || ['secrets exec', 'inbox list'].includes(two) || /^[a-z]/.test(args[1] ?? '') ? two : args[0];
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
