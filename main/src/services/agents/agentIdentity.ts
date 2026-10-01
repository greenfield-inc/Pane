import { TerminalPanelState } from '../../../../shared/types/panels';
import type { PaneCommandValue } from '../../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

export type CliAgentType = NonNullable<TerminalPanelState['agentType']>;

export const CLI_AGENT_TYPES: readonly CliAgentType[] = ['claude', 'codex', 'cursor', 'opencode'];

interface AgentExecutableLookup {
  readonly [executable: string]: CliAgentType;
}

const AGENT_EXECUTABLES: AgentExecutableLookup = {
  'cursor-agent': 'cursor',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
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

function tokenizeShellCommand(command: string, platformHint: NodeJS.Platform, spans?: Array<{ start: number; end: number }>): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let tokenStart = 0;
  let windowsPath = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!tokenStarted && !/\s/.test(character)) tokenStart = index;

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
        spans?.push({ start: tokenStart, end: index });
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
  if (tokenStarted) {
    tokens.push(token);
    spans?.push({ start: tokenStart, end: command.length });
  }
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

const SHELL_PROCESS_NAMES = new Set([
  'ash',
  'bash',
  'cmd',
  'csh',
  'dash',
  'fish',
  'ksh',
  'login',
  'mksh',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'zsh',
]);

/**
 * Claude Code's native installer runs `~/.local/share/claude/versions/<version>`,
 * so the kernel reports the version string as its process name.
 */
const VERSIONED_EXECUTABLE_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const CLAUDE_VERSIONED_EXECUTABLE_PATH = /(?:^|\/)claude\/versions\/[^/]+$/;

/** A process name or path as a comparable basename: `/bin/-zsh.exe` → `zsh`. */
export function normalizeProcessName(name: string): string {
  const basename = name.trim().replace(/\\/g, '/').split('/').pop() ?? '';
  return basename.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
}

/** True for a foreground process name that is an interactive shell (login shells report `-zsh`). */
export function isShellProcessName(name: string | undefined): boolean {
  return name !== undefined && SHELL_PROCESS_NAMES.has(normalizeProcessName(name));
}

/** Map a foreground process name, as node-pty reports it, to the agent it runs. */
export function resolveAgentTypeFromProcessName(name: string | undefined): CliAgentType | undefined {
  return name ? AGENT_EXECUTABLES[normalizeProcessName(name)] : undefined;
}

/** A bare `1.2.3` process name, which only its executable path can identify. */
export function isVersionedExecutableName(name: string | undefined): boolean {
  return name !== undefined && VERSIONED_EXECUTABLE_NAME.test(normalizeProcessName(name));
}

/** Map a foreground executable path to its agent, including Claude's versioned native binary. */
export function resolveAgentTypeFromExecutablePath(executablePath: string | undefined): CliAgentType | undefined {
  if (!executablePath) return undefined;
  const normalized = executablePath.trim().replace(/\\/g, '/');
  if (CLAUDE_VERSIONED_EXECUTABLE_PATH.test(normalized)) return 'claude';
  return resolveAgentTypeFromProcessName(normalized);
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
  const spans: Array<{ start: number; end: number }> = [];
  const tokens = tokenizeShellCommand(command, process.platform, spans);
  if (!tokens) return undefined; // Unknown shell syntax must remain untouched.
  // Options start after the executable, past any `VAR=value` or `env` prefix.
  const executable = tokens.findIndex(token => AGENT_EXECUTABLES[token.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd)$/, '') ?? ''] === 'codex');
  if (executable < 0) return undefined;
  const operands = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--remote', '--remote-auth-token-env', '--enable', '--disable', '--add-dir']);
  for (let i = executable + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    // Everything after the option terminator belongs to the launch prompt.
    if (token === '--') return command.slice(0, spans[i].start).trimEnd();
    if (operands.has(token)) { i += 1; continue; }
    if (token.startsWith('-')) continue;
    if (CODEX_SUBCOMMANDS.has(token)) return undefined;
    return `${command.slice(0, spans[i].start).trimEnd()} ${command.slice(spans[i].end).trimStart()}`.trim();
  }
  return command;
}

/** Remove the positional launch prompt without rewriting shell arguments. */
export function claudeResumeBase(command: string): string {
  const spans: Array<{ start: number; end: number }> = [];
  const tokens = tokenizeShellCommand(command, process.platform, spans);
  if (!tokens) return command;
  const executable = tokens.findIndex(token => /(?:^|[\\/])claude(?:\.exe|\.cmd)?$/i.test(token));
  if (executable < 0) return command;
  const operands = new Set(['--model', '--fallback-model', '--permission-mode', '--append-system-prompt', '--system-prompt', '--system-prompt-file', '--append-system-prompt-file', '--settings', '--setting-sources', '--agent', '--agents', '--effort', '--output-format', '--input-format', '--max-turns', '--max-budget-usd', '--json-schema', '--name', '--debug-file', '--permission-prompt-tool']);
  const flags = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--chrome', '--no-chrome', '--ide']);
  // These options accept multiple values; their boundary is ambiguous.
  const variadic = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir', '--mcp-config', '--plugin-dir']);
  for (let i = executable + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (variadic.has(token)) return command;
    if (operands.has(token)) { i += 1; continue; }
    if (flags.has(token) || (token.startsWith('--') && token.includes('='))) continue;
    if (token.startsWith('-')) return command;
    return `${command.slice(0, spans[i].start).trimEnd()} ${command.slice(spans[i].end).trimStart()}`.trim();
  }
  return command;
}
