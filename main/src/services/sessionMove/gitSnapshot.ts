import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaneError, reasonOf } from '../../../../shared/paneError';

/**
 * Git plumbing for moving a Pane's worktree to another machine.
 *
 * The source records everything uncommitted as one snapshot commit without touching its index
 * or working tree: the snapshot's tree is the full working tree (untracked, non-ignored files
 * included, deletions recorded), its first parent is HEAD and its second parent is a commit
 * whose tree is the index. A bundle carries the branch and the snapshot; the target rebuilds a
 * worktree on the branch and replays the two trees so `git diff`, `git diff --cached` and the
 * untracked list match the source byte for byte. Ignored files never travel.
 */

const MAX_BUFFER = 256 * 1024 * 1024;
/** Snapshot commits are internal, so they carry a fixed identity and never need the person's config. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Pane',
  GIT_AUTHOR_EMAIL: 'pane@localhost',
  GIT_COMMITTER_NAME: 'Pane',
  GIT_COMMITTER_EMAIL: 'pane@localhost',
};

export interface Snapshot {
  /** The ref now pointing at the snapshot commit. */
  ref: string;
  /** The snapshot commit: tree = working tree, parents = [HEAD, index commit]. */
  commit: string;
  head: string;
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null;
}

export interface MoveGitErrorDetails {
  branch?: string;
  /** For ERR_MOVE_BRANCH_DIVERGED: commits the target's branch has that the incoming one lacks. */
  extraCommits?: number;
  /** For ERR_MOVE_BRANCH_CHECKED_OUT: the worktree holding the branch. */
  checkedOutAt?: string;
  /** For ERR_MOVE_BUNDLE_PREREQUISITES: the commits the repository lacks. */
  missingCommits?: string[];
}

/** A PaneError with structured facts so the caller can rewrite the wording with machine names. */
export class MoveGitError extends PaneError {
  constructor(code: string, message: string, next: string, readonly details: MoveGitErrorDetails = {}) {
    super(code, message, next);
    this.name = 'MoveGitError';
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitOptions {
  env?: Record<string, string>;
  /** Exit codes that are answers rather than failures (for example 1 from `merge-base --is-ancestor`). */
  okExitCodes?: number[];
  input?: string;
  timeoutMs?: number;
}

/** Git variables that would point a command at a different repository or index than `cwd`'s. */
const INHERITED_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

function gitEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return { ...env, ...extra };
}

function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      env: gitEnv(options.env),
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? 10 * 60_000,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const exitCode = child.exitCode ?? -1;
      if (options.okExitCodes?.includes(exitCode)) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      const reason = stderr.trim() || reasonOf(error);
      reject(new PaneError(
        'ERR_MOVE_GIT_FAILED',
        `git ${args.join(' ')} failed in ${cwd}: ${reason}. Nothing further was changed by this step.`,
        'Check the repository with `git status` there, fix what git reports, then try the move again.',
      ));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function gitOut(cwd: string, args: string[], options?: GitOptions): Promise<string> {
  return (await git(cwd, args, options)).stdout.trim();
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', ref], { okExitCodes: [1] })).exitCode === 0;
}

async function resolveCommit(cwd: string, rev: string): Promise<string> {
  return gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pane-move-index-'));
  try {
    return await work(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Copies an index file with its mtime rounded down to the second. Git trusts an entry's stat data only
 * when the entry is older than the index file, so a fresh mtime would hide same-size edits made in the
 * index's own timestamp granule; an older mtime only makes git hash a few more files. The mtime is read
 * before copying, so an index written in between can only make the copy look older than its content.
 */
async function copyIndexFile(from: string, to: string): Promise<void> {
  const seconds = Math.floor((await fs.promises.stat(from)).mtimeMs / 1000);
  await fs.promises.copyFile(from, to);
  await fs.promises.utimes(to, seconds, seconds);
}

/** Copies the worktree's real index to `copy`, or seeds `copy` from HEAD when there is no index yet. */
async function copyIndex(worktreePath: string, copy: string): Promise<void> {
  const indexPath = path.resolve(worktreePath, await gitOut(worktreePath, ['rev-parse', '--git-path', 'index']));
  if (fs.existsSync(indexPath)) await copyIndexFile(indexPath, copy);
  else await git(worktreePath, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: copy } });
}

/** The index's tree and the full working tree's tree, computed on copies of the index so the real one is never rewritten. */
async function currentTrees(worktreePath: string): Promise<{ indexTree: string; worktreeTree: string }> {
  return withTempDir(async (dir) => {
    const indexCopy = path.join(dir, 'index');
    await copyIndex(worktreePath, indexCopy);
    const unmerged = await gitOut(worktreePath, ['ls-files', '--unmerged'], { env: { GIT_INDEX_FILE: indexCopy } });
    if (unmerged) {
      throw new PaneError(
        'ERR_MOVE_UNMERGED',
        `${worktreePath} has unresolved merge conflicts, so its work can't be recorded for the move. Nothing was changed.`,
        'Resolve or abort the merge there (`git status` lists the files), then try the move again.',
      );
    }
    const indexTree = await gitOut(worktreePath, ['write-tree'], { env: { GIT_INDEX_FILE: indexCopy } });
    const worktreeIndex = path.join(dir, 'worktree-index');
    await copyIndexFile(indexCopy, worktreeIndex);
    const env = { GIT_INDEX_FILE: worktreeIndex };
    await git(worktreePath, ['add', '-A', '--', '.'], { env });
    const worktreeTree = await gitOut(worktreePath, ['write-tree'], { env });
    return { indexTree, worktreeTree };
  });
}

/**
 * Records the worktree's commits, index and working tree (untracked non-ignored files included)
 * as one commit at `ref`, like a complete `git stash create`, without changing the index or files.
 */
export async function createSnapshot(worktreePath: string, ref: string): Promise<Snapshot> {
  const head = (await git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { okExitCodes: [1] })).stdout.trim();
  if (!head) {
    throw new PaneError(
      'ERR_MOVE_UNBORN_HEAD',
      `${worktreePath} has no commits yet, so there is no branch to move. Nothing was changed.`,
      'Make a first commit in that worktree, then try the move again.',
    );
  }
  const symbolic = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [1] });
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
  const { indexTree, worktreeTree } = await currentTrees(worktreePath);
  const env = SNAPSHOT_IDENTITY;
  const indexCommit = await gitOut(worktreePath, ['commit-tree', indexTree, '-p', head, '-m', 'index'], { env });
  const commit = await gitOut(worktreePath, ['commit-tree', worktreeTree, '-p', head, '-p', indexCommit, '-m', 'pane move snapshot'], { env });
  await git(worktreePath, ['update-ref', ref, commit]);
  return { ref, commit, head, branch };
}

interface BundleHeader {
  prerequisites: string[];
  refs: Map<string, string>;
}

/** Reads the text header of a v2 or v3 bundle: capability lines, `-<oid>` prerequisites, `<oid> <ref>` lines, then a blank line. */
async function readBundleHeader(bundleFile: string): Promise<BundleHeader> {
  const handle = await fs.promises.open(bundleFile, 'r');
  const chunks: Buffer[] = [];
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
      if (Buffer.concat(chunks).includes('\n\n')) break;
    }
  } finally {
    await handle.close();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n\n');
  const lines = (end === -1 ? text : text.slice(0, end)).split('\n');
  if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) {
    throw new PaneError(
      'ERR_MOVE_BUNDLE_INVALID',
      `${bundleFile} is not a git bundle (its first line is not "# v2 git bundle" or "# v3 git bundle"). Nothing was imported.`,
      'Start the move again from the source machine so a fresh bundle is sent.',
    );
  }
  const header: BundleHeader = { prerequisites: [], refs: new Map() };
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith('@')) continue;
    if (line.startsWith('-')) {
      header.prerequisites.push(line.slice(1).split(' ')[0]);
      continue;
    }
    const space = line.indexOf(' ');
    if (space > 0) header.refs.set(line.slice(space + 1), line.slice(0, space));
  }
  return header;
}

/**
 * Writes a bundle of `refs` holding only the commits origin lacks (everything, without an origin).
 * Git leaves out a ref whose tip origin already has; importBundle recovers the branch from the snapshot.
 */
export async function createBundle(worktreePath: string, refs: string[], outFile: string): Promise<{ prerequisites: string[] }> {
  const originTips = (await gitOut(worktreePath, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/']))
    .split('\n').filter(Boolean);
  const exclusions = [...new Set(originTips)];
  const args = ['bundle', 'create', '--quiet', outFile, ...refs];
  if (exclusions.length > 0) args.push('--not', ...exclusions);
  await git(worktreePath, args);
  return { prerequisites: (await readBundleHeader(outFile)).prerequisites };
}

/**
 * Brings a bundle's branch to `<incomingPrefix>/branch` and its snapshot to `snapshotRef` (the
 * same ref name the source used) without touching refs/heads. Fetches origin first, best effort,
 * so prerequisites pushed since this clone last fetched are present.
 */
export async function importBundle(
  repoPath: string,
  bundleFile: string,
  options: { branch: string | null; snapshotRef: string; incomingPrefix: string },
): Promise<{ branchHead: string | null; snapshot: string }> {
  await git(repoPath, ['fetch', '--quiet', 'origin'], { timeoutMs: 120_000 }).catch(() => undefined);
  const header = await readBundleHeader(bundleFile);
  const verify = await git(repoPath, ['bundle', 'verify', '--quiet', bundleFile], { okExitCodes: [1, 128] });
  if (verify.exitCode !== 0) {
    const missing: string[] = [];
    for (const commit of header.prerequisites) {
      const present = await git(repoPath, ['cat-file', '-e', `${commit}^{commit}`], { okExitCodes: [1, 128] });
      if (present.exitCode !== 0) missing.push(commit);
    }
    if (missing.length > 0) {
      throw new MoveGitError(
        'ERR_MOVE_BUNDLE_PREREQUISITES',
        `The moved branch builds on ${missing.length === 1 ? 'a commit' : `${missing.length} commits`} this repository doesn't have (${missing.join(', ')}), so it can't be imported. Nothing was changed.`,
        'Fetch origin on this machine (`git fetch origin`), or push those commits from the source machine, then try the move again.',
        { missingCommits: missing },
      );
    }
    throw new PaneError(
      'ERR_MOVE_BUNDLE_INVALID',
      `git bundle verify rejected ${bundleFile}: ${verify.stderr.trim() || 'no reason given'}. Nothing was imported.`,
      'Start the move again from the source machine so a fresh bundle is sent.',
    );
  }
  if (!header.refs.has(options.snapshotRef)) {
    throw new PaneError(
      'ERR_MOVE_BUNDLE_INVALID',
      `The bundle has no ${options.snapshotRef} ref, so the uncommitted work can't be found. Nothing was imported.`,
      'Start the move again from the source machine so a fresh bundle is sent.',
    );
  }
  const incomingBranch = `${options.incomingPrefix}/branch`;
  const branchRef = options.branch ? `refs/heads/${options.branch}` : null;
  const refspecs = [`+${options.snapshotRef}:${options.snapshotRef}`];
  if (branchRef && header.refs.has(branchRef)) refspecs.push(`+${branchRef}:${incomingBranch}`);
  await git(repoPath, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundleFile, ...refspecs]);
  const snapshot = await resolveCommit(repoPath, options.snapshotRef);
  if (!branchRef) return { branchHead: null, snapshot };
  if (!header.refs.has(branchRef)) {
    // The branch tip was already on origin, so git left it out; it is HEAD, the snapshot's first parent.
    await git(repoPath, ['update-ref', incomingBranch, await resolveCommit(repoPath, `${snapshot}^1`)]);
  }
  return { branchHead: await resolveCommit(repoPath, incomingBranch), snapshot };
}

/** Worktrees of `repoPath` that have `refs/heads/<branch>` checked out. */
async function worktreesWithBranch(repoPath: string, branch: string): Promise<string[]> {
  const fields = (await git(repoPath, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0');
  const holders: string[] = [];
  let current: string | null = null;
  for (const field of fields) {
    if (field.startsWith('worktree ')) current = field.slice('worktree '.length);
    else if (field === `branch refs/heads/${branch}` && current) holders.push(current);
  }
  return holders;
}

function checkedOutError(branch: string, where: string): MoveGitError {
  return new MoveGitError(
    'ERR_MOVE_BRANCH_CHECKED_OUT',
    `branch ${branch} is checked out at ${where} there, so the moved worktree can't use it. Nothing was changed.`,
    `Switch the worktree at ${where} to another branch (or remove it), then try again.`,
    { branch, checkedOutAt: where },
  );
}

/**
 * Points `refs/heads/<branch>` at `incoming` (a ref or commit) when that loses nothing: creates
 * it, leaves an equal one, or fast-forwards one that is not checked out anywhere.
 */
export async function placeBranch(repoPath: string, branch: string, incoming: string): Promise<'created' | 'same' | 'fast-forwarded'> {
  const target = await resolveCommit(repoPath, incoming);
  const ref = `refs/heads/${branch}`;
  if (!await refExists(repoPath, ref)) {
    await git(repoPath, ['update-ref', ref, target, '']);
    return 'created';
  }
  const local = await resolveCommit(repoPath, ref);
  if (local === target) return 'same';
  const ancestor = await git(repoPath, ['merge-base', '--is-ancestor', local, target], { okExitCodes: [1] });
  if (ancestor.exitCode !== 0) {
    const extraCommits = Number(await gitOut(repoPath, ['rev-list', '--count', `${target}..${local}`]));
    throw new MoveGitError(
      'ERR_MOVE_BRANCH_DIVERGED',
      `branch ${branch} already exists there with ${extraCommits} ${extraCommits === 1 ? 'commit' : 'commits'} this machine doesn't have. Nothing was changed.`,
      `Push or delete branch ${branch} on that machine, then try again.`,
      { branch, extraCommits },
    );
  }
  const holders = await worktreesWithBranch(repoPath, branch);
  if (holders.length > 0) throw checkedOutError(branch, holders[0]);
  await git(repoPath, ['update-ref', ref, target, local]);
  return 'fast-forwarded';
}

/** Adds a worktree on `branch` (or detached at `commit`) and tracks origin's branch when origin has one. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
  commit: string,
): Promise<{ upstream: string | null }> {
  if (!branch) {
    await git(repoPath, ['worktree', 'add', '--quiet', '--detach', '--', worktreePath, commit]);
    return { upstream: null };
  }
  const holders = await worktreesWithBranch(repoPath, branch);
  if (holders.length > 0) throw checkedOutError(branch, holders[0]);
  await git(repoPath, ['worktree', 'add', '--quiet', '--', worktreePath, branch]);
  if (!await refExists(repoPath, `refs/remotes/origin/${branch}`)) return { upstream: null };
  const upstream = `origin/${branch}`;
  await git(repoPath, ['branch', '--quiet', `--set-upstream-to=${upstream}`, branch]);
  return { upstream };
}

/**
 * Replays a snapshot into a clean worktree at the snapshot's HEAD: files become the snapshot's
 * tree, then the index becomes its index commit's tree, leaving untracked files untracked.
 */
export async function applySnapshot(worktreePath: string, snapshot: string): Promise<void> {
  const changes = await gitOut(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (changes) {
    throw new PaneError(
      'ERR_MOVE_WORKTREE_NOT_CLEAN',
      `${worktreePath} already has uncommitted changes, so the moved work wasn't applied over them. Nothing was changed.`,
      'Commit, stash or discard the changes in that worktree (or pick a new path), then try again.',
    );
  }
  await git(worktreePath, ['read-tree', '-m', '-u', 'HEAD', `${snapshot}^{tree}`]);
  await git(worktreePath, ['read-tree', `${snapshot}^2^{tree}`]);
  await git(worktreePath, ['update-index', '-q', '--refresh'], { okExitCodes: [1] });
}

/** True when HEAD, the index and the full working tree are exactly what `snapshot` recorded. */
export async function snapshotMatches(worktreePath: string, snapshot: string): Promise<boolean> {
  const [head, expectedHead, expectedIndex, expectedWorktree] = await Promise.all([
    resolveCommit(worktreePath, 'HEAD'),
    resolveCommit(worktreePath, `${snapshot}^1`),
    gitOut(worktreePath, ['rev-parse', `${snapshot}^2^{tree}`]),
    gitOut(worktreePath, ['rev-parse', `${snapshot}^{tree}`]),
  ]);
  if (head !== expectedHead) return false;
  const { indexTree, worktreeTree } = await currentTrees(worktreePath);
  return indexTree === expectedIndex && worktreeTree === expectedWorktree;
}

/** Ignored entries as git reports them (a wholly ignored directory is one `dir/` entry): what a move leaves behind. */
export async function ignoredPaths(worktreePath: string): Promise<string[]> {
  const out = (await git(worktreePath, ['status', '--ignored', '--porcelain=v1', '-z'])).stdout;
  return out.split('\0').filter((entry) => entry.startsWith('!! ')).map((entry) => entry.slice(3)).sort();
}

/** Deletes every ref under `prefix` (which must start with `refs/`). */
export async function deleteRefs(repoPath: string, prefix: string): Promise<void> {
  if (!prefix.startsWith('refs/') || prefix === 'refs/' || prefix.includes('..')) {
    throw new PaneError(
      'ERR_MOVE_REF_PREFIX',
      `deleteRefs was given "${prefix}", which is not a narrow ref prefix under refs/. No refs were deleted.`,
      'Pass the move\'s own prefix, such as refs/pane-move/<id>.',
    );
  }
  const scoped = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const refs = (await gitOut(repoPath, ['for-each-ref', '--format=%(refname)', scoped])).split('\n').filter(Boolean);
  if (refs.length === 0) return;
  await git(repoPath, ['update-ref', '--stdin'], { input: refs.map((ref) => `delete ${ref}\n`).join('') });
}
