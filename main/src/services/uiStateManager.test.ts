import { describe, expect, it } from 'vitest';
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
