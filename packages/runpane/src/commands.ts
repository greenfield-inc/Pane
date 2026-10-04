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
  branch?: string;
  baseBranch?: string;
  agent?: RunpaneAgent;
  toolCommand?: string;
  title?: string;
  url?: string;
  file?: string;
  placement?: 'split' | 'tab';
  initialInput?: string;
  initialInputFile?: string;
  asFilePointer?: boolean;
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
  noAssociate?: boolean;
  composerStrategy?: string;
  force?: boolean;
  removeWorktree?: boolean;
  merged?: boolean;
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
  /** Watch only: drop the _ok, _heartbeat, and _reconnected control lines. */
  quiet?: boolean;
  report?: boolean;
  bodyFile?: string;
  message?: string;
  query?: string;
  doc?: string;
  keys?: string[];
  toolsets?: string[];
  readOnly?: boolean;
  reportState?: ReportState;
  reportPr?: number;
  reportHead?: string;
  summary?: string;
  summaryFile?: string;
  question?: string;
  lockTtlMs?: number;
  lockWaitMs?: number;
  note?: string;
  /** `runpane cloud <subcommand> ...`: the arguments after `cloud`, parsed by cloud/cli.ts. */
  cloudArgv?: string[];
  remoteSetupArgs: string[];
}

/** `runpane report --state`: what a worker says about its task. */
type ReportState = 'ready' | 'blocked' | 'failed' | 'done';
const REPORT_STATES: readonly ReportState[] = ['ready', 'blocked', 'failed', 'done'];
const reportStateSchema = boundary.enumeration('ready', 'blocked', 'failed', 'done');
const HEAD_PATTERN = /^[0-9a-fA-F]{7,40}$/;

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
const COMMAND_GROUP_HELP_TOPICS = new Set(['panes', 'panels', 'sessions', 'workspace', 'lock']);
const LOCK_DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/u;
const LOCK_DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const MAX_LOCK_DURATION_MS = 86_400_000;

const REMOTE_VALUE_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteValue.map((flag) => flag.name));
const REMOTE_BOOLEAN_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteBoolean.map((flag) => flag.name));
const LOCAL_VALUE_FLAGS = createFlagSet(RUNPANE_CONTRACT.flags.localValue);
const LOCAL_BOOLEAN_FLAGS = createFlagSet(RUNPANE_CONTRACT.flags.localBoolean);
const INLINE_VALUE_FLAGS = new Set<string>([
  ...LOCAL_VALUE_FLAGS,
  ...RUNPANE_CONTRACT.flags.wrapper.filter((flag) => 'value' in flag).map((flag) => flag.name),
  '--command',
]);

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

  if (first === 'cloud') {
    return parseCloudEntry(args);
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
  if (parsed.command === 'watch' && parsed.sessionId !== undefined && parsed.watchPaneIds?.length) {
    throw new Error('runpane watch accepts either --session or --pane, not both; --session already follows every Pane in the Session.');
  }
  if (parsed.command === 'watch' && parsed.sessionId !== undefined && parsed.allManaged) {
    throw new Error('runpane watch accepts either --session or --all-managed, not both.');
  }
  if (parsed.command === 'watch' && parsed.allManaged && parsed.watchPaneIds?.length) {
    throw new Error('runpane watch accepts either --all-managed or --pane, not both.');
  }
  if (parsed.command === 'panes archive') {
    validatePanesArchiveArgs(parsed);
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
  if (parsed.command === 'report') validateReportArgs(parsed);
  return parsed;
}

/** `runpane cloud ...` keeps its own flags (cloud/cli.ts); only the subcommand is matched here. */
function parseCloudEntry(args: string[]): ParsedArgs {
  const wantsHelp = (arg: string) => arg === '-h' || arg === '--help';
  if (args.length === 1 || wantsHelp(args[1])) {
    return { command: 'help', helpTopic: 'cloud', ...DEFAULTS };
  }
  const matched = matchCommand(args);
  if (!matched) {
    throw new Error(`Unknown cloud command: ${args[1]}\n\n${helpText('cloud')}`);
  }
  const rest = args.slice(matched.tokens.length);
  if (rest.some(wantsHelp)) {
    return { command: 'help', helpTopic: matched.name, ...DEFAULTS };
  }
  return {
    command: decodeBoundary(matched.name, commandSchema),
    ...DEFAULTS,
    cloudArgv: [...matched.tokens.slice(1), ...rest],
    remoteSetupArgs: []
  };
}

function validateReportArgs(parsed: ParsedArgs): void {
  if (!parsed.reportState) {
    throw new Error(`runpane report requires --state <${REPORT_STATES.join('|')}>.`);
  }
  if (parsed.summary !== undefined && parsed.summaryFile !== undefined) {
    throw new Error('runpane report accepts either --summary or --summary-file, not both.');
  }
  if (parsed.reportState === 'blocked' && !parsed.question?.trim()) {
    throw new Error('runpane report --state blocked requires --question "<what you need answered>".');
  }
}

function validatePanesArchiveArgs(parsed: ParsedArgs): void {
  if (parsed.paneId && parsed.sessionId) {
    throw new Error('runpane panes archive accepts either --pane or --session, not both.');
  }
  if (parsed.merged && !parsed.sessionId) {
    throw new Error('--merged requires --session.');
  }
  if (parsed.sessionId && !parsed.merged) {
    throw new Error('runpane panes archive --session requires --merged.');
  }
  if (parsed.sessionId && parsed.force) {
    throw new Error('runpane panes archive --session does not accept --force; archive one Pane with --pane to discard its work.');
  }
}

function parseFlags(rawArgs: string[], parsed: ParsedArgs): void {
  const { args, literalValues } = splitInlineValues(rawArgs);
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
      parsed.contextCommand = readValue(args, ++index, arg, literalValues);
      continue;
    }
    // Offline commands accept --pane-dir and ignore it, so one --pane-dir works for every command.
    if ((isAgentContextCommand || parsed.command === 'version') && arg === '--pane-dir') {
      parsed.paneDir = readValue(args, ++index, arg, literalValues);
      continue;
    }
    if (isLocalCommand && LOCAL_BOOLEAN_FLAGS.has(arg)) {
      parseLocalBooleanFlag(arg, parsed);
      continue;
    }
    if (isLocalCommand && LOCAL_VALUE_FLAGS.has(arg)) {
      const value = readValue(args, ++index, arg, literalValues);
      parseLocalValueFlag(arg, value, parsed);
      continue;
    }
    if (arg === '--version') {
      parsed.paneVersion = readValue(args, ++index, arg, literalValues);
      continue;
    }
    if (arg === '--download-dir') {
      parsed.downloadDir = readValue(args, ++index, arg, literalValues);
      continue;
    }
    if (arg === '--pane-path') {
      parsed.panePath = readValue(args, ++index, arg, literalValues);
      continue;
    }
    if (arg === '--format') {
      const value = readValue(args, ++index, arg, literalValues);
      if (!FORMATS.has(value)) {
        throw new Error(`Invalid --format "${value}". Expected one of: ${[...FORMATS].join(', ')}`);
      }
      parsed.format = decodeBoundary(value, formatSchema);
      continue;
    }

    if (REMOTE_VALUE_FLAGS.has(arg)) {
      const value = readValue(args, ++index, arg, literalValues);
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

export function matchCommand(args: string[]): { name: RunpaneCommand; tokens: string[] } | undefined {
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
  if (flag === '--split' || flag === '--tab') {
    if (parsed.placement && parsed.placement !== flag.slice(2)) {
      throw new Error('Use either --split or --tab, not both.');
    }
    parsed.placement = flag === '--split' ? 'split' : 'tab';
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
  if (flag === '--no-associate') {
    parsed.noAssociate = true;
    return;
  }
  if (flag === '--force') {
    parsed.force = true;
    return;
  }
  if (flag === '--remove-worktree') {
    parsed.removeWorktree = true;
    return;
  }
  if (flag === '--merged') {
    parsed.merged = true;
    return;
  }
  if (flag === '--launch') {
    parsed.launch = true;
    return;
  }
  if (flag === '--as-file-pointer') {
    parsed.asFilePointer = true;
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
  if (flag === '--quiet' || flag === '--no-control-lines') {
    if (parsed.command !== 'watch') {
      throw new Error(`${flag} is only valid with runpane watch.`);
    }
    parsed.quiet = true;
    return;
  }
  if (flag === '--report') {
    parsed.report = true;
    return;
  }
  if (flag === '--read-only') {
    parsed.readOnly = true;
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
  if (flag === '--url') {
    parsed.url = value;
    return;
  }
  if (flag === '--file') {
    parsed.file = value;
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
  if (flag === '--branch') {
    parsed.branch = value;
    return;
  }
  if (flag === '--base-branch' || flag === '--base') {
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
  if (flag === '--initial-input-file' || flag === '--prompt-file') {
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
    if (!['auto', 'codex-ctrl-enter', 'enter', 'tab'].includes(value)) {
      throw new Error('--strategy must be one of: auto, codex-ctrl-enter, enter, tab.');
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
  if (flag === '--message') {
    parsed.message = value;
    return;
  }
  if (flag === '--query') {
    parsed.query = value;
    return;
  }
  if (flag === '--doc') {
    parsed.doc = value;
    return;
  }
  if (flag === '--url') {
    parsed.url = value;
    return;
  }
  if (flag === '--keys') {
    parsed.keys = value.split(',').map((key) => key.trim()).filter(Boolean);
    return;
  }
  if (flag === '--toolsets') {
    parsed.toolsets = value.split(',').map((name) => name.trim()).filter(Boolean);
    return;
  }
  if (flag === '--state') {
    if (!REPORT_STATES.some((state) => state === value)) {
      throw new Error(`--state must be one of: ${REPORT_STATES.join(', ')}.`);
    }
    parsed.reportState = decodeBoundary(value, reportStateSchema);
    return;
  }
  if (flag === '--pr') {
    const pr = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(pr) || pr <= 0) throw new Error('--pr must be a positive integer.');
    parsed.reportPr = pr;
    return;
  }
  if (flag === '--head') {
    if (!HEAD_PATTERN.test(value)) throw new Error('--head must be a commit SHA of 7 to 40 hex characters.');
    parsed.reportHead = value.toLowerCase();
    return;
  }
  if (flag === '--summary') {
    parsed.summary = value;
    return;
  }
  if (flag === '--summary-file') {
    parsed.summaryFile = value;
    return;
  }
  if (flag === '--question') {
    parsed.question = value;
    return;
  }
  if (flag === '--ttl') {
    parsed.lockTtlMs = parseLockTtl(value);
    return;
  }
  if (flag === '--wait') {
    const waitMs = parseNonNegativeIntegerFlag(flag, value);
    if (waitMs > MAX_LOCK_DURATION_MS) throw new Error('--wait must be at most 86400000 (24h).');
    parsed.lockWaitMs = waitMs;
    return;
  }
  if (flag === '--note') {
    parsed.note = value;
    return;
  }

  throw new Error(`Unknown option for ${parsed.command}: ${flag}`);
}

/** A lock TTL such as 90s, 30m, or 2h; a bare number is milliseconds. */
function parseLockTtl(value: string): number {
  const match = LOCK_DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error('--ttl must be a duration such as 90s, 30m, or 2h (a bare number is milliseconds).');
  const unit = match[2] === 'ms' || match[2] === 's' || match[2] === 'm' || match[2] === 'h' ? match[2] : 'ms';
  const ttlMs = Number(match[1]) * LOCK_DURATION_UNIT_MS[unit];
  if (ttlMs < 1_000 || ttlMs > MAX_LOCK_DURATION_MS) throw new Error('--ttl must be between 1s and 24h.');
  return ttlMs;
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

const LOCAL_COMMANDS = new Set<string>(RUNPANE_CONTRACT.commands.filter(command => command.localControl).map(command => command.name));

function isRunpaneLocalCommand(command: RunpaneCommand): boolean {
  return LOCAL_COMMANDS.has(command);
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

/**
 * Splits `--flag=value` for the value flags runpane parses itself. A value given this way is taken
 * literally, even when it starts with "-" (for example `--text=- [ ] item`).
 */
interface SplitArgs {
  args: string[];
  /** Indexes of values given as `--flag=value`, which are taken literally. */
  literalValues: Set<number>;
}

function splitInlineValues(rawArgs: string[]): SplitArgs {
  const args: string[] = [];
  const literalValues = new Set<number>();
  for (const arg of rawArgs) {
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? '' : arg.slice(0, separator);
    if (INLINE_VALUE_FLAGS.has(flag)) {
      args.push(flag);
      literalValues.add(args.length);
      args.push(arg.slice(separator + 1));
    } else {
      args.push(arg);
    }
  }
  return { args, literalValues };
}

function readValue(args: string[], index: number, flag: string, literalValues: Set<number>): string {
  const value = args[index];
  if (literalValues.has(index)) return value;
  const freeText = ['--text', '--prompt', '--initial-input', '--title', '--name', '--name-contains'].includes(flag);
  if (!value || (!freeText && value.startsWith('-') && value !== '-')) {
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
