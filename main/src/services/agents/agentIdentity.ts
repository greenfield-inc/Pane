import { TerminalPanelState } from '../../../../shared/types/panels';
import type { PaneCommandValue } from '../../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

export type CliAgentType = NonNullable<TerminalPanelState['agentType']>;

export const CLI_AGENT_TYPES: readonly CliAgentType[] = ['claude', 'codex', 'cursor'];

interface AgentExecutableLookup {
  readonly [executable: string]: CliAgentType;
}

const AGENT_EXECUTABLES: AgentExecutableLookup = {
  'cursor-agent': 'cursor',
  claude: 'claude',
  codex: 'codex',
};

const OPTIONLESS_COMMAND_WRAPPERS = new Set(['command', 'exec', 'nohup']);
const COMMAND_STRING_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_OPTIONS_WITH_SEPARATE_OPERAND = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-P',
]);
const ENV_FLAGS = new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug']);
const MAX_ENV_SPLIT_EXPANSIONS = 16;

function tokenizeShellCommand(command: string, platformHint: NodeJS.Platform): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let windowsPath = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        const nextCharacter = command[index + 1];
        const startsWindowsPath = token === '' ? nextCharacter === '\\' : /^[A-Za-z]:$/.test(token);

        if (platformHint === 'win32' || windowsPath || startsWindowsPath) {
          token += character;
          windowsPath = true;
        } else if (nextCharacter && ['$', '`', '"', '\\', '\n'].includes(nextCharacter)) {
          index += 1;
          if (nextCharacter !== '\n') token += nextCharacter;
        } else {
          token += character;
        }
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (character === '\\') {
      const nextCharacter = command[index + 1];
      if (!nextCharacter) return undefined;
      const startsWindowsPath = token === '' ? nextCharacter === '\\' : /^[A-Za-z]:$/.test(token);

      if (platformHint === 'win32' || windowsPath || startsWindowsPath) {
        token += character;
        windowsPath = windowsPath || platformHint === 'win32' || startsWindowsPath;
      } else {
        index += 1;
        token += nextCharacter;
      }
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
        windowsPath = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function expandEnvArguments(
  initialTokens: string[],
  platformHint: NodeJS.Platform,
): string[] | undefined {
  let tokens = initialTokens;
  let splitExpansions = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === '--') return tokens.slice(index + 1);

    let splitString: string | undefined;
    let consumedTokens = 1;
    if (token === '-S' || token === '--split-string') {
      splitString = tokens[index + 1];
      consumedTokens = 2;
    } else if (token.startsWith('-S') && token.length > 2) {
      splitString = token.slice(2);
    } else if (token.startsWith('--split-string=')) {
      splitString = token.slice('--split-string='.length);
    }

    if (splitString !== undefined) {
      splitExpansions += 1;
      if (splitExpansions > MAX_ENV_SPLIT_EXPANSIONS) return undefined;
      const splitTokens = tokenizeShellCommand(splitString, platformHint);
      if (!splitTokens) return undefined;
      tokens = [
        ...tokens.slice(0, index),
        ...splitTokens,
        ...tokens.slice(index + consumedTokens),
      ];
      continue;
    }

    if (ENV_OPTIONS_WITH_SEPARATE_OPERAND.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith('--unset=') ||
      token.startsWith('--chdir=') ||
      /^-(?:u|C|P).+/.test(token)
    ) {
      index += 1;
      continue;
    }

    if (ENV_FLAGS.has(token)) {
      index += 1;
      continue;
    }

    break;
  }

  return tokens.slice(index);
}

function expandNiceArguments(tokens: string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return tokens.slice(index + 1);
    if (token === '-n' || token === '--adjustment') {
      index += 2;
      continue;
    }
    if (/^-(?:n\d+|\d+)$/.test(token) || token.startsWith('--adjustment=')) {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

function expandSudoArguments(tokens: string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return tokens.slice(index + 1);
    if (token === '-E' || token === '--preserve-env') {
      index += 1;
      continue;
    }
    if (token === '-u' || token === '--user') {
      index += 2;
      continue;
    }
    if ((token.startsWith('-u') && token.length > 2) || token.startsWith('--user=')) {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

function expandTimeArguments(tokens: string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return tokens.slice(index + 1);
    if (token === '-p' || token === '--portability') {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

function expandShellCommandString(
  tokens: string[],
  platformHint: NodeJS.Platform,
): string[] | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (!option.startsWith('-')) return undefined;
    if (/^-[^-]+$/.test(option) && option.slice(1).includes('c')) {
      const commandString = tokens[index + 1];
      return commandString ? tokenizeShellCommand(commandString, platformHint) : undefined;
    }
  }

  return undefined;
}

function expandWrapperArguments(
  wrapper: string,
  tokens: string[],
  platformHint: NodeJS.Platform,
): string[] | undefined {
  if (OPTIONLESS_COMMAND_WRAPPERS.has(wrapper)) return tokens;
  if (wrapper === '&') return platformHint === 'win32' ? tokens : undefined;
  if (wrapper === 'nice') return expandNiceArguments(tokens);
  if (wrapper === 'sudo') return expandSudoArguments(tokens);
  if (wrapper === 'time') return expandTimeArguments(tokens);
  if (COMMAND_STRING_SHELLS.has(wrapper)) return expandShellCommandString(tokens, platformHint);

  if (wrapper === 'cmd') {
    if (platformHint !== 'win32' || tokens[0]?.toLowerCase() !== '/c') return undefined;
    const commandTokens = tokens.slice(1);
    return commandTokens.length === 1
      ? tokenizeShellCommand(commandTokens[0], platformHint)
      : commandTokens;
  }

  return undefined;
}

function resolveExecutableToken(command: string, platformHint: NodeJS.Platform): string | undefined {
  let tokens = tokenizeShellCommand(command.trim(), platformHint);
  if (!tokens) return undefined;
  let index = 0;

  while (index < tokens.length) {
    if (ENVIRONMENT_ASSIGNMENT.test(tokens[index])) {
      index += 1;
      continue;
    }

    const commandWord = tokens[index].toLowerCase();
    if (commandWord === 'env') {
      const expandedArguments = expandEnvArguments(tokens.slice(index + 1), platformHint);
      if (!expandedArguments) return undefined;
      tokens = [...tokens.slice(0, index), ...expandedArguments];
      continue;
    }

    const expandedArguments = expandWrapperArguments(
      commandWord,
      tokens.slice(index + 1),
      platformHint,
    );
    if (expandedArguments) {
      tokens = [...tokens.slice(0, index), ...expandedArguments];
      continue;
    }

    break;
  }

  return tokens[index];
}

export function isCliAgentType(value: PaneCommandValue): value is CliAgentType {
  try {
    decodeBoundary(value, boundary.enumeration(...CLI_AGENT_TYPES));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the CLI agent from a POSIX- or Windows-style executable command word,
 * including quoted paths, env options, and supported wrappers. Arguments and
 * directory names are ignored so incidental agent names cannot affect
 * lifecycle handling.
 */
export function resolveAgentTypeFromCommand(
  command?: string,
  platformHint: NodeJS.Platform = process.platform,
): CliAgentType | undefined {
  const executable = command ? resolveExecutableToken(command, platformHint) : undefined;
  const basename = executable?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return basename ? AGENT_EXECUTABLES[basename] : undefined;
}

/** Inspect positional command tokens, never words inside option values. */
const CODEX_SUBCOMMANDS = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'resume', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'fork', 'cloud', 'exec-server', 'features', 'help']);

/**
 * The Codex command a `resume` can be appended to: the command itself, minus
 * any prompt (it would be read as a new first message). Undefined when the
 * command already runs a subcommand or its shell syntax is unknown.
 */
/** Whether a Claude command already chooses its conversation (`--resume`, `--continue`, `-r`, `-c`). */
export function hasClaudeResumeFlag(command: string): boolean {
  const tokens = tokenizeShellCommand(command, process.platform) ?? command.split(/\s+/);
  return tokens.some(token => ['--resume', '--continue', '-r', '-c'].includes(token.split('=')[0]));
}

export function codexResumeBase(command: string): string | undefined {
  const tokens = tokenizeShellCommand(command, process.platform);
  if (!tokens) return undefined; // Unknown shell syntax must remain untouched.
  // Options start after the executable, past any `VAR=value` or `env` prefix.
  const executable = tokens.findIndex(token => AGENT_EXECUTABLES[token.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd)$/, '') ?? ''] === 'codex');
  if (executable < 0) return undefined;
  const operands = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--remote', '--remote-auth-token-env', '--enable', '--disable', '--add-dir']);
  for (let i = executable + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (operands.has(token)) { i += 1; continue; }
    if (token.startsWith('-')) continue;
    if (CODEX_SUBCOMMANDS.has(token)) return undefined;
    return tokens.filter((_, index) => index !== i)
      .map((part) => /^[\w@%+=:,./~-]+$/.test(part) ? part : `"${part.replace(/([\\"$`])/g, '\\$1')}"`)
      .join(' ');
  }
  return command;
}
