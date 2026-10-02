import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getAppDirectory } from '../../utils/appDirectory';
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

/**
 * Write a prompt to `<paneDir>/prompts/<paneId>/<timestamp>.md`, readable only
 * by the user, and return its absolute path.
 */
export async function writePromptFile(paneId: string, text: string, now: Date = new Date()): Promise<string> {
  const promptsRoot = path.join(getAppDirectory(), 'prompts');
  const directory = path.join(promptsRoot, paneId.replace(/[^A-Za-z0-9._-]/gu, '_'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to directories it creates, and is masked by umask.
  await fs.chmod(promptsRoot, 0o700);
  await fs.chmod(directory, 0o700);
  const name = `${now.toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}.md`;
  const file = path.join(directory, name);
  await fs.writeFile(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

/** The one line `--as-file-pointer` submits in place of the prompt. */
export function filePointerPrompt(file: string): string {
  return `Read and follow ${file}`;
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
