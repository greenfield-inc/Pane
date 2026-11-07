import { commandExecutor } from '../utils/commandExecutor';
import { getWSLContextFromProject, type WSLContext } from '../utils/wslUtils';

/**
 * A repository's identity across machines: its origin remote as `host/owner/repo`, lower-cased,
 * with no scheme, user, port or `.git`, so SSH and HTTPS clones of one repository agree.
 * Null for a remote that is a local path, or that names no repository.
 */
export function repositoryIdentityFromRemote(remote: string): string | null {
  const url = remote.trim();
  if (!url || url.startsWith('/') || url.startsWith('.') || /^[a-z]:[\\/]/i.test(url) || /^file:/i.test(url)) return null;

  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  if (scheme) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else {
    // scp-like: [user@]host:owner/repo
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (!match) return null;
    [, host, path] = match;
  }

  const repository = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !repository) return null;
  return `${host}/${repository}`.toLowerCase();
}

interface ProjectLocation {
  path: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
}

type ReadOrigin = (path: string, wsl: WSLContext | null) => Promise<string | null>;

async function readGitOrigin(path: string, wsl: WSLContext | null): Promise<string | null> {
  const { stdout } = await commandExecutor.execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: path, silent: true, timeout: 5_000 }, wsl);
  return stdout.trim() || null;
}

/**
 * Each project's repository identity, read from git once per project path for as long as the
 * host runs. The project list is asked for on many events; only a new or moved project runs git.
 */
export class RepositoryIdentities {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly readOrigin: ReadOrigin = readGitOrigin) {}

  /** The identity of each project, in order; null where it has no readable origin. */
  of(projects: readonly ProjectLocation[]): Promise<Array<string | null>> {
    return Promise.all(projects.map((project) => this.identityOf(project)));
  }

  private identityOf(project: ProjectLocation): Promise<string | null> {
    const wsl = getWSLContextFromProject(project);
    const key = `${wsl?.distribution ?? ''}\n${project.path}`;
    let identity = this.cache.get(key);
    if (!identity) {
      identity = this.readOrigin(project.path, wsl)
        .then((remote) => (remote ? repositoryIdentityFromRemote(remote) : null))
        .catch(() => null);
      this.cache.set(key, identity);
    }
    return identity;
  }
}
