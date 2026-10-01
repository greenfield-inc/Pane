import { randomBytes } from 'node:crypto';
import type { CloudDeps } from './commands';
import { createCallerSecret, mintCallerToken } from './coordinator/callerAuth';
import { pushDirectory } from './coordinatorSync';
import { CloudProviderError, SANDBOX_HOME, type CloudProvider, type CloudSize } from './provider';
import { refreshPeersFiles } from './peers';
import { deleteOwnedDevices } from './tailscale';
import { resolveBoatOrg } from './wallet';
import {
  DEFAULT_NAME_PREFIX,
  type CloudCredentials,
  type CoordinatorDeployment,
  type CoordinatorSecrets,
  type PinnedPane,
} from './store';

/**
 * `runpane cloud coordinator deploy|status|stop|start|destroy`, run on the user's machine.
 *
 * The coordinator (m4, ./coordinator/) is the always-on part of `runpane cloud`: idle-stop, reconcile
 * (stop + alert only) and /cloud/wake. It runs on a tiny sandbox joined to the tailnet as
 * tag:rp-session, so cloud Sessions can reach it, and holds a provider key scoped to read, stop and
 * resume. This file creates and manages that sandbox; the service itself is ./coordinator, shipped from
 * this very CLI package so the coordinator always matches the CLI that deployed it.
 */

const COORDINATOR_PORT = 47300;
const SCOPED_KEY_ACTIONS = ['sandbox.read', 'sandbox.stop', 'sandbox.resume'];
const STAGE_DIR = `${SANDBOX_HOME}/.runpane-cloud/coordinator-stage`;
const COORDINATOR_HOME = `${SANDBOX_HOME}/.config/runpane-cloud-coordinator`;
const COORDINATOR_APP = `${SANDBOX_HOME}/.local/share/runpane-cloud-coordinator/app`;
const READY_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 60_000;
const POLL_MS = 1_500;
const START_REPAIR_CHECK_MS = 30_000;

/** Subcommands handled here; every other `cloud coordinator <sub>` goes to the coordinator CLI in ./coordinator. */
const LIFECYCLE = new Set(['deploy', 'stop', 'start', 'destroy']);

export function isCoordinatorLifecycleCommand(argv: readonly string[]): boolean {
  const [sub, ...rest] = argv;
  if (sub === undefined) return false;
  if (LIFECYCLE.has(sub)) return true;
  // `coordinator status` alone describes the coordinator; `coordinator status <host>` asks it about a Session.
  return sub === 'status' && rest.every((arg) => arg.startsWith('-'));
}

interface CoordinatorArgs {
  sub: 'deploy' | 'status' | 'stop' | 'start' | 'destroy';
  json: boolean;
  yes: boolean;
  name?: string;
  size?: CloudSize;
  fromSnapshot?: string;
  noGolden: boolean;
  reconcile?: boolean;
  idleCheckSeconds?: number;
  wakeGraceSeconds?: number;
  pin?: Partial<PinnedPane>;
  noPin: boolean;
  keyTtl: string;
  boatOrg?: string;
}

export const COORDINATOR_LIFECYCLE_USAGE = `On this machine (create and manage the coordinator sandbox):
  runpane cloud coordinator deploy --yes [--name <host>] [--size small|default|large] [--from <snapshot>|--no-golden] [--boat-org <org|personal>]
        [--no-reconcile|--reconcile] [--idle-check-seconds <n>] [--wake-grace-seconds <n>]
        [--pin-version <v> --pin-deb-url <url> --pin-deb-sha256 <hex> | --no-pin] [--key-ttl <90d>] [--json]
  runpane cloud coordinator status [--json]
  runpane cloud coordinator stop --yes [--json]
  runpane cloud coordinator start [--json]
  runpane cloud coordinator destroy --yes [--json]`;

export function parseCoordinatorArgs(argv: readonly string[]): CoordinatorArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'deploy' && sub !== 'status' && sub !== 'stop' && sub !== 'start' && sub !== 'destroy') {
    throw new Error(COORDINATOR_LIFECYCLE_USAGE);
  }
  const args: CoordinatorArgs = { sub, json: false, yes: false, noGolden: false, noPin: false, keyTtl: '365d' };
  const value = (index: number, flag: string): string => {
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
    return next;
  };
  const positiveInt = (raw: string, flag: string): number => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer.`);
    return number;
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const deployOnly = () => {
      if (sub !== 'deploy') throw new Error(`Unknown option for runpane cloud coordinator ${sub}: ${flag}`);
    };
    switch (flag) {
      case '--json': args.json = true; break;
      case '--yes': case '-y': args.yes = true; break;
      case '--name': deployOnly(); args.name = value(index++, flag); break;
      case '--size': {
        deployOnly();
        const size = value(index++, flag);
        if (size !== 'small' && size !== 'default' && size !== 'large') throw new Error('--size must be one of: small, default, large.');
        args.size = size;
        break;
      }
      case '--from': deployOnly(); args.fromSnapshot = value(index++, flag); break;
      case '--no-golden': deployOnly(); args.noGolden = true; break;
      case '--reconcile': deployOnly(); args.reconcile = true; break;
      case '--no-reconcile': deployOnly(); args.reconcile = false; break;
      case '--idle-check-seconds': deployOnly(); args.idleCheckSeconds = positiveInt(value(index++, flag), flag); break;
      case '--wake-grace-seconds': deployOnly(); args.wakeGraceSeconds = positiveInt(value(index++, flag), flag); break;
      case '--pin-version': deployOnly(); args.pin = { ...args.pin, version: value(index++, flag) }; break;
      case '--pin-deb-url': deployOnly(); args.pin = { ...args.pin, debUrl: value(index++, flag) }; break;
      case '--pin-deb-sha256': deployOnly(); args.pin = { ...args.pin, sha256: value(index++, flag) }; break;
      case '--no-pin': deployOnly(); args.noPin = true; break;
      case '--key-ttl': deployOnly(); args.keyTtl = value(index++, flag); break;
      case '--boat-org': deployOnly(); args.boatOrg = value(index++, flag); break;
      default: throw new Error(`Unknown option for runpane cloud coordinator ${sub}: ${flag}\n\n${COORDINATOR_LIFECYCLE_USAGE}`);
    }
  }
  if (args.name !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(args.name)) {
    throw new Error('--name must be a tailnet hostname: lowercase letters, digits and hyphens.');
  }
  if (args.noGolden && args.fromSnapshot) throw new Error('--no-golden cannot be combined with --from.');
  if (args.pin && args.noPin) throw new Error('--no-pin cannot be combined with --pin-*.');
  if (args.pin && (!args.pin.version || !args.pin.debUrl || !args.pin.sha256)) {
    // The daemon installs the .deb as root, so it only accepts a checksummed artifact (m2 upgrade API).
    throw new Error('A pinned version needs all three of --pin-version, --pin-deb-url and --pin-deb-sha256.');
  }
  if (args.pin?.sha256 && !/^[0-9a-f]{64}$/u.test(args.pin.sha256)) throw new Error('--pin-deb-sha256 must be 64 lowercase hex characters.');
  return args;
}

export async function runCoordinatorLifecycle(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parseCoordinatorArgs(argv);
  switch (args.sub) {
    case 'deploy': return deploy(args, deps);
    case 'status': return status(args, deps);
    case 'stop': return stop(args, deps);
    case 'start': return start(args, deps);
    case 'destroy': return destroy(args, deps);
  }
}

// ---------------------------------------------------------------- deploy

async function deploy(args: CoordinatorArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud coordinator deploy creates (or updates) a billed always-on sandbox. Rerun with --yes to confirm.');
  }
  const settings = await deps.store.readSettings();
  const loaded = await loadProvider(deps);
  const { credentials } = loaded;
  const tailscale = credentials.tailscale;
  if (!tailscale) throw new Error('No Tailscale OAuth client saved. Run: runpane cloud setup --tailscale-client-id <id> --tailscale-secret-file <path|->');
  // A new coordinator sandbox bills --boat-org, else the saved wallet; an existing one keeps its own.
  const wantedOrg = args.boatOrg ? await resolveBoatOrg(loaded.provider, args.boatOrg) : settings.boatOrg;
  let provider = settings.coordinator?.deployment ? loaded.provider : deps.createProvider(credentials, wantedOrg?.id);
  const progress = (line: string) => (args.json ? deps.stderr(line) : deps.stdout(line));
  const started = deps.now();
  const timings: Record<string, number> = {};

  const namePrefix = settings.namePrefix ?? DEFAULT_NAME_PREFIX;
  let deployment = settings.coordinator?.deployment;
  let created = false;
  if (deployment) {
    const sandbox = await provider.get(deployment.sandboxId);
    if (sandbox.state === 'gone') {
      progress(`runpane cloud: the recorded coordinator sandbox ${deployment.sandboxId} is gone; deploying a new one.`);
      deployment = undefined;
    } else if (sandbox.state !== 'running') {
      throw new Error(`The coordinator ${deployment.hostname} is ${sandbox.providerState}. Run runpane cloud coordinator start first, then redeploy.`);
    } else if (sandbox.org && sandbox.org.id !== deployment.boatOrg?.id) {
      // Deployed before wallets were recorded: its wallet is whatever boat billed at create.
      deployment = { ...deployment, boatOrg: sandbox.org };
    }
  }

  const tailnet = deps.bootstrap.createTailnet(tailscale);
  let scopedKey: { id: string; secret: string; ttl: string } | undefined;
  if (!deployment) {
    const hostname = args.name ?? `${namePrefix}-coord`;
    // Deploy and destroy replace tailnet devices under this name, so it stays in runpane's namespace.
    if (!hostname.startsWith(`${namePrefix}-`)) {
      throw new Error(`--name must start with "${namePrefix}-" (the cloud name prefix), so it can't collide with a device runpane did not create.`);
    }
    const fromSnapshot = args.noGolden ? undefined : args.fromSnapshot ?? settings.goldenSnapshot;
    const size = args.size ?? 'small';
    progress(`runpane cloud: creating ${size} coordinator sandbox ${hostname}${fromSnapshot ? ` from ${fromSnapshot}` : ''}...`);
    provider = deps.createProvider(credentials, wantedOrg?.id);
    const sandbox = await provider.create({
      name: hostname,
      size,
      fromSnapshot,
      org: wantedOrg?.id,
      idempotencyKey: `runpane-cloud-coordinator-${randomBytes(6).toString('hex')}`,
    });
    created = true;
    try {
      const ready = await waitForState(provider, sandbox.id, 'running', READY_TIMEOUT_MS, deps);
      const billedOrg = ready.org ?? sandbox.org ?? wantedOrg;
      timings.readyMs = deps.now() - started;
      progress(`runpane cloud: ${sandbox.id} is up; joining the tailnet as ${hostname}...`);
      const joined = await deps.bootstrap.joinTailnet(provider.handle(sandbox.id), {
        sessionId: `coord${randomBytes(4).toString('hex')}`,
        hostname,
        // Over the tailnet the coordinator answers only its API port.
        tailnetTcpPorts: [COORDINATOR_PORT],
        onStep: (step) => progress(`  - ${step}`),
      }, tailscale);
      timings.joinedMs = deps.now() - started;
      scopedKey = await createScopedKey(provider, `runpane-cloud-coordinator ${hostname}`, args.keyTtl);
      progress(`  - scoped provider key ${scopedKey.id} (${SCOPED_KEY_ACTIONS.join(', ')}; expires in ${scopedKey.ttl})`);
      deployment = {
        sandboxId: sandbox.id,
        hostname,
        nodeId: joined.nodeId,
        baseUrl: `http://${joined.magicDnsName}:${COORDINATOR_PORT}`,
        scopedKeyId: scopedKey.id,
        scopedKeyTtl: scopedKey.ttl,
        managedPrefix: `${namePrefix}-`,
        reconcile: true,
        deployedAt: new Date(started).toISOString(),
        appVersion: '',
      };
      if (billedOrg) deployment.boatOrg = billedOrg;
      // Saved before the install, so `coordinator destroy` can clean up a half-finished deploy.
      await saveDeployment(deps, deployment);
    } catch (error) {
      progress(`runpane cloud: coordinator setup failed; removing sandbox ${sandbox.id} and its tailnet device...`);
      await removeCoordinator(provider, tailnet, { sandboxId: sandbox.id, hostname, scopedKeyId: scopedKey?.id }, deps).catch(() => undefined);
      throw error;
    }
  }

  const next: CoordinatorDeployment = {
    ...deployment,
    reconcile: args.reconcile ?? deployment.reconcile,
  };
  if (args.idleCheckSeconds) next.idleCheckSeconds = args.idleCheckSeconds;
  if (args.wakeGraceSeconds) next.wakeGraceSeconds = args.wakeGraceSeconds;
  if (args.noPin) delete next.pin;
  else if (args.pin?.version && args.pin.debUrl && args.pin.sha256) {
    next.pin = { version: args.pin.version, debUrl: args.pin.debUrl, sha256: args.pin.sha256 };
  }

  let secret = await deps.store.readSecretText('coordinator-secret');
  if (!secret) {
    secret = createCallerSecret();
    await deps.store.writeSecretText('coordinator-secret', secret);
  }

  progress(`runpane cloud: installing the coordinator service on ${next.hostname}...`);
  const app = await deps.packCoordinatorApp();
  next.appVersion = app.version;
  await installCoordinator(provider, next, {
    archiveBase64: app.archiveBase64,
    secret,
    scopedKeySecret: scopedKey?.secret,
  });
  timings.installedMs = deps.now() - started;

  const health = await waitForCoordinatorHealth(next.baseUrl, deps);
  timings.healthMs = deps.now() - started;
  if (!health.ok) {
    await saveDeployment(deps, next);
    throw new Error(`The coordinator service was installed but ${next.baseUrl}/health did not answer within ${HEALTH_TIMEOUT_MS / 1000} s. `
      + 'Check that this machine is on the tailnet, then run runpane cloud coordinator status.');
  }

  await deps.store.writeSecretText('coordinator.json', JSON.stringify({
    baseUrl: next.baseUrl,
    token: mintCallerToken(secret, userCallerId(deps.env)),
  }));
  await saveDeployment(deps, next);

  const coordinator = await pushDirectory(deps);
  const records = await deps.store.listHosts();
  const withoutClient = records.filter((record) => !record.meta.coordinatorPairingPath).map((record) => record.profile.cloud.hostname);
  const peers = await refreshPeersFiles(records, deps);
  timings.totalMs = deps.now() - started;

  const summary = {
    ok: true,
    created,
    coordinator: {
      hostname: next.hostname,
      sandboxId: next.sandboxId,
      baseUrl: next.baseUrl,
      version: health.version ?? next.appVersion,
      managedPrefix: next.managedPrefix,
      reconcile: next.reconcile,
      pin: next.pin ?? null,
      github: next.github ? { mode: next.github.mode, appId: next.github.appId ?? null } : null,
    },
    directory: coordinator,
    peersFiles: peers,
    hostsWithoutCoordinatorClient: withoutClient,
    timings,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: coordinator ${next.hostname} is ${created ? 'up' : 'updated'} at ${next.baseUrl} (${Math.round(timings.totalMs / 1000)} s, version ${summary.coordinator.version}).`);
    deps.stdout(`  manages sandboxes named ${next.managedPrefix}*; idle-stop on; reconcile ${next.reconcile ? 'on (stop + alert only)' : 'off'}.`);
    deps.stdout(`  holds a provider key scoped to ${SCOPED_KEY_ACTIONS.join(', ')}${next.scopedKeyTtl ? ` (lifetime ${next.scopedKeyTtl} from ${next.deployedAt.slice(0, 10)}; destroy and redeploy before it expires)` : ''}; this machine's caller token is in ${deps.store.coordinatorClientPath} (0600).`);
    if (next.pin) deps.stdout(`  pinned Pane ${next.pin.version}: Sessions are upgraded to it when they wake.`);
    if (next.secrets) deps.stdout(`  Doppler secrets kept (${next.secrets.configs.map((config) => `${config.project}/${config.config}`).join(', ') || 'no configs'}; policy ${next.secrets.policy.mode}); see runpane cloud coordinator doppler status.`);
    if (next.github) deps.stdout(`  GitHub broker kept (${next.github.mode === 'app' ? `App ${next.github.appId ?? '?'}` : 'fine-grained PAT'}); see runpane cloud coordinator github status.`);
    deps.stdout(`  directory: ${coordinator.pushed ? `${coordinator.sessions} cloud Session${coordinator.sessions === 1 ? '' : 's'}` : `not pushed (${coordinator.reason})`}.`);
    if (withoutClient.length > 0) {
      deps.stdout(`  note: ${withoutClient.join(', ')} were created before the coordinator and have no coordinator client, so idle-stop skips them. New Sessions get one automatically.`);
    }
    deps.stdout('  Stop it with runpane cloud coordinator stop --yes (idle-stop and wake-on-submit pause); start it again with runpane cloud coordinator start.');
  }
  return 0;
}

interface InstallOptions {
  archiveBase64: string;
  secret: string;
  /** Only on the first deploy: the scoped key's secret is returned once by the provider. */
  scopedKeySecret?: string;
}

/** Unset timings fall back to the coordinator's defaults (check every 300 s, 600 s grace after a wake). */
interface IdleStopConfig {
  enabled: true;
  intervalSeconds?: number;
  wakeGraceSeconds?: number;
}

function idleStopConfig(deployment: CoordinatorDeployment): IdleStopConfig {
  const config: IdleStopConfig = { enabled: true };
  if (deployment.idleCheckSeconds) config.intervalSeconds = deployment.idleCheckSeconds;
  if (deployment.wakeGraceSeconds) config.wakeGraceSeconds = deployment.wakeGraceSeconds;
  return config;
}

/** Where `coordinator github set` puts the App key or the PAT on the coordinator (0600, in a 0700 dir). */
const COORDINATOR_GITHUB_DIR = `${COORDINATOR_HOME}/github`;

/** The coordinator config's `github` section (coordinator/config.ts parses it on the box). */
interface CoordinatorGitHubConfigFile {
  mode: 'app' | 'pat';
  allowReadyPulls: boolean;
  appId?: string | null;
  privateKeyFile?: string;
  installationId?: number | null;
  patFile?: string;
  apiBaseUrl?: string;
  gitBaseUrl?: string;
}

/** The broker section of the coordinator config: settings from this machine, credential paths on the box. */
function githubConfig(deployment: CoordinatorDeployment): CoordinatorGitHubConfigFile | null {
  const github = deployment.github;
  if (!github) return null;
  const config: CoordinatorGitHubConfigFile = { mode: github.mode, allowReadyPulls: github.allowReadyPulls };
  if (github.mode === 'app') {
    config.appId = github.appId ?? null;
    config.privateKeyFile = `${COORDINATOR_GITHUB_DIR}/app.pem`;
    config.installationId = github.installationId ?? null;
  } else {
    config.patFile = `${COORDINATOR_GITHUB_DIR}/pat`;
  }
  if (github.apiBaseUrl) config.apiBaseUrl = github.apiBaseUrl;
  if (github.gitBaseUrl) config.gitBaseUrl = github.gitBaseUrl;
  return config;
}

/** Where `coordinator doppler set` puts each config's read-only service token (0600, in a 0700 dir). */
const COORDINATOR_DOPPLER_DIR = `${COORDINATOR_HOME}/doppler`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function dopplerTokenFile(project: string, config: string): string {
  return `${COORDINATOR_DOPPLER_DIR}/${project}.${config}.token`;
}

/** The secrets section of the coordinator config: settings from this machine, token paths on the box. */
function secretsConfig(deployment: CoordinatorDeployment) {
  const secrets = deployment.secrets;
  if (!secrets) return null;
  const policy: CoordinatorSecrets['policy'] = { mode: secrets.policy.mode };
  if (secrets.policy.mode === 'custom') {
    if (secrets.policy.deniedNames) policy.deniedNames = secrets.policy.deniedNames;
    if (secrets.policy.deniedConfigs) policy.deniedConfigs = secrets.policy.deniedConfigs;
  }
  return {
    doppler: {
      apiBaseUrl: secrets.apiBaseUrl ?? 'https://api.doppler.com',
      tokens: secrets.configs.map((config) => ({ project: config.project, config: config.config, tokenFile: dopplerTokenFile(config.project, config.config) })),
    },
    policy,
  };
}

/** The whole coordinator config. This machine is its single writer, so a redeploy rebuilds it from the record. */
function coordinatorConfig(deployment: CoordinatorDeployment, listenHost: string) {
  return {
    version: 1,
    listenHost,
    listenPort: COORDINATOR_PORT,
    stateDir: `${COORDINATOR_HOME}/state`,
    directoryFile: `${COORDINATOR_HOME}/directory.json`,
    secretFile: `${COORDINATOR_HOME}/caller-secret`,
    provider: {
      kind: 'boat',
      apiKeyFile: `${COORDINATOR_HOME}/boat-scoped-key`,
      // The wallet its calls default to; each Session's calls use the wallet the directory names for it.
      org: deployment.boatOrg?.id ?? null,
    },
    managedNamePrefix: deployment.managedPrefix,
    selfSandboxId: deployment.sandboxId,
    pinnedVersion: deployment.pin?.version ?? null,
    pinnedDebUrl: deployment.pin?.debUrl ?? null,
    pinnedDebSha256: deployment.pin?.sha256 ?? null,
    idleStop: idleStopConfig(deployment),
    reconcile: { enabled: deployment.reconcile },
    github: githubConfig(deployment),
    secrets: secretsConfig(deployment),
  };
}

async function coordinatorListenHost(handle: ReturnType<CloudProvider['handle']>): Promise<string> {
  const prepared = await handle.runScript(`umask 077; mkdir -p ${STAGE_DIR} ${COORDINATOR_HOME}; chmod 700 ${STAGE_DIR} ${COORDINATOR_HOME}; tailscale ip -4 | head -1`, { timeoutSeconds: 60 });
  const listenHost = prepared.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (prepared.exitCode !== 0 || !/^100\.\d+\.\d+\.\d+$/u.test(listenHost)) {
    throw new Error(`Could not read the coordinator's tailnet address (exit ${String(prepared.exitCode)}).`);
  }
  return listenHost;
}

interface ReconfigureOptions {
  githubCredential?: { file: 'app.pem' | 'pat'; content: string };
  removeGitHubCredentials?: boolean;
  /** Read-only Doppler service tokens to install (replacing any for the same config). */
  dopplerTokens?: Array<{ project: string; config: string; content: string }>;
  /** Tokens to shred first: some configs, or every one. */
  removeDopplerTokens?: Array<{ project: string; config: string }> | 'all';
}

/**
 * Rewrites the config (and optionally installs or removes the GitHub credential) without touching the
 * app, then restarts the unit and waits for /health on the box. The credential goes through the files
 * API into the stage dir, then `install -m 600` and `shred`: never a command line, env or metadata.
 */
export async function reconfigureCoordinator(
  provider: CloudProvider,
  deployment: CoordinatorDeployment,
  options: ReconfigureOptions = {},
): Promise<void> {
  const handle = provider.handle(deployment.sandboxId);
  const listenHost = await coordinatorListenHost(handle);
  await handle.writeFile(`${STAGE_DIR}/config.json`, `${JSON.stringify(coordinatorConfig(deployment, listenHost), null, 2)}\n`);
  if (options.githubCredential) await handle.writeFile(`${STAGE_DIR}/github-credential`, options.githubCredential.content);
  const target = options.githubCredential ? `${COORDINATOR_GITHUB_DIR}/${options.githubCredential.file}` : '';
  // Doppler tokens: each staged through the files API, then installed 0600 and the staged copy shredded.
  const dopplerLines: string[] = [];
  for (const [index, token] of (options.dopplerTokens ?? []).entries()) {
    await handle.writeFile(`${STAGE_DIR}/doppler-token-${index}`, `${token.content}\n`);
    const file = shellQuote(dopplerTokenFile(token.project, token.config));
    dopplerLines.push(`[ -f ${file} ] && shred -u ${file}; install -m 600 "$S/doppler-token-${index}" ${file}; shred -u "$S/doppler-token-${index}"`);
  }
  if (options.removeDopplerTokens === 'all') {
    dopplerLines.unshift('for f in "$D"/*.token; do [ -f "$f" ] && shred -u "$f"; done; true');
  } else {
    for (const removed of options.removeDopplerTokens ?? []) {
      const file = shellQuote(dopplerTokenFile(removed.project, removed.config));
      dopplerLines.unshift(`[ -f ${file} ] && shred -u ${file}; true`);
    }
  }
  const script = `set -e
umask 077
S=${STAGE_DIR}; C=${COORDINATOR_HOME}; G=${COORDINATOR_GITHUB_DIR}; D=${COORDINATOR_DOPPLER_DIR}
mkdir -p "$G" "$D"; chmod 700 "$G" "$D"
${dopplerLines.join('\n')}
${options.removeGitHubCredentials ? 'for f in "$G/app.pem" "$G/pat"; do [ -f "$f" ] && shred -u "$f"; done; true' : ''}
${options.githubCredential ? `for f in "$G/app.pem" "$G/pat"; do [ -f "$f" ] && shred -u "$f"; done; install -m 600 "$S/github-credential" "${target}"; shred -u "$S/github-credential"` : ''}
install -m 600 "$S/config.json" "$C/config.json"; rm -f "$S/config.json"
systemctl --user restart runpane-cloud-coordinator.service
for i in $(seq 1 30); do curl -fsS "http://${listenHost}:${COORDINATOR_PORT}/health" >/dev/null 2>&1 && { echo "RP_COORD ok"; exit 0; }; sleep 1; done
echo "RP_COORD the service did not answer on ${listenHost}:${COORDINATOR_PORT}"; journalctl --user -u runpane-cloud-coordinator.service -n 5 --no-pager 2>&1 | tail -5; exit 4
`;
  const result = await handle.runScript(script, { timeoutSeconds: 120 });
  if (result.exitCode !== 0) {
    // Never echo the staged credential's path contents; only our own RP_COORD lines.
    const reason = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.startsWith('RP_COORD ')).map((line) => line.slice(9)).pop();
    throw new Error(`Reconfiguring the coordinator failed (exit ${String(result.exitCode)}): ${reason ?? 'see the coordinator journal'}`);
  }
}

/** Uploads the app, the config and the secrets (0600, never on a command line), then (re)starts the unit. */
async function installCoordinator(provider: CloudProvider, deployment: CoordinatorDeployment, options: InstallOptions): Promise<void> {
  const handle = provider.handle(deployment.sandboxId);
  const listenHost = await coordinatorListenHost(handle);
  const config = coordinatorConfig(deployment, listenHost);
  await handle.writeFile(`${STAGE_DIR}/config.json`, `${JSON.stringify(config, null, 2)}\n`);
  await handle.writeFile(`${STAGE_DIR}/caller-secret`, `${options.secret}\n`);
  if (options.scopedKeySecret) await handle.writeFile(`${STAGE_DIR}/boat-scoped-key`, `${options.scopedKeySecret}\n`);
  await handle.writeFile(`${STAGE_DIR}/app.tgz.b64`, options.archiveBase64);

  const script = `set -e
umask 077
S=${STAGE_DIR}; C=${COORDINATOR_HOME}; APP=${COORDINATOR_APP}
command -v node >/dev/null || { echo "RP_COORD node is not installed in this sandbox"; exit 3; }
if [ -f "$S/boat-scoped-key" ]; then install -m 600 "$S/boat-scoped-key" "$C/boat-scoped-key"; shred -u "$S/boat-scoped-key"; fi
[ -f "$C/boat-scoped-key" ] || { echo "RP_COORD the scoped provider key is missing; destroy and redeploy the coordinator"; exit 3; }
install -m 600 "$S/caller-secret" "$C/caller-secret"; shred -u "$S/caller-secret"
# Keep a config edited by hand? No: the laptop CLI owns it (single writer); the directory file and the
# GitHub credential (github/, written by coordinator github set) are kept.
install -m 600 "$S/config.json" "$C/config.json"; rm -f "$S/config.json"
rm -rf "$APP"; mkdir -p "$APP"
base64 -d "$S/app.tgz.b64" | tar -xzf - -C "$APP"; rm -f "$S/app.tgz.b64"
node "$APP/dist/cloud/coordinator/main.js" install-service --config "$C/config.json" --entry "$APP/dist/cloud/coordinator/main.js" >/dev/null
systemctl --user restart runpane-cloud-coordinator.service
for i in $(seq 1 30); do curl -fsS "http://${listenHost}:${COORDINATOR_PORT}/health" >/dev/null 2>&1 && { echo "RP_COORD ok"; exit 0; }; sleep 1; done
echo "RP_COORD the service did not answer on ${listenHost}:${COORDINATOR_PORT}"; systemctl --user status runpane-cloud-coordinator.service --no-pager 2>&1 | tail -5; exit 4
`;
  const result = await handle.runScript(script, { timeoutSeconds: 300 });
  if (result.exitCode !== 0) {
    const reason = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.startsWith('RP_COORD ')).map((line) => line.slice(9)).pop();
    throw new Error(`Installing the coordinator failed (exit ${String(result.exitCode)}): ${reason ?? result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
}

// ---------------------------------------------------------------- status / stop / start / destroy

async function status(args: CoordinatorArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireDeployment(deps);
  const { provider } = await loadProvider(deps);
  const sandbox = await provider.get(deployment.sandboxId);
  const health = sandbox.state === 'running' ? await deps.probeCoordinatorHealth(deployment.baseUrl) : null;
  const state = sandbox.state === 'gone' ? 'lost'
    : sandbox.state === 'stopped' ? 'stopped'
      : sandbox.state === 'running' ? (health?.ok ? 'running' : 'service-down')
        : sandbox.state;
  const summary = {
    ok: state === 'running',
    state,
    hostname: deployment.hostname,
    sandboxId: deployment.sandboxId,
    providerState: sandbox.providerState,
    baseUrl: deployment.baseUrl,
    version: health?.version ?? null,
    managedPrefix: deployment.managedPrefix,
    reconcile: deployment.reconcile,
    pin: deployment.pin ?? null,
    deployedAt: deployment.deployedAt,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`coordinator ${deployment.hostname}: ${state}`);
    deps.stdout(`  sandbox ${deployment.sandboxId}: ${sandbox.providerState}`);
    deps.stdout(`  service: ${health ? (health.ok ? `healthy, version ${health.version ?? 'unknown'}` : `not answering${health.status ? ` (HTTP ${health.status})` : ''}`) : 'not checked (sandbox not running)'}`);
    deps.stdout(`  url: ${deployment.baseUrl}   manages: ${deployment.managedPrefix}*   reconcile: ${deployment.reconcile ? 'on' : 'off'}${deployment.pin ? `   pinned Pane: ${deployment.pin.version}` : ''}`);
    if (state === 'stopped') deps.stdout('  Idle-stop and wake-on-submit are paused. Start it with: runpane cloud coordinator start');
  }
  return state === 'lost' ? 1 : 0;
}

async function stop(args: CoordinatorArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud coordinator stop pauses idle-stop and wake-on-submit for every cloud Session. Rerun with --yes to confirm.');
  const deployment = await requireDeployment(deps);
  const { provider } = await loadProvider(deps);
  const started = deps.now();
  const sandbox = await provider.get(deployment.sandboxId);
  if (sandbox.state === 'gone') throw new Error(`The coordinator sandbox ${deployment.sandboxId} is gone. Run runpane cloud coordinator deploy --yes.`);
  if (sandbox.state !== 'stopped') {
    if (sandbox.state === 'running') await provider.stop(deployment.sandboxId);
    await waitForState(provider, deployment.sandboxId, 'stopped', READY_TIMEOUT_MS, deps);
  }
  const elapsed = deps.now() - started;
  report(args, deps, { ok: true, state: 'stopped', hostname: deployment.hostname, elapsedMs: elapsed },
    `coordinator ${deployment.hostname} is stopped (${(elapsed / 1000).toFixed(1)} s). Cloud Sessions keep running, but nothing idle-stops or wakes them until: runpane cloud coordinator start`);
  return 0;
}

async function start(args: CoordinatorArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireDeployment(deps);
  const { provider } = await loadProvider(deps);
  const started = deps.now();
  let sandbox = await provider.get(deployment.sandboxId);
  if (sandbox.state === 'gone') throw new Error(`The coordinator sandbox ${deployment.sandboxId} is gone. Run runpane cloud coordinator deploy --yes.`);
  if (sandbox.state === 'stopping') sandbox = await waitForState(provider, deployment.sandboxId, 'stopped', READY_TIMEOUT_MS, deps);
  const resumed = sandbox.state === 'stopped';
  if (resumed) await provider.resume(deployment.sandboxId);
  await waitForState(provider, deployment.sandboxId, 'running', READY_TIMEOUT_MS, deps);
  // The unit is enabled with lingering, so the service comes back by itself once the node is on the tailnet.
  let health = await waitForCoordinatorHealth(deployment.baseUrl, deps, START_REPAIR_CHECK_MS);
  let reenrolled: string | null = null;
  if (!health.ok) {
    // Seen live on boat: a resume can bring the node back logged out. Re-enrol it under the same name,
    // then reinstall the config, whose listen address is the (new) tailnet IP.
    const { credentials } = await loadProvider(deps);
    if (!credentials.tailscale) throw new Error('No Tailscale OAuth client saved; cannot repair the coordinator\'s tailnet node.');
    const repair = await deps.bootstrap.repairTailnet(provider.handle(deployment.sandboxId),
      { hostname: deployment.hostname, oldNodeId: deployment.nodeId, restoreServe: false }, credentials.tailscale);
    if (repair.reenrolled) {
      reenrolled = repair.nodeId;
      if (!args.json) deps.stdout(`runpane cloud: the coordinator's tailnet node came back logged out (${repair.previousBackendState}); re-enrolled it as ${repair.nodeId}.`);
      const next: CoordinatorDeployment = { ...deployment, nodeId: repair.nodeId };
      const secret = await deps.store.readSecretText('coordinator-secret');
      if (!secret) throw new Error('The coordinator caller secret is missing locally; run runpane cloud coordinator deploy --yes.');
      const app = await deps.packCoordinatorApp();
      next.appVersion = app.version;
      await installCoordinator(provider, next, { archiveBase64: app.archiveBase64, secret });
      await saveDeployment(deps, next);
    }
    health = await waitForCoordinatorHealth(deployment.baseUrl, deps);
  }
  const elapsed = deps.now() - started;
  report(args, deps, { ok: health.ok, state: health.ok ? 'running' : 'service-down', hostname: deployment.hostname, resumed, reenrolledNodeId: reenrolled, version: health.version ?? null, elapsedMs: elapsed },
    health.ok
      ? `coordinator ${deployment.hostname} is running at ${deployment.baseUrl} (${(elapsed / 1000).toFixed(1)} s).`
      : `coordinator ${deployment.hostname} is up but its service did not answer /health; run runpane cloud coordinator deploy --yes to reinstall it.`);
  if (health.ok) await pushDirectory(deps);
  return health.ok ? 0 : 1;
}

async function destroy(args: CoordinatorArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud coordinator destroy deletes the coordinator sandbox and revokes its provider key. Rerun with --yes to confirm.');
  const deployment = await requireDeployment(deps);
  const { credentials, provider } = await loadProvider(deps);
  if (!credentials.tailscale) throw new Error('No Tailscale OAuth client saved; cannot delete the coordinator\'s tailnet device.');
  const result = await removeCoordinator(provider, deps.bootstrap.createTailnet(credentials.tailscale), deployment, deps);
  const settings = await deps.store.readSettings();
  await deps.store.writeSettings({ ...settings, coordinator: { enabled: false } });
  await deps.store.removeSecretText('coordinator.json');
  await deps.store.removeSecretText('coordinator-secret');
  report(args, deps, { ok: true, hostname: deployment.hostname, ...result },
    `coordinator ${deployment.hostname} destroyed: tailnet device${result.deletedNodeIds.length === 1 ? '' : 's'} ${result.deletedNodeIds.join(', ') || '(none)'} deleted, sandbox ${deployment.sandboxId} deleted, scoped key ${result.keyRevoked ? 'revoked' : `NOT revoked (${result.keyError ?? 'unknown'}); revoke ${deployment.scopedKeyId} in the provider dashboard`}. New Sessions no longer get a coordinator client.`);
  return 0;
}

async function removeCoordinator(
  provider: CloudProvider,
  tailnet: ReturnType<CloudDeps['bootstrap']['createTailnet']>,
  target: { sandboxId: string; hostname: string; scopedKeyId?: string; nodeId?: string },
  deps: CloudDeps,
): Promise<{ deletedNodeIds: string[]; keyRevoked: boolean; keyError?: string }> {
  const deletedNodeIds = await deleteOwnedDevices(tailnet, target.hostname, target.nodeId, deps.stderr);
  await provider.destroy(target.sandboxId);
  if (!target.scopedKeyId) return { deletedNodeIds, keyRevoked: false, keyError: 'no key was minted' };
  try {
    await provider.revokeKey(target.scopedKeyId);
    return { deletedNodeIds, keyRevoked: true };
  } catch (error) {
    const keyError = error instanceof Error ? error.message : String(error);
    deps.stderr(`runpane cloud: could not revoke the coordinator's scoped key ${target.scopedKeyId}: ${keyError}`);
    return { deletedNodeIds, keyRevoked: false, keyError };
  }
}

// ---------------------------------------------------------------- helpers

/** Shorter lifetimes to fall back to, longest first, when the provider refuses the requested one. */
const FALLBACK_KEY_TTLS = ['360d', '180d', '90d', '30d', '7d', '1d'];

/**
 * boat refuses a delegated key that outlives the account key creating it ("cannot outlive its
 * parent"), so step down to the longest lifetime it accepts. The effective TTL is reported and saved.
 */
async function createScopedKey(provider: CloudProvider, name: string, ttl: string): Promise<{ id: string; secret: string; ttl: string }> {
  for (const candidate of [ttl, ...FALLBACK_KEY_TTLS.filter((fallback) => fallback !== ttl)]) {
    try {
      const key = await provider.createScopedKey({ name, ttl: candidate, actions: SCOPED_KEY_ACTIONS });
      return { ...key, ttl: candidate };
    } catch (error) {
      if (!(error instanceof CloudProviderError && error.status === 403 && /outlive/iu.test(error.message))) throw error;
    }
  }
  throw new Error('The provider refused every scoped key lifetime down to 1 day; the account key is about to expire. Create a new account key and rerun runpane cloud setup.');
}

/** Credentials and a provider scoped to the deployed coordinator's wallet (or boat's active one, before a deploy). */
async function loadProvider(deps: CloudDeps): Promise<{ credentials: CloudCredentials; provider: CloudProvider }> {
  const credentials = await deps.store.readCredentials();
  if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
  return { credentials, provider: deps.createProvider(credentials, (await deps.store.readSettings()).coordinator?.deployment?.boatOrg?.id) };
}

export const loadCoordinatorProvider = (deps: CloudDeps) => loadProvider(deps);
export const requireCoordinatorDeployment = (deps: CloudDeps) => requireDeployment(deps);
export const saveCoordinatorDeployment = (deps: CloudDeps, deployment: CoordinatorDeployment) => saveDeployment(deps, deployment);

async function requireDeployment(deps: CloudDeps): Promise<CoordinatorDeployment> {
  const deployment = (await deps.store.readSettings()).coordinator?.deployment;
  if (!deployment) throw new Error('No coordinator is deployed. Deploy one with: runpane cloud coordinator deploy --yes');
  return deployment;
}

async function saveDeployment(deps: CloudDeps, deployment: CoordinatorDeployment): Promise<void> {
  const settings = await deps.store.readSettings();
  // `enabled` makes every later `runpane cloud new` add the coordinator's paired client (idle-stop needs it).
  await deps.store.writeSettings({ ...settings, coordinator: { enabled: true, deployment } });
}

/** The coordinator's `user:<name>` caller id for this machine (letters, digits, "_" and "-" only). */
function userCallerId(env: NodeJS.ProcessEnv): string {
  const name = (env.USER ?? env.USERNAME ?? 'cli').replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 60) || 'cli';
  return `user:${name}`;
}

async function waitForCoordinatorHealth(baseUrl: string, deps: CloudDeps, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ ok: boolean; version?: string }> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const health = await deps.probeCoordinatorHealth(baseUrl);
    if (health.ok || deps.now() >= deadline) return health;
    await deps.sleep(POLL_MS);
  }
}

async function waitForState(provider: CloudProvider, sandboxId: string, wanted: 'running' | 'stopped', timeoutMs: number, deps: CloudDeps) {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const sandbox = await provider.get(sandboxId);
    if (sandbox.state === wanted) return sandbox;
    if (sandbox.state === 'gone' || sandbox.state === 'error') throw new Error(`Sandbox ${sandboxId} is ${sandbox.providerState}.`);
    if (deps.now() >= deadline) throw new Error(`Sandbox ${sandboxId} did not reach ${wanted} within ${Math.round(timeoutMs / 1000)} s.`);
    await deps.sleep(POLL_MS);
  }
}

function report<Result extends { ok: boolean }>(args: CoordinatorArgs, deps: CloudDeps, json: Result, text: string): void {
  deps.stdout(args.json ? JSON.stringify(json, null, 2) : text);
}
