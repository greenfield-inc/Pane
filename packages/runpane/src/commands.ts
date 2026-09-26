import {
  RUNPANE_CONTRACT,
  type ArtifactFormat,
  type InstallTarget,
  type RunpaneAgent,
  type RunpaneChannel,
  type RunpaneCommand
} from './generated/contract';
import { boundary, decodeBoundary } from './boundaryDecoder';

export type { ArtifactFormat, InstallTarget, RunpaneAgent, RunpaneCommand };

export interface ParsedArgs {
  command: RunpaneCommand;
  helpTopic?: string;
  target: InstallTarget;
  paneVersion: string;
  channel: RunpaneChannel;
  format: ArtifactFormat;
  downloadDir?: string;
  panePath?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  json: boolean;
  contextCommand?: string;
  paneDir?: string;
  repo?: string;
  paneId?: string;
  sessionId?: string;
  panelId?: string;
  repoPath?: string;
  folder?: string;
  resume?: string;
  name?: string;
  worktreeName?: string;
  baseBranch?: string;
  agent?: RunpaneAgent;
  toolCommand?: string;
  title?: string;
  initialInput?: string;
  initialInputFile?: string;
  panelInput?: string;
  panelInputFile?: string;
  fromJson?: string;
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  concurrency?: number;
  limit?: number;
  waitCondition?: string;
  contains?: string;
  intervalMs?: number;
  source?: string;
  noFocus?: boolean;
  focus?: boolean;
  pinned?: boolean;
  noPinned?: boolean;
  composerStrategy?: string;
  force?: boolean;
  launch?: boolean;
  watchAs?: string;
  watchSince?: number;
  watchFrom?: 'now' | 'earliest';
  watchKinds?: string[];
  watchPaneIds?: string[];
  watchExcludePaneIds?: string[];
  nameContains?: string;
  follow?: boolean;
  agentsOnly?: boolean;
  ackNow?: boolean;
  includeHeldInput?: boolean;
  watchFormat?: 'lines' | 'json';
  heartbeatSeconds?: number;
  idleAfterMs?: number;
  settleMs?: number;
  blockedSettleMs?: number;
  minIntervalMs?: number;
  idleBackoff?: boolean;
  allManaged?: boolean;
  includeShells?: boolean;
  noHeldInput?: boolean;
  selfTest?: boolean;
  report?: boolean;
  bodyFile?: string;
  remoteSetupArgs: string[];
}

const COMMAND_MATCHERS = RUNPANE_CONTRACT.commands
  .map((command) => ({ name: command.name, tokens: command.name.split(' ') }))
  .sort((a, b) => b.tokens.length - a.tokens.length);
const TARGETS = new Set<string>(RUNPANE_CONTRACT.enums.installTargets);
const FORMATS = new Set<string>(RUNPANE_CONTRACT.enums.artifactFormats);
const CHANNELS = new Set<string>(RUNPANE_CONTRACT.enums.channels);
const AGENTS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const commandSchema = boundary.enumeration(...RUNPANE_CONTRACT.commands.map((command) => command.name));
const targetSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.installTargets);
const formatSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.artifactFormats);
const channelSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.channels);
const agentSchema = boundary.enumeration(...RUNPANE_CONTRACT.enums.agents);
const COMMAND_GROUP_HELP_TOPICS = new Set(['panes', 'panels', 'sessions', 'workspace']);

const REMOTE_VALUE_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteValue.map((flag) => flag.name));
const REMOTE_BOOLEAN_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteBoolean.map((flag) => flag.name));
const LOCAL_VALUE_FLAGS = createFlagSet(RUNPANE_CONTRACT.flags.localValue);
const LOCAL_BOOLEAN_FLAGS = createFlagSet(RUNPANE_CONTRACT.flags.localBoolean);

const DEFAULTS: Omit<ParsedArgs, 'command'> = {
  target: RUNPANE_CONTRACT.defaults.target,
  paneVersion: RUNPANE_CONTRACT.defaults.paneVersion,
  channel: RUNPANE_CONTRACT.defaults.channel,
  format: RUNPANE_CONTRACT.defaults.format,
  dryRun: RUNPANE_CONTRACT.defaults.dryRun,
  yes: RUNPANE_CONTRACT.defaults.yes,
  verbose: RUNPANE_CONTRACT.defaults.verbose,
  json: false,
  remoteSetupArgs: []
};

export function parseRunpaneArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args[0];

  if (!first || first === '-h' || first === '--help') {
    return { command: 'help', ...DEFAULTS };
  }

  if (first === '-v' || first === '--version') {
    return { command: 'version', ...DEFAULTS };
  }

  if (first === 'help') {
    args.shift();
    return {
      command: 'help',
      helpTopic: args.join(' ') || undefined,
      ...DEFAULTS
    };
  }

  const groupHelpTopic = matchCommandGroupHelp(args);
  if (groupHelpTopic) {
    return {
      command: 'help',
      helpTopic: groupHelpTopic,
      ...DEFAULTS
    };
  }

  const matched = matchCommand(args);
  if (!matched) {
    throw new Error(`Unknown command: ${first}\n\n${helpText()}`);
  }

  args.splice(0, matched.tokens.length);

  const parsed: ParsedArgs = {
    command: decodeBoundary(matched.name, commandSchema),
    ...DEFAULTS,
    remoteSetupArgs: []
  };

  if (parsed.command === 'install' && args[0] && !args[0].startsWith('-')) {
    const target = args.shift();
    if (!target || !TARGETS.has(target)) {
      throw new Error(`Unknown install target: ${target ?? ''}. Expected "client" or "daemon".`);
    }
    parsed.target = decodeBoundary(target, targetSchema);
  }

  if (parsed.command === 'update') {
    parsed.target = 'client';
  }

  parseFlags(args, parsed);
  if (parsed.command === 'watch' && parsed.follow && parsed.timeoutMs === 0) {
    throw new Error('--timeout-ms must be greater than 0 with --follow.');
  }
  if (parsed.command === 'watch' && parsed.allManaged && parsed.watchPaneIds?.length) {
    throw new Error('runpane watch accepts either --all-managed or --pane, not both.');
  }
  if (parsed.command === 'watch' && parsed.json && parsed.watchFormat === 'lines') {
    throw new Error('runpane watch accepts either --json or --format lines, not both.');
  }
  const cadenceValueFlagPresent = hasCadenceValueFlag(parsed);
  if (parsed.command === 'watch' && !parsed.follow && (cadenceValueFlagPresent || parsed.idleBackoff)) {
    throw new Error('--settle, --blocked-settle, --min-interval, and --idle-backoff require --follow.');
  }
  if (parsed.command === 'watch' && parsed.watchSince !== undefined && cadenceValueFlagPresent) {
    throw new Error('runpane watch accepts either --since or --settle/--blocked-settle/--min-interval, not both (cadence needs a named cursor).');
  }
  return parsed;
}

function parseFlags(args: string[], parsed: ParsedArgs): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const isAgentContextCommand = parsed.command === 'agent-context';
    const isLocalCommand = isRunpaneLocalCommand(parsed.command);

    if (arg === '-h' || arg === '--help') {
      const topic = parsed.command;
      parsed.command = 'help';
      parsed.helpTopic = topic;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }
    if (arg === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (isAgentContextCommand && arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (isAgentContextCommand && arg === '--command') {
      parsed.contextCommand = readValue(args, ++index, arg);
      continue;
    }
    if (isLocalCommand && LOCAL_BOOLEAN_FLAGS.has(arg)) {
      parseLocalBooleanFlag(arg, parsed);
      continue;
    }
    if (isLocalCommand && LOCAL_VALUE_FLAGS.has(arg)) {
      const value = readValue(args, ++index, arg);
      parseLocalValueFlag(arg, value, parsed);
      continue;
    }
    if (arg === '--version') {
      parsed.paneVersion = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--download-dir') {
      parsed.downloadDir = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--pane-path') {
      parsed.panePath = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--format') {
      const value = readValue(args, ++index, arg);
      if (!FORMATS.has(value)) {
        throw new Error(`Invalid --format "${value}". Expected one of: ${[...FORMATS].join(', ')}`);
      }
      parsed.format = decodeBoundary(value, formatSchema);
      continue;
    }

    if (REMOTE_VALUE_FLAGS.has(arg)) {
      const value = readValue(args, ++index, arg);
      if (arg === '--channel') {
        if (!CHANNELS.has(value)) {
          throw new Error(`Invalid --channel "${value}". Expected stable or nightly.`);
        }
        parsed.channel = decodeBoundary(value, channelSchema);
      }
      appendRemoteArg(parsed, arg, value);
      continue;
    }

    if (REMOTE_BOOLEAN_FLAGS.has(arg)) {
      appendRemoteArg(parsed, arg);
      continue;
    }

    if (parsed.command === 'install' && parsed.target === 'daemon') {
      index = appendUnknownRemoteArg(args, index, parsed, arg);
      continue;
    }

    throw new Error(`Unknown option for ${parsed.command}: ${arg}`);
  }
}

function matchCommand(args: string[]): { name: string; tokens: string[] } | undefined {
  return COMMAND_MATCHERS.find((command) =>
    command.tokens.every((token, index) => args[index] === token)
  );
}

function matchCommandGroupHelp(args: string[]): string | undefined {
  if (args.length !== 2 || !['-h', '--help'].includes(args[1])) {
    return undefined;
  }
  return COMMAND_GROUP_HELP_TOPICS.has(args[0]) ? args[0] : undefined;
}

function createFlagSet(flags: readonly { name: string; aliases?: readonly string[] }[]): Set<string> {
  return new Set(flags.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])]));
}

function parseLocalBooleanFlag(flag: string, parsed: ParsedArgs): void {
  if (flag === '--json') {
    parsed.json = true;
    return;
  }
  if (flag === '--wait-ready') {
    parsed.waitReady = true;
    return;
  }
  if (flag === '--no-focus') {
    parsed.noFocus = true;
    return;
  }
  if (flag === '--focus') {
    parsed.focus = true;
    return;
  }
  if (flag === '--pinned') {
    parsed.pinned = true;
    return;
  }
  if (flag === '--no-pinned') {
    parsed.noPinned = true;
    return;
  }
  if (flag === '--force') {
    parsed.force = true;
    return;
  }
  if (flag === '--launch') {
    parsed.launch = true;
    return;
  }
  if (flag === '--follow') {
    parsed.follow = true;
    return;
  }
  if (flag === '--idle-backoff') {
    parsed.idleBackoff = true;
    return;
  }
  if (flag === '--ack-now') {
    parsed.ackNow = true;
    return;
  }
  if (flag === '--include-held-input') {
    parsed.includeHeldInput = true;
    return;
  }
  if (flag === '--agents-only') {
    parsed.agentsOnly = true;
    return;
  }
  if (flag === '--all-managed') {
    parsed.allManaged = true;
    return;
  }
  if (flag === '--include-shells') {
    parsed.includeShells = true;
    return;
  }
  if (flag === '--no-held-input') {
    parsed.noHeldInput = true;
    return;
  }
  if (flag === '--self-test') {
    parsed.selfTest = true;
    return;
  }
  if (flag === '--report') {
    parsed.report = true;
    return;
  }

  throw new Error(`Unknown option for ${parsed.command}: ${flag}`);
}

function parseLocalValueFlag(flag: string, value: string, parsed: ParsedArgs): void {
  if (flag === '--pane-dir') {
    parsed.paneDir = value;
    return;
  }
  if (flag === '--repo') {
    parsed.repo = value;
    return;
  }
  if (flag === '--pane') {
    if (parsed.command === 'watch') {
      (parsed.watchPaneIds ??= []).push(value);
    } else {
      parsed.paneId = value;
    }
    return;
  }
  if (flag === '--session') {
    parsed.sessionId = value;
    return;
  }
  if (flag === '--exclude-pane') {
    (parsed.watchExcludePaneIds ??= []).push(value);
    return;
  }
  if (flag === '--panel') {
    parsed.panelId = value;
    return;
  }
  if (flag === '--path') {
    parsed.repoPath = value;
    return;
  }
  if (flag === '--name') {
    parsed.name = value;
    return;
  }
  if (flag === '--worktree-name') {
    parsed.worktreeName = value;
    return;
  }
  if (flag === '--base-branch') {
    parsed.baseBranch = value;
    return;
  }
  if (flag === '--folder') {
    parsed.folder = value;
    return;
  }
  if (flag === '--resume') {
    parsed.resume = value;
    return;
  }
  if (flag === '--agent') {
    if (!AGENTS.has(value)) {
      throw new Error(`Invalid --agent "${value}". Expected one of: ${[...AGENTS].join(', ')}`);
    }
    parsed.agent = decodeBoundary(value, agentSchema);
    return;
  }
  if (flag === '--tool-command') {
    parsed.toolCommand = value;
    return;
  }
  if (flag === '--title') {
    parsed.title = value;
    return;
  }
  if (flag === '--initial-input' || flag === '--prompt') {
    parsed.initialInput = value;
    return;
  }
  if (flag === '--text') {
    parsed.panelInput = value;
    return;
  }
  if (flag === '--input-file') {
    parsed.panelInputFile = value;
    return;
  }
  if (flag === '--initial-input-file') {
    parsed.initialInputFile = value;
    return;
  }
  if (flag === '--from-json') {
    parsed.fromJson = value;
    return;
  }
  if (flag === '--timeout-ms') {
    const timeoutMs = Number(value);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || (timeoutMs === 0 && parsed.command !== 'watch')) {
      throw new Error('--timeout-ms must be a positive number (watch also accepts 0).');
    }
    parsed.timeoutMs = timeoutMs;
    return;
  }
  if (flag === '--ready-timeout-ms') {
    const readyTimeoutMs = Number(value);
    if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
      throw new Error('--ready-timeout-ms must be a positive number.');
    }
    parsed.readyTimeoutMs = readyTimeoutMs;
    return;
  }
  if (flag === '--concurrency') {
    const concurrency = Number(value);
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error('--concurrency must be a positive integer.');
    }
    parsed.concurrency = concurrency;
    return;
  }
  if (flag === '--limit') {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('--limit must be a positive integer.');
    }
    parsed.limit = limit;
    return;
  }
  if (flag === '--for') {
    if (!['initialized', 'ready', 'idle', 'text'].includes(value)) {
      throw new Error('--for must be one of: initialized, ready, idle, text.');
    }
    parsed.waitCondition = value;
    return;
  }
  if (flag === '--contains') {
    parsed.contains = value;
    return;
  }
  if (flag === '--interval-ms') {
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error('--interval-ms must be a positive number.');
    }
    parsed.intervalMs = intervalMs;
    return;
  }
  if (flag === '--source') {
    if (!['user', 'agent'].includes(value)) {
      throw new Error('--source must be one of: user, agent.');
    }
    parsed.source = value;
    return;
  }
  if (flag === '--strategy') {
    if (!['auto', 'codex-ctrl-enter', 'enter'].includes(value)) {
      throw new Error('--strategy must be one of: auto, codex-ctrl-enter, enter.');
    }
    parsed.composerStrategy = value;
    return;
  }
  if (flag === '--as') {
    parsed.watchAs = value;
    return;
  }
  if (flag === '--since') {
    const since = Number(value);
    if (!Number.isInteger(since) || since < 0) throw new Error('--since must be a non-negative integer.');
    parsed.watchSince = since;
    return;
  }
  if (flag === '--from') {
    if (value !== 'now' && value !== 'earliest') throw new Error('--from must be now or earliest.');
    parsed.watchFrom = value;
    return;
  }
  if (flag === '--kinds') {
    parsed.watchKinds = value.split(',').map(kind => kind.trim()).filter(Boolean);
    return;
  }
  if (flag === '--name-contains') {
    parsed.nameContains = value;
    return;
  }
  if (flag === '--format') {
    if (parsed.command === 'watch') {
      if (value !== 'lines' && value !== 'json') {
        throw new Error('--format for watch must be lines or json.');
      }
      parsed.watchFormat = value;
      return;
    }
    if (!FORMATS.has(value)) {
      throw new Error(`Invalid --format "${value}". Expected one of: ${[...FORMATS].join(', ')}`);
    }
    parsed.format = decodeBoundary(value, formatSchema);
    return;
  }
  if (flag === '--heartbeat') {
    parsed.heartbeatSeconds = parseNonNegativeIntegerFlag(flag, value);
    return;
  }
  if (flag === '--idle-after') {
    parsed.idleAfterMs = parseNonNegativeIntegerFlag(flag, value);
    return;
  }
  if (flag === '--settle') {
    parsed.settleMs = parseNonNegativeIntegerFlag(flag, value);
    return;
  }
  if (flag === '--blocked-settle') {
    parsed.blockedSettleMs = parseNonNegativeIntegerFlag(flag, value);
    return;
  }
  if (flag === '--min-interval') {
    parsed.minIntervalMs = parseNonNegativeIntegerFlag(flag, value);
    return;
  }
  if (flag === '--body-file') {
    parsed.bodyFile = value;
    return;
  }

  throw new Error(`Unknown option for ${parsed.command}: ${flag}`);
}

function parseNonNegativeIntegerFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

/** True when any cadence flag that needs a named daemon cursor was given. */
export function hasCadenceValueFlag(parsed: ParsedArgs): boolean {
  return [parsed.settleMs, parsed.blockedSettleMs, parsed.minIntervalMs].some(value => value !== undefined);
}

function isRunpaneLocalCommand(command: RunpaneCommand): boolean {
  return command === 'doctor'
    || command === 'daemon repair'
    || command === 'repos list'
    || command === 'repos add'
    || command === 'panes list'
    || command === 'panes cost'
    || command === 'panes create'
    || command === 'panes adopt'
    || command === 'panes archive'
    || command === 'panes pin'
    || command === 'panes unpin'
    || command === 'panes rename'
    || command === 'panes focus'
    || command === 'sessions list'
    || command === 'sessions create'
    || command === 'sessions get'
    || command === 'sessions update'
    || command === 'sessions set-agent'
    || command === 'sessions associate'
    || command === 'sessions detach'
    || command === 'sessions overview'
    || command === 'panels create'
    || command === 'panels list'
    || command === 'panels output'
    || command === 'panels input'
    || command === 'panels screen'
    || command === 'panels submit'
    || command === 'panels submit-composer'
    || command === 'panels wait'
    || command === 'workspace state'
    || command === 'watch'
    || command === 'agents doctor';
}

function appendRemoteArg(parsed: ParsedArgs, flag: string, value?: string): void {
  if (parsed.command === 'install' && parsed.target === 'daemon') {
    parsed.remoteSetupArgs.push(flag);
    if (value !== undefined) {
      parsed.remoteSetupArgs.push(value);
    }
    return;
  }

  if (REMOTE_VALUE_FLAGS.has(flag) || REMOTE_BOOLEAN_FLAGS.has(flag)) {
    throw new Error(`${flag} is only valid with "runpane install daemon".`);
  }
}

function appendUnknownRemoteArg(args: string[], index: number, parsed: ParsedArgs, arg: string): number {
  parsed.remoteSetupArgs.push(arg);
  const next = args[index + 1];
  if (arg.startsWith('-') && next && !next.startsWith('-')) {
    parsed.remoteSetupArgs.push(next);
    return index + 1;
  }
  return index;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || (value.startsWith('-') && value !== '-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function helpText(topic?: string): string {
  const helpTopics = RUNPANE_CONTRACT.help.npm;
  const topicLines = topic
    ? Object.entries(helpTopics).find(([key]) => key === topic)?.[1]
    : undefined;
  return (topicLines ?? helpTopics.default).join('\n');
}
