import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { BoatOrg, CloudSize } from './provider';
import type { CloudTransport } from './args';

/**
 * Local state for `runpane cloud`, on the user's machine only. Never in the desktop app or a sandbox.
 *
 *   <dir>/credentials.json        0600  provider key, Tailscale OAuth client, optional Anthropic key
 *   <dir>/settings.json           0600  non-secret defaults (golden snapshot, size, name prefix, Pane source)
 *   <dir>/hosts/<hostname>.json    0600  one record per cloud Session: the saved remote host profile plus CLI metadata
 *   <dir>/hosts/<hostname>.pairing 0600  the pane-remote:// code, written by bootstrap and never printed unless `pair` asks
 *   <dir>/coordinator.json         0600  {baseUrl, token} of the deployed coordinator (this machine's user caller token)
 *   <dir>/coordinator-secret       0600  the coordinator's caller-token HMAC secret, to mint each Session's peer-caller token
 *
 * The dir is `$RUNPANE_CLOUD_DIR`, else `$XDG_CONFIG_HOME/runpane-cloud`, else `~/.config/runpane-cloud` (0700).
 */

export interface CloudCredentials {
  boat?: { apiKey: string };
  tailscale?: { clientId: string; clientSecret: string; tailnet?: string };
  anthropic?: { apiKey: string };
  /** A Claude subscription token (`claude setup-token`), the alternative to an Anthropic API key. */
  claude?: { oauthToken: string };
}

export type PaneSource =
  | { kind: 'runpane-npm'; spec: string }
  | { kind: 'deb-url'; url: string; sha256?: string }
  | { kind: 'preinstalled' };

export interface CloudSettings {
  goldenSnapshot?: string;
  size?: CloudSize;
  /** Default for `new --transport` (auto when unset). */
  transport?: CloudTransport;
  namePrefix?: string;
  paneSource?: PaneSource;
  /** Largest number of live cloud sandboxes `new` may leave running (runaway guard). */
  maxLiveSandboxes?: number;
  coordinator?: { enabled: boolean; deployment?: CoordinatorDeployment };
  /** Extra name patterns (`*` wildcards) `cloud secrets set` refuses, on top of the built-in deny-list. */
  secretsDenyList?: string[];
  /** The boat wallet new sandboxes bill (`setup --boat-org`); unset, boat's active wallet applies. */
  boatOrg?: BoatOrg;
  /** Your guardrails for agents in every cloud Session (`runpane cloud notes`; none by default). */
  agentNotes?: { guardrails?: string[] };
}

/** The coordinator sandbox `runpane cloud coordinator deploy` created. */
export interface CoordinatorDeployment {
  sandboxId: string;
  hostname: string;
  nodeId: string;
  /** http://<MagicDNS name>:<port>, reachable from tailnet members and rp-session nodes. */
  baseUrl: string;
  /** The scoped provider key (read/stop/resume only) the coordinator holds; revoked on destroy. */
  scopedKeyId: string;
  /** The lifetime the provider accepted, e.g. "360d" (it cannot outlive the account key). */
  scopedKeyTtl?: string;
  /** Sandboxes whose name starts with this are the coordinator's to idle-stop and reconcile. */
  managedPrefix: string;
  reconcile: boolean;
  deployedAt: string;
  appVersion: string;
  pin?: PinnedPane;
  /** Idle-stop timings, when set by `deploy --idle-check-seconds/--wake-grace-seconds`; kept across redeploys. */
  idleCheckSeconds?: number;
  wakeGraceSeconds?: number;
  /** The boat wallet the coordinator sandbox bills (fixed at create); its own boat calls default to it. */
  boatOrg?: BoatOrg;
  /**
   * The GitHub broker (`coordinator github set`). Only settings: the App key or PAT lives on the
   * coordinator (0600) and never on this machine's disk. Kept so a redeploy rewrites the same config.
   */
  github?: CoordinatorGitHub;
  /**
   * The Doppler secrets service (`coordinator doppler set`). Only settings and token slugs: each
   * config's read-only service token lives on the coordinator (0600), never on this machine.
   */
  secrets?: CoordinatorSecrets;
}

export interface CoordinatorSecrets {
  /** An override for a fake Doppler (tests). */
  apiBaseUrl?: string;
  configs: CoordinatorSecretsConfig[];
  /** default: the built-in deny-list; allow-all: everything the manifest names (the user's call); custom: these lists. */
  policy: { mode: 'default' | 'allow-all' | 'custom'; deniedNames?: string[]; deniedConfigs?: string[] };
}

export interface CoordinatorSecretsConfig {
  project: string;
  config: string;
  /** Set when this machine minted the token (doppler configs tokens create), so unset can revoke it. */
  tokenSlug?: string;
  tokenName?: string;
  setAt: string;
}

export interface CoordinatorGitHub {
  mode: 'app' | 'pat';
  appId?: string;
  installationId?: number;
  allowReadyPulls: boolean;
  /** Overrides for a fake GitHub (tests, the live proof without GitHub). */
  apiBaseUrl?: string;
  gitBaseUrl?: string;
  setAt: string;
}

export interface PinnedPane {
  version: string;
  debUrl: string;
  sha256: string;
}

export const DEFAULT_NAME_PREFIX = 'rp';
export const DEFAULT_MAX_LIVE_SANDBOXES = 25;
export const DEFAULT_PANE_SOURCE: PaneSource = { kind: 'runpane-npm', spec: 'runpane@latest' };

/**
 * The `cloud` field on a saved remote host profile. Single writer: the CLI at
 * creation, then the coordinator; `version` goes up whenever the address changes.
 */
interface CloudProfileInfo {
  provider: 'boat';
  sandboxId: string;
  sessionId: string;
  nodeId: string;
  hostname: string;
  version: number;
}

/** Same shape as the desktop's RemotePaneConnectionProfile (shared/types/remoteDaemon.ts) plus `cloud`. */
export interface CloudHostProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  transport: 'http+sse';
  tunnel?: { kind: 'tailscale'; selected: boolean; note?: string };
  cloud: CloudProfileInfo;
}

interface CloudHostMeta {
  createdAt: string;
  size: CloudSize;
  namePrefix: string;
  magicDnsName: string;
  pairingPath: string;
  coordinatorPairingPath?: string;
  paneSource: PaneSource;
  daemonVersion?: string;
  pinnedVersion?: string;
  /**
   * The broker's credential kind when `brokerRepos` was last set (app: the Session reads through the broker's
   * read-only token and has the git credential helper; pat: it reads over a deploy key).
   */
  brokerMode?: 'app' | 'pat';
  repo?: { url: string; ref?: string };
  /** Sessions this one may message (J3): each is a peer record minted on the target host. */
  peers?: PeerGrant[];
  /** The boat wallet this sandbox bills, fixed at create; every provider call for the host is scoped to it. */
  boatOrg?: BoatOrg;
  /** GitHub repositories this Session can reach (`runpane cloud github connect`). */
  github?: GitHubGrant[];
  /** owner/name repos this Session may use through the coordinator's GitHub broker (directory `github.repos`). */
  brokerRepos?: string[];
}

/** Where the laptop's GitHub credential came from, so disconnect and destroy can find it again. */
export type GitHubTokenSource = { kind: 'gh' } | { kind: 'file'; path: string } | { kind: 'stdin' };

/**
 * One GitHub repository a cloud Session can reach. `deploy-key`: an ed25519 key generated inside the
 * sandbox (the private half never leaves it), registered on the repository as a deploy key through the
 * laptop's credential. `pat`: a fine-grained personal access token the user made, kept in a 0600 file
 * in the sandbox. Neither ever carries the laptop's own GitHub credential.
 */
export interface GitHubGrant {
  /** owner/name */
  repo: string;
  mode: 'deploy-key' | 'pat';
  /** Deploy keys: read-only unless connected with --read-write. PATs: whatever the token allows. */
  readOnly?: boolean;
  /** Deploy keys: the ssh host alias (`git@<alias>:owner/name.git`) and GitHub's key id and fingerprint. */
  sshAlias?: string;
  keyId?: number;
  fingerprint?: string;
  tokenSource?: GitHubTokenSource;
  connectedAt: string;
}

export interface PeerGrant {
  /** Target cloud host (tailnet hostname). */
  host: string;
  /** Peer client record id on the target's daemon (revoke deletes it). */
  peerId: string;
  /** Pane Session id on the target that the peer may submit to. */
  targetSessionId: string;
  grantedAt: string;
  /** The peer credential for the target's daemon; only ever written into the source's 0600 peers list. */
  baseUrl: string;
  token: string;
}

export interface CloudHostRecord {
  version: 1;
  profile: CloudHostProfile;
  meta: CloudHostMeta;
}

export interface CloudStore {
  readonly dir: string;
  readCredentials(): Promise<CloudCredentials>;
  writeCredentials(credentials: CloudCredentials): Promise<void>;
  readSettings(): Promise<CloudSettings>;
  writeSettings(settings: CloudSettings): Promise<void>;
  /** Host records; one that is not a host record is skipped (commands on other hosts still work). */
  listHosts(): Promise<CloudHostRecord[]>;
  /**
   * Every host record, strictly validated, for publishing (the coordinator's directory): throws naming
   * each invalid file, so a partial directory is never pushed. Empty connection fields are valid: `new`
   * records the host before its address exists.
   */
  readHostSnapshot(): Promise<CloudHostRecord[]>;
  writeHost(record: CloudHostRecord): Promise<void>;
  removeHost(hostname: string): Promise<void>;
  pairingPath(hostname: string): string;
  coordinatorPairingPath(hostname: string): string;
  readPairing(hostname: string): Promise<string>;
  /** `<dir>/coordinator.json`: the coordinator client config remote/coordinatorClient.ts reads. */
  readonly coordinatorClientPath: string;
  readSecretText(name: SecretTextName): Promise<string | undefined>;
  writeSecretText(name: SecretTextName, value: string): Promise<void>;
  removeSecretText(name: SecretTextName): Promise<void>;
}

/** Secret files kept next to credentials.json, one value each (0600). */
type SecretTextName = 'coordinator.json' | 'coordinator-secret';

function defaultCloudDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DIR) return path.resolve(env.RUNPANE_CLOUD_DIR);
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(configHome, 'runpane-cloud');
}

const HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function createCloudStore(dir: string = defaultCloudDir()): CloudStore {
  const hostsDir = path.join(dir, 'hosts');
  const hostFile = (hostname: string, suffix: string): string => {
    if (!HOSTNAME_PATTERN.test(hostname)) throw new Error(`Invalid cloud host name "${hostname}".`);
    return path.join(hostsDir, `${hostname}${suffix}`);
  };

  return {
    dir,
    async readCredentials() {
      return (await readJsonFile<CloudCredentials>(path.join(dir, 'credentials.json'))) ?? {};
    },
    async writeCredentials(credentials) {
      await writePrivateJson(path.join(dir, 'credentials.json'), credentials);
    },
    async readSettings() {
      return (await readJsonFile<CloudSettings>(path.join(dir, 'settings.json'))) ?? {};
    },
    async writeSettings(settings) {
      await writePrivateJson(path.join(dir, 'settings.json'), settings);
    },
    async listHosts() {
      const records: CloudHostRecord[] = [];
      for (const entry of await listHostFiles(hostsDir)) {
        const record = await readJsonFile<CloudHostRecord>(path.join(hostsDir, entry));
        if (record?.version === 1 && record.profile?.cloud?.hostname) records.push(record);
      }
      return records;
    },
    async readHostSnapshot() {
      const records: CloudHostRecord[] = [];
      const problems: string[] = [];
      for (const entry of await listHostFiles(hostsDir)) {
        const record = await readJsonFile<CloudHostRecord>(path.join(hostsDir, entry));
        const problem = hostRecordProblem(record, entry);
        if (problem !== null || record === undefined) problems.push(`hosts/${entry}: ${problem ?? 'removed while reading'}`);
        else records.push(record);
      }
      problems.push(...duplicateHostProblems(records));
      if (problems.length > 0) {
        throw new Error(`invalid cloud host records in ${hostsDir} (fix or remove them, then retry): ${problems.join('; ')}`);
      }
      return records;
    },
    async writeHost(record) {
      await writePrivateJson(hostFile(record.profile.cloud.hostname, '.json'), record);
    },
    async removeHost(hostname) {
      for (const suffix of ['.json', '.pairing', '.coordinator.pairing']) {
        await fs.rm(hostFile(hostname, suffix), { force: true });
      }
    },
    pairingPath: (hostname) => hostFile(hostname, '.pairing'),
    coordinatorPairingPath: (hostname) => hostFile(hostname, '.coordinator.pairing'),
    async readPairing(hostname) {
      return (await fs.readFile(hostFile(hostname, '.pairing'), 'utf8')).trim();
    },
    coordinatorClientPath: path.join(dir, 'coordinator.json'),
    async readSecretText(name) {
      try {
        return (await fs.readFile(path.join(dir, name), 'utf8')).trim() || undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async writeSecretText(name, value) {
      await writePrivateText(path.join(dir, name), `${value.trim()}\n`);
    },
    async removeSecretText(name) {
      await fs.rm(path.join(dir, name), { force: true });
    },
  };
}

async function listHostFiles(hostsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(hostsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

// The fields a published snapshot relies on. Connection fields may be empty while `new` sets a host up.
const hostRecordSchema = boundary.object({
  version: boundary.literal(1),
  profile: boundary.object({
    id: boundary.nonEmptyString,
    label: boundary.string,
    baseUrl: boundary.string,
    token: boundary.string,
    transport: boundary.literal('http+sse'),
    cloud: boundary.object({
      provider: boundary.nonEmptyString,
      sandboxId: boundary.nonEmptyString,
      sessionId: boundary.nonEmptyString,
      nodeId: boundary.string,
      hostname: boundary.nonEmptyString,
      version: boundary.number,
    }),
  }),
  meta: boundary.object({
    coordinatorPairingPath: boundary.optional(boundary.string),
    pinnedVersion: boundary.optional(boundary.string),
    repo: boundary.optional(boundary.object({ url: boundary.string, ref: boundary.optional(boundary.string) })),
    boatOrg: boundary.optional(boundary.object({ id: boundary.nonEmptyString, name: boundary.string })),
    brokerRepos: boundary.optional(boundary.array(boundary.nonEmptyString)),
  }),
});

/** Why `value` (read from `hosts/<file>`) is not a valid host record, or null when it is. */
function hostRecordProblem(value: CloudHostRecord | undefined, file: string): string | null {
  try {
    const record = decodeBoundary(value, hostRecordSchema);
    const { hostname } = record.profile.cloud;
    if (!HOSTNAME_PATTERN.test(hostname) || file !== `${hostname}.json`) return `hostname "${hostname}" does not match the file name`;
    // Provisional: no address yet. Once a host has one, it must be a usable connection.
    if (record.profile.baseUrl === '') return null;
    if (!isHttpUrl(record.profile.baseUrl)) return `baseUrl "${record.profile.baseUrl}" is not an http(s) URL`;
    if (record.profile.token === '') return 'it has a baseUrl but no token';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function duplicateHostProblems(records: readonly CloudHostRecord[]): string[] {
  const problems: string[] = [];
  for (const key of ['sessionId', 'sandboxId'] as const) {
    const seen = new Set<string>();
    for (const record of records) {
      const value = record.profile.cloud[key];
      if (seen.has(value)) problems.push(`more than one host record has ${key} ${value}`);
      seen.add(value);
    }
  }
  return problems;
}

/** Writes JSON through a 0600 temp file and a rename, creating parent dirs 0700. */
async function writePrivateJson(filePath: string, value: CloudCredentials | CloudSettings | CloudHostRecord): Promise<void> {
  await writePrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateText(filePath: string, content: string): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function readJsonFile<Value>(filePath: string): Promise<Value | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    // SAFETY: local files this CLI wrote itself; callers check the fields they rely on.
    return JSON.parse(text) as Value;
  } catch {
    throw new Error(`${filePath} is not valid JSON. Fix or remove it, then retry.`);
  }
}

export function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Finds a host by tailnet hostname, cloud Session id, label or sandbox id. */
export function findHost(records: readonly CloudHostRecord[], selector: string): CloudHostRecord {
  const wanted = selector.trim();
  const matches = records.filter((record) => {
    const { profile } = record;
    return profile.cloud.hostname === wanted
      || profile.cloud.sessionId === wanted
      || profile.cloud.sandboxId === wanted
      || profile.label === wanted
      || record.meta.magicDnsName === wanted;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known = records.map((record) => record.profile.cloud.hostname).join(', ') || 'none';
    throw new Error(`No cloud host matches "${selector}". Known hosts: ${known}. Run runpane cloud list.`);
  }
  throw new Error(`"${selector}" matches ${matches.length} cloud hosts; use the host name from runpane cloud list.`);
}
