import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ParsedArgs, RunpaneAgent } from './commands';
import { invokeDaemon, invokeRemoteDaemon, resolvePaneDirectory, type RemoteDaemonTarget } from './daemonClient';
import { RunpaneError } from './errors';
import { RUNPANE_CONTRACT } from './generated/contract';
import { paneListResultSchema, repoListResultSchema } from './localControl';
import { quote } from './handoff';
import { readMachines, resolveMachine, workspaceTarget } from './workspace';

/**
 * `runpane ask` runs one read-only agent turn headless and prints its answer; `runpane models`
 * lists each installed agent's models. Both run the agent's own CLI, on this machine or another
 * one through `runpane:machine:exec`, and read what it prints. Nothing is stored or left open.
 */

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;
/** The longest run `runpane:machine:exec` allows. */
const MAX_REMOTE_TIMEOUT_MS = 9 * 60_000;
const LIST_TIMEOUT_MS = 60_000;
/** Windows caps a command line at 32,767 characters. */
const WINDOWS_PROMPT_LIMIT = 30_000;

type AgentEntry = {
  title: string;
  label: string;
  executables: readonly string[];
  install: { command: string };
  signIn?: readonly string[];
  models?: {
    flag: string;
    aliases?: readonly string[];
    list?: { args: readonly string[]; format: string };
    status?: { args: readonly string[]; format: string };
  };
  ask?: { args: readonly string[]; env?: Readonly<Record<string, string>>; output: string };
};

function agentEntry(agent: RunpaneAgent): AgentEntry {
  return RUNPANE_CONTRACT.agents.entries[agent];
}

const AGENTS: readonly RunpaneAgent[] = RUNPANE_CONTRACT.enums.agents;

// ---------------------------------------------------------------- where a command runs

/** One place a command runs: a machine, natively or in its WSL. */
interface Place {
  machine: string;
  environment: 'native' | 'wsl';
  /** Absent for this machine. */
  remote?: RemoteDaemonTarget;
  /** The remote machine's exec shell, for quoting, and its OS. */
  shell?: string;
  windows?: boolean;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The executable was not found. */
  missing: boolean;
}

const execResultSchema = boundary.object({
  exitCode: boundary.nullable(boundary.number),
  stdout: boundary.string,
  stderr: boundary.string,
  shell: boundary.string,
  timedOut: boundary.optional(boundary.boolean),
});

const NOT_FOUND = /command not found|is not recognized as the name of|No such file or directory|not found in PATH|cannot find the path/i;

async function run(place: Place, argv: string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number }): Promise<RunResult> {
  if (!place.remote) return runHere(argv, options);
  const shell = place.shell ?? 'bash';
  if (place.environment === 'wsl') return runInWsl(place, argv, options);
  const powershell = /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell);
  // Git Bash on Windows rewrites arguments that look like POSIX paths; WSL and the agents need them as given.
  const vars = Object.entries({ ...options.env, ...(place.windows && !powershell ? { MSYS_NO_PATHCONV: '1' } : {}) });
  const command = [
    ...(powershell ? vars.map(([key, value]) => `$env:${key} = ${quote(value, shell)};`) : vars.length ? ['env', ...vars.map(([key, value]) => quote(`${key}=${value}`, shell))] : []),
    // Windows PowerShell 5 passes a double quote inside an argument through unescaped; a backslash keeps it.
    ...argv.map(arg => quote(/^powershell(?:\.exe)?$/i.test(path.basename(shell.replace(/\\/g, '/'))) ? arg.replace(/(\\*)"/g, '$1$1\\"') : arg, shell)),
  ].join(' ');
  const result = decodeBoundary(await invokeRemoteDaemon(place.remote, 'runpane:machine:exec', [{ command, cwd: options.cwd, timeoutMs: options.timeoutMs }], execResultSchema, options.timeoutMs + 30_000), execResultSchema);
  return { ...result, timedOut: result.timedOut === true, missing: result.exitCode !== 0 && (result.exitCode === 127 || NOT_FOUND.test(result.stderr.split('\n').slice(0, 3).join(' '))) };
}

/** WSL on a Windows machine: the command goes in a script its own bash runs, so only bash quotes it. */
async function runInWsl(place: Place, argv: string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number }): Promise<RunResult> {
  const remote = place.remote;
  if (!remote) throw new Error('WSL runs on a Windows machine');
  const sh = (value: string) => quote(value, 'bash');
  const script = [
    'trap \'rm -f "$0"\' EXIT',
    options.cwd ? `cd ${sh(options.cwd)} || exit 1` : '',
    `command -v ${sh(argv[0])} >/dev/null || { echo "${argv[0]}: command not found" >&2; exit 127; }`,
    [...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${sh(value)}`), ...argv.map(sh)].join(' '),
  ].filter(Boolean).join('\n') + '\n';
  const written = decodeBoundary(await invokeRemoteDaemon(remote, 'runpane:machine:write', [{ path: `~/.pane/ask/${randomUUID()}.sh`, content: script, encoding: 'utf8' }], boundary.object({ path: boundary.string })), boundary.object({ path: boundary.string }));
  const linuxPath = written.path.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
  return run({ ...place, environment: 'native' }, ['wsl.exe', '-e', 'bash', '-l', linuxPath], { timeoutMs: options.timeoutMs });
}

function runHere(argv: string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout stops everything the agent started.
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + error.message, timedOut, missing: error.code === 'ENOENT' });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, missing: process.platform === 'win32' && exitCode !== 0 && NOT_FOUND.test(stderr) });
    });
  });
}

const machineInfoSchema = boundary.object({ shell: boundary.string, os: boundary.string });

/** This machine, or the named one as a Place, ready to run commands. */
async function placeFor(machineName: string | undefined, paneDir: string | undefined, environment: Place['environment'] = 'native'): Promise<Place> {
  const here: Place = { machine: thisMachineName(), environment };
  if (!machineName) return here;
  const tailnet = await readMachines(paneDir);
  if (!tailnet.ok) throw new RunpaneError('ERR_ASK_MACHINE', `Can't reach ${machineName}: ${tailnet.reason}.`, tailnet.fix);
  const machine = resolveMachine(machineName, [tailnet.self, ...tailnet.machines]);
  if (machine.self) return here;
  const remote = workspaceTarget(machine);
  const probe = decodeBoundary(await invokeRemoteDaemon(remote, 'runpane:machine:info', [], machineInfoSchema, 20_000), machineInfoSchema);
  return { machine: machine.name, environment, remote, shell: probe.shell, windows: probe.os === 'Windows' };
}

function thisMachineName(): string {
  return os.hostname().replace(/\.local$/i, '').toLowerCase();
}

/** Where `--repo` or `--pane` points on the place's machine, and whether that repository is in WSL. */
async function resolveWorkingDirectory(place: Place, parsed: ParsedArgs): Promise<{ cwd?: string; environment: Place['environment'] }> {
  const remote = place.remote;
  if (parsed.paneId) {
    const listed = remote
      ? await invokeRemoteDaemon(remote, 'runpane:panes:list', [{}], paneListResultSchema, 20_000)
      : await invokeDaemon('runpane:panes:list', [{}], paneListResultSchema, { paneDir: parsed.paneDir, timeoutMs: 20_000 });
    const pane = listed.panes.find(item => item.id === parsed.paneId || item.paneId === parsed.paneId);
    if (!pane) throw new RunpaneError('ERR_ASK_PANE_NOT_FOUND', `${place.machine} has no Pane ${parsed.paneId}.`, `List its Panes with: runpane${place.remote ? ` workspace ${place.machine}` : ''} panes list --json`);
    return { cwd: pane.worktreePath, environment: isWslPath(pane.worktreePath) ? 'wsl' : 'native' };
  }
  if (parsed.repo === undefined) return { environment: 'native' };
  const selector = String(parsed.repo);
  const listed = remote
    ? await invokeRemoteDaemon(remote, 'runpane:repos:list', [], repoListResultSchema, 20_000)
    : await invokeDaemon('runpane:repos:list', [], repoListResultSchema, { paneDir: parsed.paneDir, timeoutMs: 20_000 });
  const repo = listed.repos.find(item => String(item.id) === selector || item.name === selector || item.path === selector);
  if (!repo) throw new RunpaneError('ERR_ASK_REPO_NOT_FOUND', `${place.machine} has no saved repository "${selector}".`, `Its repositories: ${listed.repos.map(item => item.name).join(', ') || 'none'}.`);
  return { cwd: repo.path, environment: repo.environment?.toLowerCase() === 'wsl' ? 'wsl' : 'native' };
}

function isWslPath(value: string): boolean {
  return value.startsWith('/') || /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i.test(value);
}

function describePlace(place: Place): string {
  return place.environment === 'wsl' ? `${place.machine} (WSL)` : place.machine;
}

// ---------------------------------------------------------------- reading an answer

export interface Answer {
  answer?: string;
  error?: string;
  costUsd?: number;
}

/** The final answer, the CLI's own error, and the cost it reports, from what one headless run printed. */
export function extractAnswer(output: string, stdout: string): Answer {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'));
  const events = lines.flatMap(line => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [record(value)] : [];
    } catch {
      return [];
    }
  });
  if (output === 'result-json') {
    const result = findLast(events, event => event.type === 'result') ?? events.at(-1);
    if (!result) return {};
    const text = typeof result.result === 'string' ? result.result : undefined;
    const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
    return result.is_error === true ? { error: text || String(result.subtype ?? 'error'), costUsd: cost } : { answer: text, costUsd: cost };
  }
  if (output === 'codex-jsonl') {
    const message = findLast(events, event => event.type === 'item.completed' && record(event.item).type === 'agent_message');
    if (message) return { answer: String(record(message.item).text ?? '') };
    const failure = findLast(events, event => event.type === 'turn.failed' || event.type === 'error');
    return failure ? { error: String(record(failure.error).message ?? failure.message ?? 'Codex failed') } : {};
  }
  if (output === 'opencode-jsonl') {
    const failure = findLast(events, event => event.type === 'error');
    let lastStep = 0;
    events.forEach((event, index) => { if (event.type === 'step_start') lastStep = index; });
    const text = events.slice(lastStep).filter(event => event.type === 'text').map(event => String(record(event.part).text ?? '')).join('').trim();
    const cost = events.filter(event => event.type === 'step_finish').reduce((sum, event) => sum + (Number(record(event.part).cost) || 0), 0);
    if (text) return { answer: text, costUsd: cost || undefined };
    if (failure) {
      const error = record(failure.error);
      return { error: String(record(error.data).message ?? error.name ?? 'OpenCode failed') };
    }
    return {};
  }
  return {};
}

function findLast<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (matches(items[index])) return items[index];
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

// ---------------------------------------------------------------- runpane ask

export interface AskResult {
  ok: true;
  answer: string;
  agent: RunpaneAgent;
  model?: string;
  machine: string;
  environment: Place['environment'];
  durationMs: number;
  costUsd?: number;
}

export async function runAsk(parsed: ParsedArgs): Promise<number> {
  const agent = parsed.agent;
  if (!agent) throw new RunpaneError('ERR_ASK_AGENT_REQUIRED', 'runpane ask needs --agent.', `Pick one with ${AGENTS.filter(id => agentEntry(id).ask).map(id => `--agent ${id}`).join(', ')}.`);
  const entry = agentEntry(agent);
  if (!entry.ask) {
    throw new RunpaneError('ERR_ASK_UNSUPPORTED', `${entry.label} can't answer runpane ask: Pane has no read-only headless mode for it that refuses both edits and shell commands.`,
      `Ask ${AGENTS.filter(id => agentEntry(id).ask).map(id => agentEntry(id).label).join(', ')} instead, or give ${entry.label} a tab with runpane panes create.`);
  }
  const prompt = parsed.initialInputFile !== undefined
    ? (parsed.initialInputFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(parsed.initialInputFile, 'utf8'))
    : parsed.initialInput;
  if (!prompt?.trim()) throw new RunpaneError('ERR_ASK_PROMPT_REQUIRED', 'runpane ask needs a question: --prompt "<text>" or --prompt-file <path|->.', 'Add one and run it again.');
  const model = parsed.handoffModel;
  const started = Date.now();
  const base = await placeFor(parsed.handoffMachine, parsed.paneDir);
  const { cwd, environment } = await resolveWorkingDirectory(base, parsed);
  const place = { ...base, environment: base.remote ? environment : 'native' as const };
  if (place.remote && place.environment === 'native' && /(?:powershell|pwsh)/i.test(place.shell ?? '') && prompt.length > WINDOWS_PROMPT_LIMIT) {
    throw new RunpaneError('ERR_ASK_PROMPT_TOO_LONG', `The question is ${prompt.length} characters; a Windows command line holds about ${WINDOWS_PROMPT_LIMIT}.`, 'Shorten it, or ask from its WSL repository with --repo.');
  }
  const requested = parsed.waitTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const timeoutMs = place.remote ? Math.min(requested, MAX_REMOTE_TIMEOUT_MS) : requested;
  const executable = entry.executables[0];
  const argv = [executable, ...entry.ask.args, ...(model && entry.models ? [entry.models.flag, model] : []), prompt];
  const result = await run(place, argv, { cwd, env: entry.ask.env, timeoutMs });
  const where = describePlace(place);
  if (result.missing) {
    throw new RunpaneError('ERR_ASK_AGENT_MISSING', `${entry.label} is not installed on ${where}, so it could not answer (${result.stderr.trim().split('\n')[0]}).`, `Install it there: ${entry.install.command}`);
  }
  if (result.timedOut) {
    throw new RunpaneError('ERR_ASK_TIMEOUT', `${entry.label} on ${where} had not answered after ${Math.round(timeoutMs / 1000)} s, so the run and every process it started were stopped.`, 'Ask a narrower question, or raise --timeout.');
  }
  const extracted = extractAnswer(entry.ask.output, result.stdout);
  if (extracted.answer === undefined || extracted.error) {
    const said = extracted.error ?? (result.stderr.trim().split('\n').slice(-3).join(' ') || result.stdout.trim().slice(-300) || `exit ${result.exitCode}`);
    const signIn = /log ?in|sign ?in|auth|token|401|403|unauthori|credential/i.test(said);
    throw new RunpaneError(signIn ? 'ERR_ASK_SIGNED_OUT' : 'ERR_ASK_FAILED', `${entry.label} on ${where} did not answer: ${said}`,
      signIn
        ? `Sign in there: ${[executable, ...(entry.signIn ?? ['login'])].join(' ')}${place.remote ? ` (runpane workspace ${place.machine} exec -- ...)` : ''}, then ask again.`
        : `Check the model name with: runpane models --agent ${agent}${place.remote ? ` --machine ${place.machine}` : ''}`);
  }
  const answer: AskResult = { ok: true, answer: extracted.answer, agent, machine: place.machine, environment: place.environment, durationMs: Date.now() - started };
  if (model) answer.model = model;
  if (extracted.costUsd !== undefined) answer.costUsd = extracted.costUsd;
  if (parsed.json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  else process.stdout.write(`${answer.answer}\n`);
  return 0;
}

// ---------------------------------------------------------------- runpane models

export interface ModelRow {
  machine: string;
  environment: string;
  agent?: RunpaneAgent;
  model?: string;
  /** The agent's own words about sign-in, as it reported them. */
  signIn?: string;
  /** Why this row has no model: `unreachable` (the machine didn't answer) or `list unavailable` (its list could not be read). */
  note?: string;
}

/** Model names from what a list command printed, in the format the agents config names. */
export function parseModelList(format: string, stdout: string): string[] | undefined {
  const text = stripAnsi(stdout);
  if (format === 'json-models') {
    const start = text.indexOf('{');
    try {
      const value = record(JSON.parse(text.slice(start)));
      if (!Array.isArray(value.models)) return undefined;
      return value.models.map(record).filter(model => model.visibility !== 'hide' && typeof model.slug === 'string').map(model => String(model.slug));
    } catch {
      return undefined;
    }
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (format === 'lines') {
    const models = lines.filter(line => /^[\w.@:-]+\/\S+$/.test(line));
    return models.length ? models : undefined;
  }
  if (format === 'dash-lines') {
    const models = lines.flatMap(line => /^(\S+) - /.exec(line)?.[1] ?? []);
    return models.length ? models : undefined;
  }
  return undefined;
}

/** One line in the agent's own words about sign-in. */
export function describeSignIn(format: string, stdout: string, stderr: string): string | undefined {
  const text = stripAnsi(`${stdout}\n${stderr}`);
  if (format === 'json-logged-in') {
    try {
      const value = record(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
      if (value.loggedIn === true) return `signed in${typeof value.authMethod === 'string' ? ` (${value.authMethod})` : ''}`;
      if (value.loggedIn === false) return 'signed out';
    } catch { /* fall through to the text */ }
  }
  const words = text.split(/\r?\n/).map(line => line.replace(/[│┌└┐┘─●◇◆■•✓✗]/g, '').trim()).filter(line => line && !/^\d{4}-\d\d-\d\dT/.test(line));
  const line = words.join('; ');
  return line ? (line.length > 160 ? `${line.slice(0, 157)}...` : line) : undefined;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

async function listAt(place: Place, agents: readonly RunpaneAgent[]): Promise<ModelRow[]> {
  const rows = await Promise.all(agents.map(async (agent): Promise<ModelRow[]> => {
    const entry = agentEntry(agent);
    const models = entry.models;
    if (!models || (!models.list && !models.aliases)) return [];
    const executable = entry.executables[0];
    const base = { machine: place.machine, environment: place.environment, agent };
    const [listed, status] = await Promise.all([
      models.list ? run(place, [executable, ...models.list.args], { timeoutMs: LIST_TIMEOUT_MS }) : run(place, [executable, '--version'], { timeoutMs: LIST_TIMEOUT_MS }),
      models.status ? run(place, [executable, ...models.status.args], { timeoutMs: LIST_TIMEOUT_MS }) : undefined,
    ]);
    // Not installed there: no rows.
    if (listed.missing) return [];
    const signIn = status && models.status ? describeSignIn(models.status.format, status.stdout, status.stderr) : undefined;
    const names = models.list ? parseModelList(models.list.format, listed.stdout) : [...(models.aliases ?? [])];
    if (!names) return [{ ...base, signIn, note: 'list unavailable' }];
    return names.map(model => ({ ...base, model, ...(signIn ? { signIn } : {}) }));
  }));
  return rows.flat();
}

const savedProfilesSchema = boundary.object({
  remoteDaemon: boundary.optional(boundary.object({ client: boundary.object({ profiles: boundary.array(boundary.object({ tailnetMachine: boundary.optional(boundary.string), label: boundary.string })) }) })),
});

/** Machines saved in this machine's Pane (All machines). */
function savedMachineNames(paneDir?: string): string[] {
  try {
    const config = decodeBoundary(JSON.parse(fs.readFileSync(path.join(resolvePaneDirectory(paneDir), 'config.json'), 'utf8')), savedProfilesSchema);
    return (config.remoteDaemon?.client.profiles ?? []).map(profile => profile.tailnetMachine ?? profile.label);
  } catch {
    return [];
  }
}

/** Every place on one machine: native, and its WSL when a saved repository there is in WSL. */
async function placesOn(machineName: string | undefined, paneDir?: string): Promise<Place[]> {
  const place = await placeFor(machineName, paneDir);
  if (!place.remote) return [place];
  const repos = await invokeRemoteDaemon(place.remote, 'runpane:repos:list', [], repoListResultSchema, 20_000).catch(() => undefined);
  const wsl = repos?.repos.some(repo => repo.environment?.toLowerCase() === 'wsl');
  return wsl ? [place, { ...place, environment: 'wsl' }] : [place];
}

export async function runModels(parsed: ParsedArgs): Promise<number> {
  const agents = parsed.agent ? [parsed.agent] : AGENTS;
  const machines: Array<string | undefined> = parsed.all ? [undefined, ...savedMachineNames(parsed.paneDir)] : [parsed.handoffMachine];
  const perMachine = await Promise.all(machines.map(async (machine): Promise<ModelRow[]> => {
    try {
      const places = await placesOn(machine, parsed.paneDir);
      return (await Promise.all(places.map(place => listAt(place, agents)))).flat();
    } catch {
      return [{ machine: machine ?? thisMachineName(), environment: 'native', note: 'unreachable' }];
    }
  }));
  const search = parsed.query?.toLowerCase();
  const rows = perMachine.flat().filter(row => !search || !row.model || row.model.toLowerCase().includes(search));
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, signInReportedBy: 'agent', rows }, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    const where = row.environment === 'wsl' ? `${row.machine} (WSL)` : row.machine;
    process.stdout.write(`${[where, row.agent ?? '', row.model ?? row.note ?? '', row.signIn ?? ''].join('\t')}\n`);
  }
  return 0;
}
