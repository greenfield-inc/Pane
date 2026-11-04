import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
    info: boundary.object({ id: boundary.optional(boundary.string), role: boundary.optional(boundary.string) }),
    parts: boundary.optional(boundary.array(boundary.object({ type: boundary.optional(boundary.string), text: boundary.optional(boundary.string) }))),
  })),
});

async function openCodeExport(id: string, cwd: string): Promise<string | undefined> {
  const result = await run('opencode', ['export', id], cwd, 120_000);
  if (result.code !== 0) return undefined;
  // The JSON is on stdout; a progress line goes to stderr.
  return result.stdout.includes('{') ? exportJson(result.stdout) : undefined;
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

/** The JSON in `opencode export`'s output: a progress line can come first. */
function exportJson(output: string): string {
  const start = output.indexOf('{');
  return start >= 0 ? output.slice(start) : output;
}

/**
 * How many messages another copy of an OpenCode session (`opencode export` output) has that this
 * export lacks: more than none means that copy was continued after this one was taken. A copy
 * runpane can't read counts as all of its messages missing, since nothing in it can be matched.
 */
export function openCodeMessagesMissing(exported: string, other: string): number {
  const ids = (text: string): string[] | undefined => {
    try {
      return decodeBoundary(JSON.parse(exportJson(text)), openCodeExportSchema).messages.map((message, index) => message.info.id ?? `#${index}`);
    } catch {
      return undefined;
    }
  };
  const ours = new Set(ids(exported) ?? []);
  const theirs = ids(other);
  if (!theirs) return Number.POSITIVE_INFINITY;
  return theirs.filter(id => !ours.has(id)).length;
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
  /** sha256 of the file's content when it was stamped. */
  sha256: string;
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** How the original looked before a fork, to prove the fork left it untouched (continuity check 4). */
export type OriginalSnapshot =
  | { kind: 'files'; stamps: FileStamp[]; folder?: string; listing?: string[] }
  | { kind: 'export'; id: string; cwd: string; text: string };

export async function snapshotOriginal(session: NativeSession, cwd: string): Promise<OriginalSnapshot> {
  if (session.agent === 'opencode') {
    // Without a readable export there is nothing to compare the original with afterwards.
    const text = await openCodeExport(session.id, cwd);
    if (text === undefined) throw new Error(`opencode export ${session.id} failed, so the original can't be checked after the fork`);
    return { kind: 'export', id: session.id, cwd, text };
  }
  const snapshot: OriginalSnapshot = {
    kind: 'files',
    stamps: session.files.map(file => {
      const stat = fs.statSync(file.absolute);
      return { absolute: file.absolute, bytes: stat.size, modifiedMs: stat.mtimeMs, sha256: sha256(fs.readFileSync(file.absolute)) };
    }),
  };
  // A Cursor chat is a folder; a file that appears in it changes the original too.
  if (session.folder) {
    snapshot.folder = session.folder;
    snapshot.listing = filesUnder(session.folder);
  }
  return snapshot;
}

/** How the original compares with its snapshot. */
export interface OriginalComparison {
  /** Files whose earlier content changed, files new in a Cursor chat folder, or the session's export. */
  changed: string[];
  /** Files that only grew: everything they held at the snapshot is still there, byte for byte. */
  appended: string[];
}

/**
 * What happened to the original since the snapshot. Any change to a file fails, unless
 * `appendOnly`: the sender is the running agent, so its own turn (the one running this handoff)
 * keeps appending to its transcript. Then a file may grow, as long as every byte it held at the
 * snapshot is unchanged; it is reported in `appended`, not `changed`.
 */
export async function originalChanges(snapshot: OriginalSnapshot, options: { appendOnly?: boolean } = {}): Promise<OriginalComparison> {
  if (snapshot.kind === 'export') {
    const same = (await openCodeExport(snapshot.id, snapshot.cwd)) === snapshot.text;
    return { changed: same ? [] : [`OpenCode session ${snapshot.id}`], appended: [] };
  }
  const changed: string[] = [];
  const appended: string[] = [];
  for (const stamp of snapshot.stamps) {
    let content: Buffer;
    try {
      content = fs.readFileSync(stamp.absolute);
    } catch {
      changed.push(stamp.absolute);
      continue;
    }
    const kept = content.length >= stamp.bytes && sha256(content.subarray(0, stamp.bytes)) === stamp.sha256;
    if (!kept) changed.push(stamp.absolute);
    else if (content.length > stamp.bytes) (options.appendOnly ? appended : changed).push(stamp.absolute);
    // Same content but a new modification time: something rewrote or touched it, which check 4 doesn't allow.
    else if (fs.statSync(stamp.absolute).mtimeMs !== stamp.modifiedMs) changed.push(stamp.absolute);
  }
  const before = new Set(snapshot.listing ?? []);
  if (snapshot.folder) changed.push(...filesUnder(snapshot.folder).filter(file => !before.has(file)));
  return { changed, appended };
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
 * original), and a fork whose command fails is not used. Cursor has no fork command; see
 * CURSOR_NO_FORK.
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
    // The id arrives before the fork's turn runs: a failed turn leaves a fork without its own turn.
    if (result.code !== 0) throw failure(`codex exec fork ${session.id}`, result);
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
    if (result.code !== 0) throw failure(`opencode run --session ${session.id} --fork`, result);
    const forked = result.stdout.split('\n')
      .map(line => decodeLine(line, boundary.object({ sessionID: boundary.string }))?.sessionID)
      .find(id => id !== undefined && id !== session.id);
    if (!forked) throw failure(`opencode run --session ${session.id} --fork`, result);
    return forked;
  }
  throw new Error(CURSOR_NO_FORK);
}

/**
 * Why a Cursor session can't be continued by a second agent on the same machine: a copy of its
 * chat folder under a new id still writes to the original chat once it is used (QA saw it).
 */
export const CURSOR_NO_FORK = 'Cursor has no fork command, and a copied Cursor chat still writes to the original chat once it is used, so a second Cursor agent on this machine can\'t continue your session without changing it';
