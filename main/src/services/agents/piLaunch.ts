import { PaneError } from '../../../../shared/paneError';
import { tokenizeShellCommand } from './agentIdentity';

/**
 * Pi (`pi`, from @earendil-works/pi-coding-agent) takes a caller-chosen session
 * id: `pi --session-id <id>` opens the current directory's session with that id
 * and creates it when there is none, so a fresh launch and a resume are the same
 * command. Pi 0.76.0 added the flag; older builds exit with
 * `Unknown option: --session-id`, which `runpane agents doctor --agent pi` reports.
 *
 * Pi's ids hold letters, digits, `.`, `_` and `-`, and start and end with a
 * letter or digit. Pane allocates a UUID, which always fits.
 */
export const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

// Flags that already choose (or refuse) a session; pi rejects --session-id beside them.
const PI_SESSION_FLAGS = new Set(['--session-id', '--session', '--continue', '-c', '--resume', '-r', '--fork', '--no-session']);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELL_SYNTAX = /[;&|<>`\n]|\$\(/u;

export function isValidPiSessionId(id: string | undefined): id is string {
  return id !== undefined && PI_SESSION_ID_PATTERN.test(id);
}

function isPiExecutable(word: string): boolean {
  const basename = word.replace(/\\/gu, '/').split('/').pop()?.toLowerCase() ?? '';
  return basename.replace(/\.(?:cmd|exe|ps1)$/u, '') === 'pi';
}

/** The words after the `pi` executable, when the command runs pi directly (optionally after `NAME=value` or `env NAME=value`). */
function directPiArguments(command: string, platform: NodeJS.Platform): string[] | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const words = tokenizeShellCommand(command, platform);
  if (!words) return undefined;
  let index = 0;
  if (words[index] === 'env') index += 1;
  while (index < words.length && ENVIRONMENT_ASSIGNMENT.test(words[index])) index += 1;
  if (index >= words.length || !isPiExecutable(words[index])) return undefined;
  return words.slice(index + 1);
}

/** The session id a pi command names with `--session-id <id>` or `--session-id=<id>`, if any. */
export function piCommandSessionId(command: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const args = directPiArguments(command, platform) ?? [];
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    const word = args[index];
    const value = word === '--session-id' ? args[index + 1] : word.startsWith('--session-id=') ? word.slice('--session-id='.length) : undefined;
    if (value !== undefined) return isValidPiSessionId(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Whether Pane can add `--session-id` to this command: it runs pi directly, picks
 * no session itself and has no `--` (after which pi reads every word as a message).
 */
export function canAddPiSessionId(command: string, platform: NodeJS.Platform = process.platform): boolean {
  const args = directPiArguments(command, platform);
  if (!args) return false;
  return !args.some(word => word === '--' || PI_SESSION_FLAGS.has(word.split('=')[0]));
}

export interface PiLaunchResolution {
  commandToRun: string;
  /** The session this launch opens, when Pane knows it. */
  sessionId?: string;
}

/**
 * The command that opens the panel's pi session: the saved id when it is valid,
 * otherwise `allocate()`'s. A command that already picks its own session, or
 * that Pane can't safely extend (a wrapper, shell syntax), runs unchanged.
 */
export function resolvePiLaunchCommand(options: {
  baseCommand: string;
  persistedSessionId?: string;
  allocate: () => string;
  platform?: NodeJS.Platform;
}): PiLaunchResolution {
  const { baseCommand, persistedSessionId, allocate } = options;
  const platform = options.platform ?? process.platform;
  if (!canAddPiSessionId(baseCommand, platform)) {
    return { commandToRun: baseCommand, sessionId: piCommandSessionId(baseCommand, platform) };
  }
  const saved = persistedSessionId?.trim();
  const sessionId = isValidPiSessionId(saved) ? saved : allocate();
  if (!isValidPiSessionId(sessionId)) {
    throw new PaneError(
      'ERR_PI_SESSION_ID',
      `Pi session id "${sessionId}" is not valid: pi accepts only letters, digits, ".", "_" and "-", starting and ending with a letter or digit. Pi was not launched.`,
      'Resume the tab with a valid pi session id, or start a new Pi tab.',
    );
  }
  return { commandToRun: `${baseCommand.trimEnd()} --session-id ${sessionId}`, sessionId };
}
