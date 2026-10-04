import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createCloudSandboxes, type CloudProgress, type CloudSandboxes, type CloudSandboxInfo } from './api';
import { CLOUD_SIZES, type CloudSize } from './provider';
import { createDesktopConfigHosts, defaultDesktopDir, type SavedRemoteHosts } from './savedHosts';
import type { PaneSource } from './store';

/**
 * `runpane cloud <setup|new|list|status|stop|start|update|remove>`: the command-line face of ./api.ts, which
 * Pane desktop's Remotes settings drive too. Secrets are read from files or stdin, never from arguments.
 */

interface CloudCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Reads a secret from a file path, or stdin for "-". */
  readSecret(file: string): Promise<string>;
  env: NodeJS.ProcessEnv;
}

/** A command's `--json` result; every one carries `ok`. */
interface CloudCliResult {
  ok: boolean;
}

interface CloudArgs {
  subcommand: string;
  host?: string;
  json: boolean;
  yes: boolean;
  values: Map<string, string>;
  flags: Set<string>;
}

const VALUE_FLAGS = new Set([
  '--boat-key-file',
  '--boat-org',
  '--tailscale-client-id',
  '--tailscale-secret-file',
  '--tailscale-tailnet',
  '--claude-token-file',
  '--label',
  '--size',
  '--transport',
  '--pane-deb-url',
  '--pane-deb-sha256',
  '--pane-npm-spec',
  '--name-prefix',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--yes', '--keep-on-failure']);
const HOST_COMMANDS = new Set(['status', 'stop', 'start', 'update', 'remove']);
const TRANSPORTS = ['auto', 'https', 'http'] as const;

export async function runCloud(argv: readonly string[], io: CloudCliIo = processIo(), sandboxes?: CloudSandboxes): Promise<number> {
  const args = parseCloudArgs(argv);
  const cloud = sandboxes ?? createCloudSandboxes({ savedHosts: await cliSavedHosts(io) });
  const progress = (update: CloudProgress) => (args.json ? io.stderr(update.message) : io.stdout(update.message));
  const print = <Result extends CloudCliResult>(json: Result, text: string) => io.stdout(args.json ? JSON.stringify(json, null, 2) : text);
  const requireYes = (what: string) => {
    if (!args.yes) throw new Error(`runpane cloud ${args.subcommand} ${what}. Rerun with --yes to confirm.`);
  };

  switch (args.subcommand) {
    case 'setup': {
      const status = await cloud.setup({
        boatApiKey: await readSecretFlag(args, io, '--boat-key-file'),
        boatOrg: args.values.get('--boat-org'),
        tailscaleClientId: args.values.get('--tailscale-client-id'),
        tailscaleClientSecret: await readSecretFlag(args, io, '--tailscale-secret-file'),
        tailnet: args.values.get('--tailscale-tailnet'),
        claudeToken: await readSecretFlag(args, io, '--claude-token-file'),
      });
      print({ ok: true, ...status }, [
        'runpane cloud: credentials are saved on this machine only (0600).',
        `  boat API key:           ${status.boat.configured ? 'set' : 'missing'}`,
        `  boat wallet:            ${status.boat.org ? `${status.boat.org.name} (${status.boat.org.id})` : "boat's active wallet"}`,
        `  Tailscale OAuth client: ${status.tailscale.configured ? 'set' : 'missing'}`,
        `  Claude token:           ${status.claude.configured ? 'set' : 'not set (optional)'}`,
        status.ready ? 'Next: runpane cloud new --yes' : 'Next: runpane cloud setup --boat-key-file <path|-> --tailscale-client-id <id> --tailscale-secret-file <path|->',
      ].join('\n'));
      return 0;
    }
    case 'new': {
      requireYes('creates a billed cloud sandbox');
      const info = await cloud.create({
        label: args.values.get('--label'),
        size: parseSize(args.values.get('--size')),
        boatOrg: args.values.get('--boat-org'),
        transport: parseTransport(args.values.get('--transport')),
        paneSource: parsePaneSource(args),
        keepOnFailure: args.flags.has('--keep-on-failure'),
        namePrefix: args.values.get('--name-prefix'),
      }, progress);
      print({ ok: true, sandbox: info }, describe(info));
      return 0;
    }
    case 'list': {
      const infos = await cloud.list();
      print({ ok: true, sandboxes: infos }, infos.length === 0
        ? 'No cloud sandboxes. Create one with: runpane cloud new --yes'
        : formatTable(['HOST', 'LABEL', 'STATE', 'SIZE', 'WALLET', 'URL'],
          infos.map((info) => [info.hostname, info.label, info.state, info.size ?? '-', info.org?.name ?? '-', info.baseUrl || '-'])));
      return 0;
    }
    case 'status': {
      const info = await cloud.status(requiredHost(args));
      print({ ok: info.state !== 'gone', sandbox: info }, describe(info));
      return info.state === 'gone' ? 1 : 0;
    }
    case 'stop': {
      requireYes('powers the sandbox off');
      const info = await cloud.stop(requiredHost(args), progress);
      print({ ok: true, sandbox: info }, describe(info));
      return 0;
    }
    case 'start': {
      const info = await cloud.start(requiredHost(args), progress);
      print({ ok: true, sandbox: info }, describe(info));
      return 0;
    }
    case 'update': {
      requireYes('reinstalls Pane and restarts the daemon');
      const debUrl = args.values.get('--pane-deb-url');
      const sha256 = args.values.get('--pane-deb-sha256');
      if (!debUrl || !sha256) throw new Error('runpane cloud update needs --pane-deb-url <url> and --pane-deb-sha256 <hex>.');
      const info = await cloud.update(requiredHost(args), { debUrl, sha256 }, progress);
      print({ ok: true, sandbox: info }, describe(info));
      return 0;
    }
    case 'remove': {
      requireYes('permanently deletes the sandbox, its disk and its tailnet device');
      const host = requiredHost(args);
      await cloud.remove(host, progress);
      print({ ok: true, host }, `${host} is removed.`);
      return 0;
    }
    default:
      throw new Error(`Unknown cloud command: ${args.subcommand}`);
  }
}

function parseCloudArgs(argv: readonly string[]): CloudArgs {
  const [subcommand = '', ...rest] = argv;
  const args: CloudArgs = { subcommand, json: false, yes: false, values: new Map(), flags: new Set() };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || (value.startsWith('--') && value !== '-')) throw new Error(`${arg} needs a value.`);
      args.values.set(arg, value);
      index++;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      args.flags.add(arg);
    } else if (!arg.startsWith('-') && HOST_COMMANDS.has(subcommand) && args.host === undefined) {
      args.host = arg;
    } else {
      throw new Error(`Unknown option for runpane cloud ${subcommand}: ${arg}`);
    }
  }
  args.json = args.flags.has('--json');
  args.yes = args.flags.has('--yes');
  return args;
}

function requiredHost(args: CloudArgs): string {
  if (!args.host) throw new Error(`runpane cloud ${args.subcommand} needs a host (see runpane cloud list).`);
  return args.host;
}

async function readSecretFlag(args: CloudArgs, io: CloudCliIo, flag: string): Promise<string | undefined> {
  const file = args.values.get(flag);
  if (file === undefined) return undefined;
  const value = (await io.readSecret(file)).trim();
  if (!value) throw new Error(`${flag}: the file is empty.`);
  return value;
}

function parseSize(value: string | undefined): CloudSize | undefined {
  if (value === undefined) return undefined;
  const size = CLOUD_SIZES.find((candidate) => candidate === value);
  if (!size) throw new Error(`--size must be one of ${CLOUD_SIZES.join(', ')}.`);
  return size;
}

function parseTransport(value: string | undefined): (typeof TRANSPORTS)[number] | undefined {
  if (value === undefined) return undefined;
  const transport = TRANSPORTS.find((candidate) => candidate === value);
  if (!transport) throw new Error(`--transport must be one of ${TRANSPORTS.join(', ')}.`);
  return transport;
}

function parsePaneSource(args: CloudArgs): PaneSource | undefined {
  const debUrl = args.values.get('--pane-deb-url');
  const sha256 = args.values.get('--pane-deb-sha256');
  const spec = args.values.get('--pane-npm-spec');
  if (debUrl && spec) throw new Error('Pass either --pane-deb-url or --pane-npm-spec, not both.');
  if (debUrl) {
    // Installed as root: the digest is what vouches for the package.
    if (!sha256) throw new Error('--pane-deb-url needs --pane-deb-sha256 <hex>.');
    return { kind: 'deb-url', url: debUrl, sha256 };
  }
  return spec ? { kind: 'runpane-npm', spec } : undefined;
}

function describe(info: CloudSandboxInfo): string {
  const lines = [`${info.label} (${info.hostname}): ${info.state}`, `  sandbox: ${info.sandboxId} (${info.providerState})`];
  if (info.baseUrl) lines.push(`  url: ${info.baseUrl}${info.transport === 'http' ? ' (plain HTTP inside your tailnet; no TLS certificate)' : ''}`);
  if (info.health) lines.push(`  daemon: ${info.health.ok ? 'healthy' : 'not answering'}`);
  const version = info.health?.version ?? info.daemonVersion;
  if (version) lines.push(`  Pane: ${version}`);
  if (info.org) lines.push(`  boat wallet: ${info.org.name}`);
  return lines.join('\n');
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  return [headers, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

/**
 * The CLI saves hosts into Pane desktop's config.json, which the running app reloads. Without an explicit
 * `$RUNPANE_CLOUD_DESKTOP_DIR`, a machine without Pane desktop gets a note instead of a new config file.
 */
async function cliSavedHosts(io: CloudCliIo): Promise<SavedRemoteHosts> {
  const desktopDir = defaultDesktopDir(io.env);
  const hosts = createDesktopConfigHosts(desktopDir);
  if (io.env.RUNPANE_CLOUD_DESKTOP_DIR) return hosts;
  const desktopExists = await fs.access(path.join(desktopDir, 'config.json')).then(() => true, () => false);
  if (desktopExists) return hosts;
  return {
    async upsert() {
      io.stderr(`runpane cloud: no Pane desktop config at ${desktopDir}; the host was not added to a desktop.`);
    },
    async remove() {},
  };
}

function processIo(): CloudCliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    async readSecret(file) {
      if (file !== '-') return fs.readFile(file, 'utf8');
      let text = '';
      for await (const chunk of process.stdin) text += String(chunk);
      return text;
    },
    env: process.env,
  };
}
