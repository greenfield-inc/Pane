import type http from 'node:http';
import path from 'node:path';
import { JsonlAlertSink } from './alerts';
import { BoatCoordinatorProvider } from './boatProvider';
import type { CoordinatorConfig } from './config';
import { readSecretFile } from './config';
import { describeError, HttpDaemonProbe } from './daemonProbe';
import { FileSessionDirectory } from './directory';
import { JsonlAuditLog, JsonlGitHubAudit } from './github/audit';
import { GitHubBroker } from './github/broker';
import { GitHubAppCredential, GitHubPatCredential } from './github/credentials';
import type { GitHubCredential } from './github/credentials';
import { GitPusher } from './github/gitPush';
import { createGitHubRest } from './github/rest';
import type { FetchLike } from '../githubTransport';
import { TailscaleWhois } from './github/whois';
import type { WhoisResolver } from './github/whois';
import type { DirectoryWriter } from './directory';
import { RunawayGuard, SandboxActivity } from './guards';
import { IdleStopper } from './idleStop';
import { Reconciler } from './reconciler';
import { createDopplerApi } from './secrets/doppler';
import { configKey, SecretsService } from './secrets/service';
import type { SecretsAuditEntry } from './secrets/service';
import { createCoordinatorServer } from './server';
import type { CoordinatorApi } from './server';
import type { AlertSink, Clock, CoordinatorProvider, DaemonProbe, SessionDirectory } from './types';
import { systemClock } from './types';
import { WakeService } from './wake';

export interface CoordinatorParts {
  config: CoordinatorConfig;
  clock: Clock;
  directory: SessionDirectory;
  directoryWriter: DirectoryWriter | null;
  provider: CoordinatorProvider;
  probe: DaemonProbe;
  alerts: AlertSink;
  api: CoordinatorApi;
  github: GitHubBroker;
  secrets: SecretsService;
}

interface CoordinatorOverrides extends Partial<Pick<CoordinatorParts, 'clock' | 'directory' | 'provider' | 'probe' | 'alerts'>> {
  /** Test seams for the GitHub broker: who a tailnet address is, and GitHub's REST API. */
  whois?: WhoisResolver;
  githubFetch?: FetchLike;
  /** Test seam for Doppler's REST API. */
  dopplerFetch?: FetchLike;
}

/** The broker: off without a `github` config; a credential that fails to load is reported, not fatal. */
export function buildGitHubBroker(
  config: CoordinatorConfig,
  clock: Clock,
  directory: SessionDirectory,
  overrides: Pick<CoordinatorOverrides, 'whois' | 'githubFetch'> = {},
): GitHubBroker {
  const github = config.github;
  const rest = createGitHubRest(github?.apiBaseUrl ?? 'https://api.github.com', overrides.githubFetch);
  let credential: GitHubCredential | null = null;
  let credentialError: string | null = null;
  if (github) {
    try {
      credential = github.mode === 'app'
        ? new GitHubAppCredential({ appId: github.appId ?? '', privateKeyPem: readSecretFile(github.privateKeyFile ?? ''), installationId: github.installationId }, rest, clock)
        : new GitHubPatCredential(readSecretFile(github.patFile ?? ''));
    } catch (error) {
      credentialError = describeError(error);
      console.error(`[coordinator] github broker credential not loaded: ${credentialError}`);
    }
  }
  return new GitHubBroker({
    settings: github
      ? { mode: github.mode, apiBaseUrl: github.apiBaseUrl, gitBaseUrl: github.gitBaseUrl, allowReadyPulls: github.allowReadyPulls, limits: github.limits }
      : null,
    credential,
    credentialError,
    rest,
    git: new GitPusher(path.join(config.stateDir, 'github-git')),
    directory,
    whois: overrides.whois ?? new TailscaleWhois(clock),
    audit: new JsonlGitHubAudit(path.join(config.stateDir, 'github-audit.jsonl'), clock),
    clock,
  });
}

/**
 * The secrets service: off without a `secrets` config. A token file that fails to load turns only
 * that config off (reported in status and to Sessions asking for it); nothing here is fatal.
 */
export function buildSecretsService(
  config: CoordinatorConfig,
  clock: Clock,
  directory: SessionDirectory,
  github: GitHubBroker,
  overrides: Pick<CoordinatorOverrides, 'whois' | 'dopplerFetch'> = {},
): SecretsService {
  const secrets = config.secrets;
  const tokens = new Map<string, string>();
  const tokenErrors = new Map<string, string>();
  for (const token of secrets?.tokens ?? []) {
    const key = configKey(token.project, token.config);
    try {
      tokens.set(key, readSecretFile(token.tokenFile));
    } catch (error) {
      tokenErrors.set(key, `the Doppler token for ${key} could not be loaded: ${describeError(error)}`);
      console.error(`[coordinator] secrets: ${tokenErrors.get(key) ?? ''}`);
    }
  }
  return new SecretsService({
    settings: secrets
      ? {
          apiBaseUrl: secrets.apiBaseUrl,
          configs: secrets.tokens.map((token) => ({ project: token.project, config: token.config })),
          policy: secrets.policy,
          fetchesPerSessionPerHour: secrets.fetchesPerSessionPerHour,
        }
      : null,
    tokens,
    tokenErrors,
    doppler: createDopplerApi(secrets?.apiBaseUrl ?? 'https://api.doppler.com', overrides.dopplerFetch),
    manifests: github,
    directory,
    whois: overrides.whois ?? new TailscaleWhois(clock),
    audit: new JsonlAuditLog<SecretsAuditEntry>(path.join(config.stateDir, 'secrets-audit.jsonl'), clock),
    clock,
  });
}

export function buildCoordinator(
  config: CoordinatorConfig,
  overrides: CoordinatorOverrides = {},
): CoordinatorParts {
  const clock = overrides.clock ?? systemClock;
  const fileDirectory = new FileSessionDirectory(config.directoryFile);
  const directory = overrides.directory ?? fileDirectory;
  const directoryWriter = overrides.directory ? null : fileDirectory;
  const provider = overrides.provider ?? new BoatCoordinatorProvider({
    apiBase: config.provider.apiBase,
    apiKey: readSecretFile(config.provider.apiKeyFile),
    org: config.provider.org,
  });
  const probe = overrides.probe ?? new HttpDaemonProbe();
  const alerts = overrides.alerts ?? new JsonlAlertSink({
    clock,
    file: path.join(config.stateDir, 'alerts.jsonl'),
    webhookUrl: config.alerts.webhookUrl,
  });
  const activity = new SandboxActivity(clock);
  const guard = new RunawayGuard(clock, config.guards, path.join(config.stateDir, 'resumes.json'));
  const scope = {
    managedNamePrefix: config.managedNamePrefix,
    selfSandboxId: config.selfSandboxId,
    ignoreSandboxIds: config.ignoreSandboxIds,
  };
  const idle = new IdleStopper({ directory, provider, probe, activity, alerts }, {
    requiredConsecutiveSafe: config.idleStop.requiredConsecutiveSafe,
    wakeGraceMs: config.idleStop.wakeGraceSeconds * 1000,
    dryRun: config.idleStop.dryRun,
  });
  const reconciler = new Reconciler({ directory, provider, activity, guard, alerts, clock }, {
    ...scope,
    orphanGraceMs: config.reconcile.orphanGraceSeconds * 1000,
    maxOrphanStopsPerRun: config.reconcile.maxOrphanStopsPerRun,
    dryRun: config.reconcile.dryRun,
  });
  const wake = new WakeService({ directory, provider, probe, activity, guard, alerts, clock }, {
    ...scope,
    pinnedVersion: config.pinnedVersion,
    pinnedDebUrl: config.pinnedDebUrl,
    pinnedDebSha256: config.pinnedDebSha256,
    defaultTimeoutMs: config.wake.defaultTimeoutMs,
    maxTimeoutMs: config.wake.maxTimeoutMs,
    daemonDownGraceMs: config.wake.daemonDownGraceSeconds * 1000,
    pollIntervalMs: config.wake.pollIntervalMs,
    upgradeTimeoutMs: config.wake.upgradeTimeoutMs,
  });
  const api: CoordinatorApi = {
    status: (host) => wake.status(host),
    wake: (host, request, caller) => wake.wake(host, request, caller),
    reconcile: (options) => reconciler.runOnce(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    idleCheck: (options) => idle.runOnce(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  };
  const github = buildGitHubBroker(config, clock, directory, overrides);
  const secrets = buildSecretsService(config, clock, directory, github, overrides);
  return { config, clock, directory, directoryWriter, provider, probe, alerts, api, github, secrets };
}

/** Runs `task` every `intervalMs`, never overlapping itself, until the returned stop function is called. */
function every(intervalMs: number, firstDelayMs: number, task: () => Promise<void>, onError: (cause: unknown) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await task();
    } catch (cause) {
      onError(cause);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), firstDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export interface RunningCoordinator {
  server: http.Server;
  close(): Promise<void>;
}

export async function startCoordinator(
  parts: CoordinatorParts,
  options: { version: string; log?: (line: string) => void; listenRetryMs?: number },
): Promise<RunningCoordinator> {
  const { config, api, alerts } = parts;
  const log = options.log ?? ((line: string) => console.log(line));
  const server = createCoordinatorServer({
    api,
    directory: parts.directory,
    directoryWriter: parts.directoryWriter,
    alerts,
    clock: parts.clock,
    secret: readSecretFile(config.secretFile),
    revokedCallers: config.revokedCallers,
    version: options.version,
    log,
    github: parts.github,
    secrets: parts.secrets,
  });
  await listenWithRetry(server, config.listenHost, config.listenPort, options.listenRetryMs ?? 120_000, log);
  log(`[coordinator] listening on http://${config.listenHost}:${config.listenPort}`);
  log(`[coordinator] github broker: ${config.github ? `${config.github.mode} mode, API ${config.github.apiBaseUrl}` : 'off'}`);
  log(`[coordinator] secrets: ${config.secrets ? `Doppler ${config.secrets.tokens.map((token) => configKey(token.project, token.config)).join(', ') || '(no configs)'}, policy ${config.secrets.policy.mode}` : 'off'}`);

  const onError = (label: string) => (cause: unknown) => {
    alerts.emit({ level: 'error', code: `${label}-crashed`, message: describeError(cause) });
  };
  const stops: Array<() => void> = [];
  if (config.idleStop.enabled) {
    stops.push(every(config.idleStop.intervalSeconds * 1000, 30_000, async () => {
      const report = await api.idleCheck({});
      const summary = report.results.map((r) => `${r.sessionId}=${r.decision}`).join(' ');
      log(`[coordinator] idle-check ${report.ok ? 'ok' : `failed: ${report.error}`} ${summary}`);
    }, onError('idle-check')));
  }
  if (config.reconcile.enabled) {
    stops.push(every(config.reconcile.intervalSeconds * 1000, 60_000, async () => {
      const report = await api.reconcile({});
      log(`[coordinator] reconcile ${report.aborted ? `ABORTED ${report.aborted}` : 'ok'}: ${report.detail}`);
    }, onError('reconcile')));
  }
  return {
    server,
    close: () => new Promise((resolve) => {
      for (const stop of stops) stop();
      server.close(() => resolve());
    }),
  };
}

async function listenWithRetry(
  server: http.Server,
  host: string,
  port: number,
  retryForMs: number,
  log: (line: string) => void,
): Promise<void> {
  // At boot the tailnet address may not exist yet (tailscaled still starting): retry EADDRNOTAVAIL.
  const until = Date.now() + retryForMs;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null;
      if (code !== 'EADDRNOTAVAIL' || Date.now() > until) throw error;
      log(`[coordinator] ${host} not available yet; retrying listen`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export function renderSystemdUnit(options: { nodePath: string; entryPath: string; configPath: string }): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`);
  return [
    '[Unit]',
    'Description=Runpane Cloud coordinator (idle-stop, reconcile, wake)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${quote(options.nodePath)} ${quote(options.entryPath)} serve --config ${quote(options.configPath)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
