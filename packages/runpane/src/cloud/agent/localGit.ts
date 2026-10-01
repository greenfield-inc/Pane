import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRepoSpec } from '../github';

/**
 * The Session's own git checkout, read with the local git: which branch to publish, which GitHub
 * repository it belongs to, and the bundle a broker push uploads.
 */

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', (error) => reject(new Error(`git ${args[0] ?? ''} could not run: ${error.message}`)));
  // A signal leaves no exit code: count it as a failure.
  child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }));
});

async function gitText(git: GitRunner, cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await git(args, cwd);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

/** Branch names the broker accepts: `[A-Za-z0-9._/-]{1,100}`, no `..`, no leading `/` (coordinator/github/policy.ts). */
export function assertBrokerBranch(branch: string): string {
  if (!/^[A-Za-z0-9._/-]{1,100}$/u.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.startsWith('-')
    || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('//')) {
    throw new Error(`"${branch}" is not a branch name the broker accepts (letters, digits, . _ / -, at most 100, no "..").`);
  }
  return branch;
}

export async function repoRoot(git: GitRunner, dir: string): Promise<string> {
  const root = await gitText(git, dir, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error(`${dir} is not inside a git repository.`);
  return root;
}

export async function currentBranch(git: GitRunner, dir: string): Promise<string> {
  const branch = await gitText(git, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw new Error('HEAD is detached; name the branch with --branch.');
  return branch;
}

/** owner/name of the checkout's origin remote (https, deploy-key alias or plain ssh URL). */
export async function originRepo(git: GitRunner, dir: string): Promise<string> {
  const url = await gitText(git, dir, ['remote', 'get-url', 'origin']);
  if (!url) throw new Error(`${dir} has no origin remote; name the repository with --repo <owner/name>.`);
  return parseRepoSpec(url);
}

/** The default branch origin advertises (origin/HEAD), else main or master if origin has one. */
export async function defaultBranch(git: GitRunner, dir: string): Promise<string | null> {
  const head = await gitText(git, dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head?.startsWith('refs/remotes/origin/')) return head.slice('refs/remotes/origin/'.length);
  for (const candidate of ['main', 'master']) {
    if (await gitText(git, dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) return candidate;
  }
  return null;
}

interface BranchBundle {
  head: string;
  /** `origin/<default>` the bundle is cut against, or null when it carries the whole branch. */
  base: string | null;
  commits: number;
  data: Buffer;
}

/**
 * `git bundle create` of `refs/heads/<branch>` minus `origin/<default>` (the whole branch when there is no
 * merge base), so every prerequisite is a commit GitHub's default branch already has.
 */
export async function bundleBranch(git: GitRunner, dir: string, branch: string, base: string | null): Promise<BranchBundle> {
  const ref = `refs/heads/${branch}`;
  const head = await gitText(git, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!head) throw new Error(`There is no local branch ${branch}.`);
  const baseRef = base ? `refs/remotes/origin/${base}` : null;
  const hasBase = baseRef ? (await gitText(git, dir, ['merge-base', head, baseRef])) !== null : false;
  const exclusion = hasBase && baseRef ? [`^${baseRef}`] : [];
  const commits = Number(await gitText(git, dir, ['rev-list', '--count', head, ...exclusion]) ?? '0');
  if (commits === 0) {
    throw new Error(`${branch} has no commits that origin/${base ?? '<default>'} lacks; commit your work first.`);
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-bundle-'));
  try {
    const file = path.join(scratch, 'branch.bundle');
    const created = await git(['bundle', 'create', '--quiet', file, ref, ...exclusion], dir);
    if (created.code !== 0) throw new Error(`git bundle create failed: ${created.stderr.trim().split('\n').slice(-2).join(' ')}`);
    return { head, base: hasBase ? base : null, commits, data: await fs.readFile(file) };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Subject and body of the branch's newest commit (for `gh pr create --fill`). */
export async function lastCommitMessage(git: GitRunner, dir: string): Promise<{ subject: string; body: string }> {
  const subject = await gitText(git, dir, ['log', '-1', '--format=%s']) ?? '';
  const body = await gitText(git, dir, ['log', '-1', '--format=%b']) ?? '';
  return { subject, body };
}
