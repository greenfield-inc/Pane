import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import { BUILT_IN_DENY_LIST, DENIED_DOPPLER_CONFIGS } from '../secretPolicy';

export const COORDINATOR_UNIT_NAME = 'runpane-cloud-coordinator.service';
export const DEFAULT_COORDINATOR_PORT = 47300;

export interface CoordinatorConfig {
  listenHost: string;
  listenPort: number;
  stateDir: string;
  directoryFile: string;
  /** HMAC secret used to mint and verify caller tokens (0600). */
  secretFile: string;
  /** `org`: the boat wallet its calls default to (X-Boat-Org); null: the account's active wallet. */
  provider: { kind: 'boat'; apiBase: string; apiKeyFile: string; org: string | null };
  /** Only provider sandboxes whose name starts with this prefix are cloud Sessions. */
  managedNamePrefix: string;
  /** The coordinator's own sandbox; never counted as an orphan or stopped. */
  selfSandboxId: string | null;
  ignoreSandboxIds: string[];
  pinnedVersion: string | null;
  pinnedDebUrl: string | null;
  pinnedDebSha256: string | null;
  idleStop: {
    enabled: boolean;
    intervalSeconds: number;
    requiredConsecutiveSafe: number;
    wakeGraceSeconds: number;
    dryRun: boolean;
  };
  reconcile: {
    enabled: boolean;
    intervalSeconds: number;
    orphanGraceSeconds: number;
    maxOrphanStopsPerRun: number;
    dryRun: boolean;
  };
  guards: {
    maxLiveSandboxes: number;
    maxResumesPerSandboxPerHour: number;
    maxResumesPerHour: number;
  };
  wake: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    daemonDownGraceSeconds: number;
    pollIntervalMs: number;
    upgradeTimeoutMs: number;
  };
  alerts: { webhookUrl: string | null };
  revokedCallers: string[];
  /** The GitHub broker (github/broker.ts); null: off. The credential files are 0600 on this machine. */
  github: GitHubConfig | null;
  /** The Doppler secrets service; null: off. The service token files are 0600 on this machine. */
  secrets: SecretsConfig | null;
}

interface SecretsConfig {
  /** https://api.doppler.com, or a fake's URL for tests. */
  apiBaseUrl: string;
  /** One read-only Doppler service token per config (Doppler scopes each token to one config). */
  tokens: Array<{ project: string; config: string; tokenFile: string }>;
  /**
   * The user's policy on top of every manifest. `default`: the built-in deny-list (production,
   * infrastructure and secret-manager names; stg/prd configs). `allow-all`: nothing is withheld
   * except shell/Pane variables. `custom`: the lists given.
   */
  policy: { mode: 'default' | 'allow-all' | 'custom'; deniedNames: string[]; deniedConfigs: string[] };
  fetchesPerSessionPerHour: number;
}

interface GitHubConfig {
  mode: 'app' | 'pat';
  appId: string | null;
  privateKeyFile: string | null;
  installationId: number | null;
  patFile: string | null;
  /** https://api.github.com, or a fake's URL for tests and the live proof without GitHub. */
  apiBaseUrl: string;
  /** https://github.com (git smart HTTP), or a fake's. */
  gitBaseUrl: string;
  allowReadyPulls: boolean;
  limits: {
    pushesPerSessionPerHour: number;
    writesPerSessionPerHour: number;
    readsPerSessionPerHour: number;
    writesPerHour: number;
  };
}

const optionalNumber = boundary.optional(boundary.number);
const optionalBoolean = boundary.optional(boundary.boolean);
const optionalString = boundary.optional(boundary.string);
const optionalNullableString = boundary.optional(boundary.nullable(boundary.string));

const rawConfigSchema = boundary.object({
  version: boundary.literal(1),
  listenHost: boundary.nonEmptyString,
  listenPort: optionalNumber,
  stateDir: optionalString,
  directoryFile: optionalString,
  secretFile: optionalString,
  provider: boundary.object({
    kind: boundary.literal('boat'),
    apiBase: optionalString,
    apiKeyFile: boundary.nonEmptyString,
    org: optionalNullableString,
  }),
  managedNamePrefix: boundary.nonEmptyString,
  selfSandboxId: optionalNullableString,
  ignoreSandboxIds: boundary.optional(boundary.array(boundary.string)),
  pinnedVersion: optionalNullableString,
  pinnedDebUrl: optionalNullableString,
  pinnedDebSha256: optionalNullableString,
  idleStop: boundary.optional(boundary.object({
    enabled: optionalBoolean,
    intervalSeconds: optionalNumber,
    requiredConsecutiveSafe: optionalNumber,
    wakeGraceSeconds: optionalNumber,
    dryRun: optionalBoolean,
  })),
  reconcile: boundary.optional(boundary.object({
    enabled: optionalBoolean,
    intervalSeconds: optionalNumber,
    orphanGraceSeconds: optionalNumber,
    maxOrphanStopsPerRun: optionalNumber,
    dryRun: optionalBoolean,
  })),
  guards: boundary.optional(boundary.object({
    maxLiveSandboxes: optionalNumber,
    maxResumesPerSandboxPerHour: optionalNumber,
    maxResumesPerHour: optionalNumber,
  })),
  wake: boundary.optional(boundary.object({
    defaultTimeoutMs: optionalNumber,
    maxTimeoutMs: optionalNumber,
    daemonDownGraceSeconds: optionalNumber,
    pollIntervalMs: optionalNumber,
    upgradeTimeoutMs: optionalNumber,
  })),
  alerts: boundary.optional(boundary.object({ webhookUrl: optionalNullableString })),
  revokedCallers: boundary.optional(boundary.array(boundary.string)),
  github: boundary.optional(boundary.nullable(boundary.object({
    mode: boundary.enumeration('app', 'pat'),
    appId: optionalNullableString,
    privateKeyFile: optionalNullableString,
    installationId: boundary.optional(boundary.nullable(boundary.number)),
    patFile: optionalNullableString,
    apiBaseUrl: optionalString,
    gitBaseUrl: optionalString,
    allowReadyPulls: optionalBoolean,
    limits: boundary.optional(boundary.object({
      pushesPerSessionPerHour: optionalNumber,
      writesPerSessionPerHour: optionalNumber,
      readsPerSessionPerHour: optionalNumber,
      writesPerHour: optionalNumber,
    })),
  }))),
  secrets: boundary.optional(boundary.nullable(boundary.object({
    doppler: boundary.object({
      apiBaseUrl: optionalString,
      tokens: boundary.array(boundary.object({
        project: boundary.nonEmptyString,
        config: boundary.nonEmptyString,
        tokenFile: boundary.nonEmptyString,
      })),
    }),
    policy: boundary.optional(boundary.object({
      mode: boundary.optional(boundary.enumeration('default', 'allow-all', 'custom')),
      deniedNames: boundary.optional(boundary.array(boundary.string)),
      deniedConfigs: boundary.optional(boundary.array(boundary.string)),
    })),
    limits: boundary.optional(boundary.object({ fetchesPerSessionPerHour: optionalNumber })),
  }))),
});

type RawGitHubConfig = NonNullable<ReturnType<typeof rawConfigSchema.decode>['github']>;

function httpUrl(value: string | undefined, fallback: string, name: string): string {
  const url = (value ?? fallback).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/u.test(url)) throw new Error(`coordinator config: ${name.includes('.') ? name : `github.${name}`} must be an http(s) URL`);
  return url;
}

function parseGitHubConfig(raw: RawGitHubConfig | null | undefined): GitHubConfig | null {
  if (!raw) return null;
  if (raw.mode === 'app' && (!raw.appId || !raw.privateKeyFile)) {
    throw new Error('coordinator config: github mode "app" needs appId and privateKeyFile');
  }
  if (raw.mode === 'pat' && !raw.patFile) throw new Error('coordinator config: github mode "pat" needs patFile');
  return {
    mode: raw.mode,
    appId: raw.mode === 'app' ? raw.appId ?? null : null,
    privateKeyFile: raw.mode === 'app' ? raw.privateKeyFile ?? null : null,
    installationId: raw.mode === 'app' ? raw.installationId ?? null : null,
    patFile: raw.mode === 'pat' ? raw.patFile ?? null : null,
    apiBaseUrl: httpUrl(raw.apiBaseUrl, 'https://api.github.com', 'apiBaseUrl'),
    gitBaseUrl: httpUrl(raw.gitBaseUrl, 'https://github.com', 'gitBaseUrl'),
    allowReadyPulls: raw.allowReadyPulls ?? false,
    limits: {
      pushesPerSessionPerHour: positive(raw.limits?.pushesPerSessionPerHour, 20, 'github.limits.pushesPerSessionPerHour'),
      writesPerSessionPerHour: positive(raw.limits?.writesPerSessionPerHour, 60, 'github.limits.writesPerSessionPerHour'),
      readsPerSessionPerHour: positive(raw.limits?.readsPerSessionPerHour, 600, 'github.limits.readsPerSessionPerHour'),
      writesPerHour: positive(raw.limits?.writesPerHour, 300, 'github.limits.writesPerHour'),
    },
  };
}

type RawSecretsConfig = NonNullable<ReturnType<typeof rawConfigSchema.decode>['secrets']>;

function parseSecretsConfig(raw: RawSecretsConfig | null | undefined): SecretsConfig | null {
  if (!raw) return null;
  const mode = raw.policy?.mode ?? 'default';
  const seen = new Set<string>();
  for (const token of raw.doppler.tokens) {
    const key = `${token.project}/${token.config}`;
    if (seen.has(key)) throw new Error(`coordinator config: secrets.doppler.tokens lists ${key} twice`);
    seen.add(key);
  }
  return {
    apiBaseUrl: httpUrl(raw.doppler.apiBaseUrl, 'https://api.doppler.com', 'secrets.doppler.apiBaseUrl'),
    tokens: raw.doppler.tokens.map((token) => ({ project: token.project, config: token.config, tokenFile: token.tokenFile })),
    policy: mode === 'allow-all'
      ? { mode, deniedNames: [], deniedConfigs: [] }
      : mode === 'custom'
        ? { mode, deniedNames: raw.policy?.deniedNames ?? [...BUILT_IN_DENY_LIST], deniedConfigs: raw.policy?.deniedConfigs ?? [...DENIED_DOPPLER_CONFIGS] }
        : { mode, deniedNames: [...BUILT_IN_DENY_LIST], deniedConfigs: [...DENIED_DOPPLER_CONFIGS] },
    fetchesPerSessionPerHour: positive(raw.limits?.fetchesPerSessionPerHour, 120, 'secrets.limits.fetchesPerSessionPerHour'),
  };
}

export function defaultCoordinatorHome(): string {
  return path.join(os.homedir(), '.config', 'runpane-cloud-coordinator');
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`coordinator config: ${name} must be a positive number`);
  }
  return value;
}

export function parseCoordinatorConfig(value: JsonValue, home = defaultCoordinatorHome()): CoordinatorConfig {
  const raw = decodeBoundary(value, rawConfigSchema);
  const stateDir = raw.stateDir ?? path.join(home, 'state');
  if (raw.listenHost === '0.0.0.0' || raw.listenHost === '::') {
    // Sandboxes have public addresses; the coordinator must only listen on its tailnet address.
    throw new Error('coordinator config: listenHost must be a specific (tailnet) address, not a wildcard');
  }
  return {
    listenHost: raw.listenHost,
    listenPort: positive(raw.listenPort, DEFAULT_COORDINATOR_PORT, 'listenPort'),
    stateDir,
    directoryFile: raw.directoryFile ?? path.join(home, 'directory.json'),
    secretFile: raw.secretFile ?? path.join(home, 'caller-secret'),
    provider: {
      kind: 'boat',
      apiBase: (raw.provider.apiBase ?? 'https://boat.dev/api/v1').replace(/\/+$/, ''),
      apiKeyFile: raw.provider.apiKeyFile,
      org: raw.provider.org ?? null,
    },
    managedNamePrefix: raw.managedNamePrefix,
    selfSandboxId: raw.selfSandboxId ?? null,
    ignoreSandboxIds: raw.ignoreSandboxIds ?? [],
    pinnedVersion: raw.pinnedVersion ?? null,
    pinnedDebUrl: raw.pinnedDebUrl ?? null,
    pinnedDebSha256: raw.pinnedDebSha256 ?? null,
    idleStop: {
      enabled: raw.idleStop?.enabled ?? true,
      intervalSeconds: positive(raw.idleStop?.intervalSeconds, 300, 'idleStop.intervalSeconds'),
      requiredConsecutiveSafe: positive(raw.idleStop?.requiredConsecutiveSafe, 2, 'idleStop.requiredConsecutiveSafe'),
      wakeGraceSeconds: raw.idleStop?.wakeGraceSeconds ?? 600,
      dryRun: raw.idleStop?.dryRun ?? false,
    },
    reconcile: {
      enabled: raw.reconcile?.enabled ?? true,
      intervalSeconds: positive(raw.reconcile?.intervalSeconds, 600, 'reconcile.intervalSeconds'),
      orphanGraceSeconds: raw.reconcile?.orphanGraceSeconds ?? 1800,
      maxOrphanStopsPerRun: raw.reconcile?.maxOrphanStopsPerRun ?? 3,
      dryRun: raw.reconcile?.dryRun ?? false,
    },
    guards: {
      maxLiveSandboxes: positive(raw.guards?.maxLiveSandboxes, 25, 'guards.maxLiveSandboxes'),
      maxResumesPerSandboxPerHour: positive(raw.guards?.maxResumesPerSandboxPerHour, 6, 'guards.maxResumesPerSandboxPerHour'),
      maxResumesPerHour: positive(raw.guards?.maxResumesPerHour, 60, 'guards.maxResumesPerHour'),
    },
    wake: {
      defaultTimeoutMs: positive(raw.wake?.defaultTimeoutMs, 90_000, 'wake.defaultTimeoutMs'),
      maxTimeoutMs: positive(raw.wake?.maxTimeoutMs, 300_000, 'wake.maxTimeoutMs'),
      daemonDownGraceSeconds: positive(raw.wake?.daemonDownGraceSeconds, 60, 'wake.daemonDownGraceSeconds'),
      pollIntervalMs: positive(raw.wake?.pollIntervalMs, 1000, 'wake.pollIntervalMs'),
      upgradeTimeoutMs: positive(raw.wake?.upgradeTimeoutMs, 180_000, 'wake.upgradeTimeoutMs'),
    },
    alerts: { webhookUrl: raw.alerts?.webhookUrl ?? null },
    revokedCallers: raw.revokedCallers ?? [],
    github: parseGitHubConfig(raw.github),
    secrets: parseSecretsConfig(raw.secrets),
  };
}

export function loadCoordinatorConfig(file: string): CoordinatorConfig {
  const home = path.dirname(file);
  return parseCoordinatorConfig(JSON.parse(fs.readFileSync(file, 'utf8')), home);
}

/** Reads a secret file (0600 expected) and strips the trailing newline secret stores often add. */
export function readSecretFile(file: string): string {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${file} must not be readable by group or others (chmod 600)`);
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length === 0) throw new Error(`${file} is empty`);
  return value;
}
