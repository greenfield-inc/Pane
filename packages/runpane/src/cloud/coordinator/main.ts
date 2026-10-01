import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JsonValue } from '../../boundaryDecoder';
import { getWrapperVersion } from '../../version';
import { createCallerSecret, mintCallerToken } from './callerAuth';
import { callCoordinator, defaultClientConfigPath, readClientConfig } from './client';
import type { CoordinatorClientConfig } from './client';
import {
  COORDINATOR_UNIT_NAME,
  DEFAULT_COORDINATOR_PORT,
  defaultCoordinatorHome,
  loadCoordinatorConfig,
  readSecretFile,
} from './config';
import type { IdleCheckReport } from './idleStop';
import type { ReconcileReport } from './reconciler';
import type { WakeResult } from './wake';
import { buildCoordinator, renderSystemdUnit, startCoordinator } from './service';

const USAGE = `Usage: runpane-cloud-coordinator <command> [options]

The always-on part of \`runpane cloud\`: idle-stop, reconcile (alert on orphans; never deletes), runaway guard, /cloud/wake.

On the coordinator machine:
  init --listen-host <tailnet-ip> --api-key-file <file> --managed-prefix <prefix>
       [--self-sandbox-id <id>] [--pinned-version <v>] [--directory-file <file>] [--listen-port <port>]
                                  Write a config (0600) and a caller secret if missing
  serve                           Run the HTTP API and the idle-stop / reconcile loops
  install-service [--node <path>] [--entry <path>] [--no-start]
                                  Install and start the ${COORDINATOR_UNIT_NAME} systemd user unit
  mint-token <callerId> (--out <file> | --client-config <file> --base-url <url>)
                                  Write a caller token (0600). callerId: a cloud Session id, or user:<name>.
                                  --client-config writes {baseUrl, token} for the laptop CLI.

Against a running coordinator (uses --client-config, default $RUNPANE_CLOUD_DIR/coordinator.json;
--local runs in-process on the coordinator machine instead):
  status <host>                   Status of a cloud Session without waking it
  wake <host> [--no-wait] [--timeout-ms <ms>]
                                  Wake a cloud Session and wait for /health readiness
  reconcile [--dry-run]           One reconcile pass now
  idle-check [--dry-run]          One idle-stop pass now
  alerts                          Recent alerts
  push-directory --file <directory.json>
                                  Replace the coordinator's directory (the laptop CLI is its single writer)

Options: --config <file> (default ~/.config/runpane-cloud-coordinator/config.json)
`;

interface ParsedCoordinatorArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  '--config', '--listen-host', '--api-key-file', '--managed-prefix', '--self-sandbox-id', '--pinned-version',
  '--directory-file', '--node', '--entry', '--out', '--timeout-ms', '--listen-port', '--client-config', '--base-url',
  '--file',
]);

function parseArgs(argv: readonly string[]): ParsedCoordinatorArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[index + 1];
        if (value === undefined) throw new Error(`${name} requires a value`);
        if (inline === undefined) index += 1;
        flags.set(name, value);
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

function stringFlag(args: ParsedCoordinatorArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === true ? undefined : value;
}

function requiredFlag(args: ParsedCoordinatorArgs, name: string): string {
  const value = stringFlag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

type PrintableResult = JsonValue | WakeResult | ReconcileReport | IdleCheckReport;

function printJson(value: PrintableResult): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runLocal(args: ParsedCoordinatorArgs, configPath: string): Promise<number> {
  const parts = buildCoordinator(loadCoordinatorConfig(configPath));
  const dryRun = args.flags.has('--dry-run') ? true : undefined;
  const host = args.positionals[0] ?? '';
  const timeout = stringFlag(args, '--timeout-ms');
  switch (args.command) {
    case 'reconcile':
      printJson(await parts.api.reconcile({ dryRun }));
      return 0;
    case 'idle-check':
      printJson(await parts.api.idleCheck({ dryRun }));
      return 0;
    case 'status':
    case 'wake': {
      if (!host) throw new Error(`${args.command} needs a host`);
      const result = args.command === 'status'
        ? await parts.api.status(host)
        : await parts.api.wake(host, { wait: !args.flags.has('--no-wait'), timeoutMs: timeout ? Number(timeout) : undefined }, { role: 'user', id: 'user:local-cli' });
      printJson(result);
      return result.ok ? 0 : 1;
    }
    default:
      throw new Error(`${args.command} is not available with --local`);
  }
}

async function runRemote(args: ParsedCoordinatorArgs): Promise<number> {
  const file = path.resolve(stringFlag(args, '--client-config') ?? defaultClientConfigPath());
  const client: CoordinatorClientConfig | null = readClientConfig(file);
  if (!client) throw new Error(`no coordinator client config at ${file} (or pass --local on the coordinator machine)`);
  const dryRun = args.flags.has('--dry-run');
  const host = args.positionals[0] ?? '';
  const timeout = Number(stringFlag(args, '--timeout-ms') ?? 90_000);
  let result;
  switch (args.command) {
    case 'status':
      result = await callCoordinator(client, 'GET', `/cloud/status?host=${encodeURIComponent(host)}`, undefined, 30_000);
      break;
    case 'wake':
      result = await callCoordinator(client, 'POST', '/cloud/wake', { host, wait: !args.flags.has('--no-wait'), timeoutMs: timeout }, timeout + 30_000);
      break;
    case 'reconcile':
    case 'idle-check':
      result = await callCoordinator(client, 'POST', `/cloud/${args.command}`, { dryRun }, 300_000);
      break;
    case 'alerts':
      result = await callCoordinator(client, 'GET', '/cloud/alerts?limit=100', undefined, 30_000);
      break;
    default: {
      const directoryFile = requiredFlag(args, '--file');
      const directory: JsonValue = JSON.parse(fs.readFileSync(directoryFile, 'utf8'));
      result = await callCoordinator(client, 'PUT', '/cloud/directory', directory, 60_000);
    }
  }
  printJson(result.body);
  return result.status >= 200 && result.status < 300 ? 0 : 1;
}

export async function runCoordinatorCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const configPath = path.resolve(stringFlag(args, '--config') ?? path.join(defaultCoordinatorHome(), 'config.json'));
  const home = path.dirname(configPath);

  switch (args.command) {
    case null:
    case 'help':
      console.log(USAGE);
      return args.command === null ? 2 : 0;

    case 'init': {
      if (fs.existsSync(configPath)) throw new Error(`${configPath} already exists; edit it instead`);
      const config = {
        version: 1,
        listenHost: requiredFlag(args, '--listen-host'),
        listenPort: Number(stringFlag(args, '--listen-port') ?? DEFAULT_COORDINATOR_PORT),
        stateDir: path.join(home, 'state'),
        directoryFile: path.resolve(stringFlag(args, '--directory-file') ?? path.join(home, 'directory.json')),
        secretFile: path.join(home, 'caller-secret'),
        provider: { kind: 'boat', apiKeyFile: path.resolve(requiredFlag(args, '--api-key-file')) },
        managedNamePrefix: requiredFlag(args, '--managed-prefix'),
        selfSandboxId: stringFlag(args, '--self-sandbox-id') ?? null,
        pinnedVersion: stringFlag(args, '--pinned-version') ?? null,
      };
      writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      if (!fs.existsSync(config.secretFile)) writePrivateFile(config.secretFile, `${createCallerSecret()}\n`);
      loadCoordinatorConfig(configPath);
      console.log(`wrote ${configPath} (0600) and caller secret ${config.secretFile}`);
      return 0;
    }

    case 'serve': {
      const config = loadCoordinatorConfig(configPath);
      const running = await startCoordinator(buildCoordinator(config), { version: getWrapperVersion() });
      await new Promise<void>((resolve) => {
        const shutdown = () => resolve();
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
      });
      await running.close();
      return 0;
    }

    case 'install-service': {
      loadCoordinatorConfig(configPath);
      const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      const unitFile = path.join(unitDir, COORDINATOR_UNIT_NAME);
      const unit = renderSystemdUnit({
        nodePath: stringFlag(args, '--node') ?? process.execPath,
        entryPath: path.resolve(stringFlag(args, '--entry') ?? __filename),
        configPath,
      });
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(unitFile, unit);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      if (!args.flags.has('--no-start')) {
        execFileSync('systemctl', ['--user', 'enable', '--now', COORDINATOR_UNIT_NAME], { stdio: 'inherit' });
        try {
          execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'inherit' });
        } catch {
          console.error('warning: loginctl enable-linger failed; the unit stops when you log out');
        }
      }
      console.log(`installed ${unitFile}`);
      return 0;
    }

    case 'mint-token': {
      const callerId = args.positionals[0];
      if (!callerId) throw new Error('mint-token needs a caller id');
      const config = loadCoordinatorConfig(configPath);
      const token = mintCallerToken(readSecretFile(config.secretFile), callerId);
      const out = stringFlag(args, '--out');
      const clientConfig = stringFlag(args, '--client-config');
      if (out) {
        writePrivateFile(path.resolve(out), `${token}\n`);
        console.log(`wrote the token for ${callerId} to ${out} (0600)`);
      } else if (clientConfig) {
        const baseUrl = requiredFlag(args, '--base-url');
        writePrivateFile(path.resolve(clientConfig), `${JSON.stringify({ baseUrl, token }, null, 2)}\n`);
        console.log(`wrote {baseUrl, token} for ${callerId} to ${clientConfig} (0600)`);
      } else {
        throw new Error('mint-token needs --out <file> or --client-config <file> --base-url <url> (tokens are never printed)');
      }
      return 0;
    }

    case 'status':
    case 'wake':
    case 'reconcile':
    case 'idle-check':
    case 'alerts':
    case 'push-directory':
      return args.flags.has('--local') ? runLocal(args, configPath) : runRemote(args);

    default:
      console.error(`unknown command ${args.command}\n\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  runCoordinatorCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error(`runpane-cloud-coordinator: ${cause instanceof Error ? cause.message : String(cause)}`);
      process.exitCode = 1;
    },
  );
}
