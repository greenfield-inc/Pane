import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BoatOrg, CloudSize } from './provider';

/**
 * Local state for cloud sandboxes, on the user's machine only (never in a sandbox):
 *
 *   <dir>/credentials.json      0600  boat API key, Tailscale OAuth client, optional Claude token
 *   <dir>/settings.json         0600  non-secret defaults (the boat wallet new sandboxes bill)
 *   <dir>/hosts/<hostname>.json 0600  one record per sandbox: its saved remote host profile plus metadata
 *
 * The dir is `$RUNPANE_CLOUD_DIR`, else `$XDG_CONFIG_HOME/runpane-cloud`, else `~/.config/runpane-cloud` (0700).
 * The desktop app and the CLI share it.
 */

export interface CloudCredentials {
  boat?: { apiKey: string };
  tailscale?: { clientId: string; clientSecret: string; tailnet?: string };
  /** A Claude subscription token (`claude setup-token`) that agents in every sandbox sign in with. */
  claude?: { oauthToken: string };
  /** A GitHub personal access token that gh and git in every sandbox sign in with (on create and start). */
  github?: { token: string };
}

export type PaneSource =
  | { kind: 'runpane-npm'; spec: string }
  | { kind: 'deb-url'; url: string; sha256?: string };

export const DEFAULT_PANE_SOURCE: PaneSource = { kind: 'runpane-npm', spec: 'runpane@latest' };

interface CloudSettings {
  /** The boat wallet new sandboxes bill (`setup --boat-org`); unset, boat's active wallet applies. */
  boatOrg?: BoatOrg;
}

/** The `cloud` field on a saved remote host profile (shared/types/remoteDaemon.ts RemotePaneCloudInfo). */
interface CloudProfileInfo {
  provider: 'boat';
  sandboxId: string;
  sessionId: string;
  nodeId: string;
  hostname: string;
  /** Goes up whenever the address or the tailnet node changes. */
  version: number;
}

/** Same shape as the desktop's RemotePaneConnectionProfile (shared/types/remoteDaemon.ts), with `cloud` set. */
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
  /** When this machine last created or started the sandbox. */
  startedAt?: string;
  size: CloudSize;
  magicDnsName: string;
  paneSource: PaneSource;
  daemonVersion?: string;
  /** The boat wallet this sandbox bills, fixed at create; every provider call for the host is scoped to it. */
  boatOrg?: BoatOrg;
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
  /** Host records; a file that is not a host record is skipped. */
  listHosts(): Promise<CloudHostRecord[]>;
  writeHost(record: CloudHostRecord): Promise<void>;
  removeHost(hostname: string): Promise<void>;
}

function defaultCloudDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DIR) return path.resolve(env.RUNPANE_CLOUD_DIR);
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(configHome, 'runpane-cloud');
}

const HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function createCloudStore(dir: string = defaultCloudDir()): CloudStore {
  const hostsDir = path.join(dir, 'hosts');
  const hostFile = (hostname: string): string => {
    if (!HOSTNAME_PATTERN.test(hostname)) throw new Error(`Invalid cloud host name "${hostname}".`);
    return path.join(hostsDir, `${hostname}.json`);
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
    async writeHost(record) {
      await writePrivateJson(hostFile(record.profile.cloud.hostname), record);
    },
    async removeHost(hostname) {
      await fs.rm(hostFile(hostname), { force: true });
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

/** Writes JSON through a 0600 temp file and a rename, creating parent dirs 0700. */
async function writePrivateJson(filePath: string, value: CloudCredentials | CloudSettings | CloudHostRecord): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
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
    // SAFETY: local files this module wrote itself; callers check the fields they rely on.
    return JSON.parse(text) as Value;
  } catch {
    throw new Error(`${filePath} is not valid JSON. Fix or remove it, then retry.`);
  }
}

export function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Finds a host by tailnet hostname, cloud session id, sandbox id or label. */
export function findHost(records: readonly CloudHostRecord[], selector: string): CloudHostRecord {
  const wanted = selector.trim();
  const matches = records.filter(({ profile }) => profile.cloud.hostname === wanted
    || profile.cloud.sessionId === wanted
    || profile.cloud.sandboxId === wanted
    || profile.id === wanted
    || profile.label === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known = records.map((record) => record.profile.cloud.hostname).join(', ') || 'none';
    throw new Error(`No cloud sandbox matches "${selector}". Known: ${known}.`);
  }
  throw new Error(`"${selector}" matches ${matches.length} cloud sandboxes; use the host name instead.`);
}
