import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema } from './boundaryDecoder';

/**
 * An agent's own session (a Claude Code transcript, a Codex rollout, a Cursor chat, an OpenCode
 * session) as files, so `runpane handoff` can carry it to another machine or fork it on this one.
 * The stores are each tool's internal format; this module only finds, copies and forks them, and
 * prefers each tool's own commands to editing files. OpenCode keeps sessions in a database, so its
 * session travels as the file `opencode export` writes and `opencode import` reads.
 */
export type NativeAgent = 'claude' | 'codex' | 'cursor' | 'opencode';

interface StoreFile {
  absolute: string;
  /** Path relative to the user's home folder, with forward slashes: where the copy goes on the destination. */
  home: string;
  bytes: number;
}

export interface NativeSession {
  agent: NativeAgent;
  id: string;
  /** The store's folder under the home folder: `.claude`, `.codex` or `.cursor`. */
  storeDir: string;
  /** The session's main file, then any files that belong to it (Claude subagent transcripts, a Cursor chat's folder). */
  files: StoreFile[];
  /** A Cursor chat's own folder, which is the whole session. */
  folder?: string;
  /** OpenCode: the one file is an export, which the destination brings in with `opencode import`. */
  exported?: true;
}

export function isNativeAgent(value: string | undefined): value is NativeAgent {
  return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'opencode';
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

interface StoreLocation {
  /** Where the store is on this machine. */
  root: string;
  /** The store's default folder under home, which is where a copy goes on another machine. */
  storeDir: string;
}

function storeRoot(agent: Exclude<NativeAgent, 'opencode'>, env: NodeJS.ProcessEnv): StoreLocation {
  const home = homeDirectory(env);
  if (agent === 'claude') return { root: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), storeDir: '.claude' };
  if (agent === 'codex') return { root: env.CODEX_HOME || path.join(home, '.codex'), storeDir: '.codex' };
  return { root: path.join(home, '.cursor'), storeDir: '.cursor' };
}

function entries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function filesUnder(directory: string): string[] {
  return entries(directory).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : [];
  });
}

/** Where a file sits relative to the store root, re-rooted at the store's default folder under home. */
function storeFile(absolute: string, root: string, storeDir: string): StoreFile {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  return { absolute, home: `${storeDir}/${relative}`, bytes: fs.statSync(absolute).size };
}

/**
 * The files of one session on this machine, or undefined when the store has none. Throws when
 * the id is ambiguous (two copies in one store), which the agent itself cannot resume either.
 * `cwd` is where an OpenCode export runs.
 */
export async function locateNativeSession(agent: NativeAgent, id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<NativeSession | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
  if (agent === 'opencode') return exportOpenCodeSession(id, cwd);
  const { root, storeDir } = storeRoot(agent, env);
  const mains: string[] = [];
  const extras: string[] = [];
  let folder: string | undefined;
  if (agent === 'claude') {
    for (const project of entries(path.join(root, 'projects')).filter(entry => entry.isDirectory())) {
      const projectDir = path.join(root, 'projects', project.name);
      const transcript = path.join(projectDir, `${id}.jsonl`);
      if (fs.existsSync(transcript)) {
        mains.push(transcript);
        // Claude keeps a session's subagent transcripts in a folder named by its id.
        extras.push(...filesUnder(path.join(projectDir, id)));
      }
    }
  } else if (agent === 'codex') {
    const pattern = new RegExp(`^rollout-.*${id.replace(/[.]/g, '\\.')}\\.jsonl(?:\\.zst)?$`);
    for (const file of filesUnder(path.join(root, 'sessions'))) {
      if (pattern.test(path.basename(file))) mains.push(file);
    }
  } else {
    for (const workspace of entries(path.join(root, 'chats')).filter(entry => entry.isDirectory())) {
      const chat = path.join(root, 'chats', workspace.name, id);
      const files = filesUnder(chat);
      if (files.length) {
        folder = chat;
        mains.push(files[0]);
        extras.push(...files.slice(1));
      }
    }
  }
  if (mains.length === 0) return undefined;
  if (mains.length > 1) {
    throw new Error(`${agent} has ${mains.length} copies of session ${id} on this machine (${mains.join(', ')}), so it cannot tell which one to resume.`);
  }
  const located: NativeSession = { agent, id, storeDir, files: [mains[0], ...extras].map(file => storeFile(file, root, storeDir)) };
  if (folder) located.folder = folder;
  return located;
}

/** An OpenCode export: the session and its messages, each with parts of which some carry text. */
const openCodeExportSchema = boundary.object({
  info: boundary.object({ id: boundary.string }),
  messages: boundary.array(boundary.object({
    info: boundary.object({ role: boundary.optional(boundary.string) }),
    parts: boundary.optional(boundary.array(boundary.object({ type: boundary.optional(boundary.string), text: boundary.optional(boundary.string) }))),
  })),
});

async function openCodeExport(id: string, cwd: string): Promise<string | undefined> {
  const result = await run('opencode', ['export', id], cwd, 120_000);
  if (result.code !== 0) return undefined;
  // The JSON is on stdout; a progress line goes to stderr.
  const start = result.stdout.indexOf('{');
  return start >= 0 ? result.stdout.slice(start) : undefined;
}

/** An OpenCode session as the file `opencode export` writes, in a private temporary folder. */
async function exportOpenCodeSession(id: string, cwd: string): Promise<NativeSession | undefined> {
  const text = await openCodeExport(id, cwd);
  if (text === undefined) return undefined;
  try {
    if (decodeBoundary(JSON.parse(text), openCodeExportSchema).info.id !== id) return undefined;
  } catch {
    return undefined;
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-opencode-'));
  const absolute = path.join(folder, `${id}.json`);
  fs.writeFileSync(absolute, text, { mode: 0o600 });
  return {
    agent: 'opencode', id, storeDir: '.pane', exported: true,
    files: [{ absolute, home: `.pane/handoffs/opencode-${id}.json`, bytes: Buffer.byteLength(text) }],
  };
}

function openCodeLastMessage(text: string): string | undefined {
  try {
    const { messages } = decodeBoundary(JSON.parse(text), openCodeExportSchema);
    for (const message of [...messages].reverse()) {
      if (message.info.role !== 'user' && message.info.role !== 'assistant') continue;
      const snippet = snippetOf((message.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'));
      if (snippet) return snippet;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A message's content as Claude and Codex store it: a string, or parts of which some carry text. */
const contentSchema = boundary.union(
  boundary.string,
  boundary.array(boundary.object({ type: boundary.optional(boundary.string), text: boundary.optional(boundary.string) })),
);
type MessageContent = ReturnType<typeof contentSchema.decode>;

/** A Claude transcript line; other fields are ignored. */
const claudeLineSchema = boundary.object({
  type: boundary.string,
  isMeta: boundary.optional(boundary.boolean),
  message: boundary.optional(boundary.object({ content: boundary.optional(contentSchema) })),
});

/** A Codex rollout line; a message is a `response_item` whose payload has a role. */
const codexLineSchema = boundary.object({
  type: boundary.string,
  payload: boundary.optional(boundary.object({
    type: boundary.optional(boundary.string),
    role: boundary.optional(boundary.string),
    content: boundary.optional(contentSchema),
  })),
});

const TEXT_PARTS = new Set(['text', 'output_text', 'input_text']);

function messageText(content: MessageContent | undefined): string {
  if (!Array.isArray(content)) return content ?? '';
  return content.map(part => (part.type === undefined || TEXT_PARTS.has(part.type) ? part.text ?? '' : '')).join('\n');
}

/** Decodes one JSON line with `schema`, or undefined when the line is not that kind of record. */
function decodeLine<Value>(line: string, schema: BoundarySchema<Value>): Value | undefined {
  try {
    return decodeBoundary(JSON.parse(line), schema);
  } catch {
    return undefined;
  }
}

/** The text of a complete user or assistant message on one transcript line, if the line is one. */
function lineMessage(agent: NativeAgent, line: string): string {
  if (agent === 'claude') {
    const record = decodeLine(line, claudeLineSchema);
    if (!record || (record.type !== 'user' && record.type !== 'assistant') || record.isMeta === true) return '';
    return messageText(record.message?.content);
  }
  const record = decodeLine(line, codexLineSchema);
  const payload = record?.type === 'response_item' ? record.payload : undefined;
  if (payload?.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) return '';
  const text = messageText(payload.content);
  // Codex records its own context as user messages wrapped in tags.
  return /^\s*</.test(text) ? '' : text;
}

/**
 * A short, distinctive phrase from the last complete user or assistant message in the session,
 * for checking that the resumed agent shows its history. Undefined when the store is not text
 * this module can read (a compressed rollout, a Cursor chat).
 */
export function lastMessageSnippet(session: NativeSession): string | undefined {
  const main = session.files[0];
  if (session.agent === 'cursor' || main.absolute.endsWith('.zst')) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(main.absolute, 'utf8');
  } catch {
    return undefined;
  }
  if (session.agent === 'opencode') return openCodeLastMessage(text);
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const message = lineMessage(session.agent, lines[index]);
    const snippet = snippetOf(message);
    if (snippet) return snippet;
  }
  return undefined;
}

/** The first few words of the message's last line of prose: short enough not to wrap on screen. */
function snippetOf(message: string): string | undefined {
  const lines = message.split('\n')
    .map(line => line.replace(/[`*_#>|[\]]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(line => line.split(' ').length >= 3);
  const last = lines.at(-1);
  if (!last) return undefined;
  const words: string[] = [];
  for (const word of last.split(' ')) {
    if ([...words, word].join(' ').length > 40) break;
    words.push(word);
  }
  return words.length >= 3 ? words.join(' ') : undefined;
}

/** Whether a screen shows the snippet, ignoring line wrapping and spacing. */
export function screenShows(screen: string, snippet: string): boolean {
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').toLowerCase();
  return normalize(screen).includes(normalize(snippet));
}

interface FileStamp {
  absolute: string;
  bytes: number;
  modifiedMs: number;
}

/** How the original looked before a fork, to prove the fork left it untouched (continuity check 4). */
export type OriginalSnapshot =
  | { kind: 'files'; stamps: FileStamp[] }
  | { kind: 'export'; id: string; cwd: string; text: string | undefined };

export async function snapshotOriginal(session: NativeSession, cwd: string): Promise<OriginalSnapshot> {
  if (session.agent === 'opencode') return { kind: 'export', id: session.id, cwd, text: await openCodeExport(session.id, cwd) };
  return {
    kind: 'files',
    stamps: session.files.map(file => {
      const stat = fs.statSync(file.absolute);
      return { absolute: file.absolute, bytes: stat.size, modifiedMs: stat.mtimeMs };
    }),
  };
}

/** What changed in the original since the snapshot: files whose size or time changed, or the session's export. */
export async function originalChanges(snapshot: OriginalSnapshot): Promise<string[]> {
  if (snapshot.kind === 'export') {
    return (await openCodeExport(snapshot.id, snapshot.cwd)) === snapshot.text ? [] : [`OpenCode session ${snapshot.id}`];
  }
  return snapshot.stamps.filter(stamp => {
    try {
      const stat = fs.statSync(stamp.absolute);
      return stat.size !== stamp.bytes || stat.mtimeMs !== stamp.modifiedMs;
    } catch {
      return true;
    }
  }).map(stamp => stamp.absolute);
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // Agent CLIs install as .cmd shims on Windows, which only a shell can start. Every argument
    // here is an id, a flag or a fixed sentence, quoted below.
    const windows = process.platform === 'win32';
    const child = spawn(windows ? [command, ...args.map(arg => (/^[\w.:=/-]+$/.test(arg) ? arg : `"${arg}"`))].join(' ') : command,
      windows ? [] : args, { cwd, shell: windows, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => resolve({ code: 1, stdout, stderr: stderr + error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function failure(what: string, result: { code: number | null; stdout: string; stderr: string }): Error {
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
  return new Error(`${what} failed: ${detail || `exit ${result.code}`}`);
}

/**
 * A new session with its own id holding a copy of this one's history, made with the agent's own
 * fork so the original is never written. Each fork runs one short turn of its own (never in the
 * original). Cursor has no fork command, so its chat folder is copied under a new id, best effort.
 */
const FORK_PROMPT = 'This conversation was forked for a handoff. Reply with one word: forked.';

export async function forkNativeSession(session: NativeSession, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (session.agent === 'claude') {
    const forkId = randomUUID();
    const result = await run('claude', ['-p', '--resume', session.id, '--fork-session', '--session-id', forkId, FORK_PROMPT], cwd, 300_000);
    if (result.code !== 0) throw failure(`claude --resume ${session.id} --fork-session`, result);
    if (!await locateNativeSession('claude', forkId, cwd, env)) throw new Error(`claude reported a fork, but its transcript ${forkId}.jsonl is not in the store.`);
    return forkId;
  }
  if (session.agent === 'codex') {
    // A fork with no turn of its own can lead Codex back to the original when it is opened, which
    // then writes to the original's file, so the fork carries one short turn.
    const result = await run('codex', ['exec', 'fork', session.id, FORK_PROMPT, '--json'], cwd, 300_000);
    // `--json` prints one event per line; the fork's id arrives as `thread.started`'s thread_id.
    const started = result.stdout.split('\n')
      .map(line => decodeLine(line, boundary.object({ thread_id: boundary.string }))?.thread_id)
      .find(Boolean);
    if (!started) throw failure(`codex exec fork ${session.id}`, result);
    return started;
  }
  if (session.agent === 'opencode') {
    // `--format json` prints one event per line, each naming the session it belongs to: the fork.
    const result = await run('opencode', ['run', '--session', session.id, '--fork', '--format', 'json', FORK_PROMPT], cwd, 300_000);
    const forked = result.stdout.split('\n')
      .map(line => decodeLine(line, boundary.object({ sessionID: boundary.string }))?.sessionID)
      .find(id => id !== undefined && id !== session.id);
    if (!forked) throw failure(`opencode run --session ${session.id} --fork`, result);
    return forked;
  }
  if (!session.folder) throw new Error(`Cursor chat ${session.id} has no folder to copy.`);
  const forkId = randomUUID();
  fs.cpSync(session.folder, path.join(path.dirname(session.folder), forkId), { recursive: true, errorOnExist: true });
  return forkId;
}
