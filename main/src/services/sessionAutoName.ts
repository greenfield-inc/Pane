const MAX_NAME_LENGTH = 40;
const MAX_DRAFT_LENGTH = 4_000;
/* oxlint-disable eslint/no-control-regex -- Terminal input parsing needs control-character patterns. */
const BRACKETED_PASTE = /\x1b\[200~([\s\S]*?)(?:\x1b\[201~|$)/g;
const PROMPT_NEWLINE = /\x1b\r/g;
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)/g;
/* oxlint-enable eslint/no-control-regex */

export interface TypedInput {
  /** The line still being typed. */
  draft: string;
  /** Lines submitted with Enter, oldest first. */
  submitted: string[];
}

/**
 * Replays raw terminal keystrokes onto the line being typed. Enter submits the
 * line; ESC CR and a CR inside a bracketed paste are newlines; Backspace, Ctrl-U
 * and Ctrl-C edit or clear it. Cursor movement and other escape sequences are dropped.
 */
export function applyTerminalInput(draft: string, data: string): TypedInput {
  const text = data
    .replace(PROMPT_NEWLINE, '\n')
    .replace(BRACKETED_PASTE, (_match, pasted: string) => pasted.replace(/\r\n?/g, '\n'))
    .replace(ESCAPE_SEQUENCE, '');
  const submitted: string[] = [];
  let line = draft;
  for (const char of text) {
    if (char === '\r') {
      submitted.push(line);
      line = '';
    } else if (char === '\x7f' || char === '\b') {
      line = line.slice(0, -1);
    } else if (char === '\x15' || char === '\x03') {
      line = '';
    } else if (char === '\n' || char >= ' ') {
      line += char;
    }
  }
  return { draft: line.slice(0, MAX_DRAFT_LENGTH), submitted };
}

/**
 * A short Session name from a message: its first line, whitespace collapsed,
 * cut on a word boundary near 40 characters, without trailing punctuation.
 * Slash commands and one- or two-character replies (a menu choice) give none.
 */
export function sessionNameFromMessage(message: string): string | undefined {
  const firstLine = message.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  if (firstLine.startsWith('/') || firstLine.length < 3 || !/\p{L}/u.test(firstLine)) return undefined;
  let name = firstLine;
  if (name.length > MAX_NAME_LENGTH) {
    const cut = name.slice(0, MAX_NAME_LENGTH + 1);
    const lastSpace = cut.lastIndexOf(' ');
    name = lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_NAME_LENGTH);
  }
  return name.replace(/[\s.,;:!?…-]+$/u, '') || undefined;
}
