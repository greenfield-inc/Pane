import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createSavedState } from './savedState';

let files: Map<string, string>;
const store = {
  read: (id: string) => files.get(id) ?? null,
  write: (id: string, text: string) => void files.set(id, text),
  remove: (id: string) => void files.delete(id),
};

beforeEach(() => {
  vi.useFakeTimers();
  files = new Map();
});
afterEach(() => vi.useRealTimers());

function phone(saves = (_id: string) => true) {
  const queryClient = new QueryClient();
  return { queryClient, saved: createSavedState(queryClient, store, { saves }) };
}

it('paints a machine’s lists after a relaunch, marked stale so screens still read them', () => {
  const before = phone();
  before.queryClient.setQueryData(['mac', 'sessions:get-all-with-projects'], [{ id: 1, name: 'pane' }]);
  before.queryClient.setQueryData(['mac', 'runpane:workspace:state'], { unseen: { 'pane-1': true } });
  before.queryClient.setQueryData(['mac', 'panels:list', 'pane-1', { chatTabs: true }], [{ id: 'tab' }]);
  before.queryClient.setQueryData(['mac', 'git:diff', 'pane-1'], 'not saved');
  before.queryClient.setQueryData(['devbox', 'all-machines:snapshot', 'https://devbox'], { projects: [] });
  vi.advanceTimersByTime(2_000);

  const after = phone();
  after.saved.restore('mac');
  expect(after.queryClient.getQueryData(['mac', 'sessions:get-all-with-projects'])).toEqual([{ id: 1, name: 'pane' }]);
  expect(after.queryClient.getQueryData(['mac', 'runpane:workspace:state'])).toEqual({ unseen: { 'pane-1': true } });
  expect(after.queryClient.getQueryData(['mac', 'panels:list', 'pane-1', { chatTabs: true }])).toEqual([{ id: 'tab' }]);
  expect(after.queryClient.getQueryData(['mac', 'git:diff', 'pane-1'])).toBeUndefined();
  // Another machine's lists live in its own file.
  expect(after.queryClient.getQueryData(['devbox', 'all-machines:snapshot', 'https://devbox'])).toBeUndefined();
  expect(after.queryClient.getQueryState(['mac', 'sessions:get-all-with-projects'])?.isInvalidated).toBe(true);
  after.saved.restore('devbox');
  expect(after.queryClient.getQueryData(['devbox', 'all-machines:snapshot', 'https://devbox'])).toEqual({ projects: [] });
});

it('writes once, 2 s after the last change in a burst', () => {
  const { queryClient } = phone();
  const writes = vi.spyOn(store, 'write');
  for (let count = 0; count < 5; count++) {
    queryClient.setQueryData(['mac', 'permission:getPending'], [count]);
    vi.advanceTimersByTime(500);
  }
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_500);
  expect(writes).toHaveBeenCalledTimes(1);
});

it('keeps the tab lists of the 20 Panes read most recently', () => {
  const { queryClient } = phone();
  for (let pane = 1; pane <= 25; pane++) {
    queryClient.setQueryData(['mac', 'panels:list', `pane-${pane}`], [pane], { updatedAt: 1_000 + pane });
  }
  vi.advanceTimersByTime(2_000);
  const after = phone();
  after.saved.restore('mac');
  expect(after.queryClient.getQueryData(['mac', 'panels:list', 'pane-6'])).toEqual([6]);
  expect(after.queryClient.getQueryData(['mac', 'panels:list', 'pane-5'])).toBeUndefined();
});

it('keeps newer lists already in memory', () => {
  const before = phone();
  before.queryClient.setQueryData(['mac', 'permission:getPending'], ['saved'], { updatedAt: 1_000 });
  vi.advanceTimersByTime(2_000);
  const { queryClient, saved } = phone();
  queryClient.setQueryData(['mac', 'permission:getPending'], ['live'], { updatedAt: 5_000 });
  saved.restore('mac');
  expect(queryClient.getQueryData(['mac', 'permission:getPending'])).toEqual(['live']);
});

it('ignores a file from another version or one that does not parse', () => {
  for (const text of [JSON.stringify({ version: 2, queries: [] }), '{not json']) {
    files.set('mac', text);
    const { queryClient, saved } = phone();
    expect(() => saved.restore('mac')).not.toThrow();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  }
});

it('saves nothing for a machine it must not keep, and forgets a machine on removal', () => {
  const { queryClient, saved } = phone(id => id !== 'pane-demo');
  queryClient.setQueryData(['pane-demo', 'sessions:get-all-with-projects'], []);
  queryClient.setQueryData(['mac', 'sessions:get-all-with-projects'], []);
  vi.advanceTimersByTime(2_000);
  expect([...files.keys()]).toEqual(['mac']);

  queryClient.setQueryData(['mac', 'sessions:get-all-with-projects'], [1]);
  saved.forget('mac');
  vi.advanceTimersByTime(2_000);
  expect(files.has('mac')).toBe(false);
});
