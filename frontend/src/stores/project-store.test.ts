import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types/project';
import { API } from '../utils/api';

import { useProjectStore as store } from './project-store';

const alpha: Project = { id: 11, name: 'Alpha', path: '/alpha', active: true, created_at: '', updated_at: '' };
const beta: Project = { ...alpha, id: 22, name: 'Beta', path: '/beta', active: false };

beforeEach(() => {
  vi.restoreAllMocks();
  store.setState(store.getInitialState());
  vi.spyOn(API.projects, 'getAll');
  vi.spyOn(API.projects, 'reorder');
});

describe('shared project state', () => {
  it('shares one initial read and retains project events newer than its snapshot', async () => {
    let finish!: (response: { success: boolean; data: Project[] }) => void;
    vi.mocked(API.projects.getAll).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const home = store.getState().ensureLoaded();
    const sidebar = store.getState().ensureLoaded();
    store.getState().upsert({ ...alpha, name: 'Renamed while loading' });
    finish({ success: true, data: [alpha, beta] });
    await Promise.all([home, sidebar]);
    expect(API.projects.getAll).toHaveBeenCalledTimes(1);
    expect(store.getState().projects.map(project => project.name)).toEqual(['Renamed while loading', 'Beta']);
    expect(store.getState()).toMatchObject({ isLoaded: true, isLoading: false, error: null });
    await store.getState().ensureLoaded();
    expect(API.projects.getAll).toHaveBeenCalledTimes(1);
  });

  it('retains the last usable list when a refresh fails', async () => {
    vi.mocked(API.projects.getAll).mockResolvedValueOnce({ success: true, data: [alpha, beta] });
    await store.getState().ensureLoaded();
    vi.mocked(API.projects.getAll).mockRejectedValueOnce(new Error('Host unavailable'));
    await expect(store.getState().refresh()).resolves.toBeNull();
    expect(store.getState().projects.map(project => project.id)).toEqual([11, 22]);
    expect(store.getState()).toMatchObject({ error: 'Host unavailable', isLoading: false });
  });

  it('restores the saved order after a transport failure without reverting newer project names', async () => {
    vi.mocked(API.projects.getAll).mockResolvedValueOnce({ success: true, data: [alpha, beta] });
    await store.getState().ensureLoaded();
    let fail!: (error: Error) => void;
    vi.mocked(API.projects.reorder).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const save = store.getState().reorder(11, 22);
    await vi.waitFor(() => expect(API.projects.reorder).toHaveBeenCalledWith([
      { id: 22, displayOrder: 0 }, { id: 11, displayOrder: 1 },
    ]));
    expect(store.getState().projects.map(project => project.id)).toEqual([22, 11]);
    store.getState().upsert({ ...alpha, name: 'Renamed during save' });
    fail(new Error('Host disconnected'));
    await expect(save).resolves.toBe(false);
    expect(store.getState().projects.map(project => project.name)).toEqual(['Renamed during save', 'Beta']);
    expect(store.getState()).toMatchObject({ isReordering: false, error: 'Host disconnected' });
  });
});

it('defers an overlapping refresh until a project order has been saved', async () => {
  vi.mocked(API.projects.getAll).mockResolvedValueOnce({ success: true, data: [alpha, beta] });
  await store.getState().ensureLoaded();
  let finish!: () => void;
  vi.mocked(API.projects.reorder).mockImplementation(() => new Promise(resolve => {
    finish = () => resolve({ success: true });
  }));
  const save = store.getState().reorder(11, 22);
  await vi.waitFor(() => expect(store.getState().projects[0].id).toBe(22));
  vi.mocked(API.projects.getAll).mockResolvedValueOnce({ success: true, data: [beta, alpha] });
  const refresh = store.getState().refresh();
  expect(API.projects.getAll).toHaveBeenCalledTimes(1);
  finish();
  await expect(save).resolves.toBe(true);
  await refresh;
  expect(store.getState().projects.map(project => project.id)).toEqual([22, 11]);
  expect(store.getState()).toMatchObject({ isReordering: false, isLoading: false, error: null });
});

it('reloads after a project-list invalidation arrives during the initial request', async () => {
  let finish!: (response: { success: boolean; data: Project[] }) => void;
  vi.mocked(API.projects.getAll)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ success: true, data: [beta] });
  const initial = store.getState().ensureLoaded();
  const refresh = store.getState().refresh();
  finish({ success: true, data: [alpha, beta] });
  await Promise.all([initial, refresh]);
  expect(store.getState().projects.map(project => project.name)).toEqual(['Beta']);
});
