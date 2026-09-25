import { describe, expect, it } from 'vitest';

import { buildPaneList, toggleFavorite, type ProjectWithPanes } from './paneList';

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

const noStatus = { status: () => 'unknown' as const, agent: () => undefined };

function shape(items: ReturnType<typeof buildPaneList>) {
  return items.map(item => item.type === 'section' ? `# ${item.title}` : item.label);
}

describe('buildPaneList', () => {
  it('lists pinned panes first, newest pin first, then every project with all its panes, skipping archived and hidden ones', () => {
    expect(shape(buildPaneList(projects, '', noStatus))).toEqual([
      '# Pinned',
      'pane/terminal-speed',
      'doozy/push-alerts',
      '# pane',
      'fix-login',
      'terminal-speed',
      '# website',
      '# doozy',
      'push-alerts',
      'login-copy',
    ]);
  });

  it('labels a pinned pane with its project cut to six characters, as the PWA does', () => {
    const demo: ProjectWithPanes[] = [{ id: 9, name: 'demo-app', sessions: [{ id: 'd1', name: 'claude-agent', isFavorite: true }] }];
    expect(shape(buildPaneList(demo, '', noStatus))).toEqual(['# Pinned', 'demo-a.../claude-agent', '# demo-app', 'claude-agent']);
  });

  it('matches every search word against the pane, project and branch names, leaving out projects without a match', () => {
    expect(shape(buildPaneList(projects, 'LOGIN', noStatus))).toEqual([
      '# pane',
      'fix-login',
      '# doozy',
      'login-copy',
    ]);
    expect(shape(buildPaneList(projects, 'doozy release', noStatus))).toEqual([
      '# Pinned',
      'doozy/push-alerts',
      '# doozy',
      'push-alerts',
    ]);
  });

  it('carries each pane’s live status, agent and project', () => {
    const list = buildPaneList(projects, 'fix', {
      status: id => (id === 's1' ? 'blocked' : 'idle'),
      agent: id => (id === 's1' ? 'codex' : undefined),
    });
    expect(list[1]).toMatchObject({
      type: 'pane',
      pane: { id: 's1', name: 'fix-login', projectName: 'pane', baseBranch: 'main', status: 'blocked', agent: 'codex', isFavorite: false },
    });
  });
});

describe('toggleFavorite', () => {
  it('pins a pane at the given time and unpins it the second time', () => {
    const pinned = toggleFavorite(projects, 's1', '2026-09-25T08:00:00.000Z');
    expect(pinned[0].sessions?.[0]).toMatchObject({ isFavorite: true, favoritePinnedAt: '2026-09-25T08:00:00.000Z' });
    expect(shape(buildPaneList(pinned, '', noStatus)).slice(0, 4)).toEqual([
      '# Pinned', 'pane/fix-login', 'pane/terminal-speed', 'doozy/push-alerts',
    ]);

    const unpinned = toggleFavorite(pinned, 's1', '2026-09-25T09:00:00.000Z');
    expect(unpinned[0].sessions?.[0]).toMatchObject({ isFavorite: false, favoritePinnedAt: undefined });
  });
});
