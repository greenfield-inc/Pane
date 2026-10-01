import { randomUUID } from 'node:crypto';

export const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+(?![\s\S])/;

const MAX_COMMAND_LENGTH = 65_536;
const MAX_TOKEN_COUNT = 4_096;

interface ShellToken {
  value: string;
  start: number;
  end: number;
}

interface OpenCodeLaunchOptions {
  baseCommand: string;
  persistedSessionId?: string;
  allocateSessionId?: () => string;
}

interface OpenCodeLaunchCommand {
  commandToRun: string;
  sessionId: string;
}

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
function scanShellTokens(command: string): ShellToken[] {
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

export function allocateOpenCodeSessionId(uuidFactory: () => string = randomUUID): string {
  return requireValidSessionId(`ses_${uuidFactory().replaceAll('-', '')}`, 'allocator');
}

export function isValidOpenCodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_ID_PATTERN.test(value);
}

export function resolveOpenCodeLaunchCommand(options: OpenCodeLaunchOptions): OpenCodeLaunchCommand {
  const { baseCommand } = options;
  const tokens = scanShellTokens(baseCommand);
  const terminatorIndex = tokens.findIndex(({ value }) => value === '--');
  const selectorLimit = terminatorIndex === -1 ? tokens.length : terminatorIndex;
  const commandSessionIds: string[] = [];

  for (let index = 0; index < selectorLimit; index += 1) {
    const token = tokens[index].value;

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

    if (token === '--continue' || token.startsWith('--continue=')) {
      throw new Error('OpenCode launch command cannot use --continue');
    }
  }

  if (commandSessionIds.length > 1) {
    throw new Error('OpenCode launch command contains multiple session selectors');
  }

  const persistedSessionId = options.persistedSessionId === undefined
    ? undefined
    : requireValidSessionId(options.persistedSessionId.trim(), 'persisted state');
  const commandSessionId = commandSessionIds[0];

  if (commandSessionId) {
    if (persistedSessionId && persistedSessionId !== commandSessionId) {
      throw new Error('OpenCode command and persisted session ids differ');
    }
    return { commandToRun: baseCommand, sessionId: commandSessionId };
  }

  const sessionId = persistedSessionId
    ?? requireValidSessionId(
      (options.allocateSessionId ?? allocateOpenCodeSessionId)(),
      'allocator',
    );
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
