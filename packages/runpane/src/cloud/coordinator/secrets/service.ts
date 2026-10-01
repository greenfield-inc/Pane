import { createHash } from 'node:crypto';
import type { JsonObject } from '../../../boundaryDecoder';
import { isDeniedConfig, matchingPattern, reservedBy } from '../../secretPolicy';
import type { Caller } from '../callerAuth';
import type { Clock, DirectoryEntry, SessionDirectory } from '../types';
import type { JsonlAuditLog } from '../github/audit';
import { HourlyLimiter } from '../github/audit';
import type { RepoFile } from '../github/broker';
import { BrokerError, namespaceOf } from '../github/policy';
import type { TailnetNode, WhoisResolver } from '../github/whois';
import { nodeMismatch } from '../github/whois';
import type { DopplerApi } from './doppler';
import { DopplerError } from './doppler';
import { MANIFEST_PATH, ManifestError, parseManifest } from './manifest';
import type { ManifestEntry } from './manifest';

/**
 * The coordinator's secrets service (`/cloud/secrets/*`): a cloud Session asks for its secrets and
 * gets the names its repository's manifest lists, read from Doppler with the user's read-only service
 * tokens (0600 on this machine), filtered by the user's policy. The Session's `doppler` stand-in keeps
 * them 0600 and only hands them to the child of `doppler run`. Values are never logged or audited:
 * the audit records who, from which node, which manifest and which names.
 */

type PolicyMode = 'default' | 'allow-all' | 'custom';

export interface SecretsSettings {
  apiBaseUrl: string;
  /** Configs the coordinator holds a service token for (`project/config`). */
  configs: Array<{ project: string; config: string }>;
  policy: { mode: PolicyMode; deniedNames: string[]; deniedConfigs: string[] };
  fetchesPerSessionPerHour: number;
}

/** Reads a repository file for the coordinator (the GitHub broker's credential, contents:read). */
interface ManifestSource {
  readRepoFile(repo: string, filePath: string, ref: string | null): Promise<RepoFile | null>;
}

export interface SecretsAuditEntry {
  callerId: string;
  label: string | null;
  node: string | null;
  endpoint: string;
  repo: string | null;
  ref: string | null;
  manifestSha: string | null;
  outcome: string;
  httpStatus: number;
  /** Per config: the names delivered and withheld. Never values. */
  configs: Array<{ config: string; delivered: string[]; withheld: string[]; missing: string[]; refused: string | null }>;
  durationMs: number;
}

interface SecretsServiceDeps {
  /** null: no `secrets` config, the service is off. */
  settings: SecretsSettings | null;
  /** Loaded service tokens by `project/config`; a config whose file failed to load is in tokenErrors. */
  tokens: ReadonlyMap<string, string>;
  tokenErrors: ReadonlyMap<string, string>;
  doppler: DopplerApi;
  manifests: ManifestSource;
  directory: SessionDirectory;
  whois: WhoisResolver;
  audit: JsonlAuditLog<SecretsAuditEntry>;
  clock: Clock;
  log?: (line: string) => void;
}

interface SecretsCall {
  method: string;
  /** The path after `/cloud/secrets/`. */
  path: string;
  query: URLSearchParams;
  caller: Caller;
  remoteAddress: string;
}

interface SecretsAnswer {
  status: number;
  body: JsonObject;
}

const STATUS_BY_CODE = {
  'secrets-disabled': 503,
  forbidden: 403,
  'caller-node-mismatch': 403,
  'manifest-ref-writable': 403,
  'manifest-invalid': 422,
  'manifest-unreadable': 502,
  'doppler-error': 502,
  'rate-limited': 429,
  'not-found': 404,
} as const;

type SecretsErrorCode = keyof typeof STATUS_BY_CODE;

class SecretsError extends Error {
  override name = 'SecretsError';

  constructor(readonly code: SecretsErrorCode, message: string) {
    super(message);
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

interface DeliveredConfig {
  project: string;
  config: string;
  values: Map<string, string>;
  withheld: Array<{ name: string; reason: string }>;
  missing: string[];
  refused: string | null;
}

export function configKey(project: string, config: string): string {
  return `${project}/${config}`;
}

export class SecretsService {
  private readonly limiter: HourlyLimiter;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SecretsServiceDeps) {
    this.limiter = new HourlyLimiter(deps.clock);
    this.log = deps.log ?? ((line) => console.log(line));
  }

  async handle(call: SecretsCall): Promise<SecretsAnswer> {
    const started = this.deps.clock.now();
    const route = `${call.method.toUpperCase()} ${call.path}`;
    let entry: DirectoryEntry | null = null;
    let node: TailnetNode | null = null;
    const audit: Pick<SecretsAuditEntry, 'repo' | 'ref' | 'manifestSha' | 'configs'> = { repo: null, ref: null, manifestSha: null, configs: [] };
    try {
      // Peers are bound to their own tailnet node before anything else, unknown paths included.
      if (call.caller.role === 'peer') {
        entry = await this.entryFor(call.caller.id);
        node = await this.bindNode(entry, call.remoteAddress);
      }
      switch (route) {
        case 'GET status':
          return { status: 200, body: await this.status(entry, call.caller.role === 'user' && call.query.get('check') === '1') };
        case 'GET audit': {
          if (call.caller.role !== 'user') throw new SecretsError('forbidden', 'the secrets audit is only for the user (runpane cloud coordinator doppler audit)');
          const limit = Number(call.query.get('limit') ?? '100');
          return { status: 200, body: { ok: true, entries: this.deps.audit.recent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100) } };
        }
        case 'POST fetch': {
          if (!entry || !node) throw new SecretsError('forbidden', 'only cloud Sessions fetch secrets (the user reads names with runpane cloud coordinator doppler status)');
          const body = await this.fetch(entry, audit);
          this.record(call, entry, node, route, audit, 'ok', 200, started);
          return { status: 200, body };
        }
        default:
          throw new SecretsError('not-found', `no secrets endpoint ${call.method} /cloud/secrets/${call.path}`);
      }
    } catch (error) {
      const failure = error instanceof SecretsError ? error : new SecretsError('doppler-error', error instanceof Error ? error.message : String(error));
      if (route !== 'GET status' && route !== 'GET audit') this.record(call, entry, node, route, audit, failure.code, failure.status, started);
      return { status: failure.status, body: { ok: false, code: failure.code, message: failure.message } };
    }
  }

  // ------------------------------------------------------------ caller binding

  private async entryFor(sessionId: string): Promise<DirectoryEntry> {
    const directory = await this.deps.directory.read();
    const entry = directory.ok ? directory.entries.find((candidate) => candidate.sessionId === sessionId) : undefined;
    if (!entry) throw new SecretsError('forbidden', `caller ${sessionId} is not a cloud Session in the directory`);
    return entry;
  }

  private async bindNode(entry: DirectoryEntry, remoteAddress: string): Promise<TailnetNode> {
    const node = await this.deps.whois.whois(remoteAddress);
    const mismatch = nodeMismatch(entry, node, remoteAddress);
    if (mismatch || !node) {
      this.log(`[coordinator] secrets: refused ${entry.sessionId} from ${remoteAddress}: ${mismatch ?? 'no node'}`);
      throw new SecretsError('caller-node-mismatch', `this token belongs to ${entry.label}, but ${mismatch ?? 'no node'}`);
    }
    return node;
  }

  // ------------------------------------------------------------ status

  private async status(entry: DirectoryEntry | null, check: boolean): Promise<JsonObject> {
    const { settings } = this.deps;
    const caller = entry ? { sessionId: entry.sessionId, manifest: manifestSourceOf(entry) } : null;
    if (!settings) return { ok: true, enabled: false, configs: [], policy: null, caller };
    const configs: JsonObject[] = [];
    for (const { project, config } of settings.configs) {
      const key = configKey(project, config);
      const token = this.deps.tokens.get(key);
      const item: JsonObject = { project, config, loaded: token !== undefined };
      const loadError = this.deps.tokenErrors.get(key);
      if (loadError) item.error = loadError;
      if (check && token !== undefined) {
        // The user's `doppler status --check`: does the token still read its config? Names count only.
        try {
          item.names = (await this.deps.doppler.download(token, project, config)).size;
        } catch (error) {
          item.error = error instanceof Error ? error.message : String(error);
        }
      }
      configs.push(item);
    }
    return {
      ok: true,
      enabled: true,
      apiBaseUrl: settings.apiBaseUrl,
      configs,
      policy: { mode: settings.policy.mode, deniedNames: settings.policy.deniedNames, deniedConfigs: settings.policy.deniedConfigs },
      limits: { fetchesPerSessionPerHour: settings.fetchesPerSessionPerHour },
      caller,
    };
  }

  // ------------------------------------------------------------ fetch

  private async fetch(entry: DirectoryEntry, audit: Pick<SecretsAuditEntry, 'repo' | 'ref' | 'manifestSha' | 'configs'>): Promise<JsonObject> {
    const settings = this.deps.settings;
    if (!settings) throw new SecretsError('secrets-disabled', 'the coordinator holds no Doppler credential: run runpane cloud coordinator doppler set on your machine');
    if (this.limiter.take([{ key: `fetch:${entry.sessionId}`, limit: settings.fetchesPerSessionPerHour }])) {
      throw new SecretsError('rate-limited', `this Session reached its hourly limit of ${settings.fetchesPerSessionPerHour} secrets fetches`);
    }
    const fetchedAt = new Date(this.deps.clock.now()).toISOString();
    const source = manifestSourceOf(entry);
    if (!source) {
      return { ok: true, fetchedAt, manifest: null, reason: 'this Session was not created on a GitHub repository the broker reads (runpane cloud new --repo <owner/name> --github)', configs: [], version: null };
    }
    audit.repo = source.repo;
    audit.ref = source.ref;
    const namespace = namespaceOf(entry);
    if (source.ref && (source.ref.startsWith(namespace) || source.ref.startsWith(`refs/heads/${namespace}`))) {
      // The Session can push to its own namespace, so a manifest read from there would let it widen its own grant.
      throw new SecretsError('manifest-ref-writable', `this Session was created from ${source.ref}, which it can push to itself; the coordinator reads manifests only from refs the Session cannot write`);
    }
    let file: RepoFile | null;
    try {
      file = await this.deps.manifests.readRepoFile(source.repo, MANIFEST_PATH, source.ref);
    } catch (error) {
      throw new SecretsError('manifest-unreadable', `could not read ${MANIFEST_PATH} from ${source.repo}${source.ref ? `@${source.ref}` : ''}: ${error instanceof BrokerError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : String(error)}`);
    }
    const manifestInfo: JsonObject = { repo: source.repo, ref: source.ref, path: MANIFEST_PATH, sha: file?.sha ?? null };
    if (!file) {
      return { ok: true, fetchedAt, manifest: manifestInfo, reason: `${source.repo}${source.ref ? `@${source.ref}` : ''} has no ${MANIFEST_PATH}`, configs: [], version: null };
    }
    audit.manifestSha = file.sha;
    let manifest;
    try {
      manifest = parseManifest(file.text);
    } catch (error) {
      throw new SecretsError('manifest-invalid', error instanceof ManifestError ? error.message : String(error));
    }
    const delivered: DeliveredConfig[] = [];
    for (const item of manifest.entries) delivered.push(await this.deliver(item, settings));
    audit.configs = delivered.map((config) => ({
      config: configKey(config.project, config.config),
      delivered: [...config.values.keys()],
      withheld: config.withheld.map((withheld) => withheld.name),
      missing: config.missing,
      refused: config.refused,
    }));
    this.log(`[coordinator] secrets: ${entry.label} fetched ${delivered.map((config) => `${configKey(config.project, config.config)}=${config.refused ? 'refused' : `${config.values.size} names`}`).join(' ')} (manifest ${source.repo}${source.ref ? `@${source.ref}` : ''} ${file.sha.slice(0, 12)})`);
    return {
      ok: true,
      fetchedAt,
      manifest: manifestInfo,
      policy: settings.policy.mode,
      configs: delivered.map((config) => ({
        project: config.project,
        config: config.config,
        values: Object.fromEntries(config.values),
        withheld: config.withheld,
        missing: config.missing,
        refused: config.refused,
      })),
      version: versionOf(file.sha, delivered),
    };
  }

  /** One manifest entry: the config's secrets narrowed to the listed names, then to the user's policy. */
  private async deliver(item: ManifestEntry, settings: SecretsSettings): Promise<DeliveredConfig> {
    const result: DeliveredConfig = { project: item.project, config: item.config, values: new Map(), withheld: [], missing: [], refused: null };
    const key = configKey(item.project, item.config);
    if (isDeniedConfig(item.config, settings.policy.deniedConfigs)) {
      result.refused = `the coordinator's secrets policy (${settings.policy.mode}) refuses config ${item.config}`;
      return result;
    }
    const token = this.deps.tokens.get(key);
    if (token === undefined) {
      result.refused = this.deps.tokenErrors.get(key) ?? `the coordinator holds no Doppler token for ${key} (runpane cloud coordinator doppler set --project ${item.project} --config ${item.config})`;
      return result;
    }
    let all: Map<string, string>;
    try {
      all = await this.deps.doppler.download(token, item.project, item.config);
    } catch (error) {
      // A Doppler outage fails the whole fetch, so the Session keeps what it had instead of losing it.
      throw new SecretsError('doppler-error', `${key}: ${error instanceof DopplerError ? error.message : String(error)}`);
    }
    const listed = item.names;
    const wanted = listed === 'all' ? [...all.keys()] : [...all.keys()].filter((name) => matchingPattern(name, listed) !== null);
    if (listed !== 'all') result.missing = listed.filter((name) => !name.includes('*') && !all.has(name));
    for (const name of wanted.sort()) {
      const reserved = reservedBy(name);
      const denied = matchingPattern(name, settings.policy.deniedNames);
      if (reserved) result.withheld.push({ name, reason: `reserved by the shell or Pane (${reserved})` });
      else if (denied) result.withheld.push({ name, reason: `the coordinator's secrets policy denies ${denied}` });
      else result.values.set(name, all.get(name) ?? '');
    }
    return result;
  }

  private record(call: SecretsCall, entry: DirectoryEntry | null, node: TailnetNode | null, endpoint: string, audit: Pick<SecretsAuditEntry, 'repo' | 'ref' | 'manifestSha' | 'configs'>, outcome: string, httpStatus: number, started: number): void {
    this.deps.audit.append({
      callerId: call.caller.id,
      label: entry?.label ?? null,
      node: node ? `${node.name} ${node.stableId}` : call.remoteAddress,
      endpoint,
      repo: audit.repo,
      ref: audit.ref,
      manifestSha: audit.manifestSha,
      outcome,
      httpStatus,
      configs: audit.configs,
      durationMs: this.deps.clock.now() - started,
    });
  }
}

/** The directory's manifest source; a Session with exactly one broker repository falls back to its default branch. */
function manifestSourceOf(entry: DirectoryEntry): { repo: string; ref: string | null } | null {
  if (entry.secretsManifest) return entry.secretsManifest;
  return entry.githubRepos.length === 1 ? { repo: entry.githubRepos[0], ref: null } : null;
}

/**
 * A short fingerprint of what was delivered, so a Session (and its user) can see that a refresh changed
 * something. It covers the manifest sha and every name and value together: no single value can be
 * recovered from it.
 */
function versionOf(manifestSha: string, delivered: readonly DeliveredConfig[]): string {
  const hash = createHash('sha256').update(manifestSha);
  for (const config of delivered) {
    hash.update(`\0${configKey(config.project, config.config)}`);
    for (const [name, value] of config.values) hash.update(`\0${name}\0${value}`);
  }
  return hash.digest('hex').slice(0, 16);
}
