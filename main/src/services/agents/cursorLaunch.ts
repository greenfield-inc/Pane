export const CURSOR_CHAT_ID_MARKER = 'pane-cursor-chat-id:';

const CHAT_ID_PATTERN = new RegExp(
  `${CURSOR_CHAT_ID_MARKER}\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\b`,
  'i',
);

interface CursorLaunchOptions {
  baseCommand: string;
  promptArgument?: string;
  /** A ready-made shell word for the prompt, such as `"$(cat '<file>')"`; wins over promptArgument. */
  promptWord?: string;
  resumeChatId?: string;
  shellType?: string;
}

function quoteShellArgument(value: string): string {
  return `"${value.replace(/([\\"$`])/g, '\\$1')}"`;
}

function stripAnsiSequences(output: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI stripping intentionally matches ESC and BEL.
  return output.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
}

/**
 * Cursor owns its chat ids, so a fresh launch pre-creates one with
 * `create-chat` and prints it behind a marker for Pane to scrape. The
 * `if`/`else` form is required: zsh does not word-split unquoted parameter
 * expansions, so `${VAR:+--resume "$VAR"}` would expand to a single argv word.
 * When create-chat fails (offline, Ctrl-C), the else branch launches Cursor
 * untracked instead of blocking the pane.
 */
export function buildCursorLaunchCommand(options: CursorLaunchOptions): string {
  const { baseCommand, promptArgument, promptWord, resumeChatId } = options;
  const promptSuffix = promptWord
    ? ` ${promptWord}`
    : promptArgument ? ` ${quoteShellArgument(promptArgument)}` : '';

  if (resumeChatId) {
    return `${baseCommand} --resume ${quoteShellArgument(resumeChatId)}${promptSuffix}`;
  }

  const executable = baseCommand.trim().split(/\s+/)[0];
  if (options.shellType === 'fish') {
    return (
      `if set __PANE_CURSOR_CHAT (${executable} create-chat 2>/dev/null); and test -n "$__PANE_CURSOR_CHAT"; `
      + `printf '\\n${CURSOR_CHAT_ID_MARKER} %s\\n' "$__PANE_CURSOR_CHAT"; `
      + `${baseCommand} --resume "$__PANE_CURSOR_CHAT"${promptSuffix}; `
      + `else; ${baseCommand}${promptSuffix}; end`
    );
  }
  return (
    `if __PANE_CURSOR_CHAT="$(${executable} create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; `
    + `then printf '\\n${CURSOR_CHAT_ID_MARKER} %s\\n' "$__PANE_CURSOR_CHAT"; `
    + `${baseCommand} --resume "$__PANE_CURSOR_CHAT"${promptSuffix}; `
    + `else ${baseCommand}${promptSuffix}; fi`
  );
}

export function extractCursorChatId(output: string): string | undefined {
  return stripAnsiSequences(output).match(CHAT_ID_PATTERN)?.[1];
}

const CURSOR_TUI_READY_SEQUENCE = '\x1b]0;Cursor Agent';

/**
 * Cursor renders inline (no alternate screen), and its launch is preceded by
 * the shell echo and create-chat output, so first-PTY-byte is a false ready
 * signal. The OSC 0 title is the first byte sequence the TUI itself emits.
 */
export function createCursorReadyDetector(): (chunk: string) => boolean {
  let tail = '';
  return (chunk: string) => {
    const window = tail + chunk;
    tail = window.slice(-(CURSOR_TUI_READY_SEQUENCE.length - 1));
    return window.includes(CURSOR_TUI_READY_SEQUENCE);
  };
}
