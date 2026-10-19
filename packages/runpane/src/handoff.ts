import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema } from './boundaryDecoder';
import type { ParsedArgs, RunpaneAgent } from './commands';
import { PaneDaemonClientError, resolvePaneDirectory, invokeDaemon, invokeRemoteDaemon } from './daemonClient';
import { buildPaneCreateRequest, buildPanelCreateRequest, paneCreateResultSchema, panelCreateResultSchema, paneListResultSchema, panelListResultSchema, panelScreenResultSchema, panelSubmitResultSchema, repoListResultSchema, runpaneSessionListResultSchema, runpaneSessionResultSchema } from './localControl';
import { CURSOR_NO_FORK, forkNativeSession, isNativeAgent, lastMessageSnippet, locateNativeSession, openCodeMessagesMissing, originalChanges, screenShows, sha256, snapshotOriginal, type NativeAgent, type NativeSession, type OriginalSnapshot } from './nativeSession';
import { RunpaneError } from './errors';
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
  if (agent === 'opencode' && effort !== undefined) throw new Error('OpenCode effort is not supported. Omit --effort and effort text; nothing was committed or sent.');
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
  // A note saved by PowerShell starts with a BOM and uses CRLF; its front matter is replaced all the same.
  const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\n+/, '');
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
  if (!root) throw new Error('runpane handoff runs inside the git repository being handed off, or in a Session\'s terminal to hand off the Session. Nothing was sent.');
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
  write(target: string, content: string, encoding?: 'utf8' | 'base64'): Promise<string>;
  repos(): Promise<ReturnType<typeof repoListResultSchema.decode>>;
  create(request: PaneCreateRequest): Promise<ReturnType<typeof paneCreateResultSchema.decode>>;
  /** Pane's own control commands on the destination, for checking the receiver. */
  invoke<T>(channel: string, args: unknown[], schema: BoundarySchema<T>): Promise<T>;
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
    write: async (file, content, encoding = 'utf8') =>
      (await invokeRemoteDaemon(target, 'runpane:machine:write', [{ path: file, content, encoding }], writeResultSchema, REPORT_TIMEOUT_MS)).path,
    invoke: (channel, args, schema) => invokeRemoteDaemon(target, channel, args, schema, REPORT_TIMEOUT_MS),
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
    write: async (file, content, encoding = 'utf8') => {
      const resolved = file.replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, Buffer.from(content, encoding), { mode: 0o600 });
      return resolved;
    },
    invoke: (channel, args, schema) => invokeDaemon(channel, args, schema, { paneDir, timeoutMs: REPORT_TIMEOUT_MS }),
  };
}

function quote(value: string, shell: string): string {
  if (/^[\w./:@=+-]+$/.test(value)) return value;
  // PowerShell also ends a single-quoted string at a typographic single quote.
  return /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'` : `'${value.replace(/'/g, `'\\''`)}'`;
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

// ---------------------------------------------------------------- carrying the sender's session

/**
 * The sender's own agent session, carried to the receiver and resumed there by its id, so a
 * same-agent handoff continues the conversation instead of starting a fresh agent with a note.
 * The receiver is checked as references/continuity.md in the migrate-to-pane skill describes.
 */
interface Carry {
  session: NativeSession;
  /** A phrase from the last complete message, which the receiver's screen must show. */
  snippet?: string;
  /** Why this session and not the one Pane recorded for the tab, when they differ. */
  note?: string;
  /** The sender is the running agent, identified by its own live record: its turn is still writing. */
  live?: true;
  /**
   * The tab the receiver reports back to, when it isn't PANE_PANEL_ID (which a command run through
   * Codex's shared background server can inherit from another tab); null when no tab can be named.
   */
  senderPanel?: string | null;
}

/** What happened to the sender's session, in the command's output and JSON. */
export interface ContinuityReport {
  /** True when the sender's session is (or, on a dry run, would be) carried and resumed. */
  carried: boolean;
  /** Absent on a dry run. `fresh-agent` is the note route: a new agent, not the same session. */
  result?: 'continued' | 'inconclusive' | 'not-continued' | 'fresh-agent';
  agent?: string;
  /** The sender's native session id. */
  sessionId?: string;
  /** The id the receiver resumes: the sender's, or its fork's on this machine. */
  resumedId?: string;
  fork?: boolean;
  files?: number;
  bytes?: number;
  checks?: {
    /** Pane launched the agent's own resume for resumedId. */
    resumedById: boolean;
    /** Pane recorded resumedId as the receiver's id, so a restart resumes it. */
    restartResumes: boolean;
    /** The receiver's screen showed the copy's last message; null when there was nothing to compare. */
    historyLoaded: boolean | null;
    /**
     * Forks only: everything the sender's session held before the fork is unchanged, byte for byte,
     * and nothing else changed it. When `originalAppended` is set, the sender's transcript also grew:
     * the sender is the running agent, and its own current turn appended to it.
     */
    originalUntouched?: boolean;
    /** Forks only: the running sender's own turn appended to its transcript during the handoff. */
    originalAppended?: true;
  };
  reason: string;
  next?: string;
}

type CarryPlan = { carry: Carry } | { fresh: string };

/**
 * Where an agent records, for every command it runs, which of its own conversations ran it. This is
 * the sender's own live record, so it is trusted over the id Pane captured for the tab: Pane learns
 * a Codex id only when Codex exits, and a command run through Codex's shared background server
 * can inherit another tab's PANE_PANEL_ID.
 */
const LIVE_SESSION_ENV = [['claude', 'CLAUDE_CODE_SESSION_ID'], ['codex', 'CODEX_THREAD_ID']] as const;

interface SenderSession {
  agent: NativeAgent;
  id: string;
  /** Set when the agent's live record and Pane's record for the tab disagree. */
  note?: string;
  live?: true;
}

/** Which session is handing off: the agent's live record when it has one, otherwise Pane's record for this tab. */
function senderSession(recorded: { agentType?: string; resumeId?: string } | undefined): { sender: SenderSession } | { fresh: string } {
  const live = LIVE_SESSION_ENV.flatMap(([agent, key]) => {
    const id = process.env[key]?.trim();
    return id ? [{ agent, id }] : [];
  });
  // One agent started inside another sees both records; the tab's agent decides which one is speaking.
  const chosen = live.length > 1 ? live.find(entry => entry.agent === recorded?.agentType) : live[0];
  if (live.length > 1 && !chosen) {
    return { fresh: `Both ${live.map(entry => entry.agent).join(' and ')} report a live session in this terminal (one agent was started by the other), so runpane can't tell which one is handing off. Run the handoff from that agent's own tab.` };
  }
  if (chosen) {
    const sender: SenderSession = { ...chosen, live: true };
    if (recorded?.agentType === chosen.agent && recorded.resumeId && recorded.resumeId !== chosen.id) {
      sender.note = `Pane had recorded ${recorded.resumeId} for this tab; ${chosen.agent} itself reports ${chosen.id}, which is the one carried.`;
    }
    return { sender };
  }
  const agent = recorded?.agentType;
  if (!isNativeAgent(agent) || !recorded?.resumeId) return { fresh: 'This tab runs no Claude, Codex, Cursor or OpenCode session that Pane has an id for.' };
  return { sender: { agent, id: recorded.resumeId } };
}

/**
 * The sender's session when the receiver can continue it: the agent's own live record, or the id
 * Pane recorded for this tab; the receiver is the same agent; and the session's files are here.
 */
async function planCarry(parsed: ParsedArgs, destination: HandoffDestination): Promise<CarryPlan> {
  if (parsed.handoffNoteOnly) return { fresh: 'You passed --note-only.' };
  const paneId = process.env.PANE_SESSION_ID;
  const panelId = process.env.PANE_PANEL_ID;
  let recorded: { agentType?: string; resumeId?: string } | undefined;
  let panels: Array<{ id: string; agentType?: string; resumeId?: string }> = [];
  if (paneId && panelId) {
    try {
      const listed = await invokeDaemon('runpane:panels:list', [{ paneId }], panelListResultSchema, { paneDir: parsed.paneDir });
      panels = listed.panels;
      recorded = listed.panels.find(panel => panel.id === panelId || panel.panelId === panelId);
    } catch (error) {
      if (!LIVE_SESSION_ENV.some(([, key]) => process.env[key])) {
        return { fresh: `Pane could not say which agent session this tab runs (${error instanceof Error ? error.message : String(error)}).` };
      }
    }
  } else if (!LIVE_SESSION_ENV.some(([, key]) => process.env[key])) {
    return { fresh: 'This terminal is not a Pane tab, so there is no agent session to carry.' };
  }
  const identified = senderSession(recorded);
  if ('fresh' in identified) return identified;
  const { sender } = identified;
  if (sender.agent !== destination.agent) {
    return { fresh: `Your session is ${sender.agent} and the receiver is ${destination.agent}; a session can't move between agents.` };
  }
  const session = await locateNativeSession(sender.agent, sender.id, process.cwd());
  if (!session) return { fresh: `${sender.agent} session ${sender.id} has no files in this machine's ${sender.agent} store.` };
  const carry: Carry = { session };
  if (sender.note) carry.note = sender.note;
  if (sender.live) {
    carry.live = true;
    // When PANE_PANEL_ID's tab records another session, report back to the tab that records this one.
    const owner = panels.find(panel => panel.resumeId === sender.id)?.id;
    if (recorded?.resumeId && recorded.resumeId !== sender.id) {
      carry.senderPanel = owner ?? null;
    } else if (!recorded?.resumeId && !owner && panels.filter(panel => panel.agentType === sender.agent && !panel.resumeId).length > 1) {
      // No tab records this session yet (Pane learns a Codex id when Codex exits), and several of
      // this agent's tabs could be the sender: an inherited PANE_PANEL_ID can't be trusted.
      carry.senderPanel = null;
    }
  }
  const snippet = lastMessageSnippet(session);
  if (snippet) carry.snippet = snippet;
  return { carry };
}

function describeCarry(carry: Carry, fork: boolean): ContinuityReport {
  return {
    carried: true,
    agent: carry.session.agent,
    sessionId: carry.session.id,
    fork,
    files: carry.session.files.length,
    bytes: carry.session.files.reduce((total, file) => total + file.bytes, 0),
    reason: (fork
      ? `The receiver resumes a fork of your ${carry.session.agent} session ${carry.session.id}: two agents never resume one session on one machine.`
      : `The receiver resumes your own ${carry.session.agent} session ${carry.session.id}, copied to the destination.`)
      + (carry.note ? ` ${carry.note}` : ''),
  };
}

/** Machine writes go through one request each; larger files go in parts joined on the destination. */
const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Where the session's main file already is in the destination's store, as a path under home,
 * so a session handed back and forth is replaced in place and its id never has two copies.
 * Two copies there is an error: runpane can't tell which one the agent resumes.
 */
async function existingCopy(destination: Destination, session: NativeSession): Promise<string | undefined> {
  const name = path.posix.basename(session.files[0].home);
  const store = session.files[0].home.split('/').slice(0, 2).join('/');
  const result = destination.os === 'Windows'
    ? await destination.run(['powershell', '-NoProfile', '-Command',
      `Get-ChildItem -Recurse -File -Path '${store}' -Filter '${name}' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`], 60_000)
    : await destination.run(['find', store, '-name', name, '-type', 'f'], 60_000);
  const found = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (found.length > 1) {
    throw new Error(`${destination.name} has ${found.length} copies of ${session.agent} session ${session.id} (${found.join(', ')}), so runpane can't tell which one ${session.agent} resumes there. Nothing was copied. Remove the stale copy on ${destination.name}, then run the handoff again`);
  }
  if (found.length === 0) return undefined;
  const normalized = found[0].replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith(`${store}/`)) return normalized;
  const index = normalized.indexOf(`/${store}/`);
  return index >= 0 ? normalized.slice(index + 1) : undefined;
}

function quoted(value: string, windows: boolean): string {
  // PowerShell also ends a single-quoted string at a typographic single quote.
  return windows ? `'${value.replace(/['‘’‚‛]/g, '$&$&')}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}

interface FileDigest {
  bytes: number;
  sha256: string;
}

/** Size and sha256 of each file on the destination (paths under home), by index; missing files are left out. */
async function destinationDigests(destination: Destination, files: string[]): Promise<Map<number, FileDigest>> {
  const windows = destination.os === 'Windows';
  const list = files.map(file => quoted(file, windows));
  // No double quotes in the PowerShell: Windows PowerShell mangles them in a nested -Command.
  const script = windows
    // .NET's SHA256, not Get-FileHash: a Windows PowerShell started from pwsh can fail to load the module that defines it.
    ? `$i=0; $sha=[Security.Cryptography.SHA256]::Create(); foreach ($p in @(${list.join(',')})) { if (Test-Path -LiteralPath $p -PathType Leaf) { $b=[IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $p).ProviderPath); ($i, $b.Length, ([BitConverter]::ToString($sha.ComputeHash($b)) -replace '-','').ToLower()) -join ' ' }; $i++ }`
    : `i=0; for p in ${list.join(' ')}; do if [ -f "$p" ]; then printf '%s %s %s\\n' "$i" "$(wc -c < "$p" | tr -d ' ')" "$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | cut -d ' ' -f 1)"; fi; i=$((i+1)); done`;
  const output = await mustRun(destination, windows ? ['powershell', '-NoProfile', '-Command', script] : ['sh', '-c', script], 'Reading the session files there', 300_000);
  const digests = new Map<number, FileDigest>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) ([0-9a-f]{64})$/.exec(line.trim());
    if (match) digests.set(Number(match[1]), { bytes: Number(match[2]), sha256: match[3] });
  }
  return digests;
}

/** A session file on its way into the destination's store; every path is under home. */
interface Placement {
  bytes: Buffer;
  /** Where the file goes. */
  target: string;
  /** Where it is written first, beside the target. */
  staged: string;
  /** Where the destination's previous copy waits until every file is in place. */
  previous: string;
}

/**
 * Copies the session's files into the destination agent's store; returns the main file's path
 * there. A copy already there (from an earlier handoff) is replaced only when this machine's copy
 * holds everything it does and no agent there is running it: history continued on the destination
 * is never overwritten. Every file is written beside its target and checked before any is swapped
 * in, and a failed swap puts the previous copy back. An OpenCode session goes in as its export,
 * imported into OpenCode's database from inside `repoPath`, so OpenCode files it under that repository.
 */
async function placeSession(destination: Destination, session: NativeSession, repoPath: string): Promise<string> {
  if (session.exported) return importOpenCodeSession(destination, session, repoPath);
  const windows = destination.os === 'Windows';
  const existing = await existingCopy(destination, session);
  const mainDir = path.posix.dirname(session.files[0].home);
  const targetDir = existing ? path.posix.dirname(existing) : mainDir;
  const tag = `handoff-${randomUUID().slice(0, 8)}`;
  const placements: Placement[] = session.files.map(file => {
    const target = targetDir + file.home.slice(mainDir.length);
    return { bytes: fs.readFileSync(file.absolute), target, staged: `${target}.${tag}`, previous: `${target}.${tag}.previous` };
  });

  if (existing) {
    const there = await destinationDigests(destination, placements.map(placement => placement.target));
    const diverged = placements.filter((placement, index) => {
      const digest = there.get(index);
      return digest !== undefined && (digest.bytes > placement.bytes.length || sha256(placement.bytes.subarray(0, digest.bytes)) !== digest.sha256);
    });
    if (diverged.length) {
      throw new Error(`${destination.name}'s copy of ${session.agent} session ${session.id} has history this machine's copy doesn't (${diverged.map(placement => placement.target).join(', ')}): it was continued there after an earlier handoff. Nothing was copied, so that history is kept. Continue it on ${destination.name}, or hand it off from there back to here`);
    }
    await refuseRunningReceivers(destination, session, 'copied');
  }

  const written: string[] = [];
  let mainPath = '';
  try {
    for (const placement of placements) {
      let staged: string;
      if (placement.bytes.length <= WRITE_CHUNK_BYTES) {
        staged = await destination.write(`~/${placement.staged}`, placement.bytes.toString('base64'), 'base64');
        written.push(staged);
      } else {
        const parts: string[] = [];
        for (let offset = 0, index = 0; offset < placement.bytes.length; offset += WRITE_CHUNK_BYTES, index += 1) {
          const part = await destination.write(`~/${placement.staged}.part${index}`, placement.bytes.subarray(offset, offset + WRITE_CHUNK_BYTES).toString('base64'), 'base64');
          parts.push(part);
          written.push(part);
        }
        staged = parts[0].replace(/\.part0$/, '');
        written.push(staged);
        const list = parts.map(part => quoted(part, windows));
        const join = windows
          ? ['powershell', '-NoProfile', '-Command', `$out = [IO.File]::Create(${quoted(staged, true)}); foreach ($p in @(${list.join(',')})) { $b = [IO.File]::ReadAllBytes($p); $out.Write($b, 0, $b.Length) }; $out.Close(); Remove-Item ${list.join(',')}`]
          : ['sh', '-c', `cat ${list.join(' ')} > ${quoted(staged, false)} && rm ${list.join(' ')}`];
        await mustRun(destination, join, `Joining ${path.posix.basename(placement.target)}`, 300_000);
      }
      if (placement === placements[0]) mainPath = staged.slice(0, -(tag.length + 1));
    }
    const staged = await destinationDigests(destination, placements.map(placement => placement.staged));
    const damaged = placements.filter((placement, index) => staged.get(index)?.sha256 !== sha256(placement.bytes));
    if (damaged.length) throw new Error(`The copies of ${damaged.map(placement => path.posix.basename(placement.target)).join(', ')} written to ${destination.name} don't match this machine's`);
  } catch (error) {
    const list = written.map(file => quoted(file, windows));
    if (list.length) {
      await destination.run(windows
        ? ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath ${list.join(',')}`]
        : ['sh', '-c', `rm -f ${list.join(' ')}`]).catch(() => undefined);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Nothing in ${destination.name}'s ${session.agent} store was changed`, { cause: error });
  }
  await mustRun(destination, swapScript(placements, windows), 'Putting the session files in place (any previous copy was put back)', 300_000);
  return mainPath;
}

/**
 * Moves each staged file over its target in one script, keeping the target's previous copy until
 * all are in place. If any move fails, every target gets its previous copy back (or is removed if
 * it had none) and the staged files are deleted, so the store holds the old session or the new one.
 */
function swapScript(placements: Placement[], windows: boolean): string[] {
  const q = (value: string): string => quoted(value, windows);
  if (windows) {
    const list = placements.map(placement => `$p += ,@(${q(placement.staged)}, ${q(placement.target)}, ${q(placement.previous)})`).join('; ');
    return ['powershell', '-NoProfile', '-Command', [
      `$ErrorActionPreference = 'Stop'; $p = @(); ${list}`,
      'function Undo { foreach ($x in $p) { if (Test-Path -LiteralPath $x[2]) { Move-Item -Force -LiteralPath $x[2] -Destination $x[1] } elseif (-not (Test-Path -LiteralPath $x[0])) { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $x[1] }; Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $x[0] } }',
      'try { foreach ($x in $p) { if (Test-Path -LiteralPath $x[1]) { Move-Item -LiteralPath $x[1] -Destination $x[2] }; Move-Item -LiteralPath $x[0] -Destination $x[1] } } catch { Undo; throw }',
      'foreach ($x in $p) { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $x[2] }',
      // -Command exits 1 when its last statement failed, even silently (no previous copy to remove).
      'exit 0',
    ].join('; ')];
  }
  const undo = placements.map(({ staged, target, previous }) =>
    `if [ -e ${q(previous)} ]; then mv -f ${q(previous)} ${q(target)}; elif [ ! -e ${q(staged)} ]; then rm -f ${q(target)}; fi; rm -f ${q(staged)}`).join('; ');
  const moves = placements.map(({ staged, target, previous }) =>
    `if [ -e ${q(target)} ]; then mv -f ${q(target)} ${q(previous)} || { undo; exit 1; }; fi; mv -f ${q(staged)} ${q(target)} || { undo; exit 1; }`);
  return ['sh', '-c', [`undo() { ${undo}; }`, ...moves, `rm -f ${placements.map(placement => q(placement.previous)).join(' ')}`].join('\n')];
}

/** Panels on the destination running this session, as "Pane <id> tab <id>". */
async function runningReceivers(destination: Destination, session: NativeSession): Promise<string[]> {
  // Panes list only Panes; a Session's agent tab lives in its hidden owner, so Sessions are listed too.
  const { panes } = await destination.invoke('runpane:panes:list', [{}], paneListResultSchema);
  const { sessions } = await destination.invoke('runpane:sessions:list', [], runpaneSessionListResultSchema);
  const owners = [
    ...panes.map(pane => ({ id: pane.id, label: `Pane ${pane.id}` })),
    ...sessions.map(record => ({ id: record.internalSessionId, label: `Session "${record.name}"` })),
  ];
  const running: string[] = [];
  for (const owner of owners) {
    const { panels } = await destination.invoke('runpane:panels:list', [{ paneId: owner.id }], panelListResultSchema);
    for (const panel of panels) {
      if (panel.running && panel.resumeId === session.id && panel.agentType === session.agent) running.push(`${owner.label} tab ${panel.id}`);
    }
  }
  return running;
}

/** Stops the copy when an agent on the destination is running this session. */
async function refuseRunningReceivers(destination: Destination, session: NativeSession, what: string): Promise<void> {
  const running = await runningReceivers(destination, session);
  if (running.length) {
    throw new Error(`${session.agent} session ${session.id} is open on ${destination.name} (${running.join(', ')}), and replacing it under a running agent would mix two conversations. Nothing was ${what}. Close it there first, then run the handoff again`);
  }
}

/** How `opencode export` says the session isn't in its database. */
const OPENCODE_NO_SESSION = /not\s*found|NotFoundError|no such session|does not exist/i;

/**
 * An OpenCode session goes in with `opencode import`. A session already there is replaced only
 * when this export holds every message it does and no agent there is running it; an export that
 * fails for any reason but a missing session stops the import.
 */
async function importOpenCodeSession(destination: Destination, session: NativeSession, repoPath: string): Promise<string> {
  const windows = destination.os === 'Windows';
  const inRepo = (command: string): string[] => windows
    ? ['powershell', '-NoProfile', '-Command', `Set-Location -LiteralPath ${quoted(repoPath, true)}; ${command}`]
    : ['sh', '-c', `cd ${quoted(repoPath, false)} && ${command}`];
  const exported = fs.readFileSync(session.files[0].absolute, 'utf8');
  const there = await destination.run(inRepo(`opencode export ${quoted(session.id, windows)}`), 120_000);
  if (there.exitCode !== 0) {
    // Only "no such session" means there is no history to keep; anything else (a locked database,
    // a broken install) means runpane can't tell, so it stops instead of importing over it.
    const detail = (there.stderr || there.stdout).trim().split('\n').slice(-3).join(' ');
    if (!OPENCODE_NO_SESSION.test(detail)) {
      throw new Error(`Couldn't read ${destination.name}'s OpenCode session ${session.id} to check for history this machine's copy lacks (${detail || `exit ${there.exitCode}`}). Nothing was imported. Fix that there, then run the handoff again`);
    }
  } else {
    await refuseRunningReceivers(destination, session, 'imported');
  }
  const missing = there.exitCode === 0 ? openCodeMessagesMissing(exported, there.stdout) : 0;
  if (missing) {
    throw new Error(`${destination.name}'s copy of OpenCode session ${session.id} has ${missing} message${missing === 1 ? '' : 's'} this machine's copy doesn't: it was continued there after an earlier handoff. Nothing was imported, so that history is kept. Continue it on ${destination.name}, or hand it off from there back to here`);
  }
  const written = await destination.write(`~/${session.files[0].home}`, Buffer.from(exported).toString('base64'), 'base64');
  await mustRun(destination, inRepo(`opencode import ${quoted(written, windows)}`), `opencode import of session ${session.id}`, 300_000);
  return `OpenCode's store, from ${written}`;
}

/** How long a receiver resuming a carried session has to reach its input box, unless --ready-timeout-ms says otherwise. */
const CARRIED_READY_TIMEOUT_MS = 120_000;

const PROBE = 'What were you last working on? Answer in one or two sentences.';

/** Checks 1 to 4 of the continuity check on the receiver, then says what was found. */
async function checkReceiver(options: {
  destination: Destination;
  carry: Carry;
  resumedId: string;
  paneId: string;
  panelId: string;
  ready: boolean;
  /** What the receiver's agent is waiting on, when it did not reach its input box. */
  blocked?: { message: string; suggestedCommand?: string };
  original?: OriginalSnapshot;
  /** How to look at the receiver from here. */
  inspect: string;
  /** A local runpane command, as run from here against the destination. */
  route(command: string): string;
}): Promise<Pick<ContinuityReport, 'checks' | 'result' | 'next'> & { why: string }> {
  const { destination, carry, resumedId, paneId, panelId, ready, blocked, original } = options;
  const listed = await destination.invoke('runpane:panels:list', [{ paneId }], panelListResultSchema);
  const panel = listed.panels.find(candidate => candidate.id === panelId || candidate.panelId === panelId);
  const restartResumes = panel?.resumeId === resumedId;
  const resumedById = restartResumes && (panel?.resumeSource ?? 'agent') === 'agent';
  let historyLoaded: boolean | null = null;
  if (ready && carry.snippet) {
    const screen = await destination.invoke('runpane:panels:screen', [{ panelId, limit: 400 }], panelScreenResultSchema);
    historyLoaded = screenShows(screen.text, carry.snippet);
  }
  const checks: NonNullable<ContinuityReport['checks']> = { resumedById, restartResumes, historyLoaded };
  const { changed, appended } = original ? await originalChanges(original, { appendOnly: carry.live }) : { changed: [], appended: [] };
  if (original) checks.originalUntouched = changed.length === 0;
  if (appended.length) checks.originalAppended = true;
  if (!resumedById || !restartResumes) {
    return { checks, result: 'not-continued', why: `Pane recorded ${panel?.resumeId ?? 'no id'} for the receiver, not ${resumedId}, so it is not resuming that session.` };
  }
  if (checks.originalUntouched === false) {
    return { checks, result: 'not-continued', why: `Your session changed while it was forked (${changed.join(', ')}).` };
  }
  const then = `then check it shows your last work, and ask it "${PROBE}" if that is unclear.`;
  if (!ready && blocked) {
    // The agent resumed the session but stopped on its own notice or dialog; history can be checked once it's answered.
    const prompt = blocked.message.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' / ');
    const command = blocked.suggestedCommand ? options.route(blocked.suggestedCommand) : undefined;
    const answers = command !== undefined && /\bpanels (?:input|submit)\b/.test(command);
    return {
      checks,
      result: 'inconclusive',
      why: `The receiver resumed the session but is waiting on its agent's own prompt: ${prompt}`,
      next: answers
        ? `Answer it with ${command} (or by hand), ${then}`
        : `Look at the prompt with ${command ?? options.inspect}, answer it in the receiver, ${then}`,
    };
  }
  if (!ready) {
    // Pane recorded the resumed id (checks 1 and 2), so the agent is resuming it; it is just slow to start.
    return {
      checks,
      result: 'inconclusive',
      why: 'The receiver is resuming the session but had not reached its input box when runpane stopped waiting, so its history was not checked.',
      next: `Look at it with ${options.inspect} until it is ready, ${then}`,
    };
  }
  if (historyLoaded === true) return { checks, result: 'continued', why: `The receiver shows the session's last message ("${carry.snippet}").` };
  return {
    checks,
    result: 'inconclusive',
    why: carry.snippet
      ? `The receiver is ready but its screen does not show the session's last message ("${carry.snippet}"); it may be scrolled or compacted.`
      : 'The receiver is ready, but this session\'s store is not text runpane can read, so its last message could not be compared.',
  };
}

/** What `runpane:doctor` says about the daemon's features; older Panes have none. */
const doctorFeaturesSchema = boundary.object({
  app: boundary.object({ version: boundary.string }),
  daemon: boundary.object({ features: boundary.optional(boundary.array(boundary.string)) }),
});

/**
 * The daemon feature (Pane's RUNPANE_DAEMON_FEATURES) that says panes, panels and sessions create
 * honour `resume`. An older Pane drops the field it doesn't know and starts a fresh conversation,
 * so a carried session must not be sent to it.
 */
const RESUME_ON_CREATE = 'resume-on-create';

async function assertResumesOnCreate(invoke: Destination['invoke'], where: string): Promise<void> {
  const doctor = await invoke('runpane:doctor', [], doctorFeaturesSchema);
  if (doctor.daemon.features?.includes(RESUME_ON_CREATE)) return;
  throw new RunpaneError(
    'ERR_HANDOFF_RESUME_UNSUPPORTED',
    `Pane ${doctor.app.version} on ${where} can't resume a carried session: it would start a fresh conversation and report it as yours. Nothing was committed, copied or created.`,
    `Update Pane on ${where} (runpane install client), then run the handoff again. Or ask the person before handing off with only the note: add --note-only.`,
  );
}

// ---------------------------------------------------------------- command

interface HandoffResult {
  ok: boolean;
  dryRun: boolean;
  destination: HandoffDestination & { name?: string; os?: Destination['os'] };
  note?: { path: string; sections: number; bytes: number };
  /** Absent on the Session route, which carries no git state. */
  git?: { repository: string; branch: string; head: string; remote: string; pushed: boolean; dirty: number };
  warnings: string[];
  repo?: { id: number; name: string; path: string; environment: string };
  notePath?: string;
  pane?: { id: string; panelId?: string; name?: string; worktreePath?: string };
  /** The Session the Session route created (no id on a dry run). */
  session?: { id?: string; name: string; machine: string };
  /**
   * Where the receiver runs and why: a tab in the sender's Pane (same checkout), its own new Pane,
   * or, from a Session's folder, a new Session on another machine.
   */
  receiver?: { route: 'tab' | 'new-pane' | 'session'; reason: string };
  /** Whether the receiver continues the sender's own session, and what the continuity check found. */
  continuity?: ContinuityReport;
  reportBack?: string;
}

export async function runHandoff(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const tailnet = await readTailnet();
  const self = tailnet.ok ? tailnet.self.name : (process.env.HOSTNAME ?? 'this-machine');
  // Which tab the receiver reports back to; planCarry may correct PANE_PANEL_ID.
  let senderPanel: string | null | undefined;
  const origin = (state: GitState | null): NoteOrigin => ({
    originMachine: self,
    originPane: process.env.PANE_SESSION_ID,
    originPanel: senderPanel === undefined ? process.env.PANE_PANEL_ID : senderPanel ?? undefined,
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
  // OpenCode receives a handoff only to continue an OpenCode session; a fresh OpenCode agent
  // with only the note is not supported. Decide that before touching git or the destination.
  const openCodePlan = destination.agent === 'opencode' ? await planCarry(parsed, destination) : undefined;
  if (openCodePlan && 'fresh' in openCodePlan) {
    throw new RunpaneError(
      'ERR_HANDOFF_OPENCODE_FRESH',
      `OpenCode receives a handoff only to continue your own OpenCode session, and this one can't be carried: ${openCodePlan.fresh} Nothing was committed or sent.`,
      'Run handoff from the OpenCode tab whose session should continue, or choose claude, codex or cursor for a fresh agent with the note.',
    );
  }
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

  // A Session's terminal sets PANE_ORCHESTRATION_SESSION_ID and a git ceiling, so its folder is
  // never a checkout. Anywhere inside git, even in a Session terminal, keeps the Pane route below.
  const sessionId = process.env.PANE_ORCHESTRATION_SESSION_ID;
  if (sessionId && !tryGit(['rev-parse', '--show-toplevel'], cwd)) {
    return handOffSession({ parsed, sessionId, destination, machines, self, origin: origin(null), noteText, noteInfo, warnings, say });
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
    : (panelId ? recovery('agents', 'status', '--panel', panelId) : recovery('agents', 'status', '--pane', sessionId));
  say(step('repo', `${repo.name} (${repo.path}), ${repo.environment ?? 'native'}, ${remote.os}, remote ${repoRemote}`));
  if (parsed.handoffPush && !parsed.dryRun && (!state.pushed || state.dirty.length)) {
    state = pushWork(state, machineLabel, parsed.handoffNoteFile);
  }
  if (state.dirty.length) warnings.push(`${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'} will not reach the receiver. Commit them, or pass --push to commit them as WIP.`);
  if (!state.pushed) warnings.push(`${state.branch} at ${state.head.slice(0, 7)} is not on ${state.remote}. Push it, or pass --push.`);
  say(step('git', `${state.branch} @ ${state.head.slice(0, 7)}, ${state.pushed ? `pushed to ${state.remote}` : 'NOT pushed'}${state.dirty.length ? `, ${state.dirty.length} uncommitted` : ''}`, state.pushed && !state.dirty.length));

  // A same-agent handoff carries the sender's own session; anything else is a fresh agent with the note.
  const plan = openCodePlan ?? await planCarry(parsed, destination);
  const carry = 'carry' in plan ? plan.carry : undefined;
  if (carry?.senderPanel !== undefined) {
    senderPanel = carry.senderPanel;
    if (senderPanel === null) warnings.push(`No tab in this Pane records ${carry.session.agent} session ${carry.session.id}, and this terminal's PANE_PANEL_ID may name another tab (it can be inherited from another tab's agent), so the receiver reports back on the branch instead of to a panel.`);
  }
  const continuity: ContinuityReport = carry ? describeCarry(carry, !target) : { carried: false, reason: 'fresh' in plan ? plan.fresh : '' };
  const noteOnlyCommand = `runpane handoff ${quote(text || describeDestination(destination, machineLabel), senderShell)} --note-file ${quote(parsed.handoffNoteFile ?? '<note>', senderShell)} --note-only`;
  // A second Cursor agent here would change the original chat (CURSOR_NO_FORK), so it is never
  // started; the note route is the person's call, not a silent fallback.
  const cursorHere = carry?.session.agent === 'cursor' && !target;
  if (cursorHere) {
    continuity.carried = false;
    continuity.reason = `${CURSOR_NO_FORK}. Nothing was copied and no receiver was started.`;
    continuity.next = `Ask the person before starting a fresh Cursor agent with the note instead: ${noteOnlyCommand}`;
  }
  say(carry && !cursorHere
    ? step('session', continuity.reason)
    : step('session', cursorHere ? continuity.reason : `A fresh ${destination.agent} with your note, not the same session. ${continuity.reason}`, false));

  const result: HandoffResult = {
    ok: true,
    dryRun: parsed.dryRun,
    destination: { ...destination, name: remote.name, os: remote.os },
    repo: { id: repo.id, name: repo.name, path: repo.path, environment: repo.environment ?? 'native' },
    note: noteInfo,
    git: { repository: state.repository, branch: state.branch, head: state.head, remote: state.remote, pushed: state.pushed, dirty: state.dirty.length },
    warnings,
    continuity,
  };
  if (parsed.dryRun) {
    for (const warning of warnings) say(`  ! ${warning}`);
    if (cursorHere) say(`Next: ${continuity.next}`);
    say('Dry run: nothing was sent.');
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (cursorHere) {
    continuity.result = 'not-continued';
    result.ok = false;
    say(`Next: ${continuity.next}`);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 1;
  }
  if (!carry) continuity.result = 'fresh-agent';
  if (!state.pushed) throw new Error(`${warnings.join(' ')}\nThe receiver would start without your work, so nothing was sent.`);
  if (carry) await assertResumesOnCreate(remote.invoke, remote.name);
  for (const warning of warnings) say(`  ! ${warning}`);

  await mustRun(remote, ['git', '-C', repo.path, 'fetch', repoRemote, state.branch], 'git fetch', 120_000);

  await mustRun(remote, ['git', '-C', repo.path, 'cat-file', '-e', `${state.head}^{commit}`], 'verify sender commit');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `handoff-${state.branch.replace(/^handoff[-/]/i, '')}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48).replace(/-+$/, '');
  const noteOrigin = origin(state);
  const stamped = stampNote(noteText ?? '', noteOrigin, receiverInstructions(noteOrigin, state, repoRemote, 'runpane'));
  const notePath = await remote.write(`~/.pane/handoffs/${stamp}-${name}-${randomUUID()}.md`, stamped);
  result.notePath = notePath;
  say(step('note sent', notePath));

  // Same machine: the receiver resumes a fork, so two agents never share one session file.
  // Another machine: the session is copied into that machine's store and resumed by its own id.
  let original: OriginalSnapshot | undefined;
  if (carry) {
    try {
      if (target) {
        const placed = await placeSession(remote, carry.session, repo.path);
        continuity.resumedId = carry.session.id;
        say(step('copied', `${continuity.files} file${continuity.files === 1 ? '' : 's'} of ${carry.session.agent} session ${carry.session.id} to ${placed}`));
      } else {
        original = await snapshotOriginal(carry.session, state.root);
        continuity.resumedId = await forkNativeSession(carry.session, state.root);
        say(step('forked', `${carry.session.agent} session ${carry.session.id} as ${continuity.resumedId}`));
      }
    } catch (error) {
      continuity.result = 'not-continued';
      continuity.reason = `Could not ${target ? 'copy' : 'fork'} your ${carry.session.agent} session ${carry.session.id}: ${error instanceof Error ? error.message : String(error)}. No receiver was started.`;
      continuity.next = `Fix that and run the handoff again, or ask the person before starting a fresh agent with the note instead: ${noteOnlyCommand}`;
      result.ok = false;
      say(step('session', continuity.reason, false));
      say(`Next: ${continuity.next}`);
      if (parsed.json) console.log(JSON.stringify(result, null, 2));
      return 1;
    }
  }
  const resumedId = continuity.resumedId;

  const toolCommand = agentCommand(destination, remote.shell);
  // Resuming a long session is slower than starting fresh (Codex on another machine took over 30 s in QA).
  const readyTimeoutMs = parsed.readyTimeoutMs ?? (resumedId ? CARRIED_READY_TIMEOUT_MS : undefined);
  // A resumed session already knows its work; it gets the note with the "moved" message after the check.
  const prompt = resumedId ? undefined : `Read the handoff note at ${notePath} and continue the work it describes. Start with its "Receiver instructions" section.`;
  // 1 feature = 1 worktree = 1 branch = 1 Pane: on this machine, from inside the
  // Pane that owns this checkout, the receiver opens as a new tab in that Pane.
  // Otherwise (another machine, or a checkout the sender's Pane does not own) it
  // gets a new Pane.
  const senderPane = target ? undefined : await senderPaneForCheckout(parsed, state.root);
  if (senderPane) {
    result.receiver = { route: 'tab', reason: `A new tab in Pane ${senderPane}, which owns this checkout. The receiver shares this worktree and branch; stop changing the branch yourself.` };
    say(step('receiver', result.receiver.reason));
  } else if (!target && process.env.PANE_SESSION_ID) {
    result.receiver = { route: 'new-pane', reason: `Pane ${process.env.PANE_SESSION_ID} does not own ${state.root}, so the receiver gets its own new Pane instead of a tab. Run handoff from a terminal in the Pane that owns this checkout to keep one Pane per feature.` };
    warnings.push(result.receiver.reason);
    say(step('receiver', result.receiver.reason, false));
  } else {
    result.receiver = { route: 'new-pane', reason: target ? `${remote.name} has no worktree for this branch, so the receiver gets a new Pane there.` : 'Not run from inside a Pane, so the receiver gets a new Pane.' };
  }
  let receiver: Receiver;
  if (senderPane) {
    const panelRequest = await buildPanelCreateRequest({
      ...parsed, readyTimeoutMs, paneId: senderPane, agent: destination.agent, toolCommand, initialInput: prompt,
      source: 'agent', noFocus: true, focus: false, waitReady: true, yes: true,
    });
    if (resumedId) panelRequest.resume = resumedId;
    try {
      const panel = await invokeDaemon('runpane:panels:create', [panelRequest], panelCreateResultSchema, {
        paneDir: parsed.paneDir,
        timeoutMs: (readyTimeoutMs ?? 30_000) + 10_000,
      });
      receiver = { ok: panel.ok, paneId: senderPane, panelId: panel.panelId, name: panel.title, initialInput: panel.initialInput, ready: panel.readiness?.ok === true, blocked: panel.readiness?.blocked, newTab: true };
    } catch (error) {
      throw new Error(`runpane panels create failed in Pane ${senderPane}: ${error instanceof Error ? error.message : String(error)}. The note was sent to ${notePath}.`);
    }
  } else {
    const request = await buildPaneCreateRequest({
      ...parsed, readyTimeoutMs, repo: String(repo.id), name, baseBranch: state.head, agent: destination.agent,
      toolCommand, initialInput: prompt, source: 'agent', noFocus: true, focus: false,
      waitReady: true, yes: true, noAssociate: true, fromJson: undefined,
    });
    if (resumedId) request.panes = request.panes.map(item => ({ ...item, resume: resumedId }));
    let created: ReturnType<typeof paneCreateResultSchema.decode>;
    try {
      // Workspace control carries JSON directly to the reached daemon, without
      // passing prompt arguments through the host shell or needing a host CLI.
      created = await remote.create(request);
    } catch (error) {
      throw new Error(`runpane panes create failed on ${remote.name}: ${error instanceof Error ? error.message : String(error)}. The note was sent to ${notePath}. Check ${recovery('sessions', 'list')} before retrying to avoid a duplicate Pane.`);
    }
    const item = created.items[0];
    if (item?.ok && item.sessionId && item.setupQueue) {
      result.pane = { id: item.sessionId, name: item.name, worktreePath: item.worktreePath };
      warnings.push(`Pane ${item.sessionId} was created and is queued for setup (${item.setupQueue.message}). The receiver starts after setup${resumedId ? ', resuming the session' : ' with the note'}; ${resumedId ? 'it is not checked' : 'its prompt is not verified'} yet, so do not retry. Check on it after setup: ${receiverStatus(item.sessionId)}`);
      for (const warning of warnings) say(`  ! ${warning}`);
      if (resumedId) {
        // The carry itself succeeded; only the check waits for setup, which is what inconclusive (exit 0) means.
        continuity.result = 'inconclusive';
        continuity.reason = `Pane ${item.sessionId} is queued for setup; its agent resumes ${resumedId} after setup, so the continuity check has not run.`;
        continuity.next = `After setup, check the receiver with ${receiverStatus(item.sessionId)} and, if its history is unclear, ask it: "${PROBE}". Then send it: ${receiverMessage(remote.name, item.worktreePath, notePath, true)}`;
        say(step('queued', continuity.reason, false));
        say(`Next: ${continuity.next}`);
        say(`Your session continues there after setup. End your turn now and make no more changes on ${state.branch}.`);
        if (parsed.json) console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      // The receiver's prompt rides on the launch after setup, so delivery is not verified yet.
      result.ok = false;
      if (parsed.json) console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    if (!item?.ok && !(resumedId && item?.sessionId && item.panelId)) {
      throw new Error(`Pane on ${remote.name} did not start the agent: ${item && 'error' in item ? item.error.message : 'no pane was created'}. The note was sent to ${notePath}.${item?.sessionId ? ` Pane ${item.sessionId}. Check ${receiverStatus(item.sessionId, item.panelId)} before retrying.${item.panelId && !target ? ` Inspect panel ${item.panelId}: ${recovery('panels', 'screen', '--panel', item.panelId)}.` : ''}` : ` Check ${recovery('sessions', 'list')} before retrying.`}`);
    }
    if (!item.sessionId || !item.panelId) throw new Error(`Pane on ${remote.name} reported no panel for the receiver. The note was sent to ${notePath}. Check ${recovery('sessions', 'list')} before retrying.`);
    const started = 'error' in item ? undefined : item;
    receiver = { ok: created.ok, paneId: item.sessionId, panelId: item.panelId, name: item.name, worktreePath: item.worktreePath, initialInput: started?.initialInput, ready: started?.readiness?.ok === true, blocked: started?.readiness?.blocked, newTab: false };
  }

  result.pane = { id: receiver.paneId, panelId: receiver.panelId, name: receiver.name, worktreePath: receiver.worktreePath };
  result.reportBack = noteOrigin.originPanel ? `${self} panel ${noteOrigin.originPanel}` : undefined;
  const inspect = recovery('panels', 'screen', '--panel', receiver.panelId);
  const check = receiverStatus(receiver.paneId, receiver.panelId);
  if (carry && resumedId) {
    return reportCarried({ parsed, result, continuity, carry, resumedId, receiver, destination: remote, original, say,
      target: Boolean(target), notePath, noteOnlyCommand, inspect, check, branch: state.branch,
      submit: (panelId: string) => recovery('panels', 'submit', '--panel', panelId, '--text', '<message>', '--yes'),
      route: (command: string) => command.replace(/^runpane\s+/,`${recovery()} `) });
  }
  const input = receiver.initialInput;
  const verified = input?.verifiedSubmitted === true
    && (input.delivery?.state === 'taken' || input.delivery?.state === 'queued')
    && !input.blocked && !input.error;
  if (!verified || !receiver.ok) {
    result.ok = false;
    warnings.push(`Receiver prompt is not verified submitted on panel ${receiver.panelId}${input?.blocked?.message || input?.error?.message ? `: ${input.blocked?.message ?? input.error?.message}` : ` (${input?.delivery?.state ?? 'missing delivery evidence'})`}. ${receiver.newTab ? `A new tab was opened in Pane ${receiver.paneId}` : `Pane ${receiver.paneId} was created`}; do not retry blindly. Inspect it: ${inspect}`);
    for (const warning of warnings) say(`  ! ${warning}`);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 1;
  }
  say(step('started', receiver.newTab ? `${receiver.name ?? name} as a new tab in Pane ${receiver.paneId}` : `${receiver.name ?? name} on ${remote.name}${receiver.worktreePath ? ` (${receiver.worktreePath})` : ''}`));
  say(`It is a fresh ${destination.agent} with your note, not the same session.`);
  say(result.reportBack ? `The receiver reports back to ${result.reportBack}.` : 'No sender panel to report to; the receiver reports on the branch.');
  say(`Check on it: ${check}`);
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

/**
 * The first message a receiver that resumed the sender's session gets, after the check: where it
 * now runs when the folder or machine changed, and where the sender's note is.
 */
function receiverMessage(machine: string, movedTo: string | undefined, notePath: string, moved: boolean): string {
  return `${moved ? `This session moved to ${movedTo ?? 'a new worktree'} on ${machine}.` : 'This session was handed off to this tab.'} Continue from where you were. The sender's handoff note is at ${notePath}; follow its "Receiver instructions" to report back.`;
}

interface CarriedReport {
  parsed: ParsedArgs;
  result: HandoffResult;
  continuity: ContinuityReport;
  carry: Carry;
  resumedId: string;
  receiver: Receiver;
  destination: Destination;
  original?: OriginalSnapshot;
  target: boolean;
  notePath: string;
  noteOnlyCommand: string;
  inspect: string;
  check: string;
  /** A local runpane command, as run from here against the destination. */
  route(command: string): string;
  branch: string;
  submit(panelId: string): string;
  say(line: string): void;
}

/**
 * Runs the continuity check on a receiver that resumed the sender's session, sends the "moved"
 * message when it passed and the folder or machine changed, and reports. A receiver that fails
 * is kept and never replaced: the next step names the note route for the person to choose.
 */
async function reportCarried(report: CarriedReport): Promise<number> {
  const { parsed, result, continuity, carry, resumedId, receiver, destination, original, target, say } = report;
  const checked = await checkReceiver({ destination, carry, resumedId, paneId: receiver.paneId, panelId: receiver.panelId, ready: receiver.ready, blocked: receiver.blocked, original, inspect: report.inspect, route: report.route });
  continuity.checks = checked.checks;
  continuity.result = checked.result;
  continuity.reason = carry.note ? `${checked.why} ${carry.note}` : checked.why;
  const where = receiver.newTab ? `a new tab in Pane ${receiver.paneId}` : `Pane ${receiver.paneId} on ${destination.name}${receiver.worktreePath ? ` (${receiver.worktreePath})` : ''}`;
  const moved = target || !receiver.newTab;
  // The receiver started without a prompt, so it learns of the handoff (and its note) only from this.
  const message = receiverMessage(destination.name, moved ? receiver.worktreePath ?? 'a new worktree' : undefined, report.notePath, moved);
  if (checked.result === 'continued') {
    const manual = `Send it yourself: ${report.submit(receiver.panelId)} with: ${message}`;
    try {
      const sent = await destination.invoke('runpane:panels:submit', [{ panelId: receiver.panelId, input: message, source: 'agent' }], panelSubmitResultSchema);
      if (!sent.ok) result.warnings.push(`The message telling the receiver to continue was not delivered to panel ${receiver.panelId}. ${manual}`);
    } catch (error) {
      // The check passed and the receiver is kept; only this message's delivery is unknown.
      result.warnings.push(`Sending the receiver its message to continue failed (${error instanceof Error ? error.message : String(error)}), so it may or may not have arrived. Look at the receiver first: ${report.inspect}. If the message isn't there, ${manual.charAt(0).toLowerCase()}${manual.slice(1)}`);
    }
    say(step('continued', `${carry.session.agent} session ${resumedId}${continuity.fork ? ` (a fork of ${carry.session.id})` : ''} in ${where}. ${checked.why}`));
  } else if (checked.result === 'inconclusive') {
    continuity.next = `${checked.next ?? `Ask the receiver "${PROBE}" with ${report.submit(receiver.panelId)}, and compare its answer with your own last work.`} If it matches, send it this message: "${message}" If not, tell the person it is not continued.`;
    say(step('unclear', `${where}. ${checked.why}`, false));
    say(`Next: ${continuity.next}`);
  } else {
    result.ok = false;
    continuity.next = `The receiver is kept in ${where}; inspect it with ${report.inspect}. Ask the person before starting a fresh agent with the note instead: ${report.noteOnlyCommand}`;
    say(step('not continued', checked.why, false));
    say(`Next: ${continuity.next}`);
  }
  for (const warning of result.warnings) say(`  ! ${warning}`);
  if (checked.result !== 'not-continued') {
    say(`Your session now continues in ${where}. End your turn now and make no more changes on ${report.branch}; the person can close this tab.`);
    say(`Check on it: ${report.check}`);
  }
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  return checked.result === 'not-continued' ? 1 : 0;
}

interface SessionHandoff {
  parsed: ParsedArgs;
  sessionId: string;
  destination: HandoffDestination;
  machines: TailnetMachine[];
  self: string;
  origin: NoteOrigin;
  noteText?: string;
  noteInfo?: HandoffResult['note'];
  warnings: string[];
  say(line: string): void;
}

/**
 * The Session route. From a Session's folder there is no git to move, so the receiver is a new
 * Session on another machine with the sender's name, goal and agent, and the note as its context
 * and next action. Nothing is pushed or copied but the note, and the sender Session stays as it is.
 * Like every Session, the receiver waits for its first message.
 */
async function handOffSession({ parsed, sessionId, destination, machines, self, origin, noteText, noteInfo, warnings, say }: SessionHandoff): Promise<number> {
  const target = destination.machine ? machines.find((machine) => machine.name === destination.machine) : undefined;
  if (!target) {
    throw new RunpaneError(
      'ERR_HANDOFF_SESSION_SAME_MACHINE',
      `A Session hands off to another machine, and the destination is ${self}, the machine this Session is on. Nothing was sent.`,
      `Name another of your machines: runpane handoff "${destination.agent} on <machine>" --note-file <note>. List them with: runpane workspace list`,
    );
  }
  const { session: source } = await invokeDaemon('runpane:sessions:get', [{ sessionId }], runpaneSessionResultSchema, { paneDir: parsed.paneDir });
  const remote = workspaceTarget(target);
  const listed = await invokeRemoteDaemon(remote, 'runpane:sessions:list', [], runpaneSessionListResultSchema);
  const name = nextFreeName(source.name, listed.sessions.map((session) => session.name));
  if (parsed.handoffPush) warnings.push('--push does nothing from a Session: its folder is not a git checkout, so nothing was committed or pushed.');
  const result: HandoffResult = {
    ok: true,
    dryRun: parsed.dryRun,
    destination: { ...destination, name: target.name },
    note: noteInfo,
    warnings,
    receiver: { route: 'session', reason: `A Session's folder has no branch to move, so the receiver is a new Session on ${target.name}.` },
    session: { name, machine: target.name },
  };
  // A same-agent move carries the Session agent's own conversation; the new Session resumes it when opened.
  const plan = await planCarry(parsed, destination);
  const carry = 'carry' in plan ? plan.carry : undefined;
  const continuity: ContinuityReport = carry ? describeCarry(carry, false) : { carried: false, reason: 'fresh' in plan ? plan.fresh : '' };
  result.continuity = continuity;
  say(step('session', `"${source.name}" becomes "${name}" on ${target.name}`));
  say(carry
    ? step('session', continuity.reason)
    : step('session', `A fresh ${destination.agent} with your note, not the same conversation. ${continuity.reason}`, false));
  for (const warning of warnings) say(`  ! ${warning}`);
  if (parsed.dryRun) {
    say('Dry run: nothing was sent.');
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (carry) await assertResumesOnCreate((channel, args, schema) => invokeRemoteDaemon(remote, channel, args, schema), target.name);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const slug = `handoff-${source.name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48).replace(/-+$/, '');
  const stamped = stampNote(noteText ?? '', origin, sessionReceiverInstructions(origin, source.name, target.name, carry !== undefined));
  const written = await invokeRemoteDaemon(remote, 'runpane:machine:write', [{ path: `~/.pane/handoffs/${stamp}-${slug}-${randomUUID()}.md`, content: stamped, encoding: 'utf8' }], writeResultSchema);
  const notePath = written.path;
  result.notePath = notePath;
  say(step('note sent', notePath));
  if (carry) {
    try {
      const placed = await placeSession(await remoteDestination(target), carry.session, '~');
      continuity.resumedId = carry.session.id;
      say(step('copied', `${carry.session.agent} session ${carry.session.id} to ${placed}`));
    } catch (error) {
      continuity.result = 'not-continued';
      continuity.reason = `Could not copy your ${carry.session.agent} session ${carry.session.id}: ${error instanceof Error ? error.message : String(error)}. No Session was created.`;
      continuity.next = `Fix that and run the handoff again, or ask the person before moving the Session with only the note: runpane handoff ${quote(parsed.handoffDestination ?? `${destination.agent} on ${target.name}`, 'sh')} --note-file <note> --note-only`;
      result.ok = false;
      say(step('session', continuity.reason, false));
      say(`Next: ${continuity.next}`);
      if (parsed.json) console.log(JSON.stringify(result, null, 2));
      return 1;
    }
  } else {
    continuity.result = 'fresh-agent';
  }

  const launchCommand = agentCommand(destination, 'sh');
  let created: ReturnType<typeof runpaneSessionResultSchema.decode>;
  try {
    created = await invokeRemoteDaemon(remote, 'runpane:sessions:create', [{
      name,
      agent: destination.agent,
      goal: source.goal,
      context: carry
        ? `Handed off from Session "${source.name}" on ${self}, which stays there. This Session resumes that Session's own ${carry.session.agent} conversation; the sending agent's handoff note is at ${notePath} on this machine.`
        : `Handed off from Session "${source.name}" on ${self}, which stays there. The sending agent's handoff note is at ${notePath} on this machine: read it first, including its "Receiver instructions".`,
      nextAction: `Read the handoff note at ${notePath} and continue from it.`,
      launchCommand,
      resume: continuity.resumedId,
    }], runpaneSessionResultSchema, REPORT_TIMEOUT_MS);
  } catch (error) {
    throw new RunpaneError(
      'ERR_HANDOFF_SESSION_CREATE',
      `runpane sessions create failed on ${target.name}: ${error instanceof Error ? error.message : String(error)}. The note was sent to ${notePath}; no Session was confirmed.`,
      `Check runpane workspace ${target.name} sessions list before retrying, so you don't create a duplicate Session.`,
    );
  }
  result.session = { id: created.session.id, name: created.session.name, machine: target.name };
  result.reportBack = origin.originPanel ? `${self} panel ${origin.originPanel}` : undefined;
  say(step('created', `Session "${created.session.name}" on ${target.name}`));
  if (carry) {
    // The Session's tab must already record the carried id, or opening it starts a fresh conversation.
    const recorded = await sessionResumeId(remote, created);
    if (recorded !== continuity.resumedId) {
      continuity.result = 'not-continued';
      continuity.checks = { resumedById: false, restartResumes: false, historyLoaded: null };
      continuity.reason = `Session "${created.session.name}" on ${target.name} records ${recorded ?? 'no conversation'} for its agent, not ${continuity.resumedId}, so opening it would not continue your conversation.`;
      continuity.next = `The Session is kept on ${target.name}; look at it before archiving it. Ask the person before moving the Session with only the note instead: runpane handoff ${quote(parsed.handoffDestination ?? `${destination.agent} on ${target.name}`, 'sh')} --note-file <note> --note-only`;
      result.ok = false;
      say(step('not continued', continuity.reason, false));
      say(`Next: ${continuity.next}`);
      if (parsed.json) console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    continuity.checks = { resumedById: true, restartResumes: true, historyLoaded: null };
    // A Session's agent launches when the person opens it, so the history check runs then.
    continuity.result = 'inconclusive';
    continuity.reason = `"${created.session.name}" resumes ${carry.session.agent} session ${carry.session.id} when it is first opened; its history can only be checked then.`;
    continuity.next = `Open "${created.session.name}" on ${target.name} and check it shows your last message${carry.snippet ? ` ("${carry.snippet}")` : ''}; if that is unclear, ask it "${PROBE}". Then send it: This session moved to ${target.name}. Continue from where you were. The handoff note is at ${notePath}.`;
    say(step('resumes', continuity.reason));
    say(`Next: ${continuity.next}`);
    say('Your conversation now continues on that machine. End your turn now; the person can archive this Session when they are done with it.');
  } else {
    say(`It waits for your first message: switch Pane to ${target.name}, open "${created.session.name}", and send "continue".`);
  }
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

/** The conversation id a new Session's agent tab records, which it resumes when first opened. */
async function sessionResumeId(remote: ReturnType<typeof workspaceTarget>, created: ReturnType<typeof runpaneSessionResultSchema.decode>): Promise<string | undefined> {
  if (!created.internalSessionId || !created.panelId) return undefined;
  const listed = await invokeRemoteDaemon(remote, 'runpane:panels:list', [{ paneId: created.internalSessionId }], panelListResultSchema);
  return listed.panels.find(panel => panel.id === created.panelId || panel.panelId === created.panelId)?.resumeId;
}

/** Pane's numbering for a taken Session name: "<name> 2", "<name> 3", compared without case. */
function nextFreeName(name: string, taken: readonly string[]): string {
  const normalize = (value: string): string => value.trim().toLocaleLowerCase();
  const names = new Set(taken.map(normalize));
  let candidate = name;
  for (let suffix = 2; names.has(normalize(candidate)); suffix += 1) candidate = `${name} ${suffix}`;
  return candidate;
}

function sessionReceiverInstructions(origin: NoteOrigin, sender: string, receiverMachine: string, carried: boolean): string {
  const reportTarget = origin.originPanel
    ? `runpane workspace ${origin.originMachine} panels submit --panel ${origin.originPanel} --text "<one line: what you finished, and anything blocked>" --yes`
    : 'tell the person here, since the sender left no panel to report to';
  return [
    '## Receiver instructions',
    '',
    '<!-- Added by runpane handoff. -->',
    carried
      ? `1. You are a new Session on ${receiverMachine}, continuing Session "${sender}" from ${origin.originMachine} in its own conversation, which was copied here. Its Session folder and Panes stay on ${origin.originMachine}.`
      : `1. You are a new Session on ${receiverMachine}, continuing Session "${sender}" from ${origin.originMachine}. Only this note was sent: the sender's conversation, Session folder and Panes stay on ${origin.originMachine}.`,
    `2. Read this whole note. To read a file it names from the sender's machine, run \`runpane workspace ${origin.originMachine} read <path>\`.`,
    '3. Continue from "Next steps".',
    `4. When you finish or get blocked, report back to the sender: ${reportTarget}`,
  ].join('\n');
}

interface Receiver {
  ok: boolean;
  paneId: string;
  panelId: string;
  name?: string;
  worktreePath?: string;
  initialInput?: ReturnType<typeof panelCreateResultSchema.decode>['initialInput'];
  /** The receiver's agent reached its input box when it was created. */
  ready: boolean;
  /** What the receiver's agent stopped on instead, when Pane could tell. */
  blocked?: { message: string; suggestedCommand?: string };
  newTab: boolean;
}

/**
 * The sender's Pane when it owns this checkout: PANE_SESSION_ID names a Pane in the
 * selected local Pane whose worktree is this git root. Anything else (no Pane, a
 * different checkout, an unreachable daemon) returns undefined, so the receiver
 * gets its own Pane instead of a tab in the wrong worktree.
 */
async function senderPaneForCheckout(parsed: ParsedArgs, gitRoot: string): Promise<string | undefined> {
  const paneId = process.env.PANE_SESSION_ID;
  if (!paneId) return undefined;
  try {
    const listed = await invokeDaemon('runpane:panes:list', [{}], paneListResultSchema, { paneDir: parsed.paneDir });
    const pane = listed.panes.find(candidate => candidate.id === paneId);
    if (!pane?.worktreePath) return undefined;
    return fs.realpathSync.native(pane.worktreePath) === fs.realpathSync.native(gitRoot) ? paneId : undefined;
  } catch {
    return undefined;
  }
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
