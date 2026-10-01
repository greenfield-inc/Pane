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
