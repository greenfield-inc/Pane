import { describe, expect, it } from 'vitest';

import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';

import { buildSidebar, DEFAULT_EXPANSION, toggleFavorite, type ProjectWithPanes, type SidebarInput, type SidebarItem } from './paneList';

const projects: ProjectWithPanes[] = [
  {
    id: 1,
    name: 'pane',
    sessions: [
      { id: 's1', name: 'fix-login', baseBranch: 'main' },
      { id: 's2', name: 'terminal-speed', baseBranch: 'main', isFavorite: true, favoritePinnedAt: '2026-09-02T00:00:00.000Z' },
      { id: 's3', name: 'old-spike', archived: true },
      { id: 's4', name: 'pane-chat', isHidden: true },
    ],
  },
  { id: 2, name: 'website', sessions: [] },
  {
    id: 3,
    name: 'doozy',
    sessions: [
      { id: 's5', name: 'push-alerts', baseBranch: 'release/2.0', isFavorite: true, favoritePinnedAt: '2026-09-01T00:00:00.000Z' },
      { id: 's6', name: 'login-copy', baseBranch: 'main' },
    ],
  },
];

function session(id: string, name: string, extra: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord {
  return {
    id,
    name,
    agent: 'claude',
    internalSessionId: `__orchestration_session_${id}__`,
    panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor` },
    goal: '',
    context: '',
    decisions: [],
    blockers: [],
    nextAction: '',
    evidence: [],
    outputs: [],
    associations: [],
    activity: [],
    revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

const attach = (paneId: string) => ({ paneId, panelIds: [], attachedAt: '2026-09-01T00:00:00.000Z' });

const sessions = [
  session('o1', 'Ship sidebar', { isPinned: true, associations: [attach('s1'), attach('s6')] }),
  session('o2', 'Triage'),
  session('o3', '', { associations: [attach('gone')] }),
  session('o4', 'Old plan', { archived: true, updatedAt: '2026-09-03T00:00:00.000Z' }),
  session('o5', 'Older plan', { archived: true, updatedAt: '2026-09-04T00:00:00.000Z' }),
];

const archivedProjects: ProjectWithPanes[] = [
  { id: 1, name: 'pane', sessions: [{ id: 's3', name: 'old-spike', archived: true }] },
  { id: 3, name: 'doozy', sessions: [] },
];

function input(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    projects,
    sessions,
    archivedProjects: undefined,
    expanded: DEFAULT_EXPANSION,
    collapsedSessions: new Set(),
    query: '',
    lookup: { status: () => 'unknown', agent: () => undefined },
    ...overrides,
  };
}

/** One line per row: sections as `#`, repositories as `##`, nested panes indented. */
function shape(items: SidebarItem[]): string[] {
  return items.map(item => {
    switch (item.type) {
      case 'section': return `# ${item.title}${item.expanded ? '' : ' (collapsed)'}${item.count ? ` ${item.count}` : ''}`;
      case 'repo': return `## ${item.title}`;
      case 'session': return `session ${item.label}${item.paneCount ? ` (${item.paneCount})` : ''}${item.nestedExpanded ? '' : ' >'}`;
      case 'pane': return `${item.nested ? '  ' : ''}${item.label}`;
      case 'archived': return `restore ${item.label}${item.detail ? ` · ${item.detail}` : ''}`;
      case 'note': return `note: ${item.text}`;
    }
  });
}

describe('buildSidebar', () => {
  it('lists Pinned, Sessions, Repositories and Archived in desktop order', () => {
    expect(shape(buildSidebar(input()))).toEqual([
      '# Pinned',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      'pane/terminal-speed',
      'doozy/push-alerts',
      '# Sessions',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      'session Triage',
      'session Untitled',
      '# Repositories',
      '## pane',
      'fix-login',
      'terminal-speed',
      '## website',
      '## doozy',
      'push-alerts',
      'login-copy',
      '# Archived (collapsed)',
    ]);
  });

  it('labels a pinned pane with its project cut to six characters, as the PWA does', () => {
    const demo: ProjectWithPanes[] = [{ id: 9, name: 'demo-app', sessions: [{ id: 'd1', name: 'claude-agent', isFavorite: true }] }];
    expect(shape(buildSidebar(input({ projects: demo, sessions: [] })))).toEqual([
      '# Pinned',
      'demo-a.../claude-agent',
      '# Sessions',
      'note: Create a Session to keep intent and discussion together.',
      '# Repositories',
      '## demo-app',
      'claude-agent',
      '# Archived (collapsed)',
    ]);
  });

  it('keeps a collapsed section’s header and hides its rows', () => {
    const expanded = { pinned: false, sessions: true, repositories: false, archived: false };
    expect(shape(buildSidebar(input({ expanded })))).toEqual([
      '# Pinned (collapsed)',
      '# Sessions',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      'session Triage',
      'session Untitled',
      '# Repositories (collapsed)',
      '# Archived (collapsed)',
    ]);
  });

  it('hides one Session’s nested panes without touching its other placement', () => {
    const items = buildSidebar(input({ collapsedSessions: new Set(['sessions:o1']), expanded: { ...DEFAULT_EXPANSION, repositories: false } }));
    expect(shape(items).slice(0, 9)).toEqual([
      '# Pinned',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      'pane/terminal-speed',
      'doozy/push-alerts',
      '# Sessions',
      'session Ship sidebar (2) >',
      'session Triage',
    ]);
  });

  it('leaves out the Sessions section on a host without Sessions', () => {
    expect(shape(buildSidebar(input({ sessions: 'unavailable', expanded: { ...DEFAULT_EXPANSION, repositories: false } })))).toEqual([
      '# Pinned',
      'pane/terminal-speed',
      'doozy/push-alerts',
      '# Repositories (collapsed)',
      '# Archived (collapsed)',
    ]);
  });

  it('shows a Sessions load error in place of the rows', () => {
    const items = buildSidebar(input({ sessions: [], sessionsError: 'Host timed out', expanded: { ...DEFAULT_EXPANSION, repositories: false } }));
    expect(shape(items)).toContain('note: Host timed out');
    expect(shape(items)).not.toContain('note: Create a Session to keep intent and discussion together.');
  });

  it('lists archived Sessions, newest first, then archived panes with their repository, and counts them', () => {
    const expanded = { pinned: false, sessions: false, repositories: false, archived: true };
    expect(shape(buildSidebar(input({ expanded })))).toEqual([
      '# Pinned (collapsed)',
      '# Sessions (collapsed)',
      '# Repositories (collapsed)',
      '# Archived',
      'note: Loading archived panes…',
    ]);
    expect(shape(buildSidebar(input({ expanded, archivedProjects })))).toEqual([
      '# Pinned (collapsed)',
      '# Sessions (collapsed)',
      '# Repositories (collapsed)',
      '# Archived 3',
      'restore Older plan',
      'restore Old plan',
      'restore old-spike · pane',
    ]);
    expect(shape(buildSidebar(input({ expanded, sessions: [], archivedProjects: [] })))).toContain('note: No archived panes');
  });

  it('offers archived retry after a failed load, without reporting empty or hiding cached rows', () => {
    const expanded = { pinned: false, sessions: false, repositories: false, archived: true };
    const failed = buildSidebar(input({ expanded, archivedError: 'Archive request failed', archivedProjects: undefined }));
    expect(failed.find(item => item.key === 'archived-error')).toMatchObject({ text: 'Archive request failed', danger: true, retry: 'archived' });
    expect(failed.some(item => item.key === 'archived-loading' || item.key === 'archived-empty')).toBe(false);
    const cached = buildSidebar(input({ expanded, archivedError: 'Archive request failed', archivedProjects }));
    expect(cached.some(item => item.key === 'archived-error')).toBe(true);
    expect(shape(cached)).toContain('restore old-spike � pane');
    expect(buildSidebar(input({ expanded: DEFAULT_EXPANSION, archivedError: 'Archive request failed' })).some(item => item.key === 'archived-error')).toBe(false);
  });

  it('matches every search word against Sessions and panes, and returns nothing when nothing matches', () => {
    expect(shape(buildSidebar(input({ query: 'LOGIN' })))).toEqual([
      '# Repositories',
      '## pane',
      'fix-login',
      '## doozy',
      'login-copy',
      '# Archived (collapsed)',
    ]);
    expect(shape(buildSidebar(input({ query: 'ship' })))).toEqual([
      '# Pinned',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      '# Sessions',
      'session Ship sidebar (2)',
      '  fix-login',
      '  login-copy',
      '# Archived (collapsed)',
    ]);
    expect(buildSidebar(input({ query: 'nothing-like-this' }))).toEqual([]);
  });

  it('carries each pane’s live status, agent and project', () => {
    const items = buildSidebar(input({
      query: 'fix',
      lookup: { status: id => (id === 's1' ? 'blocked' : 'idle'), agent: id => (id === 's1' ? 'codex' : undefined) },
    }));
    expect(items.find(item => item.type === 'pane')).toMatchObject({
      pane: { id: 's1', name: 'fix-login', projectName: 'pane', baseBranch: 'main', status: 'blocked', agent: 'codex', isFavorite: false },
    });
  });
});

describe('toggleFavorite', () => {
  it('pins a pane at the given time and unpins it the second time', () => {
    const pinned = toggleFavorite(projects, 's1', '2026-09-25T08:00:00.000Z');
    expect(pinned[0].sessions?.[0]).toMatchObject({ isFavorite: true, favoritePinnedAt: '2026-09-25T08:00:00.000Z' });
    const pinnedRows = shape(buildSidebar(input({ projects: pinned, sessions: 'unavailable' }))).slice(0, 4);
    expect(pinnedRows).toEqual(['# Pinned', 'pane/fix-login', 'pane/terminal-speed', 'doozy/push-alerts']);

    const unpinned = toggleFavorite(pinned, 's1', '2026-09-25T09:00:00.000Z');
    expect(unpinned[0].sessions?.[0]).toMatchObject({ isFavorite: false, favoritePinnedAt: undefined });
  });
});
