import { BrokerError } from './brokerClient';
import { sessionBroker, type AgentDeps } from './session';

/**
 * `git-credential-runpane` (git's credential-helper protocol): answers `get` for an https GitHub
 * repository with the broker's read-only, one-repository, ≤1 h installation token (App mode), so
 * fetch and clone need no deploy key. It never answers for a push: the token cannot write anyway.
 * Configured for https://github.com only (with useHttpPath, so git passes the repository path), and it
 * checks the host itself too, so a broader git config can't hand a GitHub token to another server.
 * Another host, PAT mode, a repository the coordinator doesn't allow, or an unreachable coordinator:
 * it prints nothing on stdout, and git moves on.
 */

const GITHUB_HOST = 'github.com';

function parseRequest(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return fields;
}

/** owner/name from git's `path` (`owner/name.git`, `owner/name`, or a deeper smart-HTTP path). */
function repoFromCredentialPath(value: string | undefined): string | null {
  const match = value ? /^\/?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/.*)?$/u.exec(value) : null;
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return `${match[1]}/${match[2]}`;
}

export async function runGitCredential(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const operation = argv[0];
  // store/erase: nothing is kept, so there is nothing to do.
  if (operation !== 'get') return 0;
  const request = parseRequest(await deps.readStdin());
  if (request.get('protocol') !== 'https') return 0;
  const host = request.get('host')?.toLowerCase();
  if (host !== (deps.gitHost ?? GITHUB_HOST)) {
    deps.stderr(`git-credential-runpane: answers only for ${deps.gitHost ?? GITHUB_HOST}, not ${host || 'a request with no host'}.`);
    return 0;
  }
  const repo = repoFromCredentialPath(request.get('path'));
  if (!repo) {
    deps.stderr('git-credential-runpane: git sent no repository path; set credential.https://github.com.useHttpPath true.');
    return 0;
  }
  try {
    const { token, expiresAt } = await sessionBroker(deps).readToken(repo);
    const lines = ['username=x-access-token', `password=${token}`];
    const expiry = expiresAt ? Math.floor(Date.parse(expiresAt) / 1000) : NaN;
    if (Number.isFinite(expiry)) lines.push(`password_expiry_utc=${expiry}`);
    deps.stdout(`${lines.join('\n')}\n`);
  } catch (error) {
    // PAT mode has no read tokens: the deploy key (ssh) is the way to read; stay quiet about it.
    if (!(error instanceof BrokerError && error.code === 'read-token-unsupported')) {
      deps.stderr(`git-credential-runpane: no token for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}
