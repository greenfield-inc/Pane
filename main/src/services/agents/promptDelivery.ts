import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { getAppDirectory } from '../../utils/appDirectory';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { RunpanePromptWarning } from '../../../../shared/types/runpaneOrchestration';

/**
 * Longest single-line prompt Pane types as is. Longer or multi-line text is
 * pasted into a composer, or read from a file at launch, so a shell or a TUI
 * never sees it as keystrokes.
 */
const LONG_PROMPT_THRESHOLD = 512;

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** Shells whose interactive line accepts `"$(cat '<file>')"` as one argument. */
const PROMPT_FILE_SHELLS = new Set(['bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh']);

/** CRLF and lone CR become LF: a CR typed into an agent composer is Enter. */
export function normalizePromptNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

/** Drop every trailing newline; the submit sends Enter on its own. */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/u, '');
}

export function isLongPrompt(text: string): boolean {
  return text.includes('\n') || text.length > LONG_PROMPT_THRESHOLD;
}

/**
 * Wrap text in a bracketed paste, so the TUI takes newlines as text and the
 * whole body as one paste. Paste markers inside the text would end it early.
 */
export function bracketedPaste(text: string): string {
  const body = text.split(BRACKETED_PASTE_START).join('').split(BRACKETED_PASTE_END).join('');
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}

const execFileAsync = promisify(execFile);

/** Where agent-read prompt files live inside a worktree, and the `.git/info/exclude` line that hides them. */
const WORKTREE_PROMPTS_DIRECTORY = path.join('.pane', 'prompts');
const WORKTREE_PROMPTS_EXCLUDE = '/.pane/prompts/';

function promptFileName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`;
}

/** `<paneDir>/prompts/<paneId>/`, readable only by the user. */
async function appPromptsDirectory(paneId: string): Promise<string> {
  const promptsRoot = path.join(getAppDirectory(), 'prompts');
  const directory = path.join(promptsRoot, paneId.replace(/[^A-Za-z0-9._-]/gu, '_'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to directories it creates, and is masked by umask.
  await fs.chmod(promptsRoot, 0o700);
  await fs.chmod(directory, 0o700);
  return directory;
}

async function writePrivateFile(file: string, text: string): Promise<void> {
  await fs.writeFile(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600, flag: 'wx' });
}

/**
 * Write a prompt to `<paneDir>/prompts/<paneId>/<timestamp>.md`, readable only
 * by the user, and return its absolute path.
 */
export async function writePromptFile(paneId: string, text: string, now: Date = new Date()): Promise<string> {
  const file = path.join(await appPromptsDirectory(paneId), `${promptFileName(now)}.md`);
  await writePrivateFile(file, text);
  return file;
}

/**
 * `<worktree>/.pane/prompts/`, hidden from git by the repository's
 * `info/exclude` (never a committed `.gitignore`), or undefined when the path
 * is not the top of a local git checkout.
 */
async function worktreePromptsDirectory(worktreePath: string): Promise<{ root: string; directory: string } | undefined> {
  let top: string;
  let exclude: string;
  try {
    if (!(await fs.stat(worktreePath)).isDirectory()) return undefined;
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { cwd: worktreePath, timeout: 10_000 });
    const [topLine, excludeLine] = stdout.split(/\r?\n/u);
    if (!topLine || !excludeLine) return undefined;
    // A Session folder or other non-repo folder can sit inside a repository (a tracked home directory).
    if (await fs.realpath(topLine) !== await fs.realpath(worktreePath)) return undefined;
    top = topLine;
    exclude = path.resolve(worktreePath, excludeLine);
  } catch {
    return undefined;
  }
  // Check each repository-controlled component before mkdir/chmod can follow it.
  // Even a link inside this checkout bypasses the lexical Git exclusion.
  for (const component of ['.pane', WORKTREE_PROMPTS_DIRECTORY]) {
    const candidate = path.join(top, component);
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      throw new PaneError('ERR_PROMPT_STORAGE_SYMLINK', `Cannot store the prompt: ${candidate} is a symbolic link. No prompt or attachments were written.`, 'Replace the symbolic link with a directory, then retry.');
    }
  }
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (!current.split(/\r?\n/u).includes(WORKTREE_PROMPTS_EXCLUDE)) {
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${WORKTREE_PROMPTS_EXCLUDE}\n`);
  }
  const directory = path.join(top, WORKTREE_PROMPTS_DIRECTORY);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return { root: path.normalize(top), directory };
}

export interface AgentPromptFile {
  /** The prompt file the pointer line names. */
  file: string;
  /** Copies of the attached files, in the order given. */
  attachments: string[];
  /** The worktree the files were written in; undefined for the Pane directory fallback. */
  worktreeRoot?: string;
}

/**
 * Write a prompt an agent reads (`--as-file-pointer`) and copy its attachments
 * beside it. Inside the Pane's own git worktree when it has one, so an agent
 * that may read only its working directories reads it without a prompt, and
 * git never sees it. Without a local git worktree (none given, a non-repo
 * folder, a WSL repo) it falls back to `writePromptFile`'s Pane directory.
 */
export async function writeAgentPromptFile(
  paneId: string,
  text: string,
  options: { worktreePath?: string; attachments?: readonly string[]; now?: Date } = {},
): Promise<AgentPromptFile> {
  const sources = options.attachments ?? [];
  for (const source of sources) {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(source);
    } catch (error) {
      throw new PaneError('ERR_ATTACHMENT_UNREADABLE', `Cannot attach ${source}: ${reasonOf(error)}. Nothing was sent.`, 'Pass an existing file with --attach, then retry.');
    }
    if (!stat.isFile()) {
      throw new PaneError('ERR_ATTACHMENT_UNREADABLE', `Cannot attach ${source}: it is not a file. Nothing was sent.`, 'Attach files one by one with --attach <file>, then retry.');
    }
  }
  const worktree = options.worktreePath ? await worktreePromptsDirectory(options.worktreePath) : undefined;
  const directory = worktree?.directory ?? await appPromptsDirectory(paneId);
  const worktreeRoot = worktree?.root;
  const name = promptFileName(options.now ?? new Date());
  const file = path.join(directory, `${name}.md`);
  await writePrivateFile(file, text);
  if (sources.length === 0) return { file, attachments: [], worktreeRoot };

  const attachmentDirectory = path.join(directory, name);
  await fs.mkdir(attachmentDirectory, { mode: 0o700 });
  const attachments: string[] = [];
  for (const source of sources) {
    const base = path.basename(source);
    let copy = path.join(attachmentDirectory, base);
    for (let n = 2; ; n += 1) {
      try {
        await fs.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        // Let the destination filesystem decide name equivalence (case, Unicode).
        copy = path.join(attachmentDirectory, `${n}-${base}`);
      }
    }
    await fs.chmod(copy, 0o600);
    attachments.push(copy);
  }
  return { file, attachments, worktreeRoot };
}

/** The one line `--as-file-pointer` submits in place of the prompt; `--attach` lists the copies after it. */
export function filePointerPrompt(file: string, attachments: readonly string[] = []): string {
  return attachments.length > 0
    ? `Read and follow ${file} (attached: ${attachments.join(', ')})`
    : `Read and follow ${file}`;
}

/**
 * Whether a launch command typed into this shell can read the prompt with
 * `"$(cat '<file>')"`. PowerShell, cmd, fish, WSL-bridged shells and unknown
 * shells get the prompt through the composer instead.
 */
export function canLaunchWithPromptFile(shellType: string | undefined, isWSL: boolean, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || isWSL || !shellType) return false;
  return PROMPT_FILE_SHELLS.has(shellType);
}

/**
 * One shell word that expands to the file's contents. The path is single
 * quoted; a `!` could still trigger bash history expansion inside the
 * surrounding double quotes, so such paths are refused.
 */
export function promptFileShellWord(file: string): string | undefined {
  if (/[!\n\r]/u.test(file)) return undefined;
  return `"$(cat '${file.replace(/'/gu, `'\\''`)}')"`;
}

const CLAUDE_LEADING_CHARACTER_WARNINGS = new Map<string, RunpanePromptWarning>([
  ['!', {
    code: 'leading-bang-runs-shell',
    message: 'The text starts with `!`, which Claude Code runs as a shell command instead of sending it to the model.',
  }],
  ['#', {
    code: 'leading-hash-memory',
    message: 'The text starts with `#`, which Claude Code can treat as a note to save to memory instead of a prompt.',
  }],
  ['/', {
    code: 'leading-slash-command',
    message: 'The text starts with `/`, which Claude Code reads as a slash command.',
  }],
  ['@', {
    code: 'leading-at-mention',
    message: 'The text starts with `@`, which opens Claude Code\'s file mention picker.',
  }],
]);

/** Claude Code gives a few leading characters a meaning of their own; the text is sent unchanged. */
export function claudePromptWarnings(text: string): RunpanePromptWarning[] | undefined {
  const warning = CLAUDE_LEADING_CHARACTER_WARNINGS.get(text.trimStart().charAt(0));
  return warning ? [warning] : undefined;
}
