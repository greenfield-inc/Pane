import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrokerError, isSha, parseBundleHeader, REFUSED_PATH_PREFIXES, refusedPaths } from './policy';

/**
 * The broker's git side of `POST /cloud/github/push`. It keeps one blobless (commits and trees only)
 * mirror of each repository's default branch under the state dir, so it can compute the merge base
 * of the Session's head with the default branch and refuse any change under `.github/workflows/` or
 * `.github/actions/` between them before anything reaches GitHub. The token reaches git only through
 * the environment of an inline credential helper, never argv, a remote URL or the repository's config.
 *
 * Not reusing the laptop's `githubApi.ts pushBundle`: that one fetches the prerequisites shallowly
 * into a throwaway repository, which has no history to find a merge base in.
 */

type PushOutcome = 'created' | 'fast-forward' | 'forced' | 'up-to-date';

interface PushRequest {
  /** owner/name */
  repo: string;
  /** e.g. https://github.com/owner/name.git */
  remoteUrl: string;
  token: string;
  defaultBranch: string;
  /** The Session's git bundle (exactly one ref); null when GitHub already has `sha`. */
  bundle: Buffer | null;
  /** Expected head; required without a bundle. */
  sha: string | null;
  /** refs/heads/cloud/<host>/<branch> */
  targetRef: string;
  force: boolean;
}

interface PushResult {
  sha: string;
  outcome: PushOutcome;
  mergeBase: string | null;
  changedFiles: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

export class GitPusher {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly cacheDir: string, private readonly gitBin = 'git') {}

  /** Pushes to one repository at a time (the mirror is shared); other repositories run in parallel. */
  push(request: PushRequest): Promise<PushResult> {
    const key = request.repo.toLowerCase();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.pushNow(request));
    this.queues.set(key, next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => undefined));
    return next;
  }

  private git(dir: string, token: string, args: string[]): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: os.tmpdir(),
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      RUNPANE_BROKER_TOKEN: token,
    };
    const full = [
      '-c', 'credential.helper=',
      '-c', 'credential.helper=!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$RUNPANE_BROKER_TOKEN"; }; f',
      '-c', 'transfer.fsckObjects=true',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.version=2',
      ...args,
    ];
    return new Promise((resolve) => {
      const child = spawn(this.gitBin, full, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
      const finish = (code: number, extra = '') => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: scrub(`${Buffer.concat(err).toString('utf8')}${extra}`, token) });
      };
      child.on('error', (error) => finish(127, error.message));
      child.on('close', (code) => finish(code ?? 1));
    });
  }

  private async must(dir: string, token: string, args: string[], what: string): Promise<string> {
    const result = await this.git(dir, token, args);
    if (result.code !== 0) throw new GitStepError(what, result.stderr);
    return result.stdout;
  }

  private repoDir(repo: string): string {
    return path.join(this.cacheDir, `${repo.toLowerCase().replace('/', '__')}.git`);
  }

  private async prepareMirror(request: PushRequest): Promise<string> {
    const dir = this.repoDir(request.repo);
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    try {
      await fs.access(path.join(dir, 'HEAD'));
    } catch {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this.must(dir, request.token, ['init', '-q', '--bare', '.'], 'init');
    }
    await this.must(dir, request.token, ['config', 'remote.origin.url', request.remoteUrl], 'config');
    const branch = request.defaultBranch;
    // Blobless: commits and trees are enough to find the merge base and list changed paths.
    await this.must(dir, request.token, ['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], `fetch ${branch}`);
    return dir;
  }

  private async pushNow(request: PushRequest): Promise<PushResult> {
    let dir: string;
    try {
      dir = await this.prepareMirror(request);
    } catch (error) {
      if (!(error instanceof GitStepError)) throw error;
      if (error.step === 'config') throw stepFailure(error);
      // A damaged mirror is only a cache: rebuild it once.
      await fs.rm(this.repoDir(request.repo), { recursive: true, force: true });
      try {
        dir = await this.prepareMirror(request);
      } catch (retryError) {
        throw retryError instanceof GitStepError ? stepFailure(retryError) : retryError;
      }
    }
    const incoming = `refs/runpane/incoming-${randomBytes(6).toString('hex')}`;
    const bundleFile = path.join(this.cacheDir, `${path.basename(incoming)}.bundle`);
    try {
      const head = await this.importHead(dir, request, incoming, bundleFile);
      const defaultRef = `refs/remotes/origin/${request.defaultBranch}`;
      const base = await this.git(dir, request.token, ['merge-base', head, defaultRef]);
      const mergeBase = base.code === 0 ? base.stdout.trim() : null;
      const listed = mergeBase
        ? await this.must(dir, request.token, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', mergeBase, head], 'diff')
        : await this.must(dir, request.token, ['ls-tree', '-r', '--name-only', '-z', head], 'ls-tree');
      const changed = listed.split('\0').filter(Boolean);
      const refused = refusedPaths(changed);
      if (refused.length > 0) {
        throw new BrokerError('workflow-change-refused', `the push changes ${refused.length} file(s) under ${REFUSED_PATH_PREFIXES.join(' or ')} relative to ${mergeBase ? `the merge base ${mergeBase.slice(0, 12)} with ${request.defaultBranch}` : 'an empty tree (no merge base)'}: ${refused.slice(0, 5).join(', ')}`);
      }
      const outcome = await this.pushHead(dir, request, head);
      return { sha: head, outcome, mergeBase, changedFiles: changed.length };
    } finally {
      await this.git(dir, request.token, ['update-ref', '-d', incoming]);
      await fs.rm(bundleFile, { force: true });
    }
  }

  private async ensureCommit(dir: string, request: PushRequest, sha: string, why: string): Promise<void> {
    const present = await this.git(dir, request.token, ['cat-file', '-e', `${sha}^{commit}`]);
    if (present.code === 0) return;
    const fetched = await this.git(dir, request.token, ['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', sha]);
    if (fetched.code !== 0) {
      throw new BrokerError('bad-request', `${why} ${sha.slice(0, 12)}, which ${request.repo} does not have. Fetch origin and bundle again.`);
    }
  }

  private async importHead(dir: string, request: PushRequest, incoming: string, bundleFile: string): Promise<string> {
    if (!request.bundle) {
      if (!request.sha || !isSha(request.sha)) throw new BrokerError('bad-request', 'a push without a bundle needs the 40-hex sha GitHub already has');
      await this.ensureCommit(dir, request, request.sha, 'the push names commit');
      return request.sha;
    }
    const header = parseBundleHeader(request.bundle);
    if (header.refs.length !== 1) throw new BrokerError('bad-request', `the bundle must hold exactly one ref (it holds ${header.refs.length})`);
    const [ref] = header.refs;
    if (request.sha && request.sha !== ref.sha) throw new BrokerError('bad-request', `the bundle's ref is ${ref.sha}, not ${request.sha}`);
    for (const prerequisite of header.prerequisites) {
      await this.ensureCommit(dir, request, prerequisite, 'the bundle builds on');
    }
    await fs.writeFile(bundleFile, request.bundle, { mode: 0o600 });
    const fetched = await this.git(dir, request.token, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', bundleFile, `+${ref.name}:${incoming}`]);
    if (fetched.code !== 0) throw new BrokerError('bad-request', `the bundle could not be read: ${lastLines(fetched.stderr)}`);
    const head = (await this.must(dir, request.token, ['rev-parse', '--verify', `${incoming}^{commit}`], 'rev-parse')).trim();
    if (head !== ref.sha) throw new BrokerError('bad-request', `the bundle holds ${head}, but its header names ${ref.sha}`);
    return head;
  }

  private async pushHead(dir: string, request: PushRequest, head: string): Promise<PushOutcome> {
    const spec = `${request.force ? '+' : ''}${head}:${request.targetRef}`;
    const result = await this.git(dir, request.token, ['push', '--porcelain', 'origin', spec]);
    const line = result.stdout.split('\n').find((candidate) => candidate.includes(`:${request.targetRef}\t`)) ?? '';
    const [flag, , summary = ''] = line.split('\t');
    if (result.code === 0) {
      switch (flag) {
        case '*': return 'created';
        case '+': return 'forced';
        case '=': return 'up-to-date';
        default: return 'fast-forward';
      }
    }
    if (flag === '!' && /non-fast-forward|fetch first|stale info/iu.test(summary)) {
      throw new BrokerError('non-fast-forward', `${request.targetRef} has commits the push lacks; bundle on top of it, or push with force (allowed only in your own namespace)`);
    }
    const remote = lastLines(`${summary}\n${result.stderr}`);
    if (/workflow/iu.test(remote) && /refusing to allow/iu.test(remote)) {
      // GitHub checks every pushed commit for a credential without the workflows permission.
      throw new BrokerError('workflow-change-refused', `GitHub refused the push because a commit in it changes .github/workflows/: ${remote}`, { status: 0, message: remote });
    }
    throw new BrokerError('github-error', `GitHub refused the push: ${remote}`, { status: 0, message: remote });
  }
}

class GitStepError extends Error {
  constructor(readonly step: string, stderr: string) {
    super(`git ${step} failed: ${lastLines(stderr)}`);
    this.name = 'GitStepError';
  }
}

/** A failed fetch from GitHub, as the broker reports it (403/404 when git's message says so). */
function stepFailure(error: GitStepError): BrokerError {
  const { message } = error;
  const status = /\b403\b|denied|Authentication failed/iu.test(message) ? 403 : /\b404\b|not found/iu.test(message) ? 404 : 0;
  return new BrokerError('github-error', message, { status, message });
}

function lastLines(text: string): string {
  return text.trim().split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 600);
}

/** Git's output with the token removed, in case a helper or a remote ever echoed it. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}
