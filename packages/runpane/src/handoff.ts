import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ParsedArgs, RunpaneAgent } from './commands';
import { PaneDaemonClientError, resolvePaneDirectory, invokeDaemon, invokeRemoteDaemon } from './daemonClient';
import { buildPaneCreateRequest, paneCreateResultSchema, repoListResultSchema } from './localControl';
import { RUNPANE_CONTRACT } from './generated/contract';
import { readTailnet, resolveMachine, workspaceTarget, type TailnetMachine } from './workspace';

/**
 * The note's sections. They extend Codex's compaction prompt
 * (openai/codex codex-rs/prompts/templates/compact/prompt.md: progress and decisions, context and
 * constraints, next steps, critical references) with what a receiver on another machine needs:
 * what was verified, how to check it, and where the code is.
 */
export const HANDOFF_SECTIONS = [
  { heading: 'Goal', prompt: 'What the work is for and what "done" means, in the person\'s terms. Name the issue or PR.' },
  { heading: 'Current state', prompt: 'Where things stand right now, in two or three sentences.' },
  { heading: 'Done and verified', prompt: 'Finished work, each item with how you verified it (command and result).' },
  { heading: 'In progress', prompt: 'Half-done work: what is written, what is not, and any failing test or error, quoted.' },
  { heading: 'Next steps', prompt: 'The ordered next actions. Make the first one concrete enough to start without asking.' },
  { heading: 'Decisions and constraints', prompt: 'Decisions with their reasons, the person\'s preferences, non-goals, and approaches that failed (so they are not retried).' },
  { heading: 'Open questions', prompt: 'What only the person can answer, and what you were unsure about. Write "None" if there are none.' },
  { heading: 'How to verify', prompt: 'Exact commands to build, test, and see the change working, with the result you expect.' },
  { heading: 'Git state', prompt: 'Repository, branch, head commit, whether it is pushed, and any uncommitted files that matter.' },
] as const;

const AGENTS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const AGENT_ALIASES = new Map<string, RunpaneAgent>([['claude-code', 'claude'], ['cursor-agent', 'cursor'], ['codex-cli', 'codex']]);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_PATTERN = /^(gpt-|o\d|claude-|opus|sonnet|haiku|fable|composer|gemini|grok)/i;
const FILLER = new Set(['on', 'to', 'with', 'using', 'via', 'at', 'in', 'a', 'an', 'the', 'and', 'effort', 'reasoning', 'model', 'machine']);
const THIS_MACHINE = /\b(this machine|this computer|here|locally|local|localhost)\b/gi;
const REPORT_TIMEOUT_MS = 180_000;

export interface HandoffDestination {
  /** A Tailscale machine name, or null for this machine. */
  machine: string | null;
  agent: RunpaneAgent;
  model?: string;
  effort?: string;
  /** Explicit WSL selection is recognized and rejected until supported. */
  wsl?: true;
}

export interface DestinationOverrides {
  machine?: string;
  agent?: RunpaneAgent;
  model?: string;
  effort?: string;
}

/**
 * Reads "codex gpt-5 high on parsas-macbook-pro" into a machine, agent, model, and effort.
 * Flags win over the text. Anything it cannot place is an error, not a guess.
 */
export function parseDestination(text: string, machines: readonly TailnetMachine[], overrides: DestinationOverrides = {}): HandoffDestination {
  let local = false;
  const words = text.replace(THIS_MACHINE, () => { local = true; return ' '; })
    .split(/[\s,]+/).filter(Boolean);
  const agents: RunpaneAgent[] = [];
  const efforts: string[] = [];
  const models: string[] = [];
  const unknown: string[] = [];
  let wsl = false;
  for (const raw of words) {
    const [key, value] = raw.includes('=') ? raw.split('=', 2) : [undefined, raw];
    const word = value.toLowerCase();
    if (key?.toLowerCase() === 'model') models.push(value);
    else if (key && ['effort', 'reasoning'].includes(key.toLowerCase())) efforts.push(word);
    else if (AGENTS.has(word) || AGENT_ALIASES.has(word)) agents.push(AGENT_ALIASES.get(word) ?? decodeAgent(word));
    else if (EFFORTS.has(word)) efforts.push(word);
    else if (word === 'wsl') wsl = true;
    else if (MODEL_PATTERN.test(word)) models.push(word);
    else if (!FILLER.has(word)) unknown.push(value);
  }
  for (const [label, found] of [['agents', [...new Set(agents)]], ['models', models], ['efforts', efforts]] as const) {
    if (found.length > 1) throw new Error(`"${text}" names two ${label}: ${found.join(' and ')}. Name one.`);
  }
  const agent = overrides.agent ?? agents[0];
  if (!agent) throw new Error(`Name the agent: claude, codex, or cursor. For example: runpane handoff "claude opus on parsas-macbook-pro" --note-file ~/handoff.md`);
  if (agent === 'opencode') throw new Error('OpenCode is supported in terminal panes, but handoff to OpenCode is not supported yet. Choose claude, codex, or cursor; nothing was committed or sent.');

  let machine: string | null = null;
  if (overrides.machine) {
    machine = machineName(resolveMachine(overrides.machine, machines));
  } else if (unknown.length > 1) {
    throw new Error(`Could not read "${unknown.join(' ')}" in "${text}". Name one machine, or pass --machine <name>.`);
  } else if (unknown.length === 1) {
    if (local) throw new Error(`"${text}" names this machine and "${unknown[0]}". Name one.`);
    machine = machineName(resolveMachine(unknown[0], machines));
  }

  const destination: HandoffDestination = { machine, agent };
  const model = overrides.model ?? models[0];
  const effort = overrides.effort ?? efforts[0];
  if (model !== undefined && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error('Invalid model identifier. Use letters, numbers, dots, underscores, colons, slashes, or hyphens.');
  if (effort !== undefined && !EFFORTS.has(effort)) throw new Error(`Invalid effort. Use ${[...EFFORTS].join(', ')}.`);
  if (agent === 'cursor' && effort !== undefined) throw new Error('Cursor effort is not supported. Omit --effort and effort text; nothing was committed or sent.');
  if (model) destination.model = model;
  if (effort) destination.effort = effort;
  if (wsl) destination.wsl = true;
  return destination;
}

function machineName(machine: TailnetMachine): string | null {
  return machine.self ? null : machine.name;
}

const agentSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.agents);
function decodeAgent(value: string): RunpaneAgent {
  return decodeBoundary(value, agentSchema);
}

// ---------------------------------------------------------------- the note

export interface NoteCheck {
  ok: boolean;
  /** Required sections with no heading. */
  missing: string[];
  /** Required sections whose heading is there but whose body is empty or only template comments. */
  empty: string[];
}

/** Checks that every required section is present and written; "None" counts as written. */
export function validateNote(text: string): NoteCheck {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const headings = [...body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)];
  const missing: string[] = [];
  const empty: string[] = [];
  for (const section of HANDOFF_SECTIONS) {
    const index = headings.findIndex((match) => match[1].trim().toLowerCase() === section.heading.toLowerCase());
    if (index === -1) {
      missing.push(section.heading);
      continue;
    }
    const start = (headings[index].index ?? 0) + headings[index][0].length;
    const end = headings[index + 1]?.index ?? body.length;
    if (!body.slice(start, end).replace(/<!--[\s\S]*?-->/g, '').trim()) empty.push(section.heading);
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

export interface NoteOrigin {
  originMachine: string;
  originPane?: string;
  originPanel?: string;
  originSession?: string;
  repository?: string;
  branch?: string;
  head?: string;
  remote?: string;
  pushed?: boolean;
}

/** The note an agent fills in: front matter for the origin, then one section per required heading. */
export function noteTemplate(origin: NoteOrigin): string {
  return [
    frontMatter(origin),
    '# Handoff: <title>',
    '',
    '<!--',
    'Write this for an agent that has none of your context: no chat history, no memory, a different',
    'machine. Be concise and concrete; quote errors and commands exactly. Every section is required;',
    'write "None" when one does not apply. Based on Codex\'s compaction prompt',
    '(github.com/openai/codex, codex-rs/prompts/templates/compact/prompt.md).',
    '-->',
    '',
    ...HANDOFF_SECTIONS.flatMap((section) => [`## ${section.heading}`, '', `<!-- ${section.prompt} -->`, '']),
  ].join('\n');
}

function frontMatter(origin: NoteOrigin): string {
  const fields: Array<[string, string | boolean | undefined]> = [
    ['origin_machine', origin.originMachine],
    ['origin_pane', origin.originPane],
    ['origin_panel', origin.originPanel],
    ['origin_session', origin.originSession],
    ['repository', origin.repository],
    ['branch', origin.branch],
    ['head', origin.head],
    ['remote', origin.remote],
    ['pushed', origin.pushed],
  ];
  const lines = fields.filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, '---', ''].join('\n');
}

/** Replaces the note's front matter with the CLI's own, so the origin and git state are never stale. */
function stampNote(text: string, origin: NoteOrigin, receiver: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\n+/, '');
  return `${frontMatter(origin)}\n${body.trimEnd()}\n\n${receiver}\n`;
}

// ---------------------------------------------------------------- git

interface GitState {
  root: string;
  repository: string;
  branch: string;
  head: string;
  remote: string;
  remoteUrl: string;
  dirty: string[];
  pushed: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function readGitState(cwd: string): GitState {
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('runpane handoff runs inside the git repository being handed off.');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (branch === 'HEAD') throw new Error('HEAD is detached. Check out a branch before handing off.');
  const remote = tryGit(['config', `branch.${branch}.remote`], root) ?? 'origin';
  const remoteUrl = tryGit(['remote', 'get-url', remote], root);
  if (!remoteUrl) throw new Error(`This repository has no "${remote}" remote, so the receiver cannot fetch the work. Add one, then hand off again.`);
  const head = git(['rev-parse', 'HEAD'], root);
  const remoteHead = tryGit(['rev-parse', `refs/remotes/${remote}/${branch}`], root);
  return {
    root,
    repository: repositorySlug(remoteUrl) ?? path.basename(root),
    branch,
    head,
    remote,
    remoteUrl,
    dirty: execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean),
    pushed: remoteHead !== null && tryGit(['merge-base', '--is-ancestor', head, remoteHead], root) !== null,
  };
}

function noteInCheckout(root: string, notePath: string | undefined): string {
  if (!notePath || notePath === '-') return '';
  const resolved = path.resolve(notePath);
  // Git may report a canonical root while Windows TEMP uses an 8.3 alias.
  // Canonicalize directories, keeping the leaf so a note symlink is excluded too.
  const canonicalNote = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  const relative = path.relative(fs.realpathSync.native(root), canonicalNote);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? '' : relative;
}

/** --push: commit uncommitted work as WIP and push the branch; never forces. */
/** The note is not part of the work: leave it out of the uncommitted count and the WIP commit. */
function withoutNote(state: GitState, notePath: string | undefined): GitState {
  const relative = noteInCheckout(state.root, notePath).split(path.sep).join('/');
  if (!relative) return state;
  return { ...state, dirty: state.dirty.filter((line) => line.slice(3) !== relative) };
}

function pushWork(state: GitState, destination: string, notePath: string | undefined): GitState {
  const noteRelative = noteInCheckout(state.root, notePath);
  if (noteRelative && git(['diff', '--cached', '--name-only', '--', noteRelative], state.root)) {
    throw new Error(`The handoff note is staged. Unstage it with git restore --staged -- ${JSON.stringify(noteRelative)}, then retry. Nothing was committed or pushed.`);
  }
  if (state.dirty.length) {
    const relative = noteInCheckout(state.root, notePath);
    git(['add', '-A', '--', '.', ...(relative ? [`:(exclude)${relative}`] : [])], state.root);
    git(['commit', '-m', `WIP: hand off to ${destination}`], state.root);
  }
  git(['push', '-u', state.remote, `HEAD:refs/heads/${state.branch}`], state.root);
  git(['fetch', state.remote, state.branch], state.root);
  return withoutNote(readGitState(state.root), notePath);
}

/** owner/name for a GitHub-style remote URL. */
function repositorySlug(url: string): string | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// ---------------------------------------------------------------- running on the destination

const execResultSchema = boundary.object({
  os: boundary.enumeration('macOS', 'Windows', 'Linux'),
  shell: boundary.string,
  exitCode: boundary.nullable(boundary.number),
  stdout: boundary.string,
  stderr: boundary.string,
});
const writeResultSchema = boundary.object({ path: boundary.string, bytes: boundary.number });
type SavedRepo = ReturnType<typeof repoListResultSchema.decode>['repos'][number];
type PaneCreateRequest = Awaited<ReturnType<typeof buildPaneCreateRequest>>;

/** A shell on the destination: another machine through `runpane workspace exec`, or this one. */
interface Destination {
  name: string;
  shell: string;
  os: 'macOS' | 'Windows' | 'Linux';
  run(command: string[], timeoutMs?: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  write(target: string, content: string): Promise<string>;
  repos(): Promise<ReturnType<typeof repoListResultSchema.decode>>;
  create(request: PaneCreateRequest): Promise<ReturnType<typeof paneCreateResultSchema.decode>>;
}

async function remoteDestination(machine: TailnetMachine): Promise<Destination> {
  const target = workspaceTarget(machine);
  const probe = await invokeRemoteDaemon(target, 'runpane:machine:exec', [{ command: 'echo runpane-handoff', timeoutMs: 20_000 }], execResultSchema);
  if (probe.exitCode !== 0) throw new Error(`Could not execute on ${machine.name}: ${probe.stderr || probe.stdout}`);
  if (machine.self && probe.os !== 'Windows') throw new Error(`Expected the Windows host, but ${machine.name} reports ${probe.os}. Nothing was committed or sent.`);
  const shell = probe.shell;
  // cmd has expansion rules that cannot safely represent arbitrary terminal prompts.
  if (!/^(bash|zsh|sh|fish|pwsh|powershell)(?:\.exe)?$/i.test(path.posix.basename(shell.replace(/\\/g, '/')))) {
    throw new Error(`Handoff does not support the destination shell "${shell}". Select Bash or PowerShell in Pane and retry.`);
  }
  return {
    name: machine.name,
    shell,
    os: probe.os,
    repos: () => invokeRemoteDaemon(target, 'runpane:repos:list', [], repoListResultSchema),
    create: (request) => invokeRemoteDaemon(target, 'runpane:panes:create', [request], paneCreateResultSchema, REPORT_TIMEOUT_MS),
    run: (argv, timeoutMs = 120_000) =>
      invokeRemoteDaemon(target, 'runpane:machine:exec', [{ command: argv.map((arg) => quote(arg, shell)).join(' '), timeoutMs }], execResultSchema, timeoutMs + 30_000),
    write: async (file, content) =>
      (await invokeRemoteDaemon(target, 'runpane:machine:write', [{ path: file, content, encoding: 'utf8' }], writeResultSchema)).path,
  };
}

function localDestination(name: string, paneDir?: string): Destination {
  return {
    name,
    repos: () => invokeDaemon('runpane:repos:list', [], repoListResultSchema, { paneDir, timeoutMs: 20_000 }),
    create: (request) => invokeDaemon('runpane:panes:create', [request], paneCreateResultSchema, { paneDir, timeoutMs: REPORT_TIMEOUT_MS }),
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    shell: process.platform === 'win32' ? 'powershell' : (process.env.SHELL ?? 'sh'),
    run: (command, timeoutMs = 120_000) => new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { shell: false, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: stderr + error.message }));
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    }),
    write: async (file, content) => {
      const resolved = file.replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { mode: 0o600 });
      return resolved;
    },
  };
}

function quote(value: string, shell: string): string {
  if (/^[\w./:@=+-]+$/.test(value)) return value;
  return /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function mustRun(destination: Destination, command: string[], what: string, timeoutMs?: number): Promise<string> {
  const result = await destination.run(command, timeoutMs);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`${what} failed on ${destination.name}: ${detail || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

/** The saved repository on the destination whose remotes include ours; returns it and that remote's name. */
async function findRepo(destination: Destination, listed: ReturnType<typeof repoListResultSchema.decode>, state: GitState, selector?: string): Promise<{ repo: SavedRepo; remote: string }> {
  const candidates = selector
    ? listed.repos.filter((repo) => String(repo.id) === selector || repo.name === selector || repo.path === selector)
    : listed.repos;
  if (selector && !candidates.length) throw new Error(`${destination.name} has no saved repository "${selector}". Its repositories: ${listed.repos.map((repo) => repo.name).join(', ')}.`);
  const wanted = repositorySlug(state.remoteUrl)?.toLowerCase();
  for (const repo of candidates) {
    if (repo.environment?.toLowerCase() === 'wsl' || /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i.test(repo.path)) {
      if (selector) throw new Error(`Saved repository "${repo.name}" is in WSL. Select a native Windows repository instead. Nothing was committed or sent.`);
      continue;
    }
    const remotes = await destination.run(['git', '-C', repo.path, 'remote', '-v'], 20_000);
    if (remotes.exitCode !== 0) continue;
    const match = remotes.stdout.split('\n').map((line) => line.split(/\s+/))
      .find(([, url]) => url && repositorySlug(url)?.toLowerCase() === wanted);
    if (match) return { repo, remote: match[0] };
  }
  throw new Error(`No saved repository on ${destination.name} has a remote for ${wanted}. Add a matching Git remote to the destination clone, then save the clone there with: runpane workspace ${destination.name} exec -- runpane repos add --path <clone> --yes.`);
}

function agentCommand(destination: HandoffDestination, shell: string): string | undefined {
  if (!destination.model && !destination.effort) return undefined;
  const base = RUNPANE_CONTRACT.agentTemplates[destination.agent].command;
  const { model, effort } = destination;
  const flags = destination.agent === 'codex'
    ? [model && `-m ${quote(model, shell)}`, effort && `-c ${quote(`model_reasoning_effort=${effort}`, shell)}`]
    : destination.agent === 'claude'
      ? [model && `--model ${quote(model, shell)}`, effort && `--effort ${quote(effort, shell)}`]
      : [model && `--model ${quote(model, shell)}`];
  return [base, ...flags].filter(Boolean).join(' ');
}

function describeDestination(destination: HandoffDestination, machine: string): string {
  const detail = [destination.model, destination.effort && `${destination.effort} effort`].filter(Boolean).join(', ');
  return `${destination.agent}${detail ? ` (${detail})` : ''} on ${machine}`;
}

function receiverInstructions(origin: NoteOrigin, state: GitState, remote: string, reporter: string): string {
  const reportTarget = origin.originPanel
    ? `${reporter} workspace ${origin.originMachine} panels submit --panel ${origin.originPanel} --text "<one line: what you finished, the commit or PR, and anything blocked>" --yes`
    : `a comment on the PR, or a commit message on ${state.branch}, since the sender left no panel to report to`;
  return [
    '## Receiver instructions',
    '',
    '<!-- Added by runpane handoff. -->',
    '1. Read the repository\'s AGENTS.md or CLAUDE.md, then this whole note.',
    `2. Check the git state: your worktree starts at sender commit ${state.head}; \`git log -1 --format=%H\` must print ${state.head}. If it does not, stop and report.`,
    '3. Run the commands under "How to verify" to confirm the state the note describes, then continue from "Next steps".',
    `4. Push your commits to the original branch: \`git push ${remote} HEAD:${state.branch}\`. Never force-push.`,
    `5. When you finish or get blocked, report back to the sender: ${reportTarget}`,
  ].join('\n');
}

// ---------------------------------------------------------------- command

interface HandoffResult {
  ok: boolean;
  dryRun: boolean;
  destination: HandoffDestination & { name?: string; os?: Destination['os'] };
  note?: { path: string; sections: number; bytes: number };
  git: { repository: string; branch: string; head: string; remote: string; pushed: boolean; dirty: number };
  warnings: string[];
  repo?: { id: number; name: string; path: string; environment: string };
  notePath?: string;
  pane?: { id: string; panelId: string; name?: string; worktreePath?: string };
  reportBack?: string;
}

export async function runHandoff(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const tailnet = await readTailnet();
  const self = tailnet.ok ? tailnet.self.name : (process.env.HOSTNAME ?? 'this-machine');
  const origin = (state: GitState | null): NoteOrigin => ({
    originMachine: self,
    originPane: process.env.PANE_SESSION_ID,
    originPanel: process.env.PANE_PANEL_ID,
    originSession: process.env.PANE_ORCHESTRATION_SESSION_ID,
    repository: state?.repository,
    branch: state?.branch,
    head: state?.head,
    remote: state?.remote,
    pushed: state?.pushed,
  });

  if (parsed.handoffTemplate) {
    process.stdout.write(noteTemplate(origin(tryReadGitState(cwd))));
    return 0;
  }

  const text = parsed.handoffDestination ?? '';
  if (!text && !parsed.handoffMachine && !parsed.agent) {
    throw new Error('runpane handoff needs a destination, for example: runpane handoff "claude opus on parsas-macbook-pro" --note-file ~/handoff.md. Start the note with: runpane handoff --template > ~/handoff.md');
  }
  const machines = tailnet.ok ? [tailnet.self, ...tailnet.machines] : [];
  const destination = parseDestination(text, machines, {
    machine: parsed.handoffMachine, agent: parsed.agent, model: parsed.handoffModel, effort: parsed.handoffEffort,
  });
  if (destination.wsl) throw new Error('Handoff to a WSL receiver is not supported yet. Choose a native destination without wsl; nothing was committed or sent.');
  if (destination.machine && !tailnet.ok) throw new Error(`Handing off to another machine needs Tailscale: ${tailnet.reason}. ${tailnet.fix}`);
  const machineLabel = destination.machine ?? `${self} (this machine)`;
  const say = (line: string): void => { if (!parsed.json) console.log(line); };
  say(`Handoff to ${describeDestination(destination, machineLabel)}`);

  const warnings: string[] = [];
  let noteText: string | undefined;
  let noteInfo: HandoffResult['note'];
  if (parsed.handoffNoteFile) {
    noteText = fs.readFileSync(parsed.handoffNoteFile === '-' ? 0 : parsed.handoffNoteFile, 'utf8');
    const check = validateNote(noteText);
    if (!check.ok) {
      const parts = [check.missing.length && `missing ${check.missing.join(', ')}`, check.empty.length && `not filled in: ${check.empty.join(', ')}`].filter(Boolean);
      throw new Error(`The note is incomplete (${parts.join('; ')}). Fill in every section, writing "None" where one does not apply. The template: runpane handoff --template`);
    }
    noteInfo = { path: path.resolve(parsed.handoffNoteFile), sections: HANDOFF_SECTIONS.length, bytes: Buffer.byteLength(noteText) };
    say(step('note', `${noteInfo.sections} sections, ${formatBytes(noteInfo.bytes)}`));
  } else if (!parsed.dryRun) {
    throw new Error('runpane handoff needs --note-file <path>. Write it from: runpane handoff --template > ~/handoff.md');
  }

  let state = withoutNote(readGitState(cwd), parsed.handoffNoteFile);
  let target = destination.machine ? machines.find((machine) => machine.name === destination.machine) : undefined;
  let remote = target ? await remoteDestination(target) : localDestination(self, parsed.paneDir);
  let listed: ReturnType<typeof repoListResultSchema.decode>;
  try {
    listed = await remote.repos();
  } catch (error) {
    // WSL shares its host's Tailnet identity, but not its daemon socket. Probe
    // the actual daemon: a leftover socket file is not proof it is listening.
    // Explicit instances and daemon/application errors must never change target.
    if (target || process.platform !== 'linux' || !insideWSL()
      || parsed.paneDir || process.env.PANE_DIR || process.env.FOOZOL_DIR
      || !tailnet.ok || tailnet.self.os !== 'Windows'
      || !(error instanceof PaneDaemonClientError) || !error.connectionFailure
      || (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED')) throw error;
    target = tailnet.self;
    remote = await remoteDestination(target);
    listed = await remote.repos();
  }
  const { repo, remote: repoRemote } = await findRepo(remote, listed, state, parsed.repo);
  const senderShell = process.platform === 'win32' ? 'powershell' : (process.env.SHELL ?? 'sh');
  const selectedDirectory = parsed.paneDir || process.env.PANE_DIR || process.env.FOOZOL_DIR;
  const controlPrefix = target
    ? ['runpane', 'workspace', remote.name]
    : ['runpane', ...(selectedDirectory ? ['--pane-dir', path.resolve(resolvePaneDirectory(parsed.paneDir))] : [])];
  const recovery = (...args: string[]): string => [...controlPrefix, ...args].map(arg => quote(arg, senderShell)).join(' ');
  const receiverStatus = (sessionId: string, panelId?: string): string => target
    ? (panelId ? recovery('panels', 'screen', '--panel', panelId) : recovery('sessions', 'list'))
    : recovery('agents', 'status', '--pane', sessionId);
  say(step('repo', `${repo.name} (${repo.path}), ${repo.environment ?? 'native'}, ${remote.os}, remote ${repoRemote}`));
  if (parsed.handoffPush && !parsed.dryRun && (!state.pushed || state.dirty.length)) {
    state = pushWork(state, machineLabel, parsed.handoffNoteFile);
  }
  if (state.dirty.length) warnings.push(`${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'} will not reach the receiver. Commit them, or pass --push to commit them as WIP.`);
  if (!state.pushed) warnings.push(`${state.branch} at ${state.head.slice(0, 7)} is not on ${state.remote}. Push it, or pass --push.`);
  say(step('git', `${state.branch} @ ${state.head.slice(0, 7)}, ${state.pushed ? `pushed to ${state.remote}` : 'NOT pushed'}${state.dirty.length ? `, ${state.dirty.length} uncommitted` : ''}`, state.pushed && !state.dirty.length));

  const result: HandoffResult = {
    ok: true,
    dryRun: parsed.dryRun,
    destination: { ...destination, name: remote.name, os: remote.os },
    repo: { id: repo.id, name: repo.name, path: repo.path, environment: repo.environment ?? 'native' },
    note: noteInfo,
    git: { repository: state.repository, branch: state.branch, head: state.head, remote: state.remote, pushed: state.pushed, dirty: state.dirty.length },
    warnings,
  };
  if (parsed.dryRun) {
    for (const warning of warnings) say(`  ! ${warning}`);
    say('Dry run: nothing was sent.');
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (!state.pushed) throw new Error(`${warnings.join(' ')}\nThe receiver would start without your work, so nothing was sent.`);
  for (const warning of warnings) say(`  ! ${warning}`);

  await mustRun(remote, ['git', '-C', repo.path, 'fetch', repoRemote, state.branch], 'git fetch', 120_000);

  await mustRun(remote, ['git', '-C', repo.path, 'cat-file', '-e', `${state.head}^{commit}`], 'verify sender commit');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `handoff-${state.branch.replace(/^handoff[-/]/i, '')}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48).replace(/-+$/, '');
  const noteOrigin = origin(state);
  const stamped = stampNote(noteText ?? '', noteOrigin, receiverInstructions(noteOrigin, state, repoRemote, 'runpane'));
  const notePath = await remote.write(`~/.pane/handoffs/${stamp}-${name}-${randomUUID()}.md`, stamped);
  say(step('note sent', notePath));

  const toolCommand = agentCommand(destination, remote.shell);
  const prompt = `Read the handoff note at ${notePath} and continue the work it describes. Start with its "Receiver instructions" section.`;
  const request = await buildPaneCreateRequest({
    ...parsed, repo: String(repo.id), name, baseBranch: state.head, agent: destination.agent,
    toolCommand, initialInput: prompt, source: 'agent', noFocus: true, focus: false,
    waitReady: true, yes: true, noAssociate: true, fromJson: undefined,
  });
  let created: ReturnType<typeof paneCreateResultSchema.decode>;
  try {
    // Workspace control carries JSON directly to the reached daemon, without
    // passing prompt arguments through the host shell or needing a host CLI.
    created = await remote.create(request);
  } catch (error) {
    throw new Error(`runpane panes create failed on ${remote.name}: ${error instanceof Error ? error.message : String(error)}. The note was sent to ${notePath}. Check ${recovery('sessions', 'list')} before retrying to avoid a duplicate Pane.`);
  }
  const item = created.items[0];
  if (!item?.ok || !item.sessionId || !item.panelId) throw new Error(`Pane on ${remote.name} did not start the agent: ${item && 'error' in item ? item.error.message : 'no pane was created'}. The note was sent to ${notePath}.${item?.sessionId ? ` Pane ${item.sessionId}. Check ${receiverStatus(item.sessionId, item.panelId)} before retrying.${item.panelId && !target ? ` Inspect panel ${item.panelId}: ${recovery('panels', 'screen', '--panel', item.panelId)}.` : ''}` : ` Check ${recovery('sessions', 'list')} before retrying.`}`);

  result.notePath = notePath;
  result.pane = { id: item.sessionId, panelId: item.panelId, name: item.name, worktreePath: item.worktreePath };
  result.reportBack = noteOrigin.originPanel ? `${self} panel ${noteOrigin.originPanel}` : undefined;
  const inspect = recovery('panels', 'screen', '--panel', item.panelId);
  const input = item.initialInput;
  const verified = input?.verifiedSubmitted === true
    && (input.delivery?.state === 'taken' || input.delivery?.state === 'queued')
    && !input.blocked && !input.error;
  if (!verified || !created.ok) {
    result.ok = false;
    warnings.push(`Receiver prompt is not verified submitted on panel ${item.panelId}${input?.blocked?.message || input?.error?.message ? `: ${input.blocked?.message ?? input.error?.message}` : ` (${input?.delivery?.state ?? 'missing delivery evidence'})`}. Pane ${item.sessionId} was created; do not retry blindly. Inspect it: ${inspect}`);
    for (const warning of warnings) say(`  ! ${warning}`);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 1;
  }
  say(step('started', `${item.name ?? name} on ${remote.name}${item.worktreePath ? ` (${item.worktreePath})` : ''}`));
  const check = receiverStatus(item.sessionId, item.panelId);
  say(result.reportBack ? `The receiver reports back to ${result.reportBack}.` : 'No sender panel to report to; the receiver reports on the branch.');
  say(`Check on it: ${check}`);
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

function tryReadGitState(cwd: string): GitState | null {
  try {
    return readGitState(cwd);
  } catch {
    return null;
  }
}

function step(label: string, detail: string, ok = true): string {
  return `  ${ok ? '✓' : '!'} ${label.padEnd(10)} ${detail}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function insideWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}
