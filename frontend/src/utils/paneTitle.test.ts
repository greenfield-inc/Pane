import { describe, expect, it } from 'vitest';
import { formatPaneTitle, resolvePaneStatusPills, resolvePaneTitle } from './paneTitle';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

// SAFETY: The fixture carries every field resolvePaneTitle reads off a project.
const project = {
  id: 1,
  name: 'bloomapi/bloom-mono',
  path: '/repos/bloom-mono',
  active: true,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
} as Project;

// SAFETY: The fixture carries every field resolvePaneTitle reads off a session.
const session = {
  id: 's1',
  name: 'scrub Sentry request bodies (TM-622)',
  worktreePath: '/repos/bloom-mono/worktrees/scrub-sentry',
  prompt: '',
  status: 'ready',
  createdAt: '2026-01-01',
  output: [],
  jsonMessages: [],
  projectId: 1,
} as Session;

describe('resolvePaneTitle', () => {
  it('pairs the project with the pane name', () => {
    expect(resolvePaneTitle(session, [project])).toEqual({
      project: 'bloomapi/bloom-mono',
      pane: 'scrub Sentry request bodies (TM-622)',
    });
  });

  it('falls back to the worktree folder when the pane has no name', () => {
    expect(resolvePaneTitle({ ...session, name: '   ' }, [project])).toEqual({
      project: 'bloomapi/bloom-mono',
      pane: 'scrub-sentry',
    });
  });

  it('handles Windows-style worktree paths in the fallback', () => {
    const windowsSession = {
      ...session,
      name: '',
      worktreePath: 'C:\\repos\\bloom-mono\\worktrees\\scrub-sentry',
    };
    expect(resolvePaneTitle(windowsSession, [project])?.pane).toBe('scrub-sentry');
  });

  it('names a (Main) Pane like any other Pane', () => {
    const mainRepo = { ...session, name: '(Main) bloom-mono', isMainRepo: true, worktreePath: '/repos/bloom-mono' };
    expect(resolvePaneTitle(mainRepo, [project])).toEqual({
      project: 'bloomapi/bloom-mono',
      pane: '(Main) bloom-mono',
    });
  });

  it('renders nothing without a pane or a matching project', () => {
    expect(resolvePaneTitle(undefined, [project])).toBeNull();
    expect(resolvePaneTitle(session, [])).toBeNull();
    expect(resolvePaneTitle({ ...session, projectId: undefined }, [project])).toBeNull();
  });
});

const withGitStatus = (gitStatus: Session['gitStatus']) => ({ ...session, gitStatus });

describe('resolvePaneStatusPills', () => {
  it('is empty without git status', () => {
    expect(resolvePaneStatusPills(session)).toEqual([]);
    expect(resolvePaneStatusPills(undefined)).toEqual([]);
  });

  it('colours the PR pill by state and names it in the tooltip', () => {
    const open = resolvePaneStatusPills(withGitStatus({
      state: 'ahead', prNumber: 472, prState: 'OPEN', prTitle: 'Show project and pane name',
    }));
    expect(open).toEqual([{
      key: 'pr',
      label: '#472',
      variant: 'success',
      tooltip: 'Pull request #472 (open) — Show project and pane name',
    }]);

    expect(resolvePaneStatusPills(withGitStatus({ state: 'clean', prNumber: 472, prState: 'MERGED' }))[0])
      .toMatchObject({ variant: 'primary', tooltip: 'Pull request #472 (merged)' });
    expect(resolvePaneStatusPills(withGitStatus({ state: 'clean', prNumber: 472, prState: 'CLOSED' }))[0])
      .toMatchObject({ variant: 'error' });
  });

  it('flags conflicts ahead of merge readiness', () => {
    const pills = resolvePaneStatusPills(withGitStatus({ state: 'conflict', isReadyToMerge: true }));
    expect(pills).toEqual([{
      key: 'branch',
      label: 'Conflicts',
      variant: 'error',
      tooltip: 'This worktree has merge conflicts to resolve',
    }]);
  });

  it('shows merge readiness alongside an open PR', () => {
    const pills = resolvePaneStatusPills(withGitStatus({
      state: 'ahead', isReadyToMerge: true, prNumber: 472, prState: 'OPEN',
    }));
    expect(pills.map(pill => pill.label)).toEqual(['#472', 'Ready to merge']);
  });

  it('drops merge readiness once the PR is settled', () => {
    for (const prState of ['MERGED', 'CLOSED']) {
      const pills = resolvePaneStatusPills(withGitStatus({
        state: 'ahead', isReadyToMerge: true, prNumber: 472, prState,
      }));
      expect(pills.map(pill => pill.key)).toEqual(['pr']);
    }
  });

  it('stays quiet for ordinary working states', () => {
    expect(resolvePaneStatusPills(withGitStatus({ state: 'modified', hasUncommittedChanges: true }))).toEqual([]);
    expect(resolvePaneStatusPills(withGitStatus({ state: 'clean' }))).toEqual([]);
  });
});

describe('formatPaneTitle', () => {
  it('joins the project and pane name', () => {
    expect(formatPaneTitle(resolvePaneTitle(session, [project])))
      .toBe('bloomapi/bloom-mono · scrub Sentry request bodies (TM-622)');
  });

  it('joins the project and a (Main) Pane name', () => {
    const mainRepo = { ...session, name: '(Main) bloom-mono', isMainRepo: true };
    expect(formatPaneTitle(resolvePaneTitle(mainRepo, [project]))).toBe('bloomapi/bloom-mono · (Main) bloom-mono');
  });

  it('falls back to the app name when no pane is open', () => {
    expect(formatPaneTitle(null)).toBe('Pane');
  });
});
