import { isAgentSessionId } from '../../../../shared/agents';

const MAX_COMMAND_LENGTH = 65_536;
const MAX_TOKEN_COUNT = 4_096;

interface ShellToken {
  value: string;
  start: number;
  end: number;
}

interface OpenCodeLaunchOptions {
  baseCommand: string;
  shellType?: string;
  persistedSessionId?: string;
}

interface OpenCodeLaunchCommand {
  commandToRun: string;
  /** Absent for a new conversation: OpenCode creates the id, and Pane captures it from the exit line. */
  sessionId?: string;
}

/** Ids from Pane's earlier allocator (`ses_` + a dashless lowercase UUID). OpenCode never creates these, so they never resume. */
const PANE_ALLOCATED_SESSION_ID = /^ses_[0-9a-f]{32}$/;

/** The line OpenCode prints, alone, when its TUI exits: `Continue  opencode -s <id>`. */
const OPENCODE_CONTINUE_LINE = /^[ \t]*Continue[ \t]+opencode[ \t]+-s[ \t]+(ses_[A-Za-z0-9]+)[ \t]*\r?$/gm;

function isShellWhitespace(character: string): boolean {
  return character === ' ' || character === '\t';
}

function isUnsupportedUnquotedShellCharacter(character: string): boolean {
  return '#;&|<>()$`*?[]{}~!'.includes(character);
}

/**
 * Tokenizes only the shell-word features needed to identify argv selectors.
 * Source spans let callers insert a selector without rebuilding the command.
 */
function scanShellTokens(command: string, windowsPaths: boolean): ShellToken[] {
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error('OpenCode launch command is too long');
  }

  const tokens: ShellToken[] = [];
  let index = 0;

  while (index < command.length) {
    while (index < command.length && isShellWhitespace(command[index])) {
      index += 1;
    }
    if (index >= command.length) break;

    const start = index;
    const windowsPath = windowsPaths && /^[A-Za-z]:\\/u.test(command.slice(start));
    let value = '';
    let quote: 'single' | 'double' | undefined;

    while (index < command.length) {
      const character = command[index];

      if (quote === 'single') {
        if (character === "'") {
          quote = undefined;
        } else {
          value += character;
        }
        index += 1;
        continue;
      }

      if (quote === 'double') {
        if (character === '"') {
          quote = undefined;
          index += 1;
          continue;
        }
        if (character === '\\') {
          if (index + 1 >= command.length) {
            throw new Error('OpenCode launch command has a dangling escape');
          }
          const escaped = command[index + 1];
          if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
            value += escaped;
          } else if (escaped === '\n') {
            // A shell line continuation contributes no character to the word.
          } else {
            value += `\\${escaped}`;
          }
          index += 2;
          continue;
        }
        if (character === '$' || character === '`') {
          throw new Error('OpenCode launch command contains an unsupported shell expansion');
        }
        value += character;
        index += 1;
        continue;
      }

      if (isShellWhitespace(character)) break;
      if (character === '\n' || character === '\r') {
        throw new Error('OpenCode launch command contains a command separator');
      }
      if (character === "'") {
        quote = 'single';
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = 'double';
        index += 1;
        continue;
      }
      if (character === '\\') {
        if (windowsPath) {
          value += character;
          index += 1;
          continue;
        }
        if (index + 1 >= command.length) {
          throw new Error('OpenCode launch command has a dangling escape');
        }
        const escaped = command[index + 1];
        if (escaped !== '\n') value += escaped;
        index += 2;
        continue;
      }
      if (isUnsupportedUnquotedShellCharacter(character)) {
        throw new Error('OpenCode launch command contains unsupported shell syntax');
      }

      value += character;
      index += 1;
    }

    if (quote) {
      throw new Error('OpenCode launch command has an unmatched quote');
    }

    tokens.push({ value, start, end: index });
    if (tokens.length > MAX_TOKEN_COUNT) {
      throw new Error('OpenCode launch command has too many arguments');
    }
  }

  return tokens;
}

function requireValidSessionId(value: string, source: string): string {
  if (!isValidOpenCodeSessionId(value)) {
    throw new Error(`Invalid OpenCode session id from ${source}`);
  }
  return value;
}

/** An id of the form OpenCode's `terminal.session.idPattern` gives (`ses_…`). */
export function isValidOpenCodeSessionId(value: string): boolean {
  return isAgentSessionId('opencode', value);
}

/** The session id in the last OpenCode exit line of ANSI-free terminal text. */
export function extractOpenCodeSessionId(text: string): string | undefined {
  return Array.from(text.matchAll(OPENCODE_CONTINUE_LINE)).at(-1)?.[1];
}

function scanDirectOpenCodeTokens(command: string, windowsPaths = false): ShellToken[] {
  const tokens = scanShellTokens(command, windowsPaths);
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let executableIndex = 0;
  // Shell assignments must start unquoted; env receives ordinary literal argv.
  while (tokens[executableIndex] && assignment.test(command.slice(tokens[executableIndex].start))) {
    executableIndex += 1;
  }
  if (tokens[executableIndex]?.value === 'env') {
    executableIndex += 1;
    while (tokens[executableIndex] && assignment.test(tokens[executableIndex].value)) {
      executableIndex += 1;
    }
  }
  const executable = tokens[executableIndex]?.value.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  if (executable !== 'opencode') {
    throw new Error('OpenCode native launch contains an unsupported command wrapper; run `opencode` directly');
  }
  return tokens.slice(executableIndex);
}

/** Read-only preflight: recognition of an agent inside a wrapper is not safe selector insertion. */
export function assertDirectOpenCodeLaunchCommand(baseCommand: string, windowsPaths = false): void {
  scanDirectOpenCodeTokens(baseCommand, windowsPaths);
}

export function resolveOpenCodeLaunchCommand(options: OpenCodeLaunchOptions): OpenCodeLaunchCommand {
  const { baseCommand } = options;
  const windowsPaths = /^(?:powershell|pwsh|cmd)(?:\.exe)?$/iu.test(options.shellType ?? '');
  const tokens = scanDirectOpenCodeTokens(baseCommand, windowsPaths);
  const terminatorIndex = tokens.findIndex(({ value }) => value === '--');
  const selectorLimit = terminatorIndex === -1 ? tokens.length : terminatorIndex;
  const commandSessionIds: string[] = [];

  for (let index = 0; index < selectorLimit; index += 1) {
    const token = tokens[index].value;

    if (token === '--prompt' || token.startsWith('--prompt=')) {
      throw new Error('Use Pane initial input (--prompt on runpane), not OpenCode --prompt, to avoid replaying the prompt on restore');
    }

    if (token === '--session' || token === '-s') {
      if (index + 1 >= selectorLimit) {
        throw new Error(`OpenCode ${token} selector is missing its operand`);
      }
      commandSessionIds.push(requireValidSessionId(tokens[index + 1].value, token));
      index += 1;
      continue;
    }

    if (token.startsWith('--session=')) {
      commandSessionIds.push(requireValidSessionId(token.slice('--session='.length), '--session'));
      continue;
    }

    if (token.startsWith('-s=')) {
      throw new Error('OpenCode does not support the -s=<id> selector form');
    }

    if (token === '--continue' || token.startsWith('--continue=') || token === '-c' || token.startsWith('-c=')) {
      throw new Error('OpenCode launch command cannot use --continue');
    }
  }

  if (commandSessionIds.length > 1) {
    throw new Error('OpenCode launch command contains multiple session selectors');
  }

  const savedSessionId = options.persistedSessionId === undefined
    ? undefined
    : requireValidSessionId(options.persistedSessionId.trim(), 'persisted state');
  const persistedSessionId = savedSessionId && PANE_ALLOCATED_SESSION_ID.test(savedSessionId) ? undefined : savedSessionId;
  const commandSessionId = commandSessionIds[0];

  if (commandSessionId) {
    if (persistedSessionId && persistedSessionId !== commandSessionId) {
      throw new Error('OpenCode command and persisted session ids differ');
    }
    return { commandToRun: baseCommand, sessionId: commandSessionId };
  }

  // OpenCode refuses `--session` for an id it has not created, so a new conversation starts bare.
  if (!persistedSessionId) return { commandToRun: baseCommand };
  const sessionId = persistedSessionId;
  const selector = `--session "${sessionId}"`;

  if (terminatorIndex !== -1) {
    const insertionIndex = tokens[terminatorIndex].start;
    const prefix = baseCommand.slice(0, insertionIndex);
    const leadingSeparator = prefix.length > 0 && !isShellWhitespace(prefix[prefix.length - 1]) ? ' ' : '';
    return {
      commandToRun: `${prefix}${leadingSeparator}${selector} ${baseCommand.slice(insertionIndex)}`,
      sessionId,
    };
  }

  const finalToken = tokens[tokens.length - 1];
  const separator = finalToken?.end === baseCommand.length ? ' ' : '';
  return {
    commandToRun: `${baseCommand}${separator}${selector}`,
    sessionId,
  };
}
