import { createHmac, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import type { CommandRunner } from '../utils/commandRunner';

/**
 * The repository properties on `session_created` (docs/ANALYTICS_INVARIANTS.md).
 * `repo_key` is an HMAC of the normalised origin URL under a random secret kept in
 * `<PANE_DIR>/repo-key-secret`; the secret, URL and path never leave this module.
 */
export interface RepoProperties {
  repo_key?: string;
  repo_size?: RepoSize;
}

type RepoSize = 'under_10mb' | '10_50mb' | '50_200mb' | 'over_200mb';

const SECRET_FILE = 'repo-key-secret';
const MB = 1_000_000;
const secrets = new Map<string, Promise<string>>();

/** One text per repository: drops the scheme, credentials, host case, trailing slashes and `.git`. */
function normaliseRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  const scp = /^(?:[^@/]+@)?([^:/\\]{2,}):(.*)$/.exec(trimmed);
  let host = '';
  let path = trimmed;
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1);
    path = slash === -1 ? '' : rest.slice(slash);
  } else if (scp) {
    [, host, path] = scp;
  }
  path = path.replace(/[/\\]+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  return host ? `${host.toLowerCase()}/${path}` : path;
}

function repoSizeRange(bytes: number): RepoSize {
  if (bytes < 10 * MB) return 'under_10mb';
  if (bytes < 50 * MB) return '10_50mb';
  if (bytes < 200 * MB) return '50_200mb';
  return 'over_200mb';
}

async function readOrCreateSecret(file: string): Promise<string> {
  const saved = await fs.readFile(file, 'utf8').catch(() => '');
  if (/^[0-9a-f]{64}$/.test(saved.trim())) return saved.trim();
  const created = randomBytes(32).toString('hex');
  await fs.writeFile(file, created, { mode: 0o600 });
  return created;
}

function installSecret(): Promise<string> {
  const file = join(getAppDirectory(), SECRET_FILE);
  let secret = secrets.get(file);
  if (!secret) {
    secret = readOrCreateSecret(file);
    secrets.set(file, secret);
    secret.catch(() => secrets.delete(file));
  }
  return secret;
}

/** Never rejects; a property whose git call or secret fails is left out. */
export async function repoProperties(repoPath: string, runner: CommandRunner): Promise<RepoProperties> {
  const [remote, sizes] = await Promise.allSettled([
    runner.execFile('git', ['remote', 'get-url', 'origin'], repoPath, { silent: true, timeout: 10_000 }),
    runner.execFile('git', ['ls-tree', '-r', '--format=%(objectsize)', 'HEAD'], repoPath, {
      silent: true, timeout: 30_000, maxBuffer: 64 * MB,
    }),
  ]);
  const properties: RepoProperties = {};
  const url = remote.status === 'fulfilled' ? remote.value.stdout.trim() : '';
  if (url) {
    try {
      const secret = await installSecret();
      properties.repo_key = createHmac('sha256', secret).update(normaliseRemoteUrl(url)).digest('hex').slice(0, 16);
    } catch {
      // No writable data folder: send no key rather than an unstable one.
    }
  }
  if (sizes.status === 'fulfilled') {
    // Submodule entries print "-" and count as 0.
    const bytes = sizes.value.stdout.split('\n').reduce((sum, line) => sum + (Number(line) || 0), 0);
    properties.repo_size = repoSizeRange(bytes);
  }
  return properties;
}
