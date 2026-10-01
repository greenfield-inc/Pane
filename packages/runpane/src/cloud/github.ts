import { createHash, randomBytes } from 'node:crypto';
import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import type { GitHubApi } from './githubApi';
import { MAX_SANDBOX_READ_BYTES, type CloudProvider, type SandboxHandle } from './provider';
import { findHost, type CloudHostRecord, type GitHubGrant, type GitHubTokenSource } from './store';
import { brokerCloneScript, brokerReaches, disableBroker, enableBroker, readBrokerStatus, type CoordinatorGitHubStatus } from './githubBroker';
import { hostProvider } from './wallet';

/**
 * `runpane cloud github connect|disconnect|list` and `runpane cloud git push`: GitHub access for cloud
 * Sessions without handing a sandbox the user's own GitHub credential.
 *
 * - connect (default): an ed25519 key is generated inside the sandbox; only its public half leaves, and the
 *   laptop registers it on one repository as a deploy key (read-only unless --read-write). The sandbox gets
 *   an ssh host alias with github.com's host keys pinned, so `git clone git@github.com-<owner>-<name>:owner/name.git`
 *   works there. disconnect and `cloud destroy` delete the key on GitHub.
 * - connect --pat-file: a fine-grained personal access token the user made for that repository, kept in a
 *   0600 file in the sandbox behind a credential helper scoped to the repository's URL.
 * - git push: work leaves the sandbox as a git bundle and is pushed from the laptop, with the laptop's
 *   credential, to `cloud/<host>/<branch>` only. The default branch, main and master are refused.
 */

const SSH_DIR = '/home/user/.ssh';
const GIT_CRED_DIR = '/home/user/.config/runpane-cloud-git';
const XFER_DIR = '/home/user/.runpane-cloud/xfer';
const STAGE_DIR = '/home/user/.runpane-cloud';
const PROTECTED_BRANCHES = ['main', 'master'];
/** Tokens that reach every repository the user can: refused for --pat-file. */
const BROAD_TOKEN_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

const GITHUB_USAGE = `Usage:
  runpane cloud github connect <host> --repo <owner/name> [--read-write] [--token-file <path|->] [--json]
      Generate a deploy key inside the Session and register it on the repository (read-only by default).
  runpane cloud github connect <host> --repo <owner/name> --pat-file <path|-> [--json]
      Use a fine-grained personal access token for that repository instead.
  runpane cloud github connect <host> --repo <owner/name> --broker [--token-file <path|->] [--json]
      Let the Session push, open draft PRs and issues through the coordinator's GitHub broker (gh shim).
  runpane cloud github disconnect <host> [--repo <owner/name>] [--broker] [--token-file <path|->] [--json]
  runpane cloud github list [<host>] [--json]`;

const GIT_USAGE = `Usage:
  runpane cloud git push <host> --path <repo dir in the Session> --branch <branch>
      [--repo <owner/name>] [--prefix <prefix/>] [--force] [--token-file <path|->] [--json]
      Push a Session's branch from this machine to <prefix><branch> (default prefix cloud/<host>/).`;

interface Flags {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseFlags(argv: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[], usage: string): Flags {
  const flags: Flags = { positionals: [], values: new Map(), booleans: new Set() };
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    const separator = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    if (!flag.startsWith('-')) {
      flags.positionals.push(raw);
    } else if (booleanFlags.includes(flag)) {
      flags.booleans.add(flag);
    } else if (valueFlags.includes(flag)) {
      const value = separator === -1 ? argv[++index] : raw.slice(separator + 1);
      if (value === undefined || (separator === -1 && value.startsWith('--'))) throw new Error(`${flag} requires a value.`);
      if (flags.values.has(flag)) throw new Error(`Give ${flag} once.`);
      flags.values.set(flag, value);
    } else {
      throw new Error(`Unknown option: ${flag}\n\n${usage}`);
    }
  }
  return flags;
}

function tokenSourceFrom(file: string | undefined): GitHubTokenSource {
  if (file === undefined) return { kind: 'gh' };
  if (file === '-') return { kind: 'stdin' };
  return { kind: 'file', path: file };
}

// ---------------------------------------------------------------- names

/** owner/name from `owner/name`, `https://github.com/owner/name(.git)` or `git@github.com[-alias]:owner/name(.git)`. */
export function parseRepoSpec(spec: string): string {
  const trimmed = spec.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com(?:-[A-Za-z0-9._-]+)?:|ssh:\/\/git@github\.com(?:-[A-Za-z0-9._-]+)?\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(trimmed);
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error(`"${spec}" is not a GitHub repository; use owner/name or https://github.com/owner/name.`);
  }
  return `${match[1]}/${match[2]}`;
}

function repoSlug(repo: string): string {
  return repo.toLowerCase().replace('/', '-').replace(/[^a-z0-9._-]/gu, '-');
}

/** The ssh host alias a deploy key answers to inside the Session. */
export function sshAliasFor(repo: string): string {
  return `github.com-${repoSlug(repo)}`;
}

/** The URL to clone or fetch a connected repository with inside the Session. */
export function deployKeyCloneUrl(repo: string): string {
  return `git@${sshAliasFor(repo)}:${repo}.git`;
}

/** Branch names git accepts (git check-ref-format --branch), minus the odd corners. */
function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/u.test(name)
    && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.')
    && !name.includes('..') && !name.includes('//') && !name.includes('/.') && !name.startsWith('.')
    && !name.endsWith('.lock') && name !== 'HEAD';
}

/**
 * The ref a mediated push may write: always `<prefix><branch>`, never the default branch, main or
 * master. Every rule is checked again here even when the prefix makes it impossible, on purpose.
 */
export function mediatedPushTarget(prefix: string, branch: string, defaultBranch: string): string {
  if (!isSafeBranchName(branch)) throw new Error(`"${branch}" is not a branch name runpane cloud git push accepts.`);
  if (!prefix.endsWith('/') || !isSafeBranchName(prefix.slice(0, -1))) {
    throw new Error(`--prefix must be a branch path ending in "/", like cloud/${'<host>'}/ (got "${prefix}").`);
  }
  const target = `${prefix}${branch}`;
  if (!target.startsWith(prefix) || !isSafeBranchName(target)) throw new Error(`Refusing to push to "${target}": outside ${prefix}.`);
  if (target === defaultBranch || PROTECTED_BRANCHES.includes(target)) {
    throw new Error(`Refusing to push to "${target}": runpane cloud never pushes to the default branch, main or master.`);
  }
  return target;
}

function shq(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

// ---------------------------------------------------------------- sandbox scripts

function markerLines(stdout: string, marker: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith(`${marker} `)).map((line) => line.slice(marker.length + 1).trim());
}

async function runChecked(handle: SandboxHandle, script: string, what: string, timeoutSeconds = 120): Promise<string> {
  const result = await handle.runScript(script, { timeoutSeconds });
  if (result.exitCode !== 0) {
    const detail = [...markerLines(result.stdout, 'RP_FAIL'), result.stderr.trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(' ');
    throw new Error(`${what} failed in the sandbox (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function keygenScript(repo: string, comment: string, knownHosts: string[]): string {
  const slug = repoSlug(repo);
  const key = `${SSH_DIR}/rp_github_${slug}`;
  return `set -eu
umask 077
mkdir -p ${SSH_DIR}/config.d
chmod 700 ${SSH_DIR} ${SSH_DIR}/config.d
rm -f ${key} ${key}.pub
ssh-keygen -q -t ed25519 -N '' -C ${shq(comment)} -f ${key} </dev/null
chmod 600 ${key}
cat > ${SSH_DIR}/rp_github_known_hosts <<'RP_KNOWN_HOSTS'
${knownHosts.join('\n')}
RP_KNOWN_HOSTS
chmod 644 ${SSH_DIR}/rp_github_known_hosts
cat > ${SSH_DIR}/config.d/rp-github-${slug}.conf <<'RP_SSH_CONF'
# runpane cloud github connect ${repo}: deploy key, github.com host keys pinned
Host ${sshAliasFor(repo)}
  HostName github.com
  User git
  IdentityFile ${key}
  IdentitiesOnly yes
  UserKnownHostsFile ${SSH_DIR}/rp_github_known_hosts
  StrictHostKeyChecking yes
RP_SSH_CONF
chmod 600 ${SSH_DIR}/config.d/rp-github-${slug}.conf
touch ${SSH_DIR}/config
chmod 600 ${SSH_DIR}/config
if ! grep -qxF 'Include config.d/rp-github-*.conf' ${SSH_DIR}/config; then
  existing=$(cat ${SSH_DIR}/config)
  { printf 'Include config.d/rp-github-*.conf\\n\\n'; printf '%s\\n' "$existing"; } > ${SSH_DIR}/config
fi
printf 'RP_PUBKEY %s\\n' "$(cat ${key}.pub)"
printf 'RP_FPR %s\\n' "$(ssh-keygen -lf ${key}.pub | awk '{print $2}')"
`;
}

/** ls-remote until GitHub knows the new credential (deploy keys take a moment to apply). */
function verifyScript(url: string): string {
  return `out=''
for attempt in 1 2 3 4 5 6 7 8; do
  if out=$(GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote ${shq(url)} HEAD 2>&1); then
    printf 'RP_OK %s\\n' "\${out%%[[:space:]]*}"
    exit 0
  fi
  sleep 3
done
printf 'RP_FAIL %s\\n' "$(printf '%s' "$out" | tail -2 | tr '\\n' ' ')"
exit 1
`;
}

function removeDeployKeyScript(repo: string): string {
  const slug = repoSlug(repo);
  return `rm -f ${SSH_DIR}/rp_github_${slug} ${SSH_DIR}/rp_github_${slug}.pub ${SSH_DIR}/config.d/rp-github-${slug}.conf
ls ${SSH_DIR}/config.d/rp-github-*.conf >/dev/null 2>&1 || rm -f ${SSH_DIR}/rp_github_known_hosts
echo RP_OK removed
`;
}

function patUrls(repo: string): string[] {
  return [`https://github.com/${repo}.git`, `https://github.com/${repo}`];
}

function installPatScript(repo: string, staged: string): string {
  const tokenFile = `${GIT_CRED_DIR}/github-${repoSlug(repo)}.token`;
  const helper = `${GIT_CRED_DIR}/credential-helper`;
  const configure = patUrls(repo).map((url) => `git config --global --unset-all ${shq(`credential.${url}.helper`)} || true
git config --global --add ${shq(`credential.${url}.helper`)} ''
git config --global --add ${shq(`credential.${url}.helper`)} ${shq(`${helper} ${tokenFile}`)}
git config --global ${shq(`credential.${url}.useHttpPath`)} true`).join('\n');
  return `set -eu
umask 077
mkdir -p ${GIT_CRED_DIR}
chmod 700 ${GIT_CRED_DIR}
install -m 600 ${staged} ${tokenFile}
shred -u ${staged} 2>/dev/null || rm -f ${staged}
cat > ${helper} <<'RP_HELPER'
#!/bin/sh
# runpane cloud: answers git's credential "get" for one repository from a 0600 token file ($1).
[ "$2" = get ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$(cat "$1")"
RP_HELPER
chmod 700 ${helper}
${configure}
echo RP_OK installed
`;
}

function removePatScript(repo: string): string {
  const tokenFile = `${GIT_CRED_DIR}/github-${repoSlug(repo)}.token`;
  const unset = patUrls(repo).map((url) => `git config --global --remove-section ${shq(`credential.${url}`)} 2>/dev/null || true`).join('\n');
  return `if [ -f ${tokenFile} ]; then shred -u ${tokenFile} 2>/dev/null || rm -f ${tokenFile}; fi
${unset}
echo RP_OK removed
`;
}

/** Bundles <branch> minus what origin already has; prints one RP_BUNDLE JSON line. */
export function bundleScript(dir: string, branch: string, xfer: string): string {
  return `set -eu
umask 077
cd ${shq(dir)} 2>/dev/null || { echo "RP_FAIL no directory ${dir.replace(/[^A-Za-z0-9._/ -]/gu, '?')} in the Session"; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo 'RP_FAIL not a git repository'; exit 1; }
head=$(git rev-parse --verify -q ${shq(`refs/heads/${branch}^{commit}`)}) || { echo 'RP_FAIL no such local branch: ${branch}'; exit 1; }
origin=$(git remote get-url origin 2>/dev/null || true)
prereqs=$(git rev-list --boundary "$head" --not --remotes=origin | sed -n 's/^-//p' | tr '\\n' ' ')
count=$(git rev-list --count "$head" --not --remotes=origin)
rm -rf ${xfer}
mkdir -p ${xfer}
size=0; sum=''
if [ "$count" -gt 0 ]; then
  git bundle create -q ${xfer}/session.bundle ${shq(`refs/heads/${branch}`)} --not --remotes=origin
  size=$(stat -c %s ${xfer}/session.bundle)
  sum=$(sha256sum ${xfer}/session.bundle | cut -d' ' -f1)
  split -b ${MAX_SANDBOX_READ_BYTES} -d -a 4 ${xfer}/session.bundle ${xfer}/part-
  rm -f ${xfer}/session.bundle
fi
parts=$(cd ${xfer} && ls part-* 2>/dev/null | tr '\\n' ' ' || true)
python3 -c 'import json,sys
a=sys.argv
print("RP_BUNDLE "+json.dumps({"head":a[1],"origin":a[2],"prerequisites":a[3].split(),"commits":int(a[4]),"size":int(a[5]),"sha256":a[6],"parts":a[7].split()}))' "$head" "$origin" "$prereqs" "$count" "$size" "$sum" "$parts"
`;
}

const bundleSchema = boundary.object({
  head: boundary.nonEmptyString,
  origin: boundary.string,
  prerequisites: boundary.array(boundary.nonEmptyString),
  commits: boundary.number,
  size: boundary.number,
  sha256: boundary.string,
  parts: boundary.array(boundary.nonEmptyString),
});

// ---------------------------------------------------------------- shared steps

async function requireRunning(record: CloudHostRecord, provider: CloudProvider): Promise<SandboxHandle> {
  const host = record.profile.cloud.hostname;
  const sandbox = await provider.get(record.profile.cloud.sandboxId);
  if (sandbox.state !== 'running') throw new Error(`${host} is ${sandbox.providerState}; wake it first: runpane cloud wake ${host}`);
  return provider.handle(record.profile.cloud.sandboxId);
}

interface ConnectOptions {
  repo: string;
  readWrite: boolean;
  tokenSource: GitHubTokenSource;
  onStep?: (line: string) => void;
}

/**
 * Generates the key in the sandbox, registers its public half on GitHub, saves the grant, then proves the
 * sandbox can read the repository. Undoes the registration if that proof fails. The sandbox must be running.
 */
export async function connectDeployKey(record: CloudHostRecord, handle: SandboxHandle, deps: CloudDeps, options: ConnectOptions): Promise<GitHubGrant> {
  const host = record.profile.cloud.hostname;
  const api = deps.github.api(await deps.github.resolveToken(options.tokenSource));
  const info = await api.getRepo(options.repo);
  if (!info.admin) {
    throw new Error(`Your GitHub credential cannot add deploy keys to ${info.fullName} (that needs admin on the repository). Use an admin's credential (--token-file), or --pat-file.`);
  }
  const repo = info.fullName;
  const knownHosts = await api.sshKnownHosts();
  const stdout = await runChecked(handle, keygenScript(repo, `runpane-cloud ${host} ${repo}`, knownHosts), 'Generating the deploy key');
  const [publicKey] = markerLines(stdout, 'RP_PUBKEY');
  const [fingerprint] = markerLines(stdout, 'RP_FPR');
  if (!publicKey?.startsWith('ssh-ed25519 ')) throw new Error('The sandbox did not return an ed25519 public key.');
  options.onStep?.(`deploy key generated in ${host} (${fingerprint ?? 'no fingerprint'}); private key stays there (0600)`);

  const key = await api.addDeployKey(repo, {
    title: `runpane-cloud ${host}${options.readWrite ? '' : ' (read-only)'}`,
    key: publicKey,
    readOnly: !options.readWrite,
  });
  const grant: GitHubGrant = {
    repo,
    mode: 'deploy-key',
    readOnly: !options.readWrite,
    sshAlias: sshAliasFor(repo),
    keyId: key.id,
    tokenSource: options.tokenSource.kind === 'stdin' ? { kind: 'gh' } : options.tokenSource,
    connectedAt: new Date(deps.now()).toISOString(),
  };
  if (fingerprint) grant.fingerprint = fingerprint;
  record.meta.github = [...(record.meta.github ?? []).filter((existing) => existing.repo !== repo), grant];
  await deps.store.writeHost(record);
  options.onStep?.(`registered on ${repo} as deploy key ${key.id} (${key.readOnly ? 'read-only' : 'read-write'})`);

  try {
    await runChecked(handle, verifyScript(deployKeyCloneUrl(repo)), `Reading ${repo} with the deploy key`, 150);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await api.deleteDeployKey(repo, key.id);
    } catch (cleanupError) {
      // The grant stays in the record: it is the handle disconnect and destroy delete the key with.
      throw new Error(`${reason}. Deleting deploy key ${key.id} on ${repo} failed too (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}); ${host} keeps the grant. Retry with: runpane cloud github disconnect ${host} --repo ${repo}`);
    }
    await handle.runScript(removeDeployKeyScript(repo), { timeoutSeconds: 60 }).catch(() => undefined);
    record.meta.github = (record.meta.github ?? []).filter((existing) => existing !== grant);
    if (record.meta.github.length === 0) delete record.meta.github;
    await deps.store.writeHost(record);
    throw error;
  }
  return grant;
}

async function connectPat(record: CloudHostRecord, handle: SandboxHandle, deps: CloudDeps, repoSpec: string, patFile: string): Promise<GitHubGrant> {
  const token = (await deps.readSecretFile(patFile)).trim();
  if (!token) throw new Error('The personal access token file is empty.');
  if (BROAD_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    throw new Error('That token is a classic or OAuth token, which reaches every repository you can. Make a fine-grained token for just this repository (see docs/RUNPANE_CLOUD.md, "GitHub access"), or use the deploy key default.');
  }
  // The token must see the repository before it goes anywhere.
  const repo = (await deps.github.api(token).getRepo(repoSpec)).fullName;
  const staged = `${STAGE_DIR}/gh-pat-${randomBytes(6).toString('hex')}`;
  await handle.writeFile(staged, `${token}\n`);
  await runChecked(handle, installPatScript(repo, staged), 'Installing the token');
  const grant: GitHubGrant = { repo, mode: 'pat', connectedAt: new Date(deps.now()).toISOString() };
  record.meta.github = [...(record.meta.github ?? []).filter((existing) => existing.repo !== repo), grant];
  await deps.store.writeHost(record);
  try {
    await runChecked(handle, verifyScript(`https://github.com/${repo}.git`), `Reading ${repo} with the token`, 150);
  } catch (error) {
    await handle.runScript(removePatScript(repo), { timeoutSeconds: 60 }).catch(() => undefined);
    record.meta.github = (record.meta.github ?? []).filter((existing) => existing !== grant);
    if (record.meta.github.length === 0) delete record.meta.github;
    await deps.store.writeHost(record);
    throw error;
  }
  return grant;
}

/**
 * Deletes every deploy key a Session holds on GitHub (for destroy and failed creates). Never throws:
 * a key it can't delete is reported with the command that deletes it, and its grant stays in the
 * saved record (deleted ones leave it), so the caller can stop before removing the Session and a
 * retry deletes only what is left.
 */
export async function revokeGitHubGrants(record: CloudHostRecord, deps: CloudDeps): Promise<{ deletedKeys: string[]; failed: string[]; pats: string[] }> {
  const deletedKeys: string[] = [];
  const failed: string[] = [];
  const pats: string[] = [];
  const deleted = new Set<GitHubGrant>();
  for (const grant of record.meta.github ?? []) {
    if (grant.mode === 'pat') {
      pats.push(grant.repo);
      continue;
    }
    if (grant.keyId === undefined) continue;
    try {
      const api = deps.github.api(await deps.github.resolveToken(grant.tokenSource ?? { kind: 'gh' }));
      await api.deleteDeployKey(grant.repo, grant.keyId);
      deletedKeys.push(`${grant.repo}#${grant.keyId}`);
      deleted.add(grant);
    } catch (error) {
      failed.push(`${grant.repo}#${grant.keyId}`);
      deps.stderr(`runpane cloud: could not delete deploy key ${grant.keyId} on ${grant.repo} (${error instanceof Error ? error.message : String(error)}); delete it with: gh api -X DELETE repos/${grant.repo}/keys/${grant.keyId}`);
    }
  }
  if (deleted.size > 0) {
    record.meta.github = (record.meta.github ?? []).filter((grant) => !deleted.has(grant));
    if (record.meta.github.length === 0) delete record.meta.github;
    await deps.store.writeHost(record);
  }
  return { deletedKeys, failed, pats };
}

// ---------------------------------------------------------------- github connect|disconnect|list

export async function runGitHubCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    deps.stdout(GITHUB_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub === 'connect') return githubConnect(rest, deps);
  if (sub === 'disconnect') return githubDisconnect(rest, deps);
  if (sub === 'list') return githubList(rest, deps);
  throw new Error(`Unknown command: runpane cloud github ${sub}\n\n${GITHUB_USAGE}`);
}

function oneHost(flags: Flags, usage: string): string {
  if (flags.positionals.length !== 1) throw new Error(usage);
  return flags.positionals[0];
}

async function githubConnect(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const flags = parseFlags(argv, ['--repo', '--token-file', '--pat-file'], ['--read-write', '--broker', '--json'], GITHUB_USAGE);
  const record = findHost(await deps.store.listHosts(), oneHost(flags, GITHUB_USAGE));
  const repoSpec = flags.values.get('--repo');
  if (!repoSpec) throw new Error(`runpane cloud github connect needs --repo <owner/name>.\n\n${GITHUB_USAGE}`);
  const repo = parseRepoSpec(repoSpec);
  if (flags.booleans.has('--broker')) return brokerConnect(record, repo, flags, deps);
  const patFile = flags.values.get('--pat-file');
  const readWrite = flags.booleans.has('--read-write');
  if (patFile && (readWrite || flags.values.has('--token-file'))) {
    throw new Error('--pat-file stands alone: the token decides what the Session may do, and no laptop credential is used.');
  }
  const json = flags.booleans.has('--json');
  const host = record.profile.cloud.hostname;
  const existing = record.meta.github?.find((grant) => grant.repo.toLowerCase() === repo.toLowerCase());
  if (existing) throw new Error(`${host} is already connected to ${existing.repo} (${existing.mode}). Run runpane cloud github disconnect ${host} --repo ${existing.repo} first.`);

  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const handle = await requireRunning(record, provider);
  const progress = (line: string) => (json ? deps.stderr(`  - ${line}`) : deps.stdout(`  - ${line}`));
  if (readWrite) deps.stderr(`runpane cloud: --read-write lets anything in ${host} push to any branch of ${repo}, including its default branch. Prefer the read-only default and runpane cloud git push.`);

  const grant = patFile
    ? await connectPat(record, handle, deps, repo, patFile)
    : await connectDeployKey(record, handle, deps, { repo, readWrite, tokenSource: tokenSourceFrom(flags.values.get('--token-file')), onStep: progress });
  const cloneUrl = grant.mode === 'pat' ? `https://github.com/${grant.repo}.git` : deployKeyCloneUrl(grant.repo);
  if (json) {
    deps.stdout(JSON.stringify({ ok: true, host, grant: grantJson(grant), cloneUrl }, null, 2));
  } else {
    deps.stdout(`${host} can now ${grant.mode === 'pat' ? 'use your token for' : grant.readOnly ? 'read' : 'read and push to'} ${grant.repo}.`);
    deps.stdout(`  inside it: git clone ${cloneUrl}`);
    if (grant.mode === 'deploy-key' && grant.readOnly) deps.stdout(`  to publish work: runpane cloud git push ${host} --path <dir> --branch <branch>`);
  }
  return 0;
}

async function githubDisconnect(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const flags = parseFlags(argv, ['--repo', '--token-file'], ['--broker', '--json'], GITHUB_USAGE);
  const record = findHost(await deps.store.listHosts(), oneHost(flags, GITHUB_USAGE));
  if (flags.booleans.has('--broker')) return brokerDisconnect(record, flags, deps);
  const host = record.profile.cloud.hostname;
  const grants = record.meta.github ?? [];
  const repoSpec = flags.values.get('--repo');
  const wanted = repoSpec ? parseRepoSpec(repoSpec).toLowerCase() : undefined;
  const matches = wanted ? grants.filter((grant) => grant.repo.toLowerCase() === wanted) : grants;
  if (matches.length === 0) throw new Error(`${host} has no GitHub connection${repoSpec ? ` to ${repoSpec}` : ''}. See runpane cloud github list.`);
  if (matches.length > 1) throw new Error(`${host} is connected to ${matches.map((grant) => grant.repo).join(', ')}; name one with --repo.`);
  const grant = matches[0];

  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const sandbox = await provider.get(record.profile.cloud.sandboxId);
  const running = sandbox.state === 'running';
  let keyDeleted: boolean | null = null;
  if (grant.mode === 'deploy-key') {
    if (grant.keyId !== undefined) {
      const tokenFile = flags.values.get('--token-file');
      const api = deps.github.api(await deps.github.resolveToken(tokenFile !== undefined ? tokenSourceFrom(tokenFile) : grant.tokenSource ?? { kind: 'gh' }));
      keyDeleted = await api.deleteDeployKey(grant.repo, grant.keyId);
      if (await api.getDeployKey(grant.repo, grant.keyId)) throw new Error(`GitHub still lists deploy key ${grant.keyId} on ${grant.repo}.`);
    }
  } else if (!running) {
    throw new Error(`${host} is ${sandbox.providerState}: the token file lives in it. Wake it (runpane cloud wake ${host}) and retry, or destroy the Session.`);
  }
  let sandboxCleaned = false;
  if (running) {
    const script = grant.mode === 'pat' ? removePatScript(grant.repo) : removeDeployKeyScript(grant.repo);
    await runChecked(provider.handle(record.profile.cloud.sandboxId), script, 'Removing the credential');
    sandboxCleaned = true;
  }
  record.meta.github = grants.filter((candidate) => candidate !== grant);
  if (record.meta.github.length === 0) delete record.meta.github;
  await deps.store.writeHost(record);

  const json: JsonObject = { ok: true, host, repo: grant.repo, mode: grant.mode, sandboxCleaned };
  if (grant.keyId !== undefined) json.keyId = grant.keyId;
  if (keyDeleted !== null) json.keyDeleted = keyDeleted;
  const lines = [grant.mode === 'deploy-key'
    ? `${host} is disconnected from ${grant.repo}: deploy key ${String(grant.keyId)} ${keyDeleted === false ? 'was already gone' : 'is deleted'} on GitHub${sandboxCleaned ? ' and removed from the Session' : ` (${host} is asleep; its now-useless key file stays on its disk)`}.`
    : `${host} is disconnected from ${grant.repo}: the token file is shredded. The token itself still works until you delete it at https://github.com/settings/personal-access-tokens.`];
  deps.stdout(flags.booleans.has('--json') ? JSON.stringify(json, null, 2) : lines.join('\n'));
  return 0;
}

async function githubList(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const flags = parseFlags(argv, [], ['--json'], GITHUB_USAGE);
  if (flags.positionals.length > 1) throw new Error(GITHUB_USAGE);
  const records = await deps.store.listHosts();
  const only = flags.positionals[0] ? findHost(records, flags.positionals[0]).profile.cloud.hostname : undefined;
  const selected = records.filter((record) => !only || record.profile.cloud.hostname === only);
  const rows = selected.flatMap((record) => (record.meta.github ?? []).map((grant) => ({ host: record.profile.cloud.hostname, grant })));
  const brokerRows = selected.flatMap((record) => (record.meta.brokerRepos ?? []).map((repo) => ({
    host: record.profile.cloud.hostname, repo, mode: record.meta.brokerMode ?? 'app',
  })));
  if (flags.booleans.has('--json')) {
    deps.stdout(JSON.stringify({ ok: true, grants: rows.map((row) => ({ host: row.host, ...grantJson(row.grant) })), broker: brokerRows }, null, 2));
  } else if (rows.length === 0 && brokerRows.length === 0) {
    deps.stdout('No GitHub connections. Add one with runpane cloud github connect <host> --repo <owner/name> [--broker].');
  } else {
    for (const { host, grant } of rows) {
      const access = grant.mode === 'pat' ? 'personal access token' : `deploy key ${String(grant.keyId)}, ${grant.readOnly ? 'read-only' : 'read-write'}`;
      deps.stdout(`${host} -> ${grant.repo}  (${access}, since ${grant.connectedAt})`);
    }
    for (const row of brokerRows) {
      deps.stdout(`${row.host} -> ${row.repo}  (coordinator broker, ${row.mode === 'app' ? 'GitHub App' : 'fine-grained token'}: push to cloud/${row.host}/*, draft PRs, issues)`);
    }
  }
  return 0;
}

function grantJson(grant: GitHubGrant): JsonObject {
  const json: JsonObject = { repo: grant.repo, mode: grant.mode, connectedAt: grant.connectedAt };
  if (grant.readOnly !== undefined) json.readOnly = grant.readOnly;
  if (grant.sshAlias) json.sshAlias = grant.sshAlias;
  if (grant.keyId !== undefined) json.keyId = grant.keyId;
  if (grant.fingerprint) json.fingerprint = grant.fingerprint;
  return json;
}

// ---------------------------------------------------------------- the coordinator's broker

/** The broker's answer for `repo`, or an error saying what to do; `--broker` and `new --github` share it. */
async function requireBroker(deps: CloudDeps, repo: string): Promise<CoordinatorGitHubStatus & { mode: 'app' | 'pat' }> {
  const status = await readBrokerStatus(deps);
  if ('unavailable' in status) throw new Error(`The coordinator's GitHub broker can't be asked: ${status.unavailable}.`);
  if (status.mode === 'off') {
    throw new Error('The coordinator\'s GitHub broker is off. Give it a GitHub App or fine-grained token first: runpane cloud coordinator github set --app-id <id> --private-key-file <pem> (or --pat-file <file>).');
  }
  if (!brokerReaches(status, repo)) {
    throw new Error(`The broker's ${status.mode === 'app' ? 'GitHub App' : 'token'} does not reach ${repo} (it reaches ${status.repos.join(', ')}). Install the App on it, or use a token that covers it.`);
  }
  return { ...status, mode: status.mode };
}

async function brokerConnect(record: CloudHostRecord, repo: string, flags: Flags, deps: CloudDeps): Promise<number> {
  if (flags.values.has('--pat-file') || flags.booleans.has('--read-write')) {
    throw new Error('--broker keeps GitHub write access on the coordinator: it does not combine with --pat-file or --read-write.');
  }
  const host = record.profile.cloud.hostname;
  const json = flags.booleans.has('--json');
  const progress = (line: string) => (json ? deps.stderr(`  - ${line}`) : deps.stdout(`  - ${line}`));
  const status = await requireBroker(deps, repo);
  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const handle = await requireRunning(record, provider);
  // PAT mode can't mint read tokens: the Session reads over a read-only deploy key.
  let deployKey: GitHubGrant | undefined = record.meta.github?.find((grant) => grant.repo.toLowerCase() === repo.toLowerCase());
  if (status.mode === 'pat' && !deployKey) {
    deployKey = await connectDeployKey(record, handle, deps, { repo, readWrite: false, tokenSource: tokenSourceFrom(flags.values.get('--token-file')), onStep: progress });
  }
  const enabled = await enableBroker(record, handle, deps, { repo: deployKey?.repo ?? repo, mode: status.mode });
  const cloneUrl = status.mode === 'app' ? `https://github.com/${repo}.git` : deployKeyCloneUrl(deployKey?.repo ?? repo);
  if (json && enabled.shimWarning) deps.stderr(`runpane cloud: ${enabled.shimWarning}`);
  if (json) {
    deps.stdout(JSON.stringify({ ok: true, host, repo, broker: { mode: status.mode, repos: enabled.grant.repos }, directory: enabled.directory, peersFile: enabled.peersFile, shimReady: enabled.shimWarning === null, cloneUrl }, null, 2));
  } else {
    deps.stdout(`${host} can now push to cloud/${host}/* on ${repo}, and open draft pull requests and issues there, through the coordinator (${status.mode === 'app' ? 'GitHub App' : 'fine-grained token'}).`);
    deps.stdout(`  inside it: gh pr create ... / runpane cloud agent github push; git clone ${cloneUrl}`);
    if (!enabled.directory.pushed) deps.stderr(`runpane cloud: the coordinator's directory was not updated (${enabled.directory.reason}); run runpane cloud sync.`);
    if (enabled.shimWarning) deps.stderr(`runpane cloud: ${enabled.shimWarning}`);
    if (enabled.peersFile.written === false) deps.stderr(`runpane cloud: ${host}'s peers list was not written (${String(enabled.peersFile.reason)}); the Session can't reach the coordinator until it is.`);
  }
  return 0;
}

async function brokerDisconnect(record: CloudHostRecord, flags: Flags, deps: CloudDeps): Promise<number> {
  const host = record.profile.cloud.hostname;
  const repos = record.meta.brokerRepos ?? [];
  const repoSpec = flags.values.get('--repo');
  const wanted = repoSpec ? parseRepoSpec(repoSpec) : repos.length === 1 ? repos[0] : undefined;
  if (!wanted) throw new Error(repos.length === 0 ? `${host} has no broker access. See runpane cloud github list.` : `${host} uses the broker for ${repos.join(', ')}; name one with --repo.`);
  if (!repos.some((repo) => repo.toLowerCase() === wanted.toLowerCase())) throw new Error(`${host} has no broker access to ${wanted}.`);
  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const sandbox = await provider.get(record.profile.cloud.sandboxId);
  const handle = sandbox.state === 'running' ? provider.handle(record.profile.cloud.sandboxId) : null;
  const result = await disableBroker(record, handle, deps, wanted);
  if (flags.booleans.has('--json')) {
    deps.stdout(JSON.stringify({ ok: true, host, repo: wanted, remaining: result.remaining, directory: result.directory, toolsRemoved: result.toolsRemoved }, null, 2));
  } else {
    deps.stdout(`${host} may no longer publish to ${wanted} through the coordinator${result.directory.pushed ? '' : ` (the directory was not updated: ${result.directory.reason}; run runpane cloud sync)`}.`);
    if (!handle) deps.stdout(`  ${host} is asleep: its gh shim stays until the next connect or disconnect while it is awake; the coordinator already refuses it.`);
  }
  return 0;
}

/** App mode's clone for `new --github`: over https with the helper, once the coordinator knows the Session. */
export async function cloneThroughBroker(handle: SandboxHandle, repo: string, ref: string | undefined, dir: string): Promise<string> {
  const stdout = await runChecked(handle, brokerCloneScript(repo, ref, dir), `Cloning ${repo} with the broker's read token`, 600);
  return markerLines(stdout, 'RP_HEAD')[0] ?? '';
}

// ---------------------------------------------------------------- git push

export async function runGitCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    deps.stdout(GIT_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'push') throw new Error(`Unknown command: runpane cloud git ${sub}\n\n${GIT_USAGE}`);
  return gitPush(rest, deps);
}

async function gitPush(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const flags = parseFlags(argv, ['--path', '--branch', '--repo', '--prefix', '--token-file'], ['--force', '--json'], GIT_USAGE);
  const record = findHost(await deps.store.listHosts(), oneHost(flags, GIT_USAGE));
  const host = record.profile.cloud.hostname;
  const dirArg = flags.values.get('--path');
  const branch = flags.values.get('--branch');
  if (!dirArg || !branch) throw new Error(`runpane cloud git push needs --path and --branch.\n\n${GIT_USAGE}`);
  const prefix = flags.values.get('--prefix') ?? `cloud/${host}/`;
  // Structural checks before touching anything; the default branch is checked once GitHub names it.
  mediatedPushTarget(prefix, branch, '');
  const dir = dirArg.startsWith('/') ? dirArg : `/home/user/${dirArg}`;
  const json = flags.booleans.has('--json');
  const progress = (line: string) => (json ? deps.stderr(`  - ${line}`) : deps.stdout(`  - ${line}`));

  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const handle = await requireRunning(record, provider);
  const xfer = `${XFER_DIR}/${randomBytes(6).toString('hex')}`;
  try {
    const bundle = decodeBoundary(
      JSON.parse(markerLines(await runChecked(handle, bundleScript(dir, branch, xfer), `Bundling ${branch}`, 600), 'RP_BUNDLE')[0] ?? 'null'),
      bundleSchema,
    );
    const repoSpec = flags.values.get('--repo') ?? bundle.origin;
    if (!repoSpec) throw new Error(`${dir} in ${host} has no origin remote; name the repository with --repo <owner/name>.`);
    const repo = parseRepoSpec(repoSpec);
    const token = await deps.github.resolveToken(tokenSourceFrom(flags.values.get('--token-file')));
    const api: GitHubApi = deps.github.api(token);
    const info = await api.getRepo(repo);
    const target = mediatedPushTarget(prefix, branch, info.defaultBranch);
    progress(`${branch} is ${bundle.head.slice(0, 12)}: ${bundle.commits} commit${bundle.commits === 1 ? '' : 's'} GitHub may not have (bundle ${bundle.size} bytes)`);

    let data: Buffer | undefined;
    if (bundle.parts.length > 0) {
      const chunks: Buffer[] = [];
      for (const part of bundle.parts) chunks.push(await provider.readFile(record.profile.cloud.sandboxId, `${xfer}/${part}`));
      data = Buffer.concat(chunks);
      const sum = createHash('sha256').update(data).digest('hex');
      if (data.length !== bundle.size || sum !== bundle.sha256) throw new Error(`The bundle arrived damaged (${data.length} of ${bundle.size} bytes, sha256 ${sum.slice(0, 12)}).`);
    }
    const outcome = await deps.github.pushBundle({
      repo: info.fullName,
      token,
      bundle: data,
      bundleRef: `refs/heads/${branch}`,
      head: bundle.head,
      prerequisites: data ? bundle.prerequisites : [bundle.head],
      targetRef: `refs/heads/${target}`,
      force: flags.booleans.has('--force'),
    });
    const compareUrl = `https://github.com/${info.fullName}/compare/${encodeURIComponent(info.defaultBranch)}...${target.split('/').map(encodeURIComponent).join('/')}`;
    if (json) {
      deps.stdout(JSON.stringify({ ok: true, host, repo: info.fullName, branch, target, head: bundle.head, outcome, bundleBytes: bundle.size, compareUrl }, null, 2));
    } else {
      deps.stdout(`Pushed ${host}:${dir} ${branch} (${bundle.head.slice(0, 12)}) to ${info.fullName} ${target} (${outcome}).`);
      deps.stdout(`  compare: ${compareUrl}`);
    }
    return 0;
  } finally {
    await handle.runScript(`rm -rf ${xfer}`, { timeoutSeconds: 60 }).catch(() => undefined);
  }
}
