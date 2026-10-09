import { describe, expect, it } from 'vitest';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import {
  chooseSidebarCycleSessions,
  flattenSessionsByProjects,
  getPinnedSessions,
  groupSessionsByProject,
} from './sessionOrdering';

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'projectId'>): Session {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    worktreePath: '',
    prompt: '',
    status: 'stopped',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    projectId: overrides.projectId,
    displayOrder: overrides.displayOrder,
    isFavorite: overrides.isFavorite,
    favoritePinnedAt: overrides.favoritePinnedAt,
    archived: overrides.archived,
  };
}

function project(id: number, name = `Project ${id}`): Project {
  return {
    id,
    name,
    path: '',
    active: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('sessionOrdering', () => {
  it('labels pinned rows with the Pane name and the full repository name without its owner', () => {
    const projects = new Map([
      [1, project(1, 'bloomapi/bloom-mono')],
      [2, project(2, 'dcouple\\doozy')],
    ]);
    const pinned = getPinnedSessions([
      session({ id: 'bloom', name: 'do-tm-560', projectId: 1, isFavorite: true }),
      session({ id: 'doozy', name: 'improve fan out', projectId: 2, isFavorite: true }),
    ], projects);

    expect(pinned.find(item => item.session.id === 'bloom')).toMatchObject({ label: 'do-tm-560', repositoryName: 'bloom-mono' });
    expect(pinned.find(item => item.session.id === 'doozy')).toMatchObject({ label: 'improve fan out', repositoryName: 'doozy' });
  });

  it('breaks pinned ties by Pane name, then repository', () => {
    const projects = new Map([
      [1, project(1, 'zeta')],
      [2, project(2, 'alpha')],
    ]);
    const pinnedAt = '2026-01-01T00:00:00.000Z';

    const pinned = getPinnedSessions([
      session({ id: 'b-zeta', name: 'b', projectId: 1, isFavorite: true, favoritePinnedAt: pinnedAt }),
      session({ id: 'a-zeta', name: 'a', projectId: 1, isFavorite: true, favoritePinnedAt: pinnedAt }),
      session({ id: 'a-alpha', name: 'a', projectId: 2, isFavorite: true, favoritePinnedAt: pinnedAt }),
    ], projects);

    expect(pinned.map(item => item.session.id)).toEqual(['a-alpha', 'a-zeta', 'b-zeta']);
  });

  it('orders sessions by displayOrder in the default ascending view', () => {
    const grouped = groupSessionsByProject([
      session({ id: 'newer', projectId: 1, displayOrder: 2, createdAt: '2026-01-03T00:00:00.000Z' }),
      session({ id: 'older', projectId: 1, displayOrder: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'middle', projectId: 1, displayOrder: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
    ], true);

    expect(grouped.get(1)?.map(item => item.id)).toEqual(['older', 'middle', 'newer']);
  });

  it('keeps newest-first sorting when the user flips the sort direction', () => {
    const grouped = groupSessionsByProject([
      session({ id: 'newer', projectId: 1, displayOrder: 2, createdAt: '2026-01-03T00:00:00.000Z' }),
      session({ id: 'older', projectId: 1, displayOrder: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'middle', projectId: 1, displayOrder: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
    ], false);

    expect(grouped.get(1)?.map(item => item.id)).toEqual(['newer', 'middle', 'older']);
  });

  it('uses createdAt sort when displayOrder is absent', () => {
    const grouped = groupSessionsByProject([
      session({ id: 'old', projectId: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'new', projectId: 1, createdAt: '2026-01-03T00:00:00.000Z' }),
    ], false);

    expect(grouped.get(1)?.map(item => item.id)).toEqual(['new', 'old']);
  });

  it('flattens sessions in project order while respecting collapsed projects', () => {
    const projects = [project(2), project(1)];
    const grouped = groupSessionsByProject([
      session({ id: 'one', projectId: 1, displayOrder: 0 }),
      session({ id: 'two', projectId: 2, displayOrder: 0 }),
    ], true);

    expect(flattenSessionsByProjects(projects, grouped).map(item => item.id)).toEqual(['two', 'one']);
    expect(flattenSessionsByProjects(projects, grouped, new Set([1])).map(item => item.id)).toEqual(['one']);
  });

  it('orders pinned rows by newest pin first', () => {
    const projects = new Map([
      [1, project(1, 'Zed')],
      [2, project(2, 'Alpha')],
    ]);

    const pinned = getPinnedSessions([
      session({ id: 'older', name: 'Pane', projectId: 1, isFavorite: true, favoritePinnedAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'newer', name: 'Pane', projectId: 2, isFavorite: true, favoritePinnedAt: '2026-01-03T00:00:00.000Z' }),
      session({ id: 'unpinned', projectId: 1, isFavorite: false }),
    ], projects);

    expect(pinned.map(item => item.session.id)).toEqual(['newer', 'older']);
  });

  it('falls back to createdAt for pinned rows without a pin timestamp', () => {
    const projects = new Map([[1, project(1, 'Project')]]);

    const pinned = getPinnedSessions([
      session({ id: 'old', projectId: 1, isFavorite: true, createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'new', projectId: 1, isFavorite: true, createdAt: '2026-01-03T00:00:00.000Z' }),
    ], projects);

    expect(pinned.map(item => item.session.id)).toEqual(['new', 'old']);
  });

  it('uses pinned order for sidebar cycling when active pane was selected from pinned', () => {
    const pinned = [
      session({ id: 'latest-pin', projectId: 1, isFavorite: true }),
      session({ id: 'older-pin', projectId: 1, isFavorite: true }),
    ];
    const visible = [
      session({ id: 'normal-first', projectId: 1 }),
      pinned[1],
      pinned[0],
    ];

    const scoped = chooseSidebarCycleSessions(
      'pinned',
      'older-pin',
      pinned,
      visible,
      visible
    );

    expect(scoped.map(item => item.id)).toEqual(['latest-pin', 'older-pin']);
  });

  it('falls back to visible repository order when pinned scope no longer contains the active pane', () => {
    const pinned = [
      session({ id: 'latest-pin', projectId: 1, isFavorite: true }),
    ];
    const visible = [
      session({ id: 'normal-first', projectId: 1 }),
      session({ id: 'normal-second', projectId: 1 }),
    ];

    const scoped = chooseSidebarCycleSessions(
      'pinned',
      'normal-first',
      pinned,
      visible,
      visible
    );

    expect(scoped.map(item => item.id)).toEqual(['normal-first', 'normal-second']);
  });
});
