import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UIStateManager } from './uiStateManager';

function createUiStateDb() {
  const values = new Map<string, string>();
  return {
    getUIState: (key: string) => values.get(key),
    setUIState: (key: string, value: string) => { values.set(key, value); },
    deleteUIState: (key: string) => { values.delete(key); },
  };
}

describe('UIStateManager expanded repositories', () => {
  it('keeps each host’s expanded repositories separate from this computer’s', () => {
    let remoteHostId: string | null = null;
    const manager = new UIStateManager(createUiStateDb(), () => remoteHostId);

    manager.saveExpandedProjects([1, 2]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedProjects()).toEqual([]);
    manager.saveExpandedProjects([1, 9]);

    remoteHostId = null;
    expect(manager.getExpandedProjects()).toEqual([1, 2]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedProjects()).toEqual([1, 9]);
  });
});

describe('UIStateManager opened Sessions', () => {
  it('starts with no opened Sessions, so every Session shows collapsed', () => {
    const manager = new UIStateManager(createUiStateDb());
    expect(manager.getExpandedState().expandedSessions).toEqual([]);
  });

  it('keeps each host’s opened Sessions separate from this computer’s', () => {
    let remoteHostId: string | null = null;
    const manager = new UIStateManager(createUiStateDb(), () => remoteHostId);

    manager.saveExpandedSessions(['local-session']);
    remoteHostId = 'host-b';
    expect(manager.getExpandedState().expandedSessions).toEqual([]);
    manager.saveExpandedSessions(['remote-session']);

    remoteHostId = null;
    expect(manager.getExpandedState().expandedSessions).toEqual(['local-session']);
    remoteHostId = 'host-b';
    expect(manager.getExpandedState().expandedSessions).toEqual(['remote-session']);
  });

  it('does not read the old collapsed-Sessions list as opened', () => {
    const db = createUiStateDb();
    db.setUIState('treeView.collapsedSessions', JSON.stringify(['old-collapsed']));
    db.setUIState('treeView.collapsedSessions@host-b', JSON.stringify(['old-remote']));
    let remoteHostId: string | null = null;
    const manager = new UIStateManager(db, () => remoteHostId);

    expect(manager.getExpandedState().expandedSessions).toEqual([]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedState().expandedSessions).toEqual([]);
  });

  it('forgets this computer’s opened Sessions on clear', () => {
    const manager = new UIStateManager(createUiStateDb());
    manager.saveExpandedSessions(['local-session']);

    manager.clear();

    expect(manager.getExpandedState().expandedSessions).toEqual([]);
  });
});

describe('UIStateManager Archived list', () => {
  it('starts closed, and keeps each host’s open Archived repositories separate', () => {
    let remoteHostId: string | null = null;
    const manager = new UIStateManager(createUiStateDb(), () => remoteHostId);
    expect(manager.getExpandedState().archivedSectionExpanded).toBe(false);

    manager.saveExpandedArchivedProjects([3]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedState().expandedArchivedProjects).toEqual([]);
    manager.saveExpandedArchivedProjects([7]);

    remoteHostId = null;
    expect(manager.getExpandedState().expandedArchivedProjects).toEqual([3]);
  });
});

describe('UIStateManager host navigation memory', () => {
  it('keeps each host’s remembered location separate from this computer’s', () => {
    const manager = new UIStateManager(createUiStateDb());

    manager.saveNavigationMemory(null, { view: 'sessions', projectId: null, paneId: 'local-pane' });
    manager.saveNavigationMemory('host-b', { view: 'project', projectId: 4, paneId: null });

    expect(manager.getNavigationMemory(null)).toEqual({ view: 'sessions', projectId: null, paneId: 'local-pane' });
    expect(manager.getNavigationMemory('host-b')).toEqual({ view: 'project', projectId: 4, paneId: null });
    expect(manager.getNavigationMemory('host-never-visited')).toBeNull();
  });

  it('ignores a stored location that is not a usable memory', () => {
    const db = createUiStateDb();
    const manager = new UIStateManager(db);

    db.setUIState('navigation.lastLocation', 'not json');
    expect(manager.getNavigationMemory(null)).toBeNull();

    db.setUIState('navigation.lastLocation', JSON.stringify({ view: 'inbox', projectId: null, paneId: null }));
    expect(manager.getNavigationMemory(null)).toBeNull();
  });
});

describe('UIStateManager Pane layout memory', () => {
  const split = {
    version: 1 as const,
    root: {
      type: 'split' as const, id: 'root', direction: 'row' as const, sizes: [1, 1],
      children: [
        { type: 'group' as const, id: 'left', panelIds: ['u'], activePanelId: 'u' },
        { type: 'group' as const, id: 'right', panelIds: ['page'], activePanelId: 'page' },
      ],
    },
    focusedGroupId: 'left',
  };
  const single = {
    version: 1 as const,
    root: { type: 'group' as const, id: 'main', panelIds: ['u', 'v'], activePanelId: 'v' },
  };

  it('keeps each host’s view of a Pane separate, and forgets it on request', () => {
    const manager = new UIStateManager(createUiStateDb());

    manager.savePaneLayout(null, 'pane-p', split);
    manager.savePaneLayout('host-b', 'pane-p', single);

    expect(manager.getPaneLayout(null, 'pane-p')).toEqual(split);
    expect(manager.getPaneLayout('host-b', 'pane-p')).toEqual(single);
    expect(manager.getPaneLayout(null, 'pane-q')).toBeNull();

    manager.savePaneLayout(null, 'pane-p', null);
    expect(manager.getPaneLayout(null, 'pane-p')).toBeNull();
    expect(manager.getPaneLayout('host-b', 'pane-p')).toEqual(single);
  });

  it('ignores a stored layout it cannot read', () => {
    const db = createUiStateDb();
    const manager = new UIStateManager(db);

    db.setUIState('paneLayout.pane-p', 'not json');
    expect(manager.getPaneLayout(null, 'pane-p')).toBeNull();

    db.setUIState('paneLayout.pane-p', JSON.stringify({ ...single, version: 2 }));
    expect(manager.getPaneLayout(null, 'pane-p')).toBeNull();
  });
});

describe('UIStateManager launch chat', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'pane-launch-chat-'));
  const panels = new Map([
    ['chat', { sessionId: 'pane-1', type: 'chat' }],
    ['shell', { sessionId: 'pane-1', type: 'terminal' }],
  ]);

  function setUp(options: { tab?: string; archived?: boolean; worktreePath?: string; view?: 'sessions' | 'project'; paneId?: string | null; remoteHostId?: string } = {}) {
    const manager = new UIStateManager(createUiStateDb(), () => options.remoteHostId ?? null);
    manager.saveNavigationMemory(null, { view: options.view ?? 'sessions', projectId: null, paneId: options.paneId === undefined ? 'pane-1' : options.paneId });
    manager.savePaneLayout(null, 'pane-1', {
      version: 1,
      root: { type: 'split', id: 's', direction: 'row', sizes: [50, 50], children: [
        { type: 'group', id: 'left', panelIds: ['shell'], activePanelId: 'shell' },
        { type: 'group', id: 'right', panelIds: ['chat', 'shell'], activePanelId: options.tab ?? 'chat' },
      ] },
      focusedGroupId: 'right',
    });
    const panes = {
      getSession: (id: string) => id === 'pane-1' ? { archived: options.archived ?? false, worktree_path: options.worktreePath ?? worktree } : undefined,
      getPanel: (id: string) => panels.get(id) ?? null,
    };
    return manager.getLaunchChat(panes);
  }

  it('reopens the chat tab that was in front in the last Pane shown', () => {
    expect(setUp()).toEqual({ paneId: 'pane-1', panelId: 'chat' });
  });

  it('stays on Home when the last tab in front was a terminal', () => {
    expect(setUp({ tab: 'shell' })).toBeNull();
  });

  it('stays on Home when the last view was not a Pane', () => {
    expect(setUp({ paneId: null })).toBeNull();
    expect(setUp({ view: 'project' })).toBeNull();
  });

  it('stays on Home when the Pane was archived or its folder is gone', () => {
    expect(setUp({ archived: true })).toBeNull();
    expect(setUp({ worktreePath: join(worktree, 'deleted') })).toBeNull();
  });

  it('stays on Home while another computer is the active host', () => {
    expect(setUp({ remoteHostId: 'host-b' })).toBeNull();
  });
});
