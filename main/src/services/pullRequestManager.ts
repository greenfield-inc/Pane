import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { CommandRunner } from '../utils/commandRunner';
import type { Logger } from '../utils/logger';
import { escapeShellArg } from '../utils/shellEscape';
import { escapeForBash, linuxToUNCPath, posixJoin } from '../utils/wslUtils';
import {
  PR_TEMPLATE_PATHS,
  type CreatePullRequestRequest,
  type CreatePullRequestResult,
  type ExistingPullRequest,
  type PullRequestCheck,
  type PullRequestCheckState,
  type PullRequestChecksResult,
  type BaseBranchOptions,
  type PullRequestChanges,
  type PullRequestDiff,
  type PullRequestDraft,
  type PullRequestReviewDecision,
  type PullRequestReviewer,
  type PullRequestStatus,
  type PullRequestTarget,
} from '../../../shared/types/pullRequest';
import { MAX_FILES_PER_COMMIT, type GitCommitFileChange } from '../../../shared/types/git';
import { mergeFileChanges, parseNameStatusZ, parseNumstatZ } from './gitDiffParsers';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/**
 * Opening pull requests through the GitHub CLI.
 *
 * Everything that decides *what* to send is a pure function below and tested on
 * its own; the class is the thin part that runs commands. `gh` is invoked
 * through the session's `CommandRunner`, so a WSL project uses the `gh` inside
 * the distro rather than the one on the Windows host.
 */

const GH_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Branches per API page, and how many pages are worth waiting for. */
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 5;
/** Patches beyond this are cut: a modal cannot usefully show more. */
const MAX_DIFF_BYTES = 2_000_000;

export interface CommitSummary {
  subject: string;
  body: string;
}

interface BodyFilePaths {
  writePath: string;
  ghPath: string;
}

interface DraftText {
  title: string;
  body: string;
}

interface ResolvedTargets {
  targets: PullRequestTarget[];
  defaultTarget: string;
}

export interface PullRequestFileOps {
  writeFile(path: string, contents: string): void;
  unlink(path: string): void;
}

const DEFAULT_FILE_OPS: PullRequestFileOps = {
  writeFile: (path, contents) => writeFileSync(path, contents, 'utf8'),
  unlink: path => unlinkSync(path),
};

/** Just enough of a {@link CommandRunner} to know which shell it targets. */
type ShellTarget = { wslContext?: { distribution: string } | null };

/**
 * Quote one argument for the shell that will actually run the command.
 *
 * `escapeShellArg` decides by `process.platform`, which is the wrong question
 * here. A WSL project's commands are handed to `bash -c` inside the distro even
 * though the host is Windows, and Windows-style double quotes leave `$`,
 * backticks and `\` live in bash. Git only forbids space, `~^:?*[\` and control
 * characters in a ref, so a branch named ``fix-`whoami` `` is legal — and would
 * otherwise run as a command. `wslUtils` has `escapeForBash` for exactly this,
 * with a comment saying so.
 */
export function quoteArg(target: ShellTarget, value: string): string {
  return target.wslContext ? escapeForBash(value) : escapeShellArg(value);
}

/**
 * Where the pull request body is written, and the path `gh` is given for it.
 *
 * For a WSL project `gh` runs inside the distro, so the host's `tmpdir()` — a
 * `C:\…` path on Windows — is one it cannot open, and `--body-file` fails
 * before the pull request is ever created. The file therefore goes to the
 * distro's `/tmp`, written through the UNC view Windows has of it and named to
 * `gh` as the Linux path it sees.
 */
export function resolveBodyFile(
  distribution: string | null | undefined,
  fileName: string
): BodyFilePaths {
  if (!distribution) {
    const hostPath = join(tmpdir(), fileName);
    return { writePath: hostPath, ghPath: hostPath };
  }

  const linuxPath = posixJoin('/tmp', fileName);
  return { writePath: linuxToUNCPath(linuxPath, distribution), ghPath: linuxPath };
}

/**
 * Title and body for a new pull request.
 *
 * The first commit's subject is the title — the same convention `gh pr create`
 * uses when it fills the form itself. Everything else becomes the body, with
 * the repository's template appended rather than replaced: the template asks
 * questions the commits do not answer.
 */
export function deriveDraftText(
  commits: CommitSummary[],
  template: string | null
): DraftText {
  const title = commits[0]?.subject.trim() ?? '';

  const sections: string[] = [];
  const first = commits[0]?.body.trim();
  if (first) sections.push(first);

  const rest = commits.slice(1).filter(commit => commit.subject.trim().length > 0);
  if (rest.length > 0) {
    sections.push(rest.map(commit => `- ${commit.subject.trim()}`).join('\n'));
  }

  if (template && template.trim()) sections.push(template.trim());

  return { title, body: sections.join('\n\n') };
}

/**
 * Which repositories this branch could be sent to.
 *
 * A fork has two: itself and the repository it was forked from. Contributions
 * are meant for the parent, so that is the default — sending them to your own
 * fork by accident is the mistake this ordering prevents.
 */
export function resolveTargets(repoView: {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string } | null;
  parent?: { name?: string; owner?: { login?: string }; defaultBranchRef?: { name?: string } } | null;
}): ResolvedTargets {
  const targets: PullRequestTarget[] = [];

  const parentOwner = repoView.parent?.owner?.login;
  const parentName = repoView.parent?.name;
  if (parentOwner && parentName) {
    const target: PullRequestTarget = {
      nameWithOwner: `${parentOwner}/${parentName}`,
      isParent: true,
    };
    if (repoView.parent?.defaultBranchRef?.name) {
      target.defaultBranch = repoView.parent.defaultBranchRef.name;
    }
    targets.push(target);
  }

  if (repoView.nameWithOwner) {
    const target: PullRequestTarget = {
      nameWithOwner: repoView.nameWithOwner,
      isParent: false,
    };
    if (repoView.defaultBranchRef?.name) target.defaultBranch = repoView.defaultBranchRef.name;
    targets.push(target);
  }

  return { targets, defaultTarget: targets[0]?.nameWithOwner ?? '' };
}

/**
 * Arguments for `gh pr create`, as a list.
 *
 * Returned unescaped so tests can assert the arguments themselves rather than
 * one long quoted string; the caller escapes exactly once, on the way out.
 */
export function buildCreateArgs(
  request: CreatePullRequestRequest,
  context: { branch: string; forkOwner: string | null; bodyFile: string }
): string[] {
  // A pull request that crosses repositories has to name the fork the branch
  // lives in; within one repository the bare branch name is what gh expects.
  const targetOwner = request.targetRepo.split('/')[0].toLowerCase();
  const crossRepo = Boolean(context.forkOwner) && targetOwner !== context.forkOwner?.toLowerCase();
  const head = crossRepo ? `${context.forkOwner}:${context.branch}` : context.branch;

  const args = [
    'pr', 'create',
    '--repo', request.targetRepo,
    '--base', request.baseBranch,
    '--head', head,
    '--title', request.title,
    '--body-file', context.bodyFile,
  ];
  if (request.draft) args.push('--draft');
  return args;
}

/** `gh pr create` prints the new pull request's URL, and nothing else useful. */
export function parseCreatedPullRequest(stdout: string): CreatePullRequestResult | null {
  const match = stdout.match(/https:\/\/[^\s]*\/pull\/(\d+)/);
  if (!match) return null;
  return { url: match[0], number: Number(match[1]) };
}

/** gh reports a check as a bucket (`pass`) or a raw state (`SUCCESS`). */
export function normalizeCheckState(raw: string | undefined): PullRequestCheckState {
  const value = (raw ?? '').toLowerCase();
  if (['pass', 'success', 'completed', 'neutral'].includes(value)) return 'pass';
  if (['fail', 'failure', 'failing', 'error', 'timed_out', 'action_required', 'startup_failure'].includes(value)) return 'fail';
  if (['skipping', 'skipped'].includes(value)) return 'skipped';
  if (['cancel', 'cancelled', 'canceled'].includes(value)) return 'cancelled';
  return 'pending';
}

/**
 * One state for a whole run.
 *
 * Ordered by what needs a human: a failure matters even when nine other checks
 * passed, and something still running matters more than an all-green rollup
 * that is not final yet.
 */
export function summarizeChecks(checks: PullRequestCheck[]): PullRequestChecksResult['summary'] {
  if (checks.length === 0) return 'none';
  if (checks.some(check => check.state === 'fail')) return 'fail';
  if (checks.some(check => check.state === 'pending')) return 'pending';
  if (checks.some(check => check.state === 'pass')) return 'pass';
  if (checks.some(check => check.state === 'cancelled')) return 'cancelled';
  return 'skipped';
}

/**
 * Read `gh pr view --json …`.
 *
 * Every field is treated as optional: gh omits what GitHub did not compute
 * (`mergeable` is lazy) and adds fields over time, and a review panel that
 * throws on an unexpected shape is worse than one missing a badge.
 */
export function parsePullRequestStatus(stdout: string): PullRequestStatus | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const raw = decodeBoundary(JSON.parse(trimmed), boundary.object({
    number: boundary.optional(boundary.number),
    url: boundary.optional(boundary.string),
    title: boundary.optional(boundary.string),
    state: boundary.optional(boundary.string),
    isDraft: boundary.optional(boundary.boolean),
    baseRefName: boundary.optional(boundary.string),
    headRefName: boundary.optional(boundary.string),
    headRepositoryOwner: boundary.optional(boundary.nullable(boundary.object({
      login: boundary.optional(boundary.string),
    }))),
    reviewDecision: boundary.optional(boundary.nullable(boundary.string)),
    mergeable: boundary.optional(boundary.nullable(boundary.string)),
    reviews: boundary.optional(boundary.array(boundary.object({
      author: boundary.optional(boundary.nullable(boundary.object({
        login: boundary.optional(boundary.string),
      }))),
      state: boundary.optional(boundary.string),
      submittedAt: boundary.optional(boundary.string),
    }))),
    comments: boundary.optional(boundary.array(boundary.json)),
    additions: boundary.optional(boundary.number),
    deletions: boundary.optional(boundary.number),
    changedFiles: boundary.optional(boundary.number),
  }));
  if (raw.number === undefined) return null;

  // Only the newest review per person counts — GitHub shows it that way, and a
  // "changes requested" someone later approved is not an open objection.
  const byAuthor = new Map<string, { reviewer: PullRequestReviewer; submittedAt: number }>();
  for (const review of raw.reviews ?? []) {
    const login = review?.author?.login;
    if (!login) continue;
    const parsedSubmittedAt = review.submittedAt ? Date.parse(review.submittedAt) : 0;
    const submittedAt = Number.isNaN(parsedSubmittedAt) ? 0 : parsedSubmittedAt;
    const previous = byAuthor.get(login);
    if (!previous || submittedAt >= previous.submittedAt) {
      byAuthor.set(login, {
        reviewer: { login, state: review.state ?? 'COMMENTED' },
        submittedAt,
      });
    }
  }

  const status: PullRequestStatus = {
    number: raw.number,
    url: raw.url ?? '',
    title: raw.title ?? '',
    state: (raw.state ?? 'OPEN').toUpperCase(),
    isDraft: Boolean(raw.isDraft),
    baseRefName: raw.baseRefName ?? '',
    headRefName: raw.headRefName ?? '',
    reviewDecision: normalizeReviewDecision(raw.reviewDecision),
    mergeable: (raw.mergeable ?? 'UNKNOWN').toUpperCase(),
    reviewers: Array.from(byAuthor.values(), entry => entry.reviewer),
    commentCount: Array.isArray(raw.comments) ? raw.comments.length : 0,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    fetchedAtMs: Date.now(),
  };
  if (raw.headRepositoryOwner?.login) status.headRepositoryOwner = raw.headRepositoryOwner.login;
  return status;
}

export function normalizeReviewDecision(raw: string | null | undefined): PullRequestReviewDecision {
  switch ((raw ?? '').toUpperCase()) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'REVIEW_REQUIRED': return 'review_required';
    default: return 'none';
  }
}

export function parseChecks(stdout: string): PullRequestCheck[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const rows = decodeBoundary(JSON.parse(trimmed), boundary.array(boundary.object({
    name: boundary.optional(boundary.string),
    state: boundary.optional(boundary.string),
    bucket: boundary.optional(boundary.string),
    link: boundary.optional(boundary.string),
  })));

  return rows
    .filter(row => Boolean(row?.name))
    .map(row => {
      const check: PullRequestCheck = {
        name: row.name ?? '',
        state: normalizeCheckState(row.bucket ?? row.state),
      };
      if (row.link) check.url = row.link;
      return check;
    });
}

/** Parse `git log --format=%s%x00%b%x01`. */
export function parseCommitSummaries(raw: string): CommitSummary[] {
  return raw
    .split('\x01')
    .map(record => record.trim())
    .filter(record => record.length > 0)
    .map(record => {
      const [subject, body] = record.split('\x00');
      return { subject: (subject ?? '').trim(), body: (body ?? '').trim() };
    });
}

/** Pushing goes to `origin` when it exists — the fork, in the usual setup. */
export function resolvePushRemote(remotes: string[]): string | null {
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? null;
}

/**
 * Where the GitHub CLI is when it is not on PATH.
 *
 * Pane snapshots its PATH at start-up, so a `gh` installed while the app is
 * running is invisible to it — which is exactly when people install it, having
 * just been told they need it. Rather than telling the user to restart, look
 * where the installers put it.
 */
export function ghCandidatePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    // Built with join rather than string templates: a backslash in a template
    // is an escape, and getting that wrong yields "C:\Program FilesGitHub CLI".
    const programFiles = env.ProgramFiles ?? 'C:/Program Files';
    const localAppData = env.LOCALAPPDATA ?? '';
    return [
      win32Join(programFiles, 'GitHub CLI', 'gh.exe'),
      ...(localAppData ? [win32Join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe')] : []),
    ];
  }
  return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'];
}

/** Join Windows path segments regardless of which platform is running. */
function win32Join(...segments: string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment.replace(/[\\/]+$/, '') : segment.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\');
}

/**
 * A base branch as GitHub names it.
 *
 * The session's comparison branch is a tracking ref like `origin/main`, and
 * `gh pr create --base origin/main` looks for a branch of that name — which
 * does not exist. The remote prefix has to come off.
 */
export function normalizeBaseBranch(branch: string, remotes: string[]): string {
  const trimmed = branch.trim().replace(/^refs\/heads\//, '');
  for (const remote of remotes) {
    if (trimmed.startsWith(`${remote}/`)) return trimmed.slice(remote.length + 1);
  }
  return trimmed;
}

/** Branch names from `gh api .../branches`, newest API shape or the older one. */
/**
 * Order base candidates so the useful ones are reachable without scrolling.
 *
 * A repository with hundreds of branches sorted A-Z buries `main` somewhere in
 * the middle; the branch a pull request targets is almost always the default or
 * a long-lived line, so those come first and the rest follows alphabetically.
 * Duplicates — the same name from two pages — are dropped.
 */
const LONG_LIVED_BRANCHES = ['main', 'master', 'develop', 'development', 'dev', 'release'];

export function sortBaseBranches(names: string[], defaultBranch?: string | null): string[] {
  const rank = (name: string): number => {
    if (defaultBranch && name === defaultBranch) return 0;
    const index = LONG_LIVED_BRANCHES.indexOf(name);
    if (index >= 0) return 1 + index;
    if (name.startsWith('release/') || name.startsWith('releases/')) return 50;
    return 100;
  };

  return Array.from(new Set(names)).sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.localeCompare(b);
  });
}

/**
 * Roll per-file counts up into the totals shown above the list. Binary files
 * report `null` rather than 0 and must not be counted as either.
 */
export function summarizeFileChanges(files: GitCommitFileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 }
  );
}

/**
 * Branch names from `git for-each-ref refs/remotes/<remote>`.
 *
 * `HEAD` is in there as the remote's symbolic default and is not a branch
 * anyone can target; names with a slash survive intact (`feature/x`).
 */
export function parseTrackingBranches(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(name => name.length > 0 && name !== 'HEAD');
}

export function parseBranchNames(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed);
  const stringRows = decodeOptionalBoundary(parsed, boundary.array(boundary.string));
  if (stringRows) return stringRows;

  return decodeBoundary(parsed, boundary.array(boundary.object({
    name: boundary.optional(boundary.string),
  })))
    .map(row => row.name)
    .filter((name): name is string => Boolean(name));
}

/**
 * `owner/repo` from a git remote URL, in any of the forms git accepts.
 *
 * Needed because `gh repo view` without an argument answers with the *base*
 * repository, which for a fork is the upstream one. Taking the fork's identity
 * from that would put the wrong owner in the head ref and send the pull request
 * looking for a branch that is not there.
 */
export function parseGitHubRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (!trimmed) return null;

  // https://github.com/owner/repo and ssh://git@github.com/owner/repo
  const withScheme = /^(?:https?|ssh):\/\/[^/]*github\.com\/([^/]+)\/([^/]+)/.exec(trimmed);
  if (withScheme) return `${withScheme[1]}/${withScheme[2]}`;

  // git@github.com:owner/repo
  const scpLike = /^[^@]+@[^:]*github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (scpLike) return `${scpLike[1]}/${scpLike[2]}`;

  return null;
}

export class PullRequestManager {
  /** Resolved `gh` command per execution context; see `ghCandidatePaths`. */
  private ghCommand = new Map<string, string | null>();

  constructor(
    private logger?: Logger,
    private fileOps: PullRequestFileOps = DEFAULT_FILE_OPS,
  ) {}

  /**
   * The command that runs the GitHub CLI here, or null if it is not installed.
   *
   * Tries PATH first and falls back to the standard install locations, because
   * Pane's PATH is a snapshot from start-up and `gh` is usually installed
   * after Pane has told the user it is missing.
   */
  private async resolveGh(cwd: string, commandRunner: CommandRunner): Promise<string | null> {
    const key = commandRunner.wslContext?.distribution ?? 'host';
    const cached = this.ghCommand.get(key);
    if (cached !== undefined) return cached;

    const platform = commandRunner.wslContext ? 'linux' : process.platform;
    const candidates = ['gh', ...ghCandidatePaths(platform)];

    for (const candidate of candidates) {
      try {
        await commandRunner.execAsync(`${quoteArg(commandRunner, candidate)} --version`, cwd, {
          timeout: 5000,
          silent: true,
        });
        if (candidate !== 'gh') {
          this.logger?.info(`[PullRequest] Using the GitHub CLI at ${candidate} — it is not on Pane's PATH.`);
        }
        this.ghCommand.set(key, candidate);
        return candidate;
      } catch {
        // Try the next location.
      }
    }

    this.ghCommand.set(key, null);
    return null;
  }

  /**
   * Everything the create dialog opens with.
   *
   * Deliberately one call: the branch, its commits, the target repositories, an
   * existing pull request and the repository's template all have to be on
   * screen at once, and a form that fills itself in over three round trips
   * looks broken.
   */
  async getDraft(
    worktreePath: string,
    projectPath: string,
    baseBranch: string,
    commandRunner: CommandRunner
  ): Promise<PullRequestDraft> {
    const blockers: string[] = [];
    let baseBranches: BaseBranchOptions = { all: [], local: [] };
    // `origin/main` is a tracking ref; a pull request needs the branch name.
    const base = normalizeBaseBranch(baseBranch, (await this.remotes(worktreePath, commandRunner)));

    const branch = (await this.currentBranch(worktreePath, commandRunner));
    if (!branch) blockers.push('This worktree has a detached HEAD, so there is no branch to propose.');

    const commits = branch ? (await this.commitsAhead(worktreePath, baseBranch, commandRunner)) : [];
    if (branch && commits.length === 0) {
      blockers.push(`No commits on ${branch} that ${baseBranch} does not already have.`);
    }

    const hasUncommittedChanges = (await this.hasUncommittedChanges(worktreePath, commandRunner));

    let targets: PullRequestTarget[] = [];
    let defaultTarget = '';
    let forkOwner: string | null = null;
    let existing: ExistingPullRequest | undefined;

    const gh = await this.resolveGh(worktreePath, commandRunner);
    if (!gh) {
      blockers.push('The GitHub CLI (gh) was not found. Install it from https://cli.github.com and sign in with `gh auth login`.');
    } else if (!await this.isGhAuthenticated(gh, worktreePath, commandRunner)) {
      blockers.push('The GitHub CLI is installed but not signed in. Run `gh auth login` once.');
    } else {
      const view = await this.repoView(projectPath, commandRunner, (await this.originRepo(worktreePath, commandRunner)));
      if (view) {
        const resolved = resolveTargets(view);
        targets = resolved.targets;
        defaultTarget = resolved.defaultTarget;
        forkOwner = view.nameWithOwner?.split('/')[0] ?? null;
      } else {
        blockers.push('This repository has no GitHub remote that gh recognises.');
      }

      if (branch) {
        existing = await this.findExisting(projectPath, branch, targets, forkOwner, commandRunner);
      }
      if (defaultTarget) {
        const targetDefault = targets.find(target => target.nameWithOwner === defaultTarget)?.defaultBranch;
        baseBranches = await this.listBaseBranches(defaultTarget, projectPath, commandRunner, targetDefault);
      }
    }

    const template = this.readTemplate(projectPath);
    const { title, body } = deriveDraftText(commits, template);

    const draft: PullRequestDraft = {
      branch: branch ?? '',
      baseBranch: base,
      baseBranches: baseBranches.all,
      localBaseBranches: baseBranches.local,
      title,
      body,
      commitCount: commits.length,
      hasUncommittedChanges,
      targets,
      defaultTarget,
      blockers,
    };
    if (existing) draft.existing = existing;
    return draft;
  }

  /** Push the branch, then open the pull request. */
  async create(
    request: CreatePullRequestRequest,
    worktreePath: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<CreatePullRequestResult> {
    const branch = (await this.currentBranch(worktreePath, commandRunner));
    if (!branch) throw new Error('This worktree has a detached HEAD, so there is no branch to push.');

    const remote = resolvePushRemote((await this.remotes(worktreePath, commandRunner)));
    if (!remote) throw new Error('This repository has no remote to push to.');

    const gh = await this.resolveGh(worktreePath, commandRunner);
    if (!gh) throw new Error('The GitHub CLI (gh) was not found. Install it from https://cli.github.com.');
    await this.assertBaseBranchExists(gh, request.targetRepo, request.baseBranch, projectPath, commandRunner);

    await commandRunner.execAsync(
      `git push -u ${quoteArg(commandRunner, remote)} ${quoteArg(commandRunner, branch)}`,
      worktreePath,
      { timeout: PUSH_TIMEOUT_MS }
    );

    const forkOwner = (await this.originRepo(worktreePath, commandRunner))?.split('/')[0] ?? null;

    // The body goes through a file: it is markdown with newlines, quotes and
    // backticks, and no amount of shell escaping makes that pleasant. Where the
    // file goes depends on which side of the WSL boundary gh runs on.
    const { writePath, ghPath } = resolveBodyFile(
      commandRunner.wslContext?.distribution,
      `pane-pr-${randomUUID()}.md`
    );
    this.fileOps.writeFile(writePath, request.body);

    try {
      const args = buildCreateArgs(request, { branch, forkOwner, bodyFile: ghPath });
      const command = `${quoteArg(commandRunner, gh)} ${args.map(arg => quoteArg(commandRunner, arg)).join(' ')}`;
      const { stdout } = await commandRunner.execAsync(command, worktreePath, { timeout: GH_TIMEOUT_MS });

      const created = parseCreatedPullRequest(stdout);
      if (!created) {
        throw new Error(`gh did not return a pull request URL. Output: ${stdout.trim().slice(0, 200)}`);
      }
      return created;
    } finally {
      try {
        this.fileOps.unlink(writePath);
      } catch {
        // A leftover temp file is not worth failing a created pull request over.
      }
    }
  }

  /**
   * The pull request as it stands now: state, reviews, mergeability, size.
   *
   * One `gh pr view` rather than several calls — every field here comes from
   * the same object, and the review panel wants them together or not at all.
   */
  async getStatus(
    repo: string,
    number: number,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<PullRequestStatus | null> {
    const gh = await this.resolveGh(projectPath, commandRunner);
    if (!gh) return null;

    const fields = [
      'number', 'url', 'title', 'state', 'isDraft', 'baseRefName', 'headRefName',
      'headRepositoryOwner', 'reviewDecision', 'mergeable', 'reviews', 'comments',
      'additions', 'deletions', 'changedFiles',
    ].join(',');

    try {
      const { stdout } = await commandRunner.execAsync(
        `${quoteArg(commandRunner, gh)} pr view ${number} --repo ${quoteArg(commandRunner, repo)} --json ${fields}`,
        projectPath,
        { timeout: GH_TIMEOUT_MS, silent: true }
      );
      return parsePullRequestStatus(stdout);
    } catch (error) {
      this.logger?.verbose(
        `[PullRequest] Could not read ${repo}#${number}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /** CI state for a pull request, normalised. */
  async getChecks(
    repo: string,
    number: number,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<PullRequestChecksResult> {
    const gh = await this.resolveGh(projectPath, commandRunner);
    if (!gh) return { number, checks: [], summary: 'none', fetchedAtMs: Date.now() };

    const command = `${quoteArg(commandRunner, gh)} pr checks ${number} --repo ${quoteArg(commandRunner, repo)} --json name,state,bucket,link`;

    try {
      const { stdout } = await commandRunner.execAsync(command, projectPath, {
        timeout: GH_TIMEOUT_MS,
        silent: true,
      });
      const checks = parseChecks(stdout);
      return { number, checks, summary: summarizeChecks(checks), fetchedAtMs: Date.now() };
    } catch (error) {
      // `gh pr checks` exits non-zero when checks are failing *or* when there
      // are none at all — the message tells them apart, the exit code does not.
      const message = error instanceof Error ? error.message : String(error);
      if (/no checks/i.test(message)) {
        return { number, checks: [], summary: 'none', fetchedAtMs: Date.now() };
      }

      const embedded = message.match(/\[[\s\S]*\]/);
      if (embedded) {
        const checks = parseChecks(embedded[0]);
        return { number, checks, summary: summarizeChecks(checks), fetchedAtMs: Date.now() };
      }

      this.logger?.verbose(`[PullRequest] Could not read checks for ${repo}#${number}: ${message}`);
      return { number, checks: [], summary: 'none', fetchedAtMs: Date.now() };
    }
  }

  // --- git and gh plumbing ---

  private async currentBranch(worktreePath: string, commandRunner: CommandRunner): Promise<string | null> {
    try {
      return (await commandRunner.execAsync('git branch --show-current', worktreePath, { silent: true })).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async remotes(worktreePath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      return (await commandRunner.execAsync('git remote', worktreePath, { silent: true })).stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async commitsAhead(
    worktreePath: string,
    baseBranch: string,
    commandRunner: CommandRunner
  ): Promise<CommitSummary[]> {
    // Oldest first: the first commit is the one the title comes from.
    const range = `${quoteArg(commandRunner, baseBranch)}..HEAD`;
    try {
      const raw = (await commandRunner.execAsync(`git log ${range} --reverse --format=%s%x00%b%x01`, worktreePath, { silent: true })).stdout;
      return parseCommitSummaries(raw);
    } catch {
      return [];
    }
  }

  private async hasUncommittedChanges(worktreePath: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      return (await commandRunner.execAsync('git status --porcelain', worktreePath, { silent: true })).stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private readTemplate(projectPath: string): string | null {
    for (const relative of PR_TEMPLATE_PATHS) {
      const candidate = join(projectPath, relative);
      try {
        if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
      } catch {
        // Unreadable template: fall through to the next candidate.
      }
    }
    return null;
  }

  private async isGhAuthenticated(gh: string, cwd: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      await commandRunner.execAsync(`${quoteArg(commandRunner, gh)} auth status`, cwd, { timeout: 10_000, silent: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Branches of the target repository, as candidates for the base.
   *
   * Asked of the target rather than taken from the local clone: the base has to
   * exist *there*, and a fork's branches are not the upstream's. Split in two,
   * because a busy upstream has hundreds of branches and none of them is the
   * one you meant — that one is among the handful your clone already tracks.
   */
  async listBaseBranches(
    repo: string,
    projectPath: string,
    commandRunner: CommandRunner,
    defaultBranch?: string | null
  ): Promise<BaseBranchOptions> {
    // Local knowledge first: it needs no network, and a branch pushed a minute
    // ago is in the tracking refs before anyone asks GitHub about it.
    const local = (await this.trackingBranchesFor(repo, projectPath, commandRunner));

    const gh = await this.resolveGh(projectPath, commandRunner);
    if (!gh) {
      const sorted = sortBaseBranches(local, defaultBranch);
      return { all: sorted, local: sorted };
    }

    // Paged by hand rather than with `--paginate`: this repository has hundreds
    // of branches, and waiting for every last one to fill a picker nobody
    // scrolls to the end of is not worth the round trips.
    const names: string[] = [];
    try {
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const query = `repos/${repo}/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`;
        const { stdout } = await commandRunner.execAsync(
          `${quoteArg(commandRunner, gh)} api ${quoteArg(commandRunner, query)} --jq ${quoteArg(commandRunner, '[.[].name]')}`,
          projectPath,
          { timeout: GH_TIMEOUT_MS, silent: true }
        );
        const pageNames = parseBranchNames(stdout);
        names.push(...pageNames);
        if (pageNames.length < BRANCH_PAGE_SIZE) break;
      }
    } catch (error) {
      this.logger?.verbose(
        `[PullRequest] Could not list branches of ${repo}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const all = sortBaseBranches([...names, ...local], defaultBranch);

    // The short list is the branches you *work on*, not everything you ever
    // fetched: a full fetch of a busy upstream leaves hundreds of tracking refs
    // behind, which is exactly the noise this list exists to avoid. The
    // default branch joins them because nearly every pull request targets it.
    const own = new Set((await this.localHeads(projectPath, commandRunner)));
    if (defaultBranch) own.add(defaultBranch);

    return { all, local: all.filter(name => own.has(name)) };
  }

  /** Branches that exist as heads in this clone — yours, across all worktrees. */
  private async localHeads(projectPath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      return parseTrackingBranches(
        (await commandRunner.execAsync('git for-each-ref --format=%(refname:lstrip=2) refs/heads', projectPath, { silent: true })).stdout
      );
    } catch {
      return [];
    }
  }

  /**
   * Branches this clone already tracks for the remote that *is* the given
   * repository. A fork and its upstream both have remotes here, and only the
   * matching one's branches are valid bases for a pull request into it.
   */
  private async trackingBranchesFor(repo: string, projectPath: string, commandRunner: CommandRunner): Promise<string[]> {
    for (const name of await this.remotes(projectPath, commandRunner)) {
      try {
        const { stdout: url } = await commandRunner.execAsync(`git remote get-url ${quoteArg(commandRunner, name)}`, projectPath, { silent: true });
        if (parseGitHubRemote(url)?.toLowerCase() !== repo.toLowerCase()) continue;
        const { stdout } = await commandRunner.execAsync(`git for-each-ref --format=%(refname:lstrip=3) ${quoteArg(commandRunner, `refs/remotes/${name}`)}`, projectPath, { silent: true });
        return parseTrackingBranches(stdout);
      } catch { /* Try the next remote. */ }
    }
    return [];
  }

  /**
   * Which files the pull request would carry, and by how much.
   *
   * Cheap on purpose — counts only, no patch — so the dialog can show the list
   * the moment it opens and reload it when the base changes.
   */
  async getChanges(
    worktreePath: string,
    baseBranch: string,
    commandRunner: CommandRunner
  ): Promise<PullRequestChanges> {
    const baseRef = (await this.resolveComparisonRef(worktreePath, baseBranch, commandRunner));
    const empty: PullRequestChanges = {
      baseRef, files: [], totalFiles: 0, truncated: false, additions: 0, deletions: 0,
    };
    if (!baseRef) return { ...empty, baseRef: baseBranch };

    try {
      const range = `${quoteArg(commandRunner, baseRef)}...HEAD`;
      const numstatRaw = (await commandRunner.execAsync(`git diff --numstat -M -z ${range}`, worktreePath, { silent: true })).stdout;
      const nameStatusRaw = (await commandRunner.execAsync(`git diff --name-status -M -z ${range}`, worktreePath, { silent: true })).stdout;

      const all = mergeFileChanges(parseNumstatZ(numstatRaw), parseNameStatusZ(nameStatusRaw));
      const files = all.slice(0, MAX_FILES_PER_COMMIT);
      const { additions, deletions } = summarizeFileChanges(all);

      return {
        baseRef,
        files,
        totalFiles: all.length,
        truncated: all.length > files.length,
        additions,
        deletions,
      };
    } catch (error) {
      this.logger?.verbose(
        `[PullRequest] Could not list changed files against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`
      );
      return empty;
    }
  }

  /** The patch behind {@link getChanges}, loaded only when the user asks. */
  async getDiff(
    worktreePath: string,
    baseBranch: string,
    commandRunner: CommandRunner
  ): Promise<PullRequestDiff> {
    const baseRef = (await this.resolveComparisonRef(worktreePath, baseBranch, commandRunner));
    if (!baseRef) return { baseRef: baseBranch, diff: '', truncated: false };

    const raw = (await commandRunner.execAsync(`git diff -M ${quoteArg(commandRunner, baseRef)}...HEAD`, worktreePath, { silent: true, maxBuffer: MAX_DIFF_BYTES * 2 })).stdout;

    const truncated = raw.length > MAX_DIFF_BYTES;
    return { baseRef, diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated };
  }

  /**
   * A ref git can actually compare against.
   *
   * The base is a branch name in the *target* repository. Locally it may exist
   * only as a tracking ref — a fresh worktree often has no local `main` — so the
   * remote-tracking form is tried first, and only a ref that resolves is used.
   */
  private async resolveComparisonRef(
    worktreePath: string,
    baseBranch: string,
    commandRunner: CommandRunner
  ): Promise<string> {
    const base = baseBranch.trim();
    if (!base) return '';

    const candidates = base.includes('/')
      ? [base, `refs/remotes/${base}`]
      : [`origin/${base}`, base, `upstream/${base}`];

    for (const candidate of candidates) {
      try {
        await commandRunner.execAsync(`git rev-parse --verify --quiet ${quoteArg(commandRunner, `${candidate}^{commit}`)}`, worktreePath, { silent: true });
        return candidate;
      } catch {
        // Not a ref here — try the next spelling.
      }
    }
    return '';
  }

  /** The fork this clone pushes to, as `owner/repo`. */
  private async originRepo(worktreePath: string, commandRunner: CommandRunner): Promise<string | null> {
    const remote = resolvePushRemote((await this.remotes(worktreePath, commandRunner)));
    if (!remote) return null;
    try {
      const url = (await commandRunner.execAsync(`git remote get-url ${quoteArg(commandRunner, remote)}`, worktreePath, { silent: true })).stdout;
      return parseGitHubRemote(url);
    } catch {
      return null;
    }
  }

  private async repoView(
    projectPath: string,
    commandRunner: CommandRunner,
    repo?: string | null
  ): Promise<{
    nameWithOwner?: string;
    defaultBranchRef?: { name?: string } | null;
    parent?: { name?: string; owner?: { login?: string }; defaultBranchRef?: { name?: string } } | null;
  } | null> {
    try {
      // Naming the repository matters: without it gh answers about the *base*
      // repository, which for a fork is upstream — and then the fork's own
      // identity, which the head ref needs, is nowhere in the answer.
      const gh = await this.resolveGh(projectPath, commandRunner);
      if (!gh) return null;
      const target = repo ? ` ${quoteArg(commandRunner, repo)}` : '';
      const { stdout } = await commandRunner.execAsync(
        `${quoteArg(commandRunner, gh)} repo view${target} --json nameWithOwner,defaultBranchRef,parent`,
        projectPath,
        { timeout: GH_TIMEOUT_MS, silent: true }
      );
      return JSON.parse(stdout.trim());
    } catch (error) {
      this.logger?.verbose(
        `[PullRequest] gh repo view failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private async findExisting(
    projectPath: string,
    branch: string,
    targets: PullRequestTarget[],
    forkOwner: string | null,
    commandRunner: CommandRunner
  ): Promise<ExistingPullRequest | undefined> {
    const gh = await this.resolveGh(projectPath, commandRunner);
    if (!gh) return undefined;

    for (const target of targets) {
      try {
        const targetOwner = target.nameWithOwner.split('/')[0];
        const head = forkOwner && targetOwner.toLowerCase() !== forkOwner.toLowerCase()
          ? `${forkOwner}:${branch}`
          : branch;
        const { stdout } = await commandRunner.execAsync(
          `${quoteArg(commandRunner, gh)} pr list --repo ${quoteArg(commandRunner, target.nameWithOwner)} --head ${quoteArg(commandRunner, head)} --state all --json number,url,state,title --limit 1`,
          projectPath,
          { timeout: GH_TIMEOUT_MS, silent: true }
        );
        const rows = decodeBoundary(JSON.parse(stdout.trim() || '[]'), boundary.array(boundary.object({
          number: boundary.number,
          url: boundary.string,
          state: boundary.string,
          title: boundary.string,
        })));
        if (rows[0]) return rows[0];
      } catch {
        // One inaccessible target should not hide a pull request in another.
      }
    }

    return undefined;
  }

  private async assertBaseBranchExists(
    gh: string,
    repo: string,
    branch: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<void> {
    const endpoint = `repos/${repo}/branches/${encodeURIComponent(branch)}`;
    try {
      await commandRunner.execAsync(
        `${quoteArg(commandRunner, gh)} api ${quoteArg(commandRunner, endpoint)} --silent`,
        projectPath,
        { timeout: GH_TIMEOUT_MS, silent: true }
      );
    } catch {
      throw new Error(`Base branch ${branch} was not found in ${repo}. Choose a branch that exists in the target repository.`);
    }
  }
}
