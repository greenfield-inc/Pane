import { describe, expect, it } from 'vitest';

import { buildCreatePaneRequest, defaultBaseBranch, filterBranches, paneFromCreateResult, suggestPaneName } from './createPane';

const branches = [
  { name: 'main', isCurrent: true, hasWorktree: true, isRemote: false },
  { name: 'feature/login', isCurrent: false, hasWorktree: false, isRemote: false },
  { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
  { name: 'origin/feature/login', isCurrent: false, hasWorktree: false, isRemote: true },
];

describe('defaultBaseBranch', () => {
  it('prefers the remote main branch, then the checked-out branch', () => {
    expect(defaultBaseBranch(branches)).toBe('origin/main');
    expect(defaultBaseBranch(branches.filter(branch => !branch.isRemote))).toBe('main');
    expect(defaultBaseBranch([])).toBeUndefined();
  });
});

describe('filterBranches', () => {
  it('lists remote branches first and filters by name', () => {
    expect(filterBranches(branches, '').map(branch => branch.name)).toEqual(['origin/main', 'origin/feature/login', 'main', 'feature/login']);
    expect(filterBranches(branches, 'LOGIN').map(branch => branch.name)).toEqual(['origin/feature/login', 'feature/login']);
  });
});

describe('suggestPaneName', () => {
  it('names the pane after the branch, avoiding names already taken', () => {
    expect(suggestPaneName('origin/fix-crash', [], branches)).toBe('fix-crash');
    expect(suggestPaneName('origin/fix-crash', ['fix-crash'], branches)).toBe('fix-crash-1');
    // `main` is checked out in the repo itself, so a worktree can't reuse it.
    expect(suggestPaneName('origin/main', [], branches)).toBe('main-1');
  });
});

describe('buildCreatePaneRequest', () => {
  it('asks the host for one pane running the chosen agent on the chosen base branch', () => {
    expect(buildCreatePaneRequest({ projectId: 3, name: '  fix: login?  ', baseBranch: 'origin/main', agent: 'codex' })).toEqual({
      request: {
        repo: { id: 3 },
        panes: [{ name: 'fix login', baseBranch: 'origin/main', pinned: false, tool: { agent: 'codex' } }],
      },
    });
  });

  it('explains what is missing instead of building a request', () => {
    expect(buildCreatePaneRequest({ projectId: 3, name: ' ?? ', baseBranch: 'main', agent: 'claude' })).toEqual({ error: 'Give the pane a name.' });
    expect(buildCreatePaneRequest({ projectId: undefined, name: 'x', baseBranch: 'main', agent: 'claude' })).toEqual({ error: 'Choose a repository.' });
    expect(buildCreatePaneRequest({ projectId: 3, name: 'x', baseBranch: undefined, agent: 'claude' })).toEqual({ error: 'Choose a base branch.' });
  });
});

describe('paneFromCreateResult', () => {
  it('returns the new pane, or the host’s reason it could not be created', () => {
    expect(paneFromCreateResult({
      ok: true,
      repo: { id: 3, name: 'doozy', path: '/r', active: false, sessionCount: 1 },
      items: [{ ok: true, index: 0, name: 'x', pinned: false, paneId: 'pane-1', panelId: 'panel-1' }],
    })).toEqual({ paneId: 'pane-1', panelId: 'panel-1' });

    expect(() => paneFromCreateResult({
      ok: false,
      repo: { id: 3, name: 'doozy', path: '/r', active: false, sessionCount: 0 },
      items: [{ ok: false, index: 0, error: { message: "Branch 'x' already has a worktree" } }],
    })).toThrow("Branch 'x' already has a worktree");
  });
});
