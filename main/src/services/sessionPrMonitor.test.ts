import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PR_POLL_INTERVAL_MS, SessionPrMonitor } from './sessionPrMonitor';
import { WorkspaceJournal } from './workspaceJournal';
import type { GitStatus } from '../types/session';

interface FakePr {
  state?: string;
  mergeable?: string;
  headRefOid?: string;
  statusCheckRollup?: Array<Record<string, string | null>>;
}

function prJson(number: number, pr: FakePr): string {
  return JSON.stringify({
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state: pr.state ?? 'OPEN',
    mergeable: pr.mergeable ?? 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: pr.headRefOid ?? 'abc123',
    statusCheckRollup: pr.statusCheckRollup ?? [],
    extra: 'dropped by the decoder',
  });
}

const passing = { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' };
const running = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null };

function setup(options: {
  members?: string[];
  prs?: Record<string, { number: number; state: string } | undefined>;
  archived?: string[];
} = {}) {
  const members = options.members ?? ['pane-1'];
  const cachedPrs = options.prs ?? { 'pane-1': { number: 747, state: 'OPEN' } };
  const remote = new Map<number, FakePr>();
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    const pr = remote.get(Number(args[2]));
    if (!pr) throw Object.assign(new Error('no pull requests found'), { code: 1, stderr: 'no pull requests found' });
    return { stdout: prJson(Number(args[2]), pr), stderr: '', exitCode: 0 };
  });
  // What `gh pr list --head <branch>` finds for each Pane's branch (GitStatusManager.lookupPrForPane).
  const branchPrs = new Map<string, { number: number; state: string }>();
  let lookupError: Error | undefined;
  const lookupPrForPane = vi.fn(async (paneId: string) => {
    if (lookupError) return { ok: false as const, error: lookupError };
    const pr = branchPrs.get(paneId);
    return { ok: true as const, pr: pr ? { prNumber: pr.number, prState: pr.state } : undefined };
  });
  const journal = new WorkspaceJournal({
    resolvePane: paneId => ({ paneId, paneName: `Worker ${paneId}`, repoId: 1, repoName: 'app' }),
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const slot = vi.fn(<T,>(operation: () => Promise<T>) => operation());
  // SAFETY: The fakes implement only the members SessionPrMonitor reads (Pane archived/worktreePath,
  // project path and execFile, cached PR fields, and the gh slot).
  const monitor = new SessionPrMonitor({
    sessions: { activeMemberPaneIds: () => members },
    panes: {
      getSession: vi.fn((paneId: string) => ({ id: paneId, archived: options.archived?.includes(paneId) ?? false, worktreePath: `/work/${paneId}` })) as never,
      getProjectContext: vi.fn(() => ({ project: { path: '/repo' }, commandRunner: { execFile } })) as never,
    },
    gitStatus: {
      getCachedStatus: (paneId: string) => {
        const pr = cachedPrs[paneId];
        // SAFETY: The monitor reads only prNumber and prState from a cached status.
        return pr ? { status: { state: 'clean', prNumber: pr.number, prState: pr.state } as GitStatus, lastChecked: 0 } : null;
      },
      lookupPrForPane,
      withGithubSlot: slot as never,
    },
    journal,
    logger,
    random: () => 0,
  });
  const entries = () => journal.readAfter(0, { kinds: ['pr.conflicted', 'pr.checks', 'pr.merged'] }).entries;
  const failLookups = (error: Error | undefined) => { lookupError = error; };
  return { monitor, remote, execFile, journal, logger, slot, entries, members, branchPrs, cachedPrs, lookupPrForPane, failLookups };
}

describe('SessionPrMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists PRs with running checks, polling first when the last round is stale', async () => {
    const { monitor, remote, execFile } = setup();
    remote.set(747, { statusCheckRollup: [passing, running] });

    await expect(monitor.pendingChecks(60_000)).resolves.toEqual([{ paneId: 'pane-1', prNumber: 747 }]);
    expect(execFile).toHaveBeenCalledTimes(1);

    remote.set(747, { statusCheckRollup: [passing] });
    // A fresh round is reused; a zero max age forces another poll.
    await expect(monitor.pendingChecks(60_000)).resolves.toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    await expect(monitor.pendingChecks(0)).resolves.toEqual([]);
  });

  it('shares one round between concurrent pollers', async () => {
    const { monitor, remote, execFile } = setup();
    remote.set(747, { statusCheckRollup: [running] });

    await Promise.all([monitor.pollOnce(), monitor.pendingChecks(0)]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('seeds silently, then reports each transition once', async () => {
    const { monitor, remote, entries, execFile, slot } = setup();
    remote.set(747, { mergeable: 'MERGEABLE', statusCheckRollup: [passing, running] });
    await monitor.pollOnce();
    expect(entries()).toEqual([]);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '747', '--json', 'number,url,state,mergeable,statusCheckRollup,headRefOid'],
      '/work/pane-1',
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(slot).toHaveBeenCalledTimes(1);

    remote.set(747, {
      mergeable: 'CONFLICTING',
      statusCheckRollup: [
        passing,
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', context: 'ci/e2e', state: 'ERROR' },
      ],
    });
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(entries()).toMatchObject([
      {
        kind: 'pr.conflicted',
        paneId: 'pane-1',
        paneName: 'Worker pane-1',
        repoName: 'app',
        source: 'github',
        pr: { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc123' },
      },
      { kind: 'pr.checks', checks: 'failed', failingChecks: ['test', 'ci/e2e'], pr: { number: 747 } },
    ]);

    // A new head that passes reports again; GitHub's transient UNKNOWN keeps the conflict known.
    remote.set(747, { mergeable: 'UNKNOWN', headRefOid: 'def456', statusCheckRollup: [passing] });
    await monitor.pollOnce();
    remote.set(747, { mergeable: 'CONFLICTING', headRefOid: 'def456', statusCheckRollup: [passing] });
    await monitor.pollOnce();
    remote.set(747, { state: 'MERGED', headRefOid: 'def456', statusCheckRollup: [passing] });
    await monitor.pollOnce();
    expect(entries().slice(2)).toMatchObject([
      { kind: 'pr.checks', checks: 'passed', pr: { headOid: 'def456' } },
      { kind: 'pr.merged', pr: { number: 747, headOid: 'def456' } },
    ]);
    expect(entries()[2]).not.toHaveProperty('failingChecks');

    // A merged PR is not polled again, even while the git status cache still says OPEN.
    execFile.mockClear();
    await monitor.pollOnce();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not report a PR that was already conflicting or failed when first seen', async () => {
    const { monitor, remote, entries } = setup();
    remote.set(747, {
      mergeable: 'CONFLICTING',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(entries()).toEqual([]);
  });

  it('views only Session members with an open PR, and looks up the rest by branch', async () => {
    const { monitor, remote, execFile, lookupPrForPane } = setup({
      members: ['open', 'merged', 'none', 'archived'],
      prs: {
        open: { number: 1, state: 'OPEN' },
        merged: { number: 2, state: 'MERGED' },
        archived: { number: 3, state: 'OPEN' },
        outsider: { number: 4, state: 'OPEN' },
      },
      archived: ['archived'],
    });
    remote.set(1, {});
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][1][2]).toBe('1');
    expect(lookupPrForPane.mock.calls.map(call => call[0])).toEqual(['merged', 'none']);
  });

  it('discovers the PR of a member nobody is looking at, then reports its transitions', async () => {
    const { monitor, remote, execFile, entries, branchPrs, lookupPrForPane } = setup({ members: ['worker'], prs: {} });
    await monitor.pollOnce();
    expect(lookupPrForPane).toHaveBeenCalledWith('worker');
    expect(execFile).not.toHaveBeenCalled();

    // The worker opens a PR; the next round finds it by branch and seeds it silently.
    branchPrs.set('worker', { number: 12, state: 'OPEN' });
    remote.set(12, { mergeable: 'MERGEABLE' });
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);

    // Once tracked, the PR is viewed directly, without another lookup.
    lookupPrForPane.mockClear();
    remote.set(12, { mergeable: 'CONFLICTING' });
    await monitor.pollOnce();
    expect(lookupPrForPane).not.toHaveBeenCalled();
    expect(entries()).toMatchObject([{ kind: 'pr.conflicted', paneId: 'worker', pr: { number: 12 } }]);
  });

  it('resumes polling a PR that was closed and reopened', async () => {
    const { monitor, remote, execFile, entries, branchPrs } = setup();
    remote.set(747, { mergeable: 'MERGEABLE' });
    await monitor.pollOnce();
    remote.set(747, { state: 'CLOSED' });
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(2);

    // Closed: the stale cached OPEN is not trusted; the branch lookup decides.
    branchPrs.set('pane-1', { number: 747, state: 'CLOSED' });
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(2);

    branchPrs.set('pane-1', { number: 747, state: 'OPEN' });
    remote.set(747, { mergeable: 'CONFLICTING' });
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(entries()).toMatchObject([{ kind: 'pr.conflicted', pr: { number: 747 } }]);
  });

  it('backs off when the branch lookup finds gh unavailable', async () => {
    vi.useFakeTimers();
    const { monitor, lookupPrForPane, failLookups, logger } = setup({ members: ['worker'], prs: {} });
    failLookups(Object.assign(new Error('gh: To get started with GitHub CLI, please run: gh auth login'), {
      code: 4,
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    expect(lookupPrForPane).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not signed in'));
    monitor.stop();
  });

  it('runs no gh at all when no Session has a member', async () => {
    vi.useFakeTimers();
    const { monitor, execFile, slot, lookupPrForPane } = setup({ members: [] });
    monitor.start();
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS * 5);
    monitor.stop();
    expect(execFile).not.toHaveBeenCalled();
    expect(slot).not.toHaveBeenCalled();
    expect(lookupPrForPane).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off and logs once while gh is unavailable, then resumes', async () => {
    vi.useFakeTimers();
    const { monitor, remote, execFile, logger } = setup();
    remote.set(747, {});
    execFile.mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    expect(execFile).toHaveBeenCalledTimes(1);
    // The next round waits twice the interval, not one interval.
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    expect(execFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('not installed');

    execFile.mockRejectedValue(Object.assign(new Error('rate limited'), { code: 1, stderr: 'API rate limit exceeded for user' }));
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS * 4);
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    execFile.mockResolvedValue({ stdout: prJson(747, {}), stderr: '', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS * 8);
    expect(execFile).toHaveBeenCalledTimes(4);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('resumed'));
    await vi.advanceTimersByTimeAsync(SESSION_PR_POLL_INTERVAL_MS);
    expect(execFile).toHaveBeenCalledTimes(5);
    monitor.stop();
  });

  it('skips one failing PR without pausing the others', async () => {
    const { monitor, remote, execFile, logger } = setup({
      members: ['gone', 'live'],
      prs: { gone: { number: 9, state: 'OPEN' }, live: { number: 10, state: 'OPEN' } },
    });
    remote.set(10, {});
    await monitor.pollOnce();
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
