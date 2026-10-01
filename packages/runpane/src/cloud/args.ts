import { CLOUD_SIZES, type CloudSize } from './provider';

/** How clients reach a cloud Session's daemon: see ProvisionOptions.transport. */
const CLOUD_TRANSPORTS = ['auto', 'https', 'http'] as const;
export type CloudTransport = (typeof CLOUD_TRANSPORTS)[number];

const CLOUD_SUBCOMMANDS = ['setup', 'new', 'list', 'status', 'stop', 'wake', 'repair', 'destroy', 'pair', 'sync', 'coordinator', 'peers', 'secrets', 'port', 'github', 'git', 'notes', 'agent-defaults'] as const;
type CloudSubcommand = typeof CLOUD_SUBCOMMANDS[number];

/** Subcommands that act on one host, named by a positional argument or --host. */
const HOST_SUBCOMMANDS = new Set<CloudSubcommand>(['status', 'stop', 'wake', 'repair', 'destroy', 'pair']);

export interface CloudArgs {
  subcommand: CloudSubcommand;
  host?: string;
  json: boolean;
  yes: boolean;
  force: boolean;
  noWait: boolean;
  noImport: boolean;
  keepOnFailure: boolean;
  label?: string;
  repo?: string;
  ref?: string;
  size?: CloudSize;
  transport?: CloudTransport;
  fromSnapshot?: string;
  noGolden: boolean;
  namePrefix?: string;
  paneDebUrl?: string;
  /** Hex sha256 the sandbox checks the --pane-deb-url download against before installing it as root. */
  paneDebSha256?: string;
  paneNpmSpec?: string;
  panePreinstalled: boolean;
  desktopDir?: string;
  timeoutMs?: number;
  boatKeyFile?: string;
  /** boat wallet: org id, name or `personal` (setup saves it; new overrides it for one create). */
  boatOrg?: string;
  tailscaleClientId?: string;
  tailscaleSecretFile?: string;
  tailscaleTailnet?: string;
  anthropicKeyFile?: string;
  claudeTokenFile?: string;
  golden?: string;
  maxLive?: number;
  coordinator?: boolean;
  noVerify: boolean;
  /** `new --github`: clone --repo over a deploy key generated in the sandbox (private repositories). */
  github: boolean;
  readWrite: boolean;
  githubTokenFile?: string;
  /** `runpane cloud coordinator|peers|secrets|port|github|git|notes|agent-defaults ...`: everything after the subcommand, parsed by its own module. */
  passthrough: string[];
}

type ValueFlag = Exclude<{
  [Key in keyof CloudArgs]-?: CloudArgs[Key] extends string | number | undefined ? Key : never
}[keyof CloudArgs], 'host' | 'subcommand'>;

type BooleanFlag = {
  [Key in keyof CloudArgs]-?: CloudArgs[Key] extends boolean ? Key : never
}[keyof CloudArgs];

const VALUE_FLAGS = new Map<string, ValueFlag>([
  ['--label', 'label'],
  ['--repo', 'repo'],
  ['--ref', 'ref'],
  ['--size', 'size'],
  ['--transport', 'transport'],
  ['--from', 'fromSnapshot'],
  ['--name-prefix', 'namePrefix'],
  ['--pane-deb-url', 'paneDebUrl'],
  ['--pane-deb-sha256', 'paneDebSha256'],
  ['--pane-npm-spec', 'paneNpmSpec'],
  ['--desktop-dir', 'desktopDir'],
  ['--timeout-ms', 'timeoutMs'],
  ['--boat-key-file', 'boatKeyFile'],
  ['--boat-org', 'boatOrg'],
  ['--tailscale-client-id', 'tailscaleClientId'],
  ['--tailscale-secret-file', 'tailscaleSecretFile'],
  ['--tailscale-tailnet', 'tailscaleTailnet'],
  ['--anthropic-key-file', 'anthropicKeyFile'],
  ['--claude-token-file', 'claudeTokenFile'],
  ['--golden', 'golden'],
  ['--max-live', 'maxLive'],
  ['--github-token-file', 'githubTokenFile'],
]);

const BOOLEAN_FLAGS = new Map<string, BooleanFlag>([
  ['--json', 'json'],
  ['--yes', 'yes'],
  ['-y', 'yes'],
  ['--force', 'force'],
  ['--no-wait', 'noWait'],
  ['--no-import', 'noImport'],
  ['--keep-on-failure', 'keepOnFailure'],
  ['--no-golden', 'noGolden'],
  ['--pane-preinstalled', 'panePreinstalled'],
  ['--no-verify', 'noVerify'],
  ['--github', 'github'],
  ['--read-write', 'readWrite'],
]);

/** Flags each subcommand accepts, beyond --json. */
const ALLOWED = {
  setup: ['--boat-key-file', '--boat-org', '--tailscale-client-id', '--tailscale-secret-file', '--tailscale-tailnet', '--anthropic-key-file', '--claude-token-file',
    '--golden', '--no-golden', '--size', '--transport', '--name-prefix', '--pane-deb-url', '--pane-deb-sha256', '--pane-npm-spec', '--pane-preinstalled', '--max-live',
    '--coordinator', '--no-coordinator', '--no-verify'],
  new: ['--label', '--boat-org', '--repo', '--ref', '--size', '--transport', '--from', '--no-golden', '--name-prefix', '--pane-deb-url', '--pane-deb-sha256', '--pane-npm-spec',
    '--pane-preinstalled', '--desktop-dir', '--no-import', '--timeout-ms', '--keep-on-failure', '--yes', '-y',
    '--github', '--read-write', '--github-token-file'],
  list: [],
  status: ['--host'],
  stop: ['--host', '--yes', '-y', '--force', '--no-wait'],
  wake: ['--host', '--size', '--timeout-ms'],
  repair: ['--host'],
  destroy: ['--host', '--yes', '-y', '--desktop-dir', '--no-import'],
  pair: ['--host'],
  sync: ['--desktop-dir'],
  coordinator: [],
  peers: [],
  secrets: [],
  port: [],
  github: [],
  git: [],
  notes: [],
  'agent-defaults': [],
} satisfies Record<CloudSubcommand, readonly string[]>;

function isCloudSubcommand(value: string | undefined): value is CloudSubcommand {
  return CLOUD_SUBCOMMANDS.some((name) => name === value);
}

/** Parses the arguments after `runpane cloud`. */
export function parseCloudArgs(argv: readonly string[]): CloudArgs {
  const [first, ...rest] = argv;
  if (!isCloudSubcommand(first)) {
    throw new Error(`Unknown cloud command: ${first ?? '(none)'}. Expected one of: ${CLOUD_SUBCOMMANDS.join(', ')}.`);
  }
  const parsed: CloudArgs = {
    subcommand: first,
    json: false,
    yes: false,
    force: false,
    noWait: false,
    noImport: false,
    keepOnFailure: false,
    noGolden: false,
    panePreinstalled: false,
    noVerify: false,
    github: false,
    readWrite: false,
    passthrough: [],
  };
  if (first === 'coordinator' || first === 'peers' || first === 'secrets' || first === 'port' || first === 'github' || first === 'git' || first === 'notes' || first === 'agent-defaults') {
    parsed.passthrough = [...rest];
    return parsed;
  }

  const allowed = new Set<string>(['--json', ...ALLOWED[first]]);
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index];
    const separator = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : raw.slice(separator + 1);

    if (!flag.startsWith('-')) {
      if (!HOST_SUBCOMMANDS.has(first) || parsed.host !== undefined) {
        throw new Error(`Unexpected argument for runpane cloud ${first}: ${raw}`);
      }
      parsed.host = raw;
      continue;
    }
    if (!allowed.has(flag)) throw new Error(`Unknown option for runpane cloud ${first}: ${flag}`);

    if (flag === '--coordinator' || flag === '--no-coordinator') {
      parsed.coordinator = flag === '--coordinator';
      continue;
    }
    const booleanKey = BOOLEAN_FLAGS.get(flag);
    if (booleanKey) {
      parsed[booleanKey] = true;
      continue;
    }
    const value = inlineValue ?? rest[++index];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`${flag} requires a value.`);
    }
    if (flag === '--host') {
      if (parsed.host !== undefined) throw new Error('Name the host once.');
      parsed.host = value;
      continue;
    }
    const valueKey = VALUE_FLAGS.get(flag);
    if (!valueKey) throw new Error(`Unknown option for runpane cloud ${first}: ${flag}`);
    assignValue(parsed, valueKey, flag, value);
  }

  if (HOST_SUBCOMMANDS.has(first) && !parsed.host) {
    throw new Error(`runpane cloud ${first} needs a host: runpane cloud ${first} <host>. See runpane cloud list.`);
  }
  if ([parsed.paneDebUrl, parsed.paneNpmSpec, parsed.panePreinstalled || undefined].filter(Boolean).length > 1) {
    throw new Error('Use only one of --pane-deb-url, --pane-npm-spec, --pane-preinstalled.');
  }
  if (parsed.paneDebSha256 && !parsed.paneDebUrl) throw new Error('--pane-deb-sha256 goes with --pane-deb-url.');
  if ((parsed.readWrite || parsed.githubTokenFile) && !parsed.github) {
    throw new Error('--read-write and --github-token-file go with --github.');
  }
  if (parsed.github && !parsed.repo) throw new Error('--github needs --repo <owner/name or GitHub URL>.');
  if (parsed.noGolden && (parsed.fromSnapshot || parsed.golden)) {
    throw new Error('--no-golden cannot be combined with --from or --golden.');
  }
  return parsed;
}

function assignValue(parsed: CloudArgs, key: ValueFlag, flag: string, value: string): void {
  if (key === 'size') {
    const size = CLOUD_SIZES.find((candidate) => candidate === value);
    if (!size) throw new Error(`--size must be one of: ${CLOUD_SIZES.join(', ')}.`);
    parsed.size = size;
    return;
  }
  if (key === 'transport') {
    const transport = CLOUD_TRANSPORTS.find((candidate) => candidate === value);
    if (!transport) throw new Error(`--transport must be one of: ${CLOUD_TRANSPORTS.join(', ')}.`);
    parsed.transport = transport;
    return;
  }
  if (key === 'timeoutMs' || key === 'maxLive') {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer.`);
    parsed[key] = number;
    return;
  }
  if (key === 'paneDebSha256') {
    if (!/^[0-9a-fA-F]{64}$/u.test(value)) throw new Error('--pane-deb-sha256 must be the 64 hex digit sha256 of the .deb.');
    parsed.paneDebSha256 = value.toLowerCase();
    return;
  }
  if (key === 'namePrefix' && !/^[a-z][a-z0-9-]{0,40}[a-z0-9]$|^[a-z]$/u.test(value)) {
    throw new Error('--name-prefix must be lowercase letters, digits and hyphens, starting with a letter.');
  }
  parsed[key] = value;
}
