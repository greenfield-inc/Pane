import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PullRequestManager,
  ghCandidatePaths,
  normalizeBaseBranch,
  parseBranchNames,
  parseTrackingBranches,
  buildCreateArgs,
  deriveDraftText,
  normalizeCheckState,
  normalizeReviewDecision,
  parsePullRequestStatus,
  parseChecks,
  parseCommitSummaries,
  parseCreatedPullRequest,
  parseGitHubRemote,
  resolvePushRemote,
  resolveTargets,
  sortBaseBranches,
  summarizeChecks,
  summarizeFileChanges,
} from './pullRequestManager';
import type { GitCommitFileChange } from '../../../shared/types/git';
import type { CommandRunner } from '../utils/commandRunner';

describe('deriveDraftText', () => {
  it('takes the title from the first commit and the body from the rest', () => {
    const { title, body } = deriveDraftText([
      { subject: 'Add the thing', body: 'Because the other thing needed it.' },
      { subject: 'Fix a typo in the thing', body: '' },
    ], null);

    expect(title).toBe('Add the thing');
    expect(body).toContain('Because the other thing needed it.');
    expect(body).toContain('- Fix a typo in the thing');
  });

  it('appends the repository template rather than replacing the commits', () => {
    const { body } = deriveDraftText(
      [{ subject: 'Add the thing', body: 'Why.' }],
      '## Checklist\n- [ ] tests',
    );

    expect(body).toBe('Why.\n\n## Checklist\n- [ ] tests');
  });

  it('survives a repository with no commits and no template', () => {
    expect(deriveDraftText([], null)).toEqual({ title: '', body: '' });
  });
});

describe('resolveTargets', () => {
  /**
   * The whole point of the target picker: contributions from a fork are meant
   * for the parent, and picking your own fork by accident is a silent mistake.
   */
  it('offers the parent first for a fork', () => {
    const { targets, defaultTarget } = resolveTargets({
      nameWithOwner: '0x92/Pane',
      defaultBranchRef: { name: 'main' },
      parent: { name: 'Pane', owner: { login: 'dcouple' }, defaultBranchRef: { name: 'main' } },
    });

    expect(targets.map(t => t.nameWithOwner)).toEqual(['dcouple/Pane', '0x92/Pane']);
    expect(targets[0].isParent).toBe(true);
    expect(defaultTarget).toBe('dcouple/Pane');
  });

  it('offers only the repository itself when it is not a fork', () => {
    const { targets, defaultTarget } = resolveTargets({
      nameWithOwner: 'someone/thing',
      defaultBranchRef: { name: 'trunk' },
      parent: null,
    });

    expect(targets).toEqual([
      { nameWithOwner: 'someone/thing', isParent: false, defaultBranch: 'trunk' },
    ]);
    expect(defaultTarget).toBe('someone/thing');
  });
});

describe('buildCreateArgs', () => {
  const request = {
    sessionId: 's1',
    title: 'Add the thing',
    body: 'ignored — the body goes through a file',
    baseBranch: 'main',
    targetRepo: 'dcouple/Pane',
  };

  it('names the fork in the head ref when the pull request crosses repositories', () => {
    const args = buildCreateArgs(request, {
      branch: 'feature/x',
      forkOwner: '0x92',
      bodyFile: '/tmp/body.md',
    });

    expect(args).toEqual([
      'pr', 'create',
      '--repo', 'dcouple/Pane',
      '--base', 'main',
      '--head', '0x92:feature/x',
      '--title', 'Add the thing',
      '--body-file', '/tmp/body.md',
    ]);
  });

  it('uses the bare branch when staying inside one repository', () => {
    const args = buildCreateArgs(
      { ...request, targetRepo: '0x92/Pane' },
      { branch: 'feature/x', forkOwner: '0x92', bodyFile: '/tmp/body.md' },
    );

    expect(args).toContain('feature/x');
    expect(args).not.toContain('0x92:feature/x');
  });

  it('compares owners case-insensitively — GitHub does', () => {
    const args = buildCreateArgs(
      { ...request, targetRepo: '0X92/Pane' },
      { branch: 'feature/x', forkOwner: '0x92', bodyFile: '/tmp/body.md' },
    );

    expect(args).toContain('feature/x');
    expect(args).not.toContain('0x92:feature/x');
  });

  it('adds --draft only when asked', () => {
    expect(buildCreateArgs(request, { branch: 'b', forkOwner: null, bodyFile: '/tmp/b.md' }))
      .not.toContain('--draft');
    expect(buildCreateArgs({ ...request, draft: true }, { branch: 'b', forkOwner: null, bodyFile: '/tmp/b.md' }))
      .toContain('--draft');
  });

  it('never inlines the body — markdown does not survive a shell', () => {
    const args = buildCreateArgs(
      { ...request, body: 'contains `backticks` and "quotes"\nand newlines' },
      { branch: 'b', forkOwner: null, bodyFile: '/tmp/b.md' },
    );

    expect(args).toContain('--body-file');
    expect(args.join(' ')).not.toContain('backticks');
  });
});

describe('parseCreatedPullRequest', () => {
  it('reads the number and url gh prints', () => {
    expect(parseCreatedPullRequest('https://github.com/dcouple/Pane/pull/382\n')).toEqual({
      url: 'https://github.com/dcouple/Pane/pull/382',
      number: 382,
    });
  });

  it('finds the url among gh chatter', () => {
    const stdout = 'Warning: 3 uncommitted changes\nhttps://github.com/o/r/pull/7\n';
    expect(parseCreatedPullRequest(stdout)?.number).toBe(7);
  });

  it('returns null when gh printed something else entirely', () => {
    expect(parseCreatedPullRequest('aborted')).toBeNull();
  });
});

describe('check states', () => {
  it('maps gh buckets and raw states onto one vocabulary', () => {
    expect(normalizeCheckState('pass')).toBe('pass');
    expect(normalizeCheckState('SUCCESS')).toBe('pass');
    expect(normalizeCheckState('fail')).toBe('fail');
    expect(normalizeCheckState('TIMED_OUT')).toBe('fail');
    expect(normalizeCheckState('skipping')).toBe('skipped');
    expect(normalizeCheckState('cancel')).toBe('cancelled');
    expect(normalizeCheckState(undefined)).toBe('pending');
    expect(normalizeCheckState('something new')).toBe('pending');
  });

  it('prefers the bucket over the raw state', () => {
    const checks = parseChecks(JSON.stringify([
      { name: 'build', state: 'COMPLETED', bucket: 'fail', link: 'https://ci/1' },
    ]));

    expect(checks).toEqual([{ name: 'build', state: 'fail', url: 'https://ci/1' }]);
  });

  it('summarises by what needs attention first', () => {
    const check = (state: string) => ({ name: state, state: normalizeCheckState(state) });

    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks([check('pass'), check('fail'), check('pending')])).toBe('fail');
    expect(summarizeChecks([check('pass'), check('pending')])).toBe('pending');
    expect(summarizeChecks([check('pass'), check('skipping')])).toBe('pass');
    expect(summarizeChecks([check('skipping')])).toBe('skipped');
  });

  it('ignores rows without a name', () => {
    expect(parseChecks(JSON.stringify([{ bucket: 'pass' }]))).toEqual([]);
  });
});

describe('parsePullRequestStatus', () => {
  const view = {
    number: 382,
    url: 'https://github.com/dcouple/Pane/pull/382',
    title: 'Add Agent Fleet',
    state: 'open',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feature/agent-fleet',
    headRepositoryOwner: { login: '0x92' },
    reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'CONFLICTING',
    reviews: [
      { author: { login: 'parsa' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-20T10:00:00Z' },
      { author: { login: 'parsa' }, state: 'APPROVED', submittedAt: '2026-08-21T10:00:00Z' },
      { author: { login: 'someone' }, state: 'COMMENTED' },
    ],
    comments: [{}, {}],
    additions: 2599,
    deletions: 65,
    changedFiles: 23,
  };

  it('reads the fields the review panel shows', () => {
    const status = parsePullRequestStatus(JSON.stringify(view));

    expect(status).toMatchObject({
      number: 382,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feature/agent-fleet',
      headRepositoryOwner: '0x92',
      reviewDecision: 'changes_requested',
      mergeable: 'CONFLICTING',
      commentCount: 2,
      changedFiles: 23,
    });
  });

  it('keeps only the newest review per person', () => {
    // parsa asked for changes and later approved: one reviewer, approved.
    expect(parsePullRequestStatus(JSON.stringify(view))?.reviewers).toEqual([
      { login: 'parsa', state: 'APPROVED' },
      { login: 'someone', state: 'COMMENTED' },
    ]);
  });

  it('uses submission time when reviews arrive out of order', () => {
    const status = parsePullRequestStatus(JSON.stringify({
      number: 382,
      reviews: [
        { author: { login: 'parsa' }, state: 'APPROVED', submittedAt: '2026-08-21T10:00:00Z' },
        { author: { login: 'parsa' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-20T10:00:00Z' },
      ],
    }));

    expect(status?.reviewers).toEqual([{ login: 'parsa', state: 'APPROVED' }]);
  });

  it('fills in what gh left out rather than throwing', () => {
    const status = parsePullRequestStatus(JSON.stringify({ number: 7 }));

    expect(status).toMatchObject({
      number: 7,
      state: 'OPEN',
      reviewDecision: 'none',
      mergeable: 'UNKNOWN',
      reviewers: [],
      commentCount: 0,
      additions: 0,
    });
  });

  it('is null for an empty answer or one without a number', () => {
    expect(parsePullRequestStatus('')).toBeNull();
    expect(parsePullRequestStatus('{}')).toBeNull();
  });
});

describe('normalizeReviewDecision', () => {
  it('maps GitHub spellings and treats anything else as no decision', () => {
    expect(normalizeReviewDecision('APPROVED')).toBe('approved');
    expect(normalizeReviewDecision('changes_requested')).toBe('changes_requested');
    expect(normalizeReviewDecision('REVIEW_REQUIRED')).toBe('review_required');
    expect(normalizeReviewDecision(null)).toBe('none');
    expect(normalizeReviewDecision('SOMETHING_NEW')).toBe('none');
  });
});

describe('parseCommitSummaries', () => {
  it('splits subjects from bodies without tripping over blank lines', () => {
    const raw = 'First\x00Body line one\n\nBody line two\x01Second\x00\x01';
    expect(parseCommitSummaries(raw)).toEqual([
      { subject: 'First', body: 'Body line one\n\nBody line two' },
      { subject: 'Second', body: '' },
    ]);
  });

  it('returns nothing for an empty log', () => {
    expect(parseCommitSummaries('')).toEqual([]);
  });
});

describe('normalizeBaseBranch', () => {
  /**
   * `gh pr create --base origin/main` looks for a branch called
   * "origin/main" — which does not exist anywhere.
   */
  it('strips the remote prefix from a tracking ref', () => {
    expect(normalizeBaseBranch('origin/main', ['origin', 'upstream'])).toBe('main');
    expect(normalizeBaseBranch('upstream/release/2.x', ['origin', 'upstream'])).toBe('release/2.x');
  });

  it('leaves a plain branch alone', () => {
    expect(normalizeBaseBranch('main', ['origin'])).toBe('main');
    expect(normalizeBaseBranch('feature/origin-story', ['origin'])).toBe('feature/origin-story');
  });

  it('strips refs/heads/ as well', () => {
    expect(normalizeBaseBranch('refs/heads/main', [])).toBe('main');
  });
});

describe('ghCandidatePaths', () => {
  /**
   * Pane snapshots PATH at start-up, so a `gh` installed *because* Pane asked
   * for it is invisible until a restart. These are the places to look instead.
   */
  // String.raw throughout: a lone backslash in a normal literal is an escape,
  // which is exactly the mistake this test exists to catch.
  it('builds real Windows paths, separators and all', () => {
    const paths = ghCandidatePaths('win32', {
      ProgramFiles: String.raw`C:\Program Files`,
      LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`,
    } satisfies NodeJS.ProcessEnv);

    expect(paths[0]).toBe(String.raw`C:\Program Files\GitHub CLI\gh.exe`);
    expect(paths[1]).toBe(String.raw`C:\Users\me\AppData\Local\Programs\GitHub CLI\gh.exe`);
    // The bug this replaced produced "C:\Program FilesGitHub CLIgh.exe".
    for (const candidate of paths) {
      expect(candidate).not.toMatch(/FilesGitHub|LocalPrograms/);
    }
  });

  it('does not double a separator the environment already ends with', () => {
    // Not String.raw here: a template literal cannot end on a backslash.
    const paths = ghCandidatePaths('win32', { ProgramFiles: 'C:\\Program Files\\' } satisfies NodeJS.ProcessEnv);
    expect(paths[0]).toBe(String.raw`C:\Program Files\GitHub CLI\gh.exe`);
  });

  it('leaves out the user location when the environment has none', () => {
    const paths = ghCandidatePaths('win32', { ProgramFiles: String.raw`C:\Program Files` } satisfies NodeJS.ProcessEnv);
    expect(paths).toHaveLength(1);
  });

  it('covers homebrew and the usual unix prefixes', () => {
    const paths = ghCandidatePaths('darwin', {} satisfies NodeJS.ProcessEnv);
    expect(paths).toContain('/opt/homebrew/bin/gh');
    expect(paths).toContain('/usr/local/bin/gh');
  });
});

describe('parseBranchNames', () => {
  it('reads names from the api response', () => {
    expect(parseBranchNames('["main","dev"]')).toEqual(['main', 'dev']);
    expect(parseBranchNames('[{"name":"main"},{"name":"dev"}]')).toEqual(['main', 'dev']);
  });

  it('is empty rather than throwing on an empty answer', () => {
    expect(parseBranchNames('')).toEqual([]);
    expect(parseBranchNames('[]')).toEqual([]);
  });
});

describe('parseGitHubRemote', () => {
  it('reads owner/repo from every url form git accepts', () => {
    expect(parseGitHubRemote('https://github.com/0x92/Pane.git')).toBe('0x92/Pane');
    expect(parseGitHubRemote('https://github.com/0x92/Pane')).toBe('0x92/Pane');
    expect(parseGitHubRemote('git@github.com:0x92/Pane.git')).toBe('0x92/Pane');
    expect(parseGitHubRemote('ssh://git@github.com/0x92/Pane.git')).toBe('0x92/Pane');
  });

  it('ignores remotes that are not GitHub', () => {
    expect(parseGitHubRemote('https://gitlab.com/o/r.git')).toBeNull();
    expect(parseGitHubRemote('/srv/git/bare.git')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
  });
});

describe('resolvePushRemote', () => {
  it('prefers origin, which is the fork in the usual setup', () => {
    expect(resolvePushRemote(['upstream', 'origin'])).toBe('origin');
  });

  it('falls back to the only remote there is', () => {
    expect(resolvePushRemote(['fork'])).toBe('fork');
  });

  it('reports none rather than guessing', () => {
    expect(resolvePushRemote([])).toBeNull();
  });
});

/**
 * A CommandRunner whose answers are chosen by matching the command text.
 *
 * Quotes are stripped before matching: arguments are shell-escaped on the way
 * out, and on Windows that wraps even `pr` and `create` in double quotes.
 */
function stubRunner(responses: Array<[match: string, output: string | Error]>): CommandRunner {
  const pick = (command: string) => {
    const plain = command.replace(/["']/g, '');
    for (const [match, output] of responses) {
      if (plain.includes(match)) return output;
    }
    return '';
  };
  // SAFETY: The service tests exercise only the CommandRunner members supplied by this fixture.
  return {
    execAsync: vi.fn(async (command: string) => {
      const output = pick(command);
      if (output instanceof Error) throw output;
      return { stdout: output, stderr: '' };
    }),
    wslContext: null,
  } as CommandRunner;
}

describe('PullRequestManager.getDraft', () => {
  afterEach(() => vi.restoreAllMocks());

  it('blocks with a readable reason when there is nothing to propose', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git log', ''],
      ['git status --porcelain', ''],
      ['--version', 'gh version 2.97.0'],
      ['auth status', 'Logged in'],
      ['repo view', JSON.stringify({ nameWithOwner: '0x92/Pane', parent: null })],
      ['pr list', '[]'],
    ]);

    const draft = await new PullRequestManager().getDraft('/wt', '/repo', 'main', runner);

    expect(draft.commitCount).toBe(0);
    expect(draft.blockers).toContainEqual(expect.stringContaining('No commits on feature/x'));
  });

  it('says what to do when gh is missing instead of failing obscurely', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git log', 'Add it\x00Why.\x01'],
      ['--version', new Error('command not found: gh')],
    ]);

    const draft = await new PullRequestManager().getDraft('/wt', '/repo', 'main', runner);

    expect(draft.blockers.join(' ')).toMatch(/cli\.github\.com/);
    expect(draft.title).toBe('Add it');
  });

  it('distinguishes "not installed" from "not signed in"', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git log', 'Add it\x00\x01'],
      ['--version', 'gh version 2.97.0'],
      ['auth status', new Error('You are not logged into any GitHub hosts')],
    ]);

    const draft = await new PullRequestManager().getDraft('/wt', '/repo', 'main', runner);

    expect(draft.blockers.join(' ')).toMatch(/gh auth login/);
    expect(draft.blockers.join(' ')).not.toMatch(/cli\.github\.com/);
  });

  it('surfaces an existing pull request instead of offering to open a second', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git log', 'Add it\x00\x01'],
      ['git status --porcelain', ''],
      ['--version', 'gh version 2.97.0'],
      ['auth status', 'Logged in'],
      ['repo view', JSON.stringify({
        nameWithOwner: '0x92/Pane',
        parent: { name: 'Pane', owner: { login: 'dcouple' } },
      })],
      ['pr list', JSON.stringify([
        { number: 382, url: 'https://github.com/dcouple/Pane/pull/382', state: 'OPEN', title: 'Add it' },
      ])],
    ]);

    const draft = await new PullRequestManager().getDraft('/wt', '/repo', 'main', runner);

    expect(draft.existing?.number).toBe(382);
    expect(draft.defaultTarget).toBe('dcouple/Pane');
    const commands = vi.mocked(runner.execAsync).mock.calls
      .map(call => call[0].replace(/["']/g, ''));
    expect(commands).toContainEqual(expect.stringContaining(
      'pr list --repo dcouple/Pane --head 0x92:feature/x'
    ));
  });

  it('reports uncommitted work so the dialog can offer to commit first', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git log', 'Add it\x00\x01'],
      ['git status --porcelain', ' M src/thing.ts\n'],
      ['--version', 'gh version 2.97.0'],
      ['auth status', 'Logged in'],
      ['repo view', JSON.stringify({ nameWithOwner: '0x92/Pane', parent: null })],
      ['pr list', '[]'],
    ]);

    const draft = await new PullRequestManager().getDraft('/wt', '/repo', 'main', runner);
    expect(draft.hasUncommittedChanges).toBe(true);
  });
});

describe('PullRequestManager.create', () => {
  it('pushes the branch before asking gh to open anything', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git remote', 'origin\nupstream\n'],
      ['git push', ''],
      ['repo view', JSON.stringify({ nameWithOwner: '0x92/Pane' })],
      ['pr create', 'https://github.com/dcouple/Pane/pull/391\n'],
    ]);

    const result = await new PullRequestManager().create(
      {
        sessionId: 's1',
        title: 'Add it',
        body: 'Why.',
        baseBranch: 'main',
        targetRepo: 'dcouple/Pane',
      },
      '/wt', '/repo', runner,
    );

    expect(result).toEqual({ number: 391, url: 'https://github.com/dcouple/Pane/pull/391' });

    const commands = vi.mocked(runner.execAsync).mock.calls
      .map(c => c[0].replace(/["']/g, ''));
    const pushIndex = commands.findIndex(c => c.includes('git push'));
    const createIndex = commands.findIndex(c => c.includes('gh pr create'));
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(pushIndex);
    expect(commands[pushIndex]).toContain('-u');
  });

  it('fails loudly when gh returns no url', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git remote', 'origin\n'],
      ['git push', ''],
      ['repo view', JSON.stringify({ nameWithOwner: '0x92/Pane' })],
      ['pr create', 'aborted: you have no permission'],
    ]);

    await expect(new PullRequestManager().create(
      { sessionId: 's1', title: 't', body: 'b', baseBranch: 'main', targetRepo: 'dcouple/Pane' },
      '/wt', '/repo', runner,
    )).rejects.toThrow(/did not return a pull request URL/);
  });

  it('rejects a missing target base before pushing the branch', async () => {
    const runner = stubRunner([
      ['branch --show-current', 'feature/x\n'],
      ['git remote', 'origin\n'],
      ['--version', 'gh version 2.97.0'],
      ['repos/dcouple/Pane/branches/missing', new Error('HTTP 404')],
    ]);

    await expect(new PullRequestManager().create(
      { sessionId: 's1', title: 't', body: 'b', baseBranch: 'missing', targetRepo: 'dcouple/Pane' },
      '/wt', '/repo', runner,
    )).rejects.toThrow(/Base branch missing was not found in dcouple\/Pane/);

    const commands = vi.mocked(runner.execAsync).mock.calls
      .map(call => call[0]);
    expect(commands.some(command => command.includes('git push'))).toBe(false);
  });
});

describe('PullRequestManager.getChecks', () => {
  it('reads the checks gh reports', async () => {
    const runner = stubRunner([
      ['pr checks', JSON.stringify([
        { name: 'quality', bucket: 'pass', link: 'https://ci/1' },
        { name: 'smoke', bucket: 'pending' },
      ])],
    ]);

    const result = await new PullRequestManager().getChecks('dcouple/Pane', 382, '/repo', runner);

    expect(result.checks).toHaveLength(2);
    expect(result.summary).toBe('pending');
  });

  /** gh exits non-zero when a check fails — the data is still in the output. */
  it('still reports failures, which gh signals with a non-zero exit', async () => {
    const payload = JSON.stringify([{ name: 'quality', bucket: 'fail' }]);
    const runner = stubRunner([
      ['pr checks', new Error(`Command failed: gh pr checks\n${payload}`)],
    ]);

    const result = await new PullRequestManager().getChecks('dcouple/Pane', 382, '/repo', runner);

    expect(result.summary).toBe('fail');
    expect(result.checks[0].name).toBe('quality');
  });

  it('treats "no checks" as a state, not an error', async () => {
    const runner = stubRunner([
      ['pr checks', new Error('no checks reported on the "main" branch')],
    ]);

    const result = await new PullRequestManager().getChecks('dcouple/Pane', 382, '/repo', runner);

    expect(result.summary).toBe('none');
    expect(result.checks).toEqual([]);
  });
});

describe('sortBaseBranches', () => {
  it('lifts the default branch and the long-lived lines above the alphabet', () => {
    const sorted = sortBaseBranches(
      ['zebra', 'develop', 'main', 'alpha', 'release/2.4', 'master'],
      'main'
    );

    expect(sorted).toEqual(['main', 'master', 'develop', 'release/2.4', 'alpha', 'zebra']);
  });

  it('honours a default branch that is not called main', () => {
    expect(sortBaseBranches(['main', 'trunk', 'alpha'], 'trunk')[0]).toBe('trunk');
  });

  it('drops duplicates from overlapping pages', () => {
    expect(sortBaseBranches(['a', 'b', 'a'], null)).toEqual(['a', 'b']);
  });
});

describe('summarizeFileChanges', () => {
  const file = (additions: number | null, deletions: number | null): GitCommitFileChange => ({
    path: 'x', oldPath: 'x', status: 'modified', additions, deletions, isBinary: additions === null,
  });

  it('adds up the counts and treats binary files as zero', () => {
    expect(summarizeFileChanges([file(3, 1), file(null, null), file(10, 0)]))
      .toEqual({ additions: 13, deletions: 1 });
  });

  it('is zero for an empty comparison', () => {
    expect(summarizeFileChanges([])).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('PullRequestManager.getChanges', () => {
  afterEach(() => vi.restoreAllMocks());

  // numstat keeps the path in the same record as the counts; name-status puts
  // it in the next NUL-separated token.
  const NUMSTAT = '3\t1\tsrc/a.ts\x002\t0\tsrc/b.ts\x00';
  const NAME_STATUS = 'M\x00src/a.ts\x00A\x00src/b.ts\x00';

  it('compares against the tracking ref and reports totals', async () => {
    const runner = stubRunner([
      ['rev-parse --verify --quiet origin/main', 'abc123\n'],
      ['diff --numstat', NUMSTAT],
      ['diff --name-status', NAME_STATUS],
    ]);

    const changes = await new PullRequestManager().getChanges('/wt', 'main', runner);

    expect(changes.baseRef).toBe('origin/main');
    expect(changes.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(changes.files[1].status).toBe('added');
    expect(changes).toMatchObject({ additions: 5, deletions: 1, totalFiles: 2, truncated: false });
  });

  it('falls back to the local branch when there is no tracking ref', async () => {
    const runner = stubRunner([
      ['rev-parse --verify --quiet origin/main', new Error('unknown revision')],
      ['rev-parse --verify --quiet main', 'abc123\n'],
      ['diff --numstat', NUMSTAT],
      ['diff --name-status', NAME_STATUS],
    ]);

    expect((await new PullRequestManager().getChanges('/wt', 'main', runner)).baseRef).toBe('main');
  });

  it('says so rather than throwing when the base resolves to nothing', async () => {
    const runner = stubRunner([['rev-parse', new Error('unknown revision')]]);

    const changes = await new PullRequestManager().getChanges('/wt', 'nope', runner);

    expect(changes).toMatchObject({ baseRef: 'nope', files: [], totalFiles: 0 });
  });
});

describe('parseTrackingBranches', () => {
  it('keeps slashed branch names and drops the remote HEAD', () => {
    const raw = ['feature/usage-and-limits', 'HEAD', 'main', 'fix/agent-terminal-robustness', ''].join('\n');

    expect(parseTrackingBranches(raw)).toEqual([
      'feature/usage-and-limits',
      'main',
      'fix/agent-terminal-robustness',
    ]);
  });

  it('is empty for a remote with no refs', () => {
    expect(parseTrackingBranches('\n  \n')).toEqual([]);
  });
});

describe('PullRequestManager.listBaseBranches', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The case that surprised the user: their own feature branches sit in the
   * fork, so they must appear when the fork is the target — and only then, as
   * GitHub rejects a base the target repository does not have.
   */
  it('adds the tracking refs of the remote that is the target repository', async () => {
    const runner = stubRunner([
      ['--version', 'gh version 2.97.0'],
      ['git remote get-url origin', 'https://github.com/0x92/Pane.git\n'],
      ['git remote', 'origin\nupstream\n'],
      ['for-each-ref --format=%(refname:lstrip=2) refs/heads', 'main\nfeature/usage-and-limits\n'],
      ['for-each-ref', 'feature/usage-and-limits\nHEAD\nmain\n'],
      ['api repos/0x92/Pane/branches', JSON.stringify(['main'])],
    ]);

    const branches = await new PullRequestManager()
      .listBaseBranches('0x92/Pane', '/repo', runner, 'main');

    expect(branches.all).toEqual(['main', 'feature/usage-and-limits']);
    // Everything here is locally known, so the short list is the whole list.
    expect(branches.local).toEqual(['main', 'feature/usage-and-limits']);
  });

  it('keeps the short list to branches of this clone, not everything fetched', async () => {
    const runner = stubRunner([
      ['--version', 'gh version 2.97.0'],
      ['git remote get-url upstream', 'https://github.com/dcouple/Pane.git\n'],
      ['git remote', 'upstream\n'],
      // A full fetch of a busy upstream leaves hundreds of tracking refs…
      ['for-each-ref --format=%(refname:lstrip=2) refs/heads', 'main\nmy-feature\n'],
      ['for-each-ref', 'release\nsomeone-elses-branch\nanother\n'],
      ['api repos/dcouple/Pane/branches', JSON.stringify(['main', 'release', 'someone-elses-branch', 'another'])],
    ]);

    const branches = await new PullRequestManager()
      .listBaseBranches('dcouple/Pane', '/repo', runner, 'main');

    // …but only `main` is a branch of this clone, and `my-feature` is not a
    // branch of the upstream at all, so it is no candidate either.
    expect(branches.all).toHaveLength(4);
    expect(branches.local).toEqual(['main']);
  });

  it('ignores a remote that points at a different repository', async () => {
    const runner = stubRunner([
      ['--version', 'gh version 2.97.0'],
      ['git remote get-url origin', 'https://github.com/0x92/Pane.git\n'],
      ['git remote', 'origin\n'],
      ['for-each-ref', 'feature/usage-and-limits\n'],
      ['api repos/dcouple/Pane/branches', JSON.stringify(['main', 'release'])],
    ]);

    const branches = await new PullRequestManager()
      .listBaseBranches('dcouple/Pane', '/repo', runner, 'main');

    expect(branches.all).toEqual(['main', 'release']);
  });

  it('still answers from git alone when gh is missing', async () => {
    const runner = stubRunner([
      ['--version', new Error('not found')],
      ['git remote get-url origin', 'https://github.com/0x92/Pane.git\n'],
      ['git remote', 'origin\n'],
      ['for-each-ref', 'main\nfeature/x\n'],
    ]);

    expect(await new PullRequestManager().listBaseBranches('0x92/Pane', '/repo', runner, 'main'))
      .toEqual({ all: ['main', 'feature/x'], local: ['main', 'feature/x'] });
  });
});

describe('PullRequestManager.getDiff', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the patch for the merge base, not a two-dot range', async () => {
    const runner = stubRunner([
      ['rev-parse --verify --quiet origin/main', 'abc123\n'],
      ['git diff -M', 'diff --git a/x b/x\n'],
    ]);

    const result = await new PullRequestManager().getDiff('/wt', 'main', runner);

    expect(result).toMatchObject({ baseRef: 'origin/main', truncated: false });
    expect(result.diff).toContain('diff --git');
    const commands = vi.mocked(runner.execAsync).mock.calls.map(call => call[0]);
    expect(commands.some(command => command.includes('...HEAD'))).toBe(true);
  });

  it('is empty rather than an error when the base does not resolve', async () => {
    const runner = stubRunner([['rev-parse', new Error('unknown revision')]]);
    expect(await new PullRequestManager().getDiff('/wt', 'ghost', runner))
      .toEqual({ baseRef: 'ghost', diff: '', truncated: false });
  });
});
