import type { Logger } from '../utils/logger';
import type { CommandRunner } from '../utils/commandRunner';
import {
  DEFAULT_GRAPH_LIMIT,
  GRAPH_REMOTE_ALL,
  GRAPH_REMOTE_NONE,
  MAX_GRAPH_LIMIT,
  MAX_GRAPH_REFS,
  type GitGraphNode,
  type GitRef,
  type PaneWorktreeRef,
  type RepoGitGraph,
} from '../../../shared/types/gitGraph';

/**
 * Record and field delimiters for `git log --format`.
 *
 * `%x01` separates commits and `%x00` separates fields, because both are
 * impossible in a ref name and vanishingly unlikely in a commit subject. The
 * same trick is used by `GitDiffManager.getGraphCommitHistory`.
 */
const RECORD_SEP = '\x01';
const FIELD_SEP = '\x00';
const LOG_FORMAT = '%x01%H%x00%h%x00%P%x00%s%x00%aI%x00%an%x00%ae';

export type GitGraphCommandRunner = Pick<CommandRunner, 'execAsync'>;

/** Git messages that mean "valid repo, just nothing to show". */
function isEmptyRepoError(message: string): boolean {
  return /does not have any commits yet|bad default revision|unknown revision/i.test(message);
}

function isNotARepoError(message: string): boolean {
  return /not a git repository/i.test(message);
}

/**
 * Parse `git log --format=LOG_FORMAT`. Commit subjects may contain newlines
 * after `%s` only in pathological cases, so records are split on RECORD_SEP
 * rather than by line.
 */
export function parseGraphLog(raw: string): GitGraphNode[] {
  if (!raw.trim()) return [];

  return raw
    .split(RECORD_SEP)
    .filter(record => record.trim().length > 0)
    .map(record => {
      const [hash, shortHash, parentStr, subject, authorDate, authorName, authorEmail] =
        record.replace(/\n$/, '').split(FIELD_SEP);

      return {
        hash: (hash ?? '').trim(),
        shortHash: shortHash ?? '',
        parents: parentStr ? parentStr.trim().split(' ').filter(Boolean) : [],
        subject: subject ?? '',
        authorDate: authorDate ?? '',
        authorName: authorName ?? '',
        authorEmail: (authorEmail ?? '').replace(/\n[\s\S]*$/, ''),
        refs: [],
      } satisfies GitGraphNode;
    })
    .filter(node => node.hash.length > 0);
}

/**
 * Parse `git for-each-ref --format='%(objecttype)%00%(refname)%00%(objectname)%00%(*objectname)'`.
 *
 * `%(*objectname)` is non-empty only for annotated tags, where it holds the
 * commit the tag peels to — that is the hash the graph must key on.
 */
export function parseForEachRef(raw: string, currentBranch: string | null): GitRef[] {
  const refs: GitRef[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [, refName, objectName, peeled, aheadBehind] = line.split(FIELD_SEP);
    if (!refName || !objectName) continue;

    const hash = peeled && peeled.trim() ? peeled.trim() : objectName.trim();
    // `%(ahead-behind:HEAD)` prints "3 1"; older git prints nothing at all.
    const [ahead, behind] = (aheadBehind ?? '').trim().split(/\s+/).map(Number);
    const divergence = Number.isFinite(ahead) && Number.isFinite(behind)
      ? { ahead, behind }
      : {};

    if (refName.startsWith('refs/heads/')) {
      const name = refName.slice('refs/heads/'.length);
      refs.push({ kind: 'localBranch', name, hash, isCurrent: name === currentBranch, ...divergence });
    } else if (refName.startsWith('refs/remotes/')) {
      const name = refName.slice('refs/remotes/'.length);
      // `origin/HEAD` is a symbolic alias, not a branch anyone wants to see.
      if (name.endsWith('/HEAD')) continue;
      refs.push({ kind: 'remoteBranch', name, hash, isCurrent: false, ...divergence });
    } else if (refName.startsWith('refs/tags/')) {
      refs.push({ kind: 'tag', name: refName.slice('refs/tags/'.length), hash, isCurrent: false });
    }
  }

  return refs;
}

/** A remote name git would accept — no whitespace, no glob, no ref magic. */
export function isPlainRemoteName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * A ref name safe to interpolate into a command.
 *
 * Slashes are legal (`origin/main`, `feature/x`), a leading dash is not — it
 * would be read as an option — and neither is anything the shell reacts to.
 */
export function isPlainRefName(value: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..');
}

/**
 * Decide which refs the graph covers.
 *
 * A fork's clone holds `origin` *and* `upstream`, and those are two different
 * repositories as far as the user is concerned — graphing `--all` mixed a
 * hundred `upstream/*` branches into what should be one project's history.
 * The default is therefore the repo's own remote, with everything else a
 * deliberate choice.
 */
export function resolveRemoteScope(requested: string | undefined, remotes: string[]): string {
  if (requested === GRAPH_REMOTE_NONE || requested === GRAPH_REMOTE_ALL) return requested;
  if (requested && remotes.includes(requested)) return requested;
  // Unknown or absent: prefer origin, then whatever came first, then local only.
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? GRAPH_REMOTE_NONE;
}

export class GitGraphManager {
  constructor(private logger?: Logger) {}

  /**
   * Build a repository-wide commit graph: every branch and tag, ordered by
   * date, with Pane's own worktrees resolved so the UI can highlight them.
   *
   * Returns an empty graph (never throws) for empty repos, non-repos and
   * detached HEADs — those are ordinary states the view renders as-is.
   */
  async getRepoGraph(
    projectPath: string,
    options: { limit?: number; remoteScope?: string; focusRef?: string },
    commandRunner: GitGraphCommandRunner,
    resolveWorktrees: () => Promise<PaneWorktreeRef[]>
  ): Promise<RepoGitGraph> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const remotes = await this.getRemotes(projectPath, commandRunner);
    const remoteScope = resolveRemoteScope(options.remoteScope, remotes);
    // A focused ref replaces the ref set entirely: "just this branch's history".
    const focusRef = options.focusRef
      && isPlainRefName(options.focusRef)
      && await this.isResolvableCommit(projectPath, options.focusRef, commandRunner)
      ? options.focusRef
      : undefined;

    const empty: RepoGitGraph = {
      nodes: [],
      refs: [],
      currentBranch: null,
      paneWorktrees: [],
      truncated: false,
      limit,
      remotes,
      remoteScope,
    };
    if (focusRef) empty.focusRef = focusRef;

    let nodes: GitGraphNode[];
    // Asking for one extra commit is how we detect that history continues past
    // the window.
    const refScope = focusRef
      ? focusRef
      : remoteScope === GRAPH_REMOTE_ALL
        ? '--all'
        : remoteScope === GRAPH_REMOTE_NONE
          ? '--branches --tags'
          : `--branches --tags --glob=refs/remotes/${remoteScope}`;
    const logCommand = `git log ${refScope} --date-order --format="${LOG_FORMAT}" -n ${limit + 1}`;

    try {
      nodes = parseGraphLog((await commandRunner.execAsync(logCommand, projectPath)).stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNotARepoError(message)) {
        return { ...empty, notice: 'This project directory is not a git repository.' };
      }
      if (isEmptyRepoError(message)) {
        return { ...empty, notice: 'This repository has no commits yet.' };
      }
      this.logger?.error('Failed to read repository graph log', error instanceof Error ? error : undefined);
      throw error;
    }

    const truncated = nodes.length > limit;
    if (truncated) nodes = nodes.slice(0, limit);

    if (nodes.length === 0) {
      return { ...empty, notice: 'This repository has no commits yet.' };
    }

    const currentBranch = await this.getCurrentBranch(projectPath, commandRunner);
    const { refs, refsTruncated } = await this.getRefs(projectPath, currentBranch, remoteScope, commandRunner);

    // A detached HEAD has no branch ref, so surface it as its own marker.
    if (!currentBranch) {
      const headHash = await this.getHeadHash(projectPath, commandRunner);
      if (headHash) refs.push({ kind: 'head', name: 'HEAD', hash: headHash, isCurrent: true });
    }

    const refsByHash = new Map<string, GitRef[]>();
    for (const ref of refs) {
      const bucket = refsByHash.get(ref.hash);
      if (bucket) bucket.push(ref);
      else refsByHash.set(ref.hash, [ref]);
    }
    for (const node of nodes) {
      node.refs = refsByHash.get(node.hash) ?? [];
    }

    let paneWorktrees: PaneWorktreeRef[] = [];
    try {
      paneWorktrees = await resolveWorktrees();
    } catch (error) {
      this.logger?.verbose(
        `Could not resolve worktrees for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const graph: RepoGitGraph = {
      nodes,
      refs,
      currentBranch,
      paneWorktrees,
      truncated,
      limit,
      remotes,
      remoteScope,
    };
    if (focusRef) graph.focusRef = focusRef;
    if (refsTruncated) graph.notice = `Showing the first ${MAX_GRAPH_REFS} refs.`;
    return graph;
  }

  /** Remotes configured in this clone; empty for a repo with none. */
  private async getRemotes(projectPath: string, commandRunner: GitGraphCommandRunner): Promise<string[]> {
    try {
      return (await commandRunner.execAsync('git remote', projectPath)).stdout
        .split('\n')
        .map(line => line.trim())
        .filter(name => name.length > 0 && isPlainRemoteName(name));
    } catch {
      // Not a repo, or no remotes — both are just "nothing to offer".
      return [];
    }
  }

  private async getCurrentBranch(projectPath: string, commandRunner: GitGraphCommandRunner): Promise<string | null> {
    try {
      const output = (await commandRunner.execAsync('git symbolic-ref --short -q HEAD', projectPath)).stdout.trim();
      return output || null;
    } catch {
      // Non-zero exit means a detached HEAD, which is not an error here.
      return null;
    }
  }

  private async getHeadHash(projectPath: string, commandRunner: GitGraphCommandRunner): Promise<string | null> {
    try {
      return (await commandRunner.execAsync('git rev-parse HEAD', projectPath)).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async isResolvableCommit(
    projectPath: string,
    refName: string,
    commandRunner: GitGraphCommandRunner
  ): Promise<boolean> {
    try {
      return (await commandRunner.execAsync(
        `git rev-parse --verify --quiet "${refName}^{commit}"`,
        projectPath
      )).stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async getRefs(
    projectPath: string,
    currentBranch: string | null,
    remoteScope: string,
    commandRunner: GitGraphCommandRunner
  ) {
    const scopes = remoteScope === GRAPH_REMOTE_ALL
      ? 'refs/heads refs/remotes refs/tags'
      : remoteScope === GRAPH_REMOTE_NONE
        ? 'refs/heads refs/tags'
        : `refs/heads refs/tags refs/remotes/${remoteScope}`;
    const baseFormat = '%(objecttype)%00%(refname)%00%(objectname)%00%(*objectname)';
    // `%(ahead-behind:)` needs git 2.41; older versions fail the whole command,
    // so the divergence numbers are attempted first and silently dropped.
    const formats = [`${baseFormat}%00%(ahead-behind:HEAD)`, baseFormat];

    for (const format of formats) {
      try {
        const raw = (await commandRunner.execAsync(
          `git for-each-ref --count=${MAX_GRAPH_REFS + 1} --format="${format}" ${scopes}`,
          projectPath
        )).stdout;
        const parsed = parseForEachRef(raw, currentBranch);
        const refsTruncated = parsed.length > MAX_GRAPH_REFS;
        return { refs: refsTruncated ? parsed.slice(0, MAX_GRAPH_REFS) : parsed, refsTruncated };
      } catch (error) {
        this.logger?.verbose(
          `Could not list refs for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return { refs: [], refsTruncated: false };
  }
}
